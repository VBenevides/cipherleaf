package app

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"testing"
)

type targetTestWindow struct {
	application.Window
	visible, focused    bool
	events              []string
	screen              *application.Screen
	width, height, x, y int
}

func (w *targetTestWindow) IsVisible() bool          { return w.visible }
func (w *targetTestWindow) IsFocused() bool          { return w.focused }
func (w *targetTestWindow) Show() application.Window { w.visible = true; return w }
func (w *targetTestWindow) Focus()                   { w.focused = true }
func (w *targetTestWindow) EmitEvent(name string, _ ...any) bool {
	w.events = append(w.events, name)
	return true
}
func (w *targetTestWindow) GetScreen() (*application.Screen, error) { return w.screen, nil }
func (w *targetTestWindow) Size() (int, int)                        { return w.width, w.height }
func (w *targetTestWindow) SetSize(width, height int) application.Window {
	w.width, w.height = width, height
	return w
}
func (w *targetTestWindow) SetPosition(x, y int) { w.x, w.y = x, y }

func TestScratchpadTargetWindowRouting(t *testing.T) {
	service := newScratchpadShortcutTestService(t)
	main := &targetTestWindow{screen: &application.Screen{Bounds: application.Rect{X: 100, Y: 50, Width: 1000, Height: 800}}}
	overlay := &targetTestWindow{}
	service.toggleScratchpadForTarget(nil, main, overlay)
	if !main.visible || !main.focused || overlay.visible {
		t.Fatal("locked target must focus the main window only")
	}
	if _, err := service.store.Create(t.TempDir(), "target window secret"); err != nil {
		t.Fatal(err)
	}
	service.toggleScratchpadForTarget(nil, main, overlay)
	if len(main.events) != 1 || main.events[0] != scratchpadFocusEvent || overlay.visible {
		t.Fatal("active main window must receive target focus")
	}
	service.toggleDefaultScratchpad(nil, main, overlay)
	if len(main.events) != 2 || main.events[1] != scratchpadFocusEvent || overlay.visible {
		t.Fatal("default shortcut must focus Scratchpad in the active main window")
	}
	main.focused = false
	service.toggleScratchpadForTarget(nil, main, overlay)
	if !overlay.visible || !overlay.focused || overlay.width != 800 || overlay.height != 600 || overlay.x != 200 || overlay.y != 50 {
		t.Fatalf("overlay placement: %+v", overlay)
	}
	if len(overlay.events) != 1 || overlay.events[0] != "cipherleaf:scratchpad-overlay-refresh" {
		t.Fatal("overlay must refresh its target")
	}
	overlay.height = 300
	positionScratchpad(nil, main, overlay)
	if overlay.height != 300 {
		t.Fatal("positioning must preserve existing height")
	}
}
