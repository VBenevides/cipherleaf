//go:build linux

package app

import (
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
