//go:build !windows

package app

import "github.com/wailsapp/wails/v3/pkg/application"

func disableScratchpadWindowTransitions(window application.Window) error {
	return nil
}

func hideScratchpadWindowImmediately(window application.Window) {
	// Other platforms have no native transition override; window.Hide below performs the hide.
}
