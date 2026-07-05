package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	vaultService := NewVaultService()
	app := application.New(application.Options{
		Name:        "Encrypted Markdown Vault",
		Description: "A local-first encrypted Markdown notes application",
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
	vaultService.setApp(app)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Encrypted Markdown Vault",
		Width:     1280,
		Height:    800,
		MinWidth:  920,
		MinHeight: 620,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(20, 20, 24),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
