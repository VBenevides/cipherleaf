package main

import (
	"embed"
	"fmt"
	"log"
	"strings"

	cipherleafapp "cipherleaf/internal/app"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

//go:embed VERSION
var version string

const scratchpadDefaultWidth = 620

// positionScratchpad places the overlay at the top center of Cipherleaf's
// current display. Wails exposes screen and window geometry in device-
// independent pixels, so the values can be combined directly.
func positionScratchpad(app *application.App, mainWindow, scratchpad *application.WebviewWindow) {
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

func main() {
	appTitle := fmt.Sprintf("Cipherleaf - v%s", strings.TrimSpace(version))
	vaultService := cipherleafapp.NewVaultService()
	app := application.New(application.Options{
		Name:        appTitle,
		Description: "Note taking app with encryption",
		Services: []application.Service{
			application.NewService(vaultService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	vaultService.SetApp(app)

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     appTitle,
		Width:     1280,
		Height:    720,
		MinWidth:  620,
		MinHeight: 620,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(20, 20, 24),
		URL:              "/",
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionClipboardRead: application.PermissionAllow,
		},
	})
	scratchpad := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "scratchpad",
		Title:            "Cipherleaf Scratchpad",
		Width:            scratchpadDefaultWidth,
		Height:           600,
		MinHeight:        240,
		AlwaysOnTop:      true,
		Frameless:        true,
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		InitialPosition:  application.WindowXY,
		X:                0,
		Y:                0,
		Hidden:           true,
		URL:              "/?window=scratchpad",
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionClipboardRead: application.PermissionAllow,
		},
	})
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		scratchpad.Hide()
		event.Cancel()
		window.EmitEvent("cipherleaf:close-requested")
	})
	requestVaultLock := func(*application.ApplicationEvent) {
		scratchpad.Hide()
		window.EmitEvent("cipherleaf:system-lock-requested")
	}
	app.Event.OnApplicationEvent(events.Common.SystemWillSleep, requestVaultLock)
	app.Event.OnApplicationEvent(events.Common.ScreenLocked, requestVaultLock)

	const scratchpadShortcut = "Ctrl+F12"
	if err := app.GlobalShortcut.Register(scratchpadShortcut, func() {
		mainWindowActive := window.IsFocused() && window.IsVisible()
		if scratchpad.IsVisible() {
			scratchpad.Hide()
			if mainWindowActive {
				window.EmitEvent("cipherleaf:scratchpad-focus")
			}
		} else if mainWindowActive {
			window.EmitEvent("cipherleaf:scratchpad-focus")
		} else if vaultService.GetSession().Locked {
			scratchpad.Hide()
			window.Show()
			window.Focus()
		} else {
			positionScratchpad(app, window, scratchpad)
			scratchpad.Show()
			scratchpad.Focus()
		}
	}); err != nil {
		log.Printf("failed to register scratchpad global shortcut: %v", err)
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
