package app

import (
	"path/filepath"
	"testing"

	appsession "cipherleaf/internal/session"
)

func TestScratchpadShortcutGuardsAndHelpers(t *testing.T) {
	service := NewVaultService()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if got := service.GetScratchpadShortcut(); got != appsession.DefaultScratchpadShortcut {
		t.Fatalf("default Scratchpad shortcut = %q, want %q", got, appsession.DefaultScratchpadShortcut)
	}
	if err := service.recent.SetScratchpadShortcut("Ctrl+Shift+S"); err != nil {
		t.Fatal(err)
	}
	if got := service.GetScratchpadShortcut(); got != "Ctrl+Shift+S" {
		t.Fatalf("saved Scratchpad shortcut = %q", got)
	}

	if err := service.InitializeScratchpadShortcut(); err == nil {
		t.Fatal("initialization without an application unexpectedly succeeded")
	}
	service.scratchpadShortcut = "Alt+S"
	service.scratchpadShortcutInitialized = true
	if got := service.GetScratchpadShortcut(); got != "Alt+S" {
		t.Fatalf("initialized Scratchpad shortcut = %q", got)
	}
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatalf("already initialized shortcut: %v", err)
	}

	if err := service.HideScratchpad(); err == nil {
		t.Fatal("hiding Scratchpad without an application unexpectedly succeeded")
	}
	service.toggleScratchpad()
	hideScratchpadWindow(nil)

	fresh := NewVaultService()
	if _, err := fresh.SetScratchpadShortcut("Ctrl+S"); err == nil {
		t.Fatal("setting an uninitialized Scratchpad shortcut unexpectedly succeeded")
	}
	fresh.scratchpadShortcut = "Ctrl+S"
	fresh.scratchpadShortcutInitialized = true
	if got, err := fresh.SetScratchpadShortcut(" Ctrl+S "); err != nil || got != "Ctrl+S" {
		t.Fatalf("setting the current shortcut = %q, %v", got, err)
	}
	if got, err := fresh.SetScratchpadShortcut("Alt+S"); err == nil || got != "Ctrl+S" {
		t.Fatalf("unavailable shortcut application = %q, %v", got, err)
	}

	for _, test := range []struct {
		namespace  string
		generation uint64
		explicit   bool
		wantErr    bool
	}{
		{scratchpadNamespace, 0, false, false},
		{scratchpadNamespace + ":7", 7, true, false},
		{"other", 0, false, true},
		{scratchpadNamespace + ":bad", 0, false, true},
	} {
		generation, explicit, err := scratchpadGeneration(test.namespace)
		if (err != nil) != test.wantErr || generation != test.generation || explicit != test.explicit {
			t.Fatalf("scratchpadGeneration(%q) = %d, %v, %v", test.namespace, generation, explicit, err)
		}
	}

	for _, data := range [][]byte{
		nil,
		make([]byte, scratchpadMaxAttachmentBytes+1),
		[]byte("not WebP"),
		[]byte("RIFF1234NOPE"),
	} {
		if err := validateScratchpadAttachment(data); err == nil {
			t.Fatalf("invalid attachment accepted: %d bytes", len(data))
		}
	}
	if err := validateScratchpadAttachment(scratchpadWebP(12, 'x')); err != nil {
		t.Fatalf("valid WebP rejected: %v", err)
	}
	for _, id := range []string{"", "short", "0123456789abcdef0123456789abcdeG", "0123456789abcdef0123456789abcdef0"} {
		if isScratchpadAttachmentID(id) {
			t.Fatalf("invalid attachment ID accepted: %q", id)
		}
	}
}
