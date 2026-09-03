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
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		window.EmitEvent("cipherleaf:close-requested")
	})
	requestVaultLock := func(*application.ApplicationEvent) {
		window.EmitEvent("cipherleaf:system-lock-requested")
	}
	app.Event.OnApplicationEvent(events.Common.SystemWillSleep, requestVaultLock)
	app.Event.OnApplicationEvent(events.Common.ScreenLocked, requestVaultLock)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
