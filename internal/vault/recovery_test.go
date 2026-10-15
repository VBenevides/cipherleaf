package vault

import (
	"encoding/json"
	"errors"
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

func TestNoteHistoryDeduplicatesContentAndUsesConfiguredLimit(t *testing.T) {
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
	if _, err := store.SaveVaultSettings(VaultSettings{FileHistoryLimit: 3}); err != nil {
		t.Fatal(err)
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
	if len(versions) != 3 {
		t.Fatalf("history count = %d, want 3", len(versions))
	}
	entries, err := os.ReadDir(filepath.Join(store.root, historyDirectory, note.ID))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".bak") {
			t.Fatalf("history contains redundant backup %q", entry.Name())
		}
	}
}

func TestCleanHistoryPrunesEveryFileAndBackups(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "history-clean-secret"); err != nil {
		t.Fatal(err)
	}
	notes := make([]Note, 2)
	for index := range notes {
		note, err := store.CreateNote(fmt.Sprintf("File %d", index))
		if err != nil {
			t.Fatal(err)
		}
		for revision := range 6 {
			note, err = store.SaveNote(note.ID, note.Title, fmt.Sprintf("version %d", revision))
			if err != nil {
				t.Fatal(err)
			}
		}
		notes[index] = note
	}
	if _, err := store.SaveVaultSettings(VaultSettings{FileHistoryLimit: 3}); err != nil {
		t.Fatal(err)
	}
	historyRoot := filepath.Join(store.root, historyDirectory)
	if err := os.WriteFile(filepath.Join(historyRoot, "orphan.bak"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, note := range notes {
		if err := os.WriteFile(store.historyPathLocked(note.ID, 1)+".bak", []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.CleanHistory(); err != nil {
		t.Fatal(err)
	}
	for _, note := range notes {
		versions, err := store.ListNoteVersions(note.ID)
		if err != nil || len(versions) != 3 {
			t.Fatalf("history count = %d, %v; want 3", len(versions), err)
		}
	}
	if err := filepath.WalkDir(historyRoot, func(path string, entry os.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(entry.Name(), ".bak") {
			t.Fatalf("history contains redundant backup %q", path)
		}
		return err
	}); err != nil {
		t.Fatal(err)
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

func TestTrashRestoreRequiresAccessibleParents(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "restore-parent-secret"); err != nil {
		t.Fatal(err)
	}
	parent, err := store.CreateFolder("Parent")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Note", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(parent.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.RestoreTrashItem("note", note.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("restoring note without its folder = %v, want ErrFolderLocked", err)
	}

	store.mu.RLock()
	cycle := map[string]trashedFolder{
		"a": {Folder: Folder{ID: "a", ParentID: "b"}},
		"b": {Folder: Folder{ID: "b", ParentID: "a"}},
	}
	cycleErr := store.requireTrashFolderAccessibleLocked("a", cycle, make(map[string]struct{}))
	store.mu.RUnlock()
	if !errors.Is(cycleErr, ErrFolderLocked) {
		t.Fatalf("cyclic trash folders = %v, want ErrFolderLocked", cycleErr)
	}
}

func TestPermanentTrashDeletionRemovesOrphanedDescendants(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "orphan-test-secret"); err != nil {
		t.Fatal(err)
	}
	parent, err := store.CreateFolder("Parent")
	if err != nil {
		t.Fatal(err)
	}
	child, err := store.CreateFolder("Child", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(child.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(parent.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.PermanentlyDeleteTrashItem("folder", parent.ID); err != nil {
		t.Fatal(err)
	}
	items, err := store.ListTrash()
	if err != nil || len(items) != 1 || items[0].ID != child.ID {
		t.Fatalf("orphaned child trash = %#v, %v", items, err)
	}
	if err := store.PermanentlyDeleteTrashItem("folder", child.ID); err != nil {
		t.Fatal(err)
	}
	if items, err := store.ListTrash(); err != nil || len(items) != 0 {
		t.Fatalf("trash after orphan cleanup = %#v, %v", items, err)
	}
}
