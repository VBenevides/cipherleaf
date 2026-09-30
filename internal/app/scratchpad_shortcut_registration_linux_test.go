//go:build linux

package app

import (
	"errors"
	"strings"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestPortalShortcutTrigger(t *testing.T) {
	for _, test := range []struct {
		shortcut string
		want     string
	}{
		{shortcut: "Super+`", want: "LOGO+grave"},
		{shortcut: "Shift+Ctrl+S", want: "CTRL+SHIFT+s"},
		{shortcut: "Alt+F12", want: "ALT+F12"},
		{shortcut: "CmdOrCtrl+plus", want: "CTRL+plus"},
	} {
		got, err := portalShortcutTrigger(test.shortcut)
		if err != nil || got != test.want {
			t.Fatalf("portalShortcutTrigger(%q) = %q, %v; want %q", test.shortcut, got, err, test.want)
		}
	}
	for _, shortcut := range []string{"S", "Meta+S", "Ctrl+F25"} {
		if _, err := portalShortcutTrigger(shortcut); err == nil {
			t.Fatalf("portalShortcutTrigger(%q) unexpectedly succeeded", shortcut)
		}
	}
}

func TestWaitPortalResponseRejectsClosedOrMalformedSignals(t *testing.T) {
	closed := make(chan *dbus.Signal)
	close(closed)
	if _, err := waitPortalResponseWithTimeout(closed, "/request", portalResponseTimeout); err == nil {
		t.Fatal("closed portal response stream unexpectedly succeeded")
	}

	malformed := make(chan *dbus.Signal, 1)
	malformed <- &dbus.Signal{Name: portalRequestIf + ".Response", Path: "/request", Body: []interface{}{"ok"}}
	if _, err := waitPortalResponseWithTimeout(malformed, "/request", portalResponseTimeout); err == nil {
		t.Fatal("malformed portal response unexpectedly succeeded")
	}
}

// Only Call is used by session creation and binding. Embedding the interface
// keeps unexpected use of any other bus operation from silently succeeding.
type shortcutPortalObject struct {
	dbus.BusObject
	reply *dbus.Call
}

func (p shortcutPortalObject) Call(string, dbus.Flags, ...interface{}) *dbus.Call {
	return p.reply
}

func shortcutPortalResponse(path dbus.ObjectPath, code uint32, results map[string]dbus.Variant) *dbus.Signal {
	return &dbus.Signal{
		Name: portalRequestIf + ".Response",
		Path: path,
		Body: []interface{}{code, results},
	}
}

func TestWaitPortalResponseFiltersUnrelatedSignals(t *testing.T) {
	signals := make(chan *dbus.Signal, 6)
	signals <- nil
	signals <- &dbus.Signal{Name: portalShortcutIf + ".Activated", Path: "/request", Body: []interface{}{uint32(9)}}
	signals <- shortcutPortalResponse("/other_request", 9, nil)
	signals <- &dbus.Signal{Name: portalRequestIf + ".Response", Path: "/request"}
	signals <- shortcutPortalResponse("/request", 2, map[string]dbus.Variant{"reason": dbus.MakeVariant("denied")})
	close(signals)
	response, err := waitPortalResponseWithTimeout(signals, "/request", portalResponseTimeout)
	if err != nil || response.code != 2 || response.results["reason"].Value() != "denied" {
		t.Fatalf("matching response = %#v, %v; want refusal and its results", response, err)
	}
}

func TestWaitPortalResponseTimeout(t *testing.T) {
	_, err := waitPortalResponseWithTimeout(make(chan *dbus.Signal), "/request", 0)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("timeout error = %v", err)
	}
}

func TestCreatePortalShortcutSessionResponseBoundaries(t *testing.T) {
	for _, test := range []struct {
		name    string
		code    uint32
		results map[string]dbus.Variant
		want    dbus.ObjectPath
		errText string
	}{
		{name: "accepted", results: map[string]dbus.Variant{"session_handle": dbus.MakeVariant(dbus.ObjectPath("/session/accepted"))}, want: "/session/accepted"},
		{name: "cancelled", code: 1, errText: "refused shortcut session (response 1)"},
		{name: "refused despite handle", code: 2, results: map[string]dbus.Variant{"session_handle": dbus.MakeVariant(dbus.ObjectPath("/session/accepted"))}, errText: "refused shortcut session (response 2)"},
		{name: "missing handle", errText: "invalid shortcut session handle"},
		{name: "wrong handle type", results: map[string]dbus.Variant{"session_handle": dbus.MakeVariant(uint32(3))}, errText: "invalid shortcut session handle"},
		{name: "invalid path", results: map[string]dbus.Variant{"session_handle": dbus.MakeVariant(dbus.ObjectPath("not/a/path"))}, errText: "invalid shortcut session handle"},
		{name: "empty path", results: map[string]dbus.Variant{"session_handle": dbus.MakeVariant(dbus.ObjectPath(""))}, errText: "invalid shortcut session handle"},
	} {
		t.Run(test.name, func(t *testing.T) {
			signals := make(chan *dbus.Signal, 1)
			signals <- shortcutPortalResponse("/request", test.code, test.results)
			close(signals)
			portal := shortcutPortalObject{reply: &dbus.Call{Body: []interface{}{dbus.ObjectPath("/request")}}}
			got, err := createPortalShortcutSession(portal, signals)
			if test.errText != "" {
				if err == nil || !strings.Contains(err.Error(), test.errText) || got != "" {
					t.Fatalf("session = %q, %v; want no session and %q", got, err, test.errText)
				}
			} else if err != nil || got != test.want {
				t.Fatalf("session = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestPortalSetupReportsTransportAndResponseFailures(t *testing.T) {
	transportErr := errors.New("portal transport disconnected")
	for _, operation := range []struct {
		name string
		run  func(dbus.BusObject, <-chan *dbus.Signal) error
	}{
		{name: "create portal shortcut session", run: func(portal dbus.BusObject, signals <-chan *dbus.Signal) error {
			_, err := createPortalShortcutSession(portal, signals)
			return err
		}},
		{name: "bind portal Scratchpad shortcut", run: func(portal dbus.BusObject, signals <-chan *dbus.Signal) error {
			return bindPortalShortcut(portal, signals, "/session", "CTRL+s")
		}},
	} {
		t.Run(operation.name, func(t *testing.T) {
			err := operation.run(shortcutPortalObject{reply: &dbus.Call{Err: transportErr}}, nil)
			if !errors.Is(err, transportErr) || !strings.Contains(err.Error(), operation.name) {
				t.Fatalf("transport error lost cause or operation context: %v", err)
			}
			checkPortalSetupResponseFailures(t, operation.name, operation.run)
		})
	}
}

func checkPortalSetupResponseFailures(t *testing.T, operationName string, run func(dbus.BusObject, <-chan *dbus.Signal) error) {
	t.Helper()
	for _, test := range []struct {
		name    string
		reply   []interface{}
		signal  *dbus.Signal
		errText string
	}{
		{name: "invalid method reply", reply: []interface{}{uint32(1)}, errText: operationName},
		{name: "closed response stream", reply: []interface{}{dbus.ObjectPath("/request")}, errText: "portal response stream closed"},
		{name: "malformed response", reply: []interface{}{dbus.ObjectPath("/request")}, signal: &dbus.Signal{Name: portalRequestIf + ".Response", Path: "/request", Body: []interface{}{"success"}}, errText: "invalid response code"},
	} {
		t.Run(test.name, func(t *testing.T) {
			signals := make(chan *dbus.Signal, 1)
			if test.signal != nil {
				signals <- test.signal
			}
			close(signals)
			err := run(shortcutPortalObject{reply: &dbus.Call{Body: test.reply}}, signals)
			if err == nil || !strings.Contains(err.Error(), test.errText) {
				t.Fatalf("error = %v; want %q", err, test.errText)
			}
		})
	}
}

func TestBindPortalShortcutApprovalBoundaries(t *testing.T) {
	for _, code := range []uint32{0, 1, 2} {
		signals := make(chan *dbus.Signal, 1)
		signals <- shortcutPortalResponse("/request", code, nil)
		close(signals)
		err := bindPortalShortcut(shortcutPortalObject{reply: &dbus.Call{Body: []interface{}{dbus.ObjectPath("/request")}}}, signals, "/session", "CTRL+s")
		if code == 0 && err != nil {
			t.Fatalf("approved binding failed: %v", err)
		}
		if code != 0 && (err == nil || !strings.Contains(err.Error(), "rejected Scratchpad shortcut")) {
			t.Fatalf("refused binding %d returned %v", code, err)
		}
	}
}

func TestPortalActivationIsolation(t *testing.T) {
	signals := make(chan *dbus.Signal, 6)
	signals <- &dbus.Signal{Name: portalRequestIf + ".Response", Body: []interface{}{dbus.ObjectPath("/session"), portalShortcutID}}
	signals <- &dbus.Signal{Name: portalShortcutIf + ".Activated", Body: []interface{}{dbus.ObjectPath("/other_session"), portalShortcutID}}
	signals <- &dbus.Signal{Name: portalShortcutIf + ".Activated", Body: []interface{}{dbus.ObjectPath("/session"), "other_shortcut"}}
	signals <- &dbus.Signal{Name: portalShortcutIf + ".Activated", Body: []interface{}{dbus.ObjectPath("/session")}}
	signals <- &dbus.Signal{Name: portalShortcutIf + ".Activated", Body: []interface{}{dbus.ObjectPath("/session"), portalShortcutID, uint64(42)}}
	close(signals)
	calls := 0
	registration := portalScratchpadShortcut{signals: signals, sessionPath: "/session", done: make(chan struct{}), callback: func() { calls++ }}
	registration.consumeSignals()
	if calls != 1 {
		t.Fatalf("callback invoked %d times; want only the matching activation", calls)
	}
}

func TestPortalSignalConsumerShutdown(t *testing.T) {
	for _, reason := range []string{"done", "closed stream", "nil signal"} {
		t.Run(reason, func(t *testing.T) {
			done := make(chan struct{})
			signals := make(chan *dbus.Signal, 1)
			switch reason {
			case "done":
				close(done)
			case "closed stream":
				close(signals)
			case "nil signal":
				signals <- nil
			}
			registration := portalScratchpadShortcut{signals: signals, done: done, callback: func() { t.Error("callback invoked during shutdown") }}
			registration.consumeSignals()
		})
	}
}
