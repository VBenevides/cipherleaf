package app

import (
	"errors"
	"fmt"
	"log"
	"strings"

	appsession "cipherleaf/internal/session"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	mainWindowName       = "main"
	scratchpadWindowName = "scratchpad"
)

func registerWailsScratchpadShortcut(app *application.App, shortcut string, callback func()) (func() error, error) {
	if err := app.GlobalShortcut.Register(shortcut, callback); err != nil {
		return nil, err
	}
	return func() error { return app.GlobalShortcut.Unregister(shortcut) }, nil
}

// GetScratchpadShortcut returns the saved application-wide Scratchpad shortcut.
func (s *VaultService) GetScratchpadShortcut() string {
	s.scratchpadShortcutMu.Lock()
	defer s.scratchpadShortcutMu.Unlock()
	if s.scratchpadShortcutInitialized {
		return s.scratchpadShortcut
	}
	return s.recent.GetScratchpadShortcut()
}

// InitializeScratchpadShortcut registers the saved Scratchpad shortcut after
// the application starts. A rejected custom shortcut falls back to the default.
func (s *VaultService) InitializeScratchpadShortcut() error {
	s.scratchpadShortcutMu.Lock()
	defer s.scratchpadShortcutMu.Unlock()
	if s.scratchpadShortcutInitialized {
		return nil
	}

	app := s.application()
	if app == nil || app.GlobalShortcut == nil {
		return errors.New("application global shortcuts are unavailable")
	}
	scratchpad, _ := app.Window.GetByName(scratchpadWindowName)
	if err := disableScratchpadWindowTransitions(scratchpad); err != nil {
		log.Printf("failed to disable Scratchpad window transitions: %v", err)
	}
	candidate := s.recent.GetScratchpadShortcut()
	if strings.TrimSpace(candidate) == "" {
		candidate = appsession.DefaultScratchpadShortcut
	}
	register := func(shortcut string) (func() error, error) {
		return registerScratchpadShortcut(app, shortcut, s.toggleScratchpad)
	}
	registration, err := register(candidate)
	if err != nil {
		if candidate == appsession.DefaultScratchpadShortcut {
			return fmt.Errorf("register Scratchpad shortcut %q: %w", candidate, err)
		}
		var fallbackErr error
		registration, fallbackErr = register(appsession.DefaultScratchpadShortcut)
		if fallbackErr != nil {
			return fmt.Errorf("register Scratchpad shortcut %q: %v; register default %q: %w", candidate, err, appsession.DefaultScratchpadShortcut, fallbackErr)
		}
		log.Printf("failed to register saved Scratchpad shortcut %q; using default %q: %v", candidate, appsession.DefaultScratchpadShortcut, err)
		candidate = appsession.DefaultScratchpadShortcut
	}
	s.scratchpadShortcutRegistration = registration
	if err := s.recent.SetScratchpadShortcut(candidate); err != nil {
		s.scratchpadShortcut = candidate
		s.scratchpadShortcutInitialized = true
		log.Printf("failed to persist Scratchpad shortcut %q; keeping the registered shortcut for this session: %v", candidate, err)
		return nil
	}
	s.scratchpadShortcut = candidate
	s.scratchpadShortcutInitialized = true
	return nil
}

// HideScratchpad hides the Scratchpad window synchronously.
func (s *VaultService) HideScratchpad() error {
	app := s.application()
	if app == nil {
		return errors.New("application is unavailable")
	}
	scratchpad, ok := app.Window.GetByName(scratchpadWindowName)
	if !ok || scratchpad == nil {
		return errors.New("Scratchpad window is unavailable")
	}
	hideScratchpadWindow(scratchpad)
	return nil
}

// SetScratchpadShortcut changes the registered and persisted application-wide
// Scratchpad shortcut as one serialized transaction.
func (s *VaultService) SetScratchpadShortcut(shortcut string) (string, error) {
	s.scratchpadShortcutMu.Lock()
	defer s.scratchpadShortcutMu.Unlock()

	if !s.scratchpadShortcutInitialized {
		return "", errors.New("Scratchpad shortcut is not initialized")
	}
	shortcut = strings.TrimSpace(shortcut)
	current := s.scratchpadShortcut
	if shortcut == current {
		return current, nil
	}
	app := s.application()
	if app == nil || app.GlobalShortcut == nil {
		return current, errors.New("application global shortcuts are unavailable")
	}
	registration, err := registerScratchpadShortcut(app, shortcut, s.toggleScratchpad)
	if err != nil {
		return current, fmt.Errorf("register Scratchpad shortcut %q: %w", shortcut, err)
	}
	if err := s.recent.SetScratchpadShortcut(shortcut); err != nil {
		cleanupErr := registration()
		if cleanupErr != nil {
			return current, fmt.Errorf("persist Scratchpad shortcut: %v; cleanup candidate: %w", err, cleanupErr)
		}
		return current, fmt.Errorf("persist Scratchpad shortcut: %w", err)
	}
	if s.scratchpadShortcutRegistration != nil {
		if err := s.scratchpadShortcutRegistration(); err != nil {
			restoreRegistration, restoreErr := registerScratchpadShortcut(app, current, s.toggleScratchpad)
			if restoreErr == nil {
				s.scratchpadShortcutRegistration = restoreRegistration
				restorePersistenceErr := s.recent.SetScratchpadShortcut(current)
				cleanupErr := registration()
				if restorePersistenceErr != nil || cleanupErr != nil {
					return current, fmt.Errorf("retire previous Scratchpad shortcut: %v; restore persistence: %v; cleanup candidate: %v", err, restorePersistenceErr, cleanupErr)
				}
				return current, fmt.Errorf("retire previous Scratchpad shortcut: %w", err)
			}
			s.scratchpadShortcut = shortcut
			s.scratchpadShortcutRegistration = registration
			return shortcut, fmt.Errorf("retire previous Scratchpad shortcut: %v; restore old binding: %v; keeping candidate %q", err, restoreErr, shortcut)
		}
	}
	s.scratchpadShortcut = shortcut
	s.scratchpadShortcutRegistration = registration
	return shortcut, nil
}

func (s *VaultService) application() *application.App {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.app
}

func (s *VaultService) toggleScratchpad() {
	app := s.application()
	if app == nil {
		return
	}
	mainWindow, mainOK := app.Window.GetByName(mainWindowName)
	scratchpad, scratchpadOK := app.Window.GetByName(scratchpadWindowName)
	if !mainOK || !scratchpadOK {
		return
	}

	mainWindowActive := mainWindow.IsFocused() && mainWindow.IsVisible()
	if scratchpad.IsVisible() {
		hideScratchpadWindow(scratchpad)
		if mainWindowActive {
			mainWindow.EmitEvent("cipherleaf:scratchpad-focus")
		}
	} else if mainWindowActive {
		mainWindow.EmitEvent("cipherleaf:scratchpad-focus")
	} else if s.GetSession().Locked {
		hideScratchpadWindow(scratchpad)
		mainWindow.Show()
		mainWindow.Focus()
	} else {
		positionScratchpad(app, mainWindow, scratchpad)
		scratchpad.Show()
		scratchpad.Focus()
	}
}

func hideScratchpadWindow(window application.Window) {
	if window == nil {
		return
	}
	application.InvokeSync(func() {
		hideScratchpadWindowImmediately(window)
		window.Hide()
	})
}

func positionScratchpad(app *application.App, mainWindow, scratchpad application.Window) {
	screen, err := mainWindow.GetScreen()
	if err != nil || screen == nil {
		screen = app.Screen.GetPrimary()
	}
	if screen == nil {
		screen, _ = scratchpad.GetScreen()
	}
	if screen == nil || screen.Bounds.Width <= 0 {
		return
	}

	width := screen.Bounds.Width * 4 / 5
	_, height := scratchpad.Size()
	if height <= 0 {
		height = 600
	}
	scratchpad.SetSize(width, height)
	scratchpad.SetPosition(screen.Bounds.X+(screen.Bounds.Width-width)/2, screen.Bounds.Y)
}
