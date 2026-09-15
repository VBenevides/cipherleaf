//go:build linux

package app

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	portalServiceName     = "org.freedesktop.portal.Desktop"
	portalObjectPath      = dbus.ObjectPath("/org/freedesktop/portal/desktop")
	portalRegistryIf      = "org.freedesktop.host.portal.Registry"
	portalShortcutIf      = "org.freedesktop.portal.GlobalShortcuts"
	portalRequestIf       = "org.freedesktop.portal.Request"
	portalSessionIf       = "org.freedesktop.portal.Session"
	portalAppID           = "cipherleaf"
	portalShortcutID      = "scratchpad"
	portalSignalQueueSize = 16
	portalResponseTimeout = 30 * time.Second
	portalBindTimeout     = 5 * time.Minute // BindShortcuts may wait for user approval.
)

var portalTokenSequence uint64

func registerScratchpadShortcut(app *application.App, shortcut string, callback func()) (func() error, error) {
	if !isWaylandSession() {
		return registerWailsScratchpadShortcut(app, shortcut, callback)
	}
	return registerPortalScratchpadShortcut(shortcut, callback)
}

func isWaylandSession() bool {
	session := strings.ToLower(os.Getenv("XDG_SESSION_TYPE"))
	return session == "wayland" || (session != "x11" && os.Getenv("WAYLAND_DISPLAY") != "")
}

type portalScratchpadShortcut struct {
	conn        *dbus.Conn
	signals     chan *dbus.Signal
	sessionPath dbus.ObjectPath
	done        chan struct{}
	callback    func()
}

type portalShortcutEntry struct {
	ID    string
	Props map[string]dbus.Variant
}

type portalResponse struct {
	code    uint32
	results map[string]dbus.Variant
}

func registerPortalScratchpadShortcut(shortcut string, callback func()) (func() error, error) {
	trigger, err := portalShortcutTrigger(shortcut)
	if err != nil {
		return nil, err
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("connect to session bus: %w", err)
	}
	var signals chan *dbus.Signal
	var sessionPath dbus.ObjectPath
	keepAlive := false
	defer func() {
		if !keepAlive {
			if signals != nil {
				conn.RemoveSignal(signals)
			}
			if sessionPath != "" {
				_ = conn.Object(portalServiceName, sessionPath).Call(portalSessionIf+".Close", 0).Err
			}
			_ = conn.Close()
		}
	}()
	portal := conn.Object(portalServiceName, portalObjectPath)
	// Host applications must identify this D-Bus peer before using the portal.
	if err := portal.Call(portalRegistryIf+".Register", 0, portalAppID, map[string]dbus.Variant{}).Err; err != nil {
		return nil, fmt.Errorf("register portal application %q: %w", portalAppID, err)
	}
	signals = make(chan *dbus.Signal, portalSignalQueueSize)
	conn.Signal(signals)
	if err := conn.AddMatchSignal(dbus.WithMatchSender(portalServiceName), dbus.WithMatchInterface(portalRequestIf), dbus.WithMatchMember("Response")); err != nil {
		return nil, fmt.Errorf("listen for portal responses: %w", err)
	}
	if err := conn.AddMatchSignal(dbus.WithMatchSender(portalServiceName), dbus.WithMatchInterface(portalShortcutIf), dbus.WithMatchMember("Activated")); err != nil {
		return nil, fmt.Errorf("listen for portal activations: %w", err)
	}

	var createRequest dbus.ObjectPath
	if err := portal.Call(portalShortcutIf+".CreateSession", 0, map[string]dbus.Variant{
		"handle_token":         dbus.MakeVariant(nextPortalToken("request")),
		"session_handle_token": dbus.MakeVariant(nextPortalToken("session")),
	}).Store(&createRequest); err != nil {
		return nil, fmt.Errorf("create portal shortcut session: %w", err)
	}
	created, err := waitPortalResponseWithTimeout(signals, createRequest, portalResponseTimeout)
	if err != nil {
		return nil, fmt.Errorf("create portal shortcut session: %w", err)
	}
	if created.code != 0 {
		return nil, fmt.Errorf("portal refused shortcut session (response %d)", created.code)
	}
	session, ok := created.results["session_handle"]
	if !ok || session.Store(&sessionPath) != nil || !sessionPath.IsValid() {
		return nil, fmt.Errorf("portal returned an invalid shortcut session handle")
	}

	entry := portalShortcutEntry{
		ID: portalShortcutID,
		Props: map[string]dbus.Variant{
			"description":       dbus.MakeVariant("Cipherleaf Scratchpad"),
			"preferred_trigger": dbus.MakeVariant(trigger),
		},
	}
	var bindRequest dbus.ObjectPath
	if err := portal.Call(portalShortcutIf+".BindShortcuts", 0, sessionPath, []portalShortcutEntry{entry}, "", map[string]dbus.Variant{
		"handle_token": dbus.MakeVariant(nextPortalToken("bind")),
	}).Store(&bindRequest); err != nil {
		return nil, fmt.Errorf("bind portal Scratchpad shortcut: %w", err)
	}
	bound, err := waitPortalResponseWithTimeout(signals, bindRequest, portalBindTimeout)
	if err != nil {
		return nil, fmt.Errorf("bind portal Scratchpad shortcut: %w", err)
	}
	if bound.code != 0 {
		return nil, fmt.Errorf("portal rejected Scratchpad shortcut (response %d)", bound.code)
	}

	registration := &portalScratchpadShortcut{
		conn:        conn,
		signals:     signals,
		sessionPath: sessionPath,
		done:        make(chan struct{}),
		callback:    callback,
	}
	// Keep the connection and session alive for Activated signals.
	keepAlive = true
	go registration.consumeSignals()
	return registration.Unregister, nil
}

func nextPortalToken(prefix string) string {
	return fmt.Sprintf("cipherleaf_%s_%d", prefix, atomic.AddUint64(&portalTokenSequence, 1))
}

func waitPortalResponseWithTimeout(signals <-chan *dbus.Signal, requestPath dbus.ObjectPath, timeout time.Duration) (portalResponse, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			return portalResponse{}, fmt.Errorf("timed out waiting for portal response")
		case signal, ok := <-signals:
			if !ok {
				return portalResponse{}, fmt.Errorf("portal response stream closed")
			}
			if signal == nil || signal.Name != portalRequestIf+".Response" || signal.Path != requestPath || len(signal.Body) == 0 {
				continue
			}
			code, ok := signal.Body[0].(uint32)
			if !ok {
				return portalResponse{}, fmt.Errorf("portal returned an invalid response code")
			}
			response := portalResponse{code: code}
			if len(signal.Body) > 1 {
				response.results, _ = signal.Body[1].(map[string]dbus.Variant)
			}
			return response, nil
		}
	}
}

func (p *portalScratchpadShortcut) consumeSignals() {
	for {
		select {
		case <-p.done:
			return
		case signal, ok := <-p.signals:
			if !ok || signal == nil {
				return
			}
			if signal.Name == portalShortcutIf+".Activated" && len(signal.Body) >= 2 &&
				signal.Body[0] == p.sessionPath && signal.Body[1] == portalShortcutID {
				p.callback()
			}
		}
	}
}

func (p *portalScratchpadShortcut) Unregister() error {
	close(p.done)
	p.conn.RemoveSignal(p.signals)
	err := p.conn.Object(portalServiceName, p.sessionPath).Call(portalSessionIf+".Close", 0).Err
	if closeErr := p.conn.Close(); err == nil {
		err = closeErr
	}
	return err
}

func portalShortcutTrigger(shortcut string) (string, error) {
	parts := strings.Split(shortcut, "+")
	if len(parts) < 2 {
		return "", fmt.Errorf("global shortcut %q needs a modifier", shortcut)
	}
	var hasCtrl, hasAlt, hasShift, hasSuper bool
	for _, raw := range parts[:len(parts)-1] {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "cmdorctrl", "cmd", "command", "ctrl":
			hasCtrl = true
		case "optionoralt", "option", "alt":
			hasAlt = true
		case "shift":
			hasShift = true
		case "super":
			hasSuper = true
		default:
			return "", fmt.Errorf("global shortcut %q has invalid modifier %q", shortcut, raw)
		}
	}
	key, err := portalShortcutKey(parts[len(parts)-1])
	if err != nil {
		return "", fmt.Errorf("global shortcut %q: %w", shortcut, err)
	}
	modifiers := make([]string, 0, 4)
	if hasCtrl {
		modifiers = append(modifiers, "CTRL")
	}
	if hasAlt {
		modifiers = append(modifiers, "ALT")
	}
	if hasShift {
		modifiers = append(modifiers, "SHIFT")
	}
	if hasSuper {
		modifiers = append(modifiers, "LOGO")
	}
	return strings.Join(append(modifiers, key), "+"), nil
}

func portalShortcutKey(raw string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(raw))
	keys := map[string]string{
		"backspace": "BackSpace", "tab": "Tab", "return": "Return", "enter": "Return", "escape": "Escape",
		"space": "space", "delete": "Delete", "page up": "Prior", "page down": "Next", "end": "End", "home": "Home",
		"left": "Left", "up": "Up", "right": "Right", "down": "Down", "numlock": "Num_Lock",
		";": "semicolon", "=": "equal", ",": "comma", "-": "minus", ".": "period", "/": "slash", "`": "grave",
		"[": "bracketleft", "\\": "backslash", "]": "bracketright", "'": "apostrophe", "plus": "plus",
	}
	if mapped, ok := keys[key]; ok {
		return mapped, nil
	}
	if len([]rune(key)) == 1 {
		return key, nil
	}
	if strings.HasPrefix(key, "f") {
		if number, err := strconv.Atoi(strings.TrimPrefix(key, "f")); err == nil && number >= 1 && number <= 24 {
			return strings.ToUpper(key), nil
		}
	}
	return "", fmt.Errorf("unsupported key %q", raw)
}
