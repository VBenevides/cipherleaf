//go:build windows

package app

import (
	"fmt"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"
)

func disableScratchpadWindowTransitions(window application.Window) error {
	if window == nil {
		return fmt.Errorf("Scratchpad window is unavailable")
	}
	nativeWindow := window.NativeWindow()
	if nativeWindow == nil {
		return fmt.Errorf("Scratchpad window native handle is unavailable")
	}

	hwnd := w32.HWND(nativeWindow)
	disabled := w32.BOOL(1)
	if hr := w32.DwmSetWindowAttribute(hwnd, w32.DWMWA_TRANSITIONS_FORCEDISABLED, unsafe.Pointer(&disabled), unsafe.Sizeof(disabled)); w32.FAILED(hr) {
		return fmt.Errorf("DwmSetWindowAttribute failed with HRESULT 0x%08x", uint32(hr))
	}
	return nil
}

func hideScratchpadWindowImmediately(window application.Window) {
	if window == nil || window.NativeWindow() == nil {
		return
	}
	w32.SetWindowPos(w32.HWND(window.NativeWindow()), 0, 0, 0, 0, 0, uint(w32.SWP_HIDEWINDOW|w32.SWP_NOMOVE|w32.SWP_NOSIZE|w32.SWP_NOZORDER|w32.SWP_NOACTIVATE))
}
