//go:build !linux

package app

import "github.com/wailsapp/wails/v3/pkg/application"

func registerScratchpadShortcut(app *application.App, shortcut string, callback func()) (func() error, error) {
	return registerWailsScratchpadShortcut(app, shortcut, callback)
}
