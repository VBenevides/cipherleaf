package main

import "testing"

func TestClearClipboardIfUnchanged(t *testing.T) {
	value := "vault-secret"
	clearClipboardIfUnchanged(
		value,
		func() (string, bool) { return value, true },
		func(next string) bool {
			value = next
			return true
		},
	)
	if value != "" {
		t.Fatalf("clipboard value = %q, want cleared", value)
	}

	value = "new user value"
	clearClipboardIfUnchanged(
		"vault-secret",
		func() (string, bool) { return value, true },
		func(next string) bool {
			value = next
			return true
		},
	)
	if value != "new user value" {
		t.Fatal("clipboard clear overwrote a newer value")
	}
}

func TestSelectClipboardImageType(t *testing.T) {
	if got := selectClipboardImageType("text/plain\nimage/jpeg\nimage/png\n"); got != "image/png" {
		t.Fatalf("selected MIME type = %q, want image/png", got)
	}
	if got := selectClipboardImageType("text/plain\ntext/html\n"); got != "" {
		t.Fatalf("selected non-image MIME type %q", got)
	}
}
