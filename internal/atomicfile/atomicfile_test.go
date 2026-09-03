package atomicfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteReplacesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "value")
	if err := Write(path, []byte("first"), true); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, []byte("second"), true); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "second" {
		t.Fatalf("ReadFile() = %q, %v", data, err)
	}
}

func TestWriteWithoutDirectorySyncAndMissingParent(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "value")
	if err := Write(path, []byte("no directory sync"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := Write(filepath.Join(root, "missing", "value"), []byte("data"), false); err == nil {
		t.Fatal("expected missing parent error")
	}
}
