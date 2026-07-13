package vault

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrashRestoresNoteAndFolder(t *testing.T) {
	store := NewStore()
	root := t.TempDir()
	if _, err := store.Create(root, "recovery-test-secret"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Archive")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Recover me", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "private recovery content"); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(folder.ID); err != nil {
		t.Fatal(err)
	}
	items, err := store.ListTrash()
	if err != nil || len(items) != 2 {
		t.Fatalf("ListTrash() = %#v, %v", items, err)
	}
	if err := store.RestoreTrashItem("folder", folder.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.RestoreTrashItem("note", note.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := store.GetNote(note.ID)
	if err != nil || restored.Content != "private recovery content" || restored.FolderID != folder.ID {
		t.Fatalf("restored note = %#v, %v", restored, err)
	}
	if items, err := store.ListTrash(); err != nil || len(items) != 0 {
		t.Fatalf("trash after restore = %#v, %v", items, err)
	}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, readErr := os.ReadFile(path)
		if readErr == nil && strings.Contains(string(data), "private recovery content") {
			t.Fatalf("plaintext recovery content leaked into %s", path)
		}
		return readErr
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNoteVersionHistoryRestoresContent(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "history-test-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Versioned")
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.SaveNote(note.ID, "Version one", "first body")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, "Version two", "second body"); err != nil {
		t.Fatal(err)
	}
	versions, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, version := range versions {
		if version.Revision == first.Revision {
			found = true
		}
	}
	if !found {
		t.Fatalf("revision %d missing from %#v", first.Revision, versions)
	}
	restored, err := store.RestoreNoteVersion(note.ID, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Title != "Version one" || restored.Content != "first body" || restored.Revision <= first.Revision {
		t.Fatalf("restored version = %#v", restored)
	}
}

func TestRestoringCurrentVersionDoesNotCreateHistory(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "restore-dedup-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Versioned")
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.SaveNote(note.ID, note.Title, "first body")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "second body"); err != nil {
		t.Fatal(err)
	}
	restored, err := store.RestoreNoteVersion(note.ID, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	again, err := store.RestoreNoteVersion(note.ID, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	after, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.Revision != restored.Revision || len(after) != len(before) {
		t.Fatalf("duplicate restore changed revision/history: revision %d -> %d, history %d -> %d", restored.Revision, again.Revision, len(before), len(after))
	}
}

func TestNoteContentEqualityIgnoresStoredDocumentStructure(t *testing.T) {
	left := canonicalizeNoteContent("# Same note")
	var document canonicalObjectDocument
	if err := json.Unmarshal([]byte(left), &document); err != nil {
		t.Fatal(err)
	}
	document.Objects[0].ID = "different-object-id"
	right, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if !noteContentsEqual(left, string(right)) {
		t.Fatal("equivalent note documents were treated as different content")
	}
}

func TestNoteHistoryDeduplicatesNonAdjacentContent(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "history-non-adjacent-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Versioned")
	if err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"first", "second", "first"} {
		if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
			t.Fatal(err)
		}
	}
	before, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "second"); err != nil {
		t.Fatal(err)
	}
	after, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("non-adjacent duplicate changed history: %d -> %d", len(before), len(after))
	}
}

func TestNoteHistoryDeduplicatesContentAndKeepsTwentyVersions(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "history-retention-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Versioned")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, "First title", "same body"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, "Second title", "same body"); err != nil {
		t.Fatal(err)
	}
	before, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, "Third title", "same body"); err != nil {
		t.Fatal(err)
	}
	after, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("same content created history: before=%d after=%d", len(before), len(after))
	}
	for index := 0; index < 25; index++ {
		current, err := store.GetNote(note.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.SaveNote(note.ID, current.Title, fmt.Sprintf("body %d", index)); err != nil {
			t.Fatal(err)
		}
	}
	versions, err := store.ListNoteVersions(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if maxNoteHistory != 20 {
		t.Fatalf("maxNoteHistory = %d, want 20", maxNoteHistory)
	}
	if len(versions) != maxNoteHistory {
		t.Fatalf("history count = %d, want 20", len(versions))
	}
}

func TestPermanentTrashDeletion(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "delete-test-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Disposable")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.PermanentlyDeleteTrashItem("note", note.ID); err != nil {
		t.Fatal(err)
	}
	if items, err := store.ListTrash(); err != nil || len(items) != 0 {
		t.Fatalf("trash = %#v, %v", items, err)
	}
	if err := store.RestoreTrashItem("note", note.ID); err == nil {
		t.Fatal("restored permanently deleted note")
	}
}
