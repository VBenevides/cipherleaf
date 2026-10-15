//go:build linux

package app

import (
	"bufio"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// Use a private bus: these tests must never register desktop shortcuts on the
// developer's session or require a running desktop portal in CI.
func privateShortcutBus(t *testing.T) *dbus.Conn {
	t.Helper()
	if _, err := exec.LookPath("dbus-daemon"); err != nil {
		t.Skip("dbus-daemon is not installed")
	}
	command := exec.Command("dbus-daemon", "--session", "--nofork", "--print-address=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := command.Process.Kill(); err != nil {
			t.Errorf("stop private D-Bus: %v", err)
		}
		// Killing the private daemon intentionally produces an exit error.
		_ = command.Wait()
	})
	address, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", strings.TrimSpace(address))
	t.Setenv("XDG_SESSION_TYPE", "wayland")
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(); err != nil {
			t.Errorf("close portal test connection: %v", err)
		}
	})
	return conn
}

func TestPortalShortcutLifecycleOnPrivateBus(t *testing.T) {
	conn := privateShortcutBus(t)
	if _, err := conn.RequestName(portalServiceName, dbus.NameFlagDoNotQueue); err != nil {
		t.Fatal(err)
	}
	const session = dbus.ObjectPath("/org/freedesktop/portal/desktop/session/test")
	closed := make(chan struct{}, 4)
	registerError := false
	bindCode := uint32(0)
	export := func(path dbus.ObjectPath, iface string, methods map[string]interface{}) {
		t.Helper()
		if err := conn.ExportMethodTable(methods, path, iface); err != nil {
			t.Fatal(err)
		}
	}
	export(portalObjectPath, portalRegistryIf, map[string]interface{}{
		"Register": func(appID string, _ map[string]dbus.Variant) *dbus.Error {
			if registerError {
				return dbus.MakeFailedError(fmt.Errorf("registration refused"))
			}
			if appID != portalAppID {
				return dbus.MakeFailedError(fmt.Errorf("unexpected app ID %q", appID))
			}
			return nil
		},
	})
	export(portalObjectPath, portalShortcutIf, map[string]interface{}{
		"CreateSession": func(_ map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
			path := dbus.ObjectPath("/request/create")
			if err := conn.Emit(path, portalRequestIf+".Response", uint32(0), map[string]dbus.Variant{"session_handle": dbus.MakeVariant(session)}); err != nil {
				return "", dbus.MakeFailedError(err)
			}
			return path, nil
		},
		"BindShortcuts": func(gotSession dbus.ObjectPath, entries []portalShortcutEntry, _ string, _ map[string]dbus.Variant) (dbus.ObjectPath, *dbus.Error) {
			if gotSession != session || len(entries) != 1 || entries[0].ID != portalShortcutID || entries[0].Props["preferred_trigger"].Value() != "LOGO+grave" {
				return "", dbus.MakeFailedError(fmt.Errorf("invalid shortcut binding"))
			}
			path := dbus.ObjectPath("/request/bind")
			if err := conn.Emit(path, portalRequestIf+".Response", bindCode, map[string]dbus.Variant{}); err != nil {
				return "", dbus.MakeFailedError(err)
			}
			return path, nil
		},
	})
	export(session, portalSessionIf, map[string]interface{}{
		"Close": func() *dbus.Error { closed <- struct{}{}; return nil },
	})
	activated := make(chan struct{}, 1)
	unregister, err := registerScratchpadShortcut(nil, "Super+`", func() { activated <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Emit(portalObjectPath, portalShortcutIf+".Activated", session, portalShortcutID, uint64(1)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-activated:
	case <-time.After(3 * time.Second):
		t.Fatal("matching portal activation did not reach callback")
	}
	if err := unregister(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("unregister did not close portal session")
	}
	bindCode = 2
	if _, err := registerPortalScratchpadShortcut("invalid", func() {}); err == nil {
		t.Fatal("invalid binding unexpectedly succeeded")
	}
	if _, err := registerPortalScratchpadShortcut("Super+`", func() {}); err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("binding refusal = %v", err)
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("failed binding did not close allocated session")
	}
	registerError = true
	if _, err := registerPortalScratchpadShortcut("Super+`", func() {}); err == nil || !strings.Contains(err.Error(), "registration refused") {
		t.Fatalf("registration refusal = %v", err)
	}
}
