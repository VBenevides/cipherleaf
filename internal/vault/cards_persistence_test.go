package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStructuredCardDataStaysEncrypted(t *testing.T) {
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "card-persistence-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Private card title")
	if err != nil {
		t.Fatal(err)
	}
	content := "---\ncipherleaf-card: true\ncipherleaf-card-status: not-started\ncipherleaf-card-tags: [\"Work\"]\ncipherleaf-card-created-at: 2026-09-02T00:00:00Z\n---\nPrivate card body"
	if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
		t.Fatal(err)
	}
	store.Lock()
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), "Private card") || strings.Contains(string(data), "cipherleaf-card") {
			t.Errorf("structured card data leaked into %s", path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(root, "card-persistence-secret"); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Content != content {
		t.Fatalf("content = %q, want %q", loaded.Content, content)
	}
}
