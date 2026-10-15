package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appsession "cipherleaf/internal/session"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestScratchpadShortcutGuardsAndHelpers(t *testing.T) {
	service := newScratchpadShortcutTestService(t)
	testScratchpadShortcutState(t, service)
	testScratchpadShortcutTarget(t, service)
	testScratchpadShortcutRegistration(t)
	testScratchpadValidationHelpers(t)
}

func newScratchpadShortcutTestService(t *testing.T) *VaultService {
	t.Helper()
	service := NewVaultService()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	return service
}

func testScratchpadShortcutState(t *testing.T, service *VaultService) {
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
	service.toggleScratchpad()
	if err := service.HideScratchpad(); err == nil {
		t.Fatal("hiding Scratchpad without an application unexpectedly succeeded")
	}
	hideScratchpadWindow(nil)
}

func testScratchpadShortcutTarget(t *testing.T, service *VaultService) {
	if got := service.GetScratchpadShortcutTarget(); got != defaultScratchpadShortcutTarget {
		t.Fatalf("default Scratchpad shortcut target = %q", got)
	}
	if _, err := service.store.Create(t.TempDir(), "shortcut target secret"); err != nil {
		t.Fatal(err)
	}
	if got, err := service.SetScratchpadShortcutTarget("note:abc"); err != nil || got != "note:abc" {
		t.Fatalf("setting Scratchpad shortcut target = %q, %v", got, err)
	}
	if got := service.GetScratchpadShortcutTarget(); got != "note:abc" {
		t.Fatalf("saved Scratchpad shortcut target = %q", got)
	}
	settings, err := service.store.GetVaultSettings()
	if err != nil || settings.ScratchpadNoteID != "abc" {
		t.Fatalf("vault Scratchpad target = %q, %v", settings.ScratchpadNoteID, err)
	}
	if _, err := service.SetScratchpadShortcutTarget("tab:1"); err == nil {
		t.Fatal("invalid Scratchpad shortcut target unexpectedly accepted")
	}
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatalf("already initialized shortcut: %v", err)
	}
}

func testScratchpadShortcutRegistration(t *testing.T) {
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
}

func testScratchpadValidationHelpers(t *testing.T) {
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
	for _, data := range [][]byte{nil, make([]byte, scratchpadMaxAttachmentBytes+1), []byte("not WebP"), []byte("RIFF1234NOPE")} {
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

type coverageNoopTransport struct{}

func (coverageNoopTransport) Start(context.Context, *application.MessageProcessor) error { return nil }
func (coverageNoopTransport) JSClient() []byte                                           { return nil }
func (coverageNoopTransport) Stop() error                                                { return nil }

func TestScratchpadShortcutApplicationBranches(t *testing.T) {
	t.Setenv("XDG_SESSION_TYPE", "x11")
	wailsApp := application.New(application.Options{
		DisableDefaultSignalHandler: true,
		Transport:                   coverageNoopTransport{},
	})
	cleanupPendingScratchpadShortcuts(t, wailsApp)
	wailsApp.Window.Add(application.NewWindow(application.WebviewWindowOptions{Name: mainWindowName}))
	wailsApp.Window.Add(application.NewWindow(application.WebviewWindowOptions{Name: scratchpadWindowName}))
	if err := wailsApp.Screen.LayoutScreens([]*application.Screen{{
		ID: "primary", IsPrimary: true, Bounds: application.Rect{Width: 1200, Height: 800},
	}}); err != nil {
		t.Fatal(err)
	}

	service := NewVaultService()
	service.SetApp(wailsApp)
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if err := service.recent.SetScratchpadShortcut("Ctrl+Shift+S"); err != nil {
		t.Fatal(err)
	}
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatal(err)
	}
	if got, err := service.SetScratchpadShortcut("Alt+S"); err != nil || got != "Alt+S" {
		t.Fatalf("changed Scratchpad shortcut = %q, %v", got, err)
	}
	if _, err := service.store.Create(t.TempDir(), "shortcut coverage secret"); err != nil {
		t.Fatal(err)
	}
	service.toggleScratchpad()

	fallback := NewVaultService()
	fallback.SetApp(wailsApp)
	fallback.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if err := fallback.recent.SetScratchpadShortcut("Alt+S"); err != nil {
		t.Fatal(err)
	}
	if err := fallback.InitializeScratchpadShortcut(); err != nil {
		t.Fatal(err)
	}
	if got := fallback.GetScratchpadShortcut(); got != appsession.DefaultScratchpadShortcut {
		t.Fatalf("fallback shortcut = %q", got)
	}

	defaultConflict := NewVaultService()
	defaultConflict.SetApp(wailsApp)
	defaultConflict.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if err := defaultConflict.InitializeScratchpadShortcut(); err == nil {
		t.Fatal("duplicate default shortcut unexpectedly initialized")
	}

	service.toggleScratchpad()
}

// The application is deliberately never run: Wails keeps these registrations
// pending, so these tests exercise conflicts without binding OS shortcuts.
func newPendingScratchpadShortcutService(t *testing.T) (*VaultService, *application.App) {
	t.Helper()
	t.Setenv("XDG_SESSION_TYPE", "x11")
	app := application.New(application.Options{
		DisableDefaultSignalHandler: true,
		Transport:                   coverageNoopTransport{},
	})
	cleanupPendingScratchpadShortcuts(t, app)
	service := newScratchpadShortcutTestService(t)
	service.SetApp(app)
	return service, app
}

func cleanupPendingScratchpadShortcuts(t *testing.T, app *application.App) {
	t.Helper()
	t.Cleanup(func() {
		for _, shortcut := range []string{appsession.DefaultScratchpadShortcut, "Alt+S", "Ctrl+Shift+S"} {
			if app.GlobalShortcut.IsRegistered(shortcut) {
				if err := app.GlobalShortcut.Unregister(shortcut); err != nil {
					t.Errorf("release test shortcut %q: %v", shortcut, err)
				}
			}
		}
	})
}

func TestScratchpadShortcutInitializationPersistenceFailure(t *testing.T) {
	service, app := newPendingScratchpadShortcutService(t)
	service.recent = appsession.NewRecentVaultStore(t.TempDir())
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatalf("usable session shortcut rejected because persistence failed: %v", err)
	}
	if got := service.GetScratchpadShortcut(); got != appsession.DefaultScratchpadShortcut {
		t.Fatalf("session shortcut = %q", got)
	}
	if !app.GlobalShortcut.IsRegistered(appsession.DefaultScratchpadShortcut) {
		t.Fatal("session shortcut was not retained")
	}
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatalf("initialization should remain idempotent after persistence failure: %v", err)
	}
}

func TestScratchpadShortcutInitializationBothBindingsConflict(t *testing.T) {
	service, app := newPendingScratchpadShortcutService(t)
	const saved = "Alt+S"
	if err := service.recent.SetScratchpadShortcut(saved); err != nil {
		t.Fatal(err)
	}
	for _, shortcut := range []string{saved, appsession.DefaultScratchpadShortcut} {
		if err := app.GlobalShortcut.Register(shortcut, func() {}); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.InitializeScratchpadShortcut(); err == nil ||
		!strings.Contains(err.Error(), saved) || !strings.Contains(err.Error(), appsession.DefaultScratchpadShortcut) {
		t.Fatalf("both conflicting bindings should be reported: %v", err)
	}
	if got := service.recent.GetScratchpadShortcut(); got != saved {
		t.Fatalf("failed initialization changed saved shortcut to %q", got)
	}
	if err := app.GlobalShortcut.Unregister(saved); err != nil {
		t.Fatal(err)
	}
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatalf("initialization could not recover after conflict was removed: %v", err)
	}
	if got := service.GetScratchpadShortcut(); got != saved {
		t.Fatalf("recovered shortcut = %q", got)
	}
}

func TestScratchpadShortcutChangeConflictAndPersistenceRollback(t *testing.T) {
	service, app := newPendingScratchpadShortcutService(t)
	if err := service.InitializeScratchpadShortcut(); err != nil {
		t.Fatal(err)
	}
	current := service.GetScratchpadShortcut()
	const candidate = "Alt+S"
	if err := app.GlobalShortcut.Register(candidate, func() {}); err != nil {
		t.Fatal(err)
	}
	if got, err := service.SetScratchpadShortcut(candidate); err == nil || got != current {
		t.Fatalf("conflicting change = %q, %v", got, err)
	}
	if got := service.recent.GetScratchpadShortcut(); got != current {
		t.Fatalf("conflict changed persisted shortcut to %q", got)
	}
	if err := app.GlobalShortcut.Unregister(candidate); err != nil {
		t.Fatal(err)
	}
	testScratchpadShortcutPersistenceRollback(t, service, app, current, candidate)
}

func testScratchpadShortcutPersistenceRollback(t *testing.T, service *VaultService, app *application.App, current, candidate string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "recent.json")
	service.recent = appsession.NewRecentVaultStore(path)
	if err := service.recent.SetScratchpadShortcut(current); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := service.SetScratchpadShortcut(candidate); err == nil || got != current {
		t.Fatalf("unpersistable change = %q, %v", got, err)
	}
	if app.GlobalShortcut.IsRegistered(candidate) || !app.GlobalShortcut.IsRegistered(current) {
		t.Fatal("persistence failure did not release candidate and retain current binding")
	}
	if got := service.GetScratchpadShortcut(); got != current {
		t.Fatalf("persistence failure changed session shortcut to %q", got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if got, err := service.SetScratchpadShortcut(candidate); err != nil || got != candidate {
		t.Fatalf("retry after repairing persistence = %q, %v", got, err)
	}
	if app.GlobalShortcut.IsRegistered(current) || !app.GlobalShortcut.IsRegistered(candidate) {
		t.Fatal("successful retry did not replace the old binding")
	}
	if got := service.recent.GetScratchpadShortcut(); got != candidate {
		t.Fatalf("successful retry persisted %q", got)
	}
}

func TestScratchpadShortcutRetirementRecovery(t *testing.T) {
	t.Run("restore previous", func(t *testing.T) {
		service, app := newPendingScratchpadShortcutService(t)
		if err := service.InitializeScratchpadShortcut(); err != nil {
			t.Fatal(err)
		}
		current := service.GetScratchpadShortcut()
		if err := app.GlobalShortcut.Unregister(current); err != nil {
			t.Fatal(err)
		}
		testScratchpadShortcutRetirementResult(t, service, app, current)
		if app.GlobalShortcut.IsRegistered("Alt+S") {
			t.Fatal("rollback left candidate registered")
		}
		testScratchpadShortcutReplacementAfterRecovery(t, service, app, current)
	})
	t.Run("retain candidate when restoration conflicts", func(t *testing.T) {
		service, app := newPendingScratchpadShortcutService(t)
		if err := service.InitializeScratchpadShortcut(); err != nil {
			t.Fatal(err)
		}
		// A native retirement failure can leave the previous binding
		// occupied. Restoration must not discard the usable candidate.
		service.scratchpadShortcutRegistration = func() error {
			return errors.New("binding could not be retired")
		}
		testScratchpadShortcutRetirementResult(t, service, app, "Alt+S")
		testScratchpadShortcutReplacementAfterRecovery(t, service, app, "Alt+S")
	})
}

func testScratchpadShortcutRetirementResult(t *testing.T, service *VaultService, app *application.App, want string) {
	t.Helper()
	if got, err := service.SetScratchpadShortcut("Alt+S"); err == nil || got != want {
		t.Fatalf("retirement failure = %q, %v; want %q and error", got, err, want)
	}
	if got := service.GetScratchpadShortcut(); got != want {
		t.Fatalf("effective shortcut = %q, want %q", got, want)
	}
	if got := service.recent.GetScratchpadShortcut(); got != want {
		t.Fatalf("persisted shortcut = %q, want %q", got, want)
	}
	if !app.GlobalShortcut.IsRegistered(want) {
		t.Fatalf("effective shortcut %q is unavailable", want)
	}
}

func testScratchpadShortcutReplacementAfterRecovery(t *testing.T, service *VaultService, app *application.App, previous string) {
	t.Helper()
	// A later change must retire whichever registration recovery kept.
	const next = "Ctrl+Shift+S"
	if got, err := service.SetScratchpadShortcut(next); err != nil || got != next {
		t.Fatalf("change after recovery = %q, %v", got, err)
	}
	if app.GlobalShortcut.IsRegistered(previous) || !app.GlobalShortcut.IsRegistered(next) {
		t.Fatal("recovered registration could not be replaced")
	}
}

func TestScratchpadShortcutTargetResetAndLockedVault(t *testing.T) {
	service := newScratchpadShortcutTestService(t)
	if _, err := service.SetScratchpadShortcutTarget("note:abc"); err == nil {
		t.Fatal("locked vault accepted a target change")
	}
	if _, err := service.store.Create(t.TempDir(), "shortcut target secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetScratchpadShortcutTarget("note:abc"); err != nil {
		t.Fatal(err)
	}
	if got, err := service.SetScratchpadShortcutTarget("   "); err != nil || got != defaultScratchpadShortcutTarget {
		t.Fatalf("reset target = %q, %v", got, err)
	}
	if got := service.GetScratchpadShortcutTarget(); got != defaultScratchpadShortcutTarget {
		t.Fatalf("reset did not restore default target: %q", got)
	}
	settings, err := service.store.GetVaultSettings()
	if err != nil || settings.ScratchpadNoteID != "" {
		t.Fatalf("reset did not clear persisted note target: %q, %v", settings.ScratchpadNoteID, err)
	}
}
