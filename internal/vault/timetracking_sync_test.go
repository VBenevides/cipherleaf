package vault

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTrackingMergeCombinesIndependentChanges(t *testing.T) {
	first, root := newTrackingTestStore(t)
	second := cloneTrackingTestStore(t, root)
	if _, err := first.CreateProject("Local Project"); err != nil {
		t.Fatal(err)
	}
	if _, err := second.CreateTag("Remote Tag"); err != nil {
		t.Fatal(err)
	}
	if _, err := second.CreateClient("Remote Client"); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := second.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	result, err := first.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	if result.UpToDate || len(result.TrackingConflicts) != 0 {
		t.Fatalf("unexpected merge result: %#v", result)
	}
	catalog, _ := first.GetTimeTrackingCatalog()
	if len(catalog.Clients) != 1 || len(catalog.Projects) != 1 || len(catalog.Tags) != 1 {
		t.Fatalf("independent changes were lost: %#v", catalog)
	}
}

func TestTrackingMergePreservesEditAndInvariantConflicts(t *testing.T) {
	first, root := newTrackingTestStore(t)
	project, _ := first.CreateProject("Base")
	entry := createCompletedTrackingEntry(t, first, "Base Entry", project.ID, nil, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z")
	second := cloneTrackingTestStore(t, root)
	if _, err := first.RenameProject(project.ID, "Local Name"); err != nil {
		t.Fatal(err)
	}
	if _, err := second.RenameProject(project.ID, "Remote Name"); err != nil {
		t.Fatal(err)
	}
	if _, err := first.UpdateTimeEntry(entry.ID, "Local Entry", project.ID, nil, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := second.UpdateTimeEntry(entry.ID, "Remote Entry", project.ID, nil, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z"); err != nil {
		t.Fatal(err)
	}
	createCompletedTrackingEntry(t, first, "Local Extra", "", nil, "2026-07-12T10:00:00Z", "2026-07-12T12:00:00Z")
	createCompletedTrackingEntry(t, second, "Remote Extra", "", nil, "2026-07-12T11:00:00Z", "2026-07-12T13:00:00Z")
	setTrackingTestNow(first, "2026-07-11T10:00:00Z")
	if _, err := first.StartTimeEntry("Local Running", "", nil); err != nil {
		t.Fatal(err)
	}
	setTrackingTestNow(second, "2026-07-11T11:00:00Z")
	if _, err := second.StartTimeEntry("Remote Running", "", nil); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := second.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	result, err := first.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	kinds := make(map[TimeTrackingConflictKind]bool)
	for _, conflict := range result.TrackingConflicts {
		kinds[conflict.Kind] = true
	}
	for _, kind := range []TimeTrackingConflictKind{TimeProjectRenameConflict, TimeEntryEditConflict, TimeActiveEntriesConflict} {
		if !kinds[kind] {
			t.Fatalf("missing conflict %q: %#v", kind, result.TrackingConflicts)
		}
	}
	first.mu.Lock()
	if len(first.timeTrackingCatalog.Conflicts) < 3 {
		first.mu.Unlock()
		t.Fatal("tracking conflicts were not persisted")
	}
	first.mu.Unlock()
	if err := first.ExportRemoteSnapshot(t.TempDir()); err == nil {
		t.Fatal("unresolved tracking conflicts did not block export")
	}
	conflicts, err := first.ListTimeTrackingConflicts()
	if err != nil {
		t.Fatal(err)
	}
	for _, conflict := range conflicts {
		if err := first.ResolveTimeTrackingConflict(conflict.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := first.ExportRemoteSnapshot(t.TempDir()); err != nil {
		t.Fatal("resolved tracking conflicts still blocked export:", err)
	}
}

func TestTrackingMergeDoesNotResurrectDeletedEntry(t *testing.T) {
	first, root := newTrackingTestStore(t)
	entry := createCompletedTrackingEntry(t, first, "Delete", "", nil, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z")
	second := cloneTrackingTestStore(t, root)
	if err := first.DeleteTimeEntry(entry.ID); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := second.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if _, err := first.MergeRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	if _, _, err := first.findTimeTrackingEntryLocked(entry.ID); err == nil {
		t.Fatal("stale remote entry was resurrected")
	}
}

func TestTrackingSnapshotValidationRejectsDamageBeforeMutation(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	if _, err := store.CreateProject("Stable"); err != nil {
		t.Fatal(err)
	}
	createCompletedTrackingEntry(t, store, "Stable Entry", "", nil, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z")
	remote := t.TempDir()
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	before, _ := store.SnapshotRevision()
	inventoryPath := filepath.Join(remote, syncDirectory, syncTrackingFile)
	store.mu.Lock()
	plaintext, err := store.readEnvelopeFileLocked(inventoryPath, "sync-tracking", "sync-tracking")
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	var inventory remoteTrackingInventory
	if err := json.Unmarshal(plaintext, &inventory); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	inventory.Buckets = append(inventory.Buckets, inventory.Buckets...)
	damaged, _ := json.Marshal(inventory)
	if err := store.writeEnvelopeLocked(inventoryPath, "sync-tracking", "sync-tracking", damaged); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()
	if _, err := store.MergeRemoteSnapshot(remote); err == nil {
		t.Fatal("duplicate remote tracking inventory was accepted")
	}
	after, _ := store.SnapshotRevision()
	if after != before {
		t.Fatal("failed remote validation mutated the local vault")
	}

	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	unknownID := "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	unknown := filepath.Join(remote, trackingDirectory, trackingObjectsDirectory, unknownID[:2], unknownID+".enc")
	if err := os.MkdirAll(filepath.Dir(unknown), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unknown, []byte("unknown"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MergeRemoteSnapshot(remote); err == nil {
		t.Fatal("unknown remote tracking file was accepted")
	}

	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	bucketID := store.timeTrackingCatalog.Buckets[0].ID
	store.mu.Unlock()
	bucketPath := filepath.Join(remote, trackingDirectory, trackingObjectsDirectory, bucketID[:2], bucketID+".enc")
	if err := os.Remove(bucketPath); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MergeRemoteSnapshot(remote); err == nil {
		t.Fatal("missing remote tracking bucket was accepted")
	}

	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	catalogData, err := os.ReadFile(filepath.Join(remote, trackingDirectory, trackingCatalogFilename))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bucketPath, catalogData, 0o600); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	plaintext, _ = store.readEnvelopeFileLocked(inventoryPath, "sync-tracking", "sync-tracking")
	if err := json.Unmarshal(plaintext, &inventory); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	inventory.Buckets[0].CiphertextHash = ciphertextHash(catalogData)
	damaged, _ = json.Marshal(inventory)
	if err := store.writeEnvelopeLocked(inventoryPath, "sync-tracking", "sync-tracking", damaged); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()
	if _, err := store.MergeRemoteSnapshot(remote); err == nil {
		t.Fatal("tracking catalog envelope authenticated as a bucket")
	}
}

func TestTrackingMergeWriteFailureRollsBackBuckets(t *testing.T) {
	first, root := newTrackingTestStore(t)
	second := cloneTrackingTestStore(t, root)
	local := createCompletedTrackingEntry(t, first, "Local", "", nil, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z")
	remoteEntry := createCompletedTrackingEntry(t, second, "Remote", "", nil, "2026-07-10T12:00:00Z", "2026-07-10T13:00:00Z")
	remote := t.TempDir()
	if err := second.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	first.mu.Lock()
	first.timeTrackingWriteHook = func(kind, _ string) error {
		if kind == "catalog" {
			return os.ErrPermission
		}
		return nil
	}
	first.mu.Unlock()
	if _, err := first.MergeRemoteSnapshot(remote); err == nil {
		t.Fatal("merge unexpectedly survived catalog write failure")
	}
	first.mu.Lock()
	first.timeTrackingWriteHook = nil
	if _, _, err := first.findTimeTrackingEntryLocked(local.ID); err != nil {
		first.mu.Unlock()
		t.Fatal("local entry was lost during rollback:", err)
	}
	if _, _, err := first.findTimeTrackingEntryLocked(remoteEntry.ID); err == nil {
		first.mu.Unlock()
		t.Fatal("failed merge left the remote entry live")
	}
	first.mu.Unlock()
}

func TestRestoreRemoteSnapshotRestoresNotesAndTracking(t *testing.T) {
	source, _ := newTrackingTestStore(t)
	note, err := source.CreateNote("Restored Note")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.SaveNote(note.ID, note.Title, "restored content"); err != nil {
		t.Fatal(err)
	}
	project, _ := source.CreateProject("Restored Project")
	tag, _ := source.CreateTag("Restored Tag")
	deleted := createCompletedTrackingEntry(t, source, "Deleted", project.ID, []string{tag.ID}, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z")
	if err := source.DeleteTimeEntry(deleted.ID); err != nil {
		t.Fatal(err)
	}
	setTrackingTestNow(source, "2026-07-11T10:00:00Z")
	active, err := source.StartTimeEntry("Restored Running", project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := source.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	restored := NewStore()
	if _, err := restored.RestoreRemoteSnapshot(remote, t.TempDir(), "Restored", "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	restoredNote, err := restored.GetNote(note.ID)
	if err != nil || restoredNote.Content != "restored content" {
		t.Fatalf("note was not restored with tracking: %#v, %v", restoredNote, err)
	}
	catalog, err := restored.GetTimeTrackingCatalog()
	if err != nil || len(catalog.Projects) != 1 || len(catalog.Tags) != 1 {
		t.Fatalf("tracking labels were not restored: %#v, %v", catalog, err)
	}
	restoredActive, err := restored.GetActiveTimeEntry()
	if err != nil || restoredActive == nil || restoredActive.ID != active.ID {
		t.Fatalf("active entry was not restored: %#v, %v", restoredActive, err)
	}
	restored.mu.Lock()
	defer restored.mu.Unlock()
	if len(restored.timeTrackingCatalog.DeletedEntries) != 1 || restored.timeTrackingCatalog.DeletedEntries[0].ID != deleted.ID {
		t.Fatalf("tracking tombstone was not restored: %#v", restored.timeTrackingCatalog.DeletedEntries)
	}
}

func cloneTrackingTestStore(t *testing.T, source string) *Store {
	t.Helper()
	target := t.TempDir()
	if err := copyAttachmentDirectory(source, target); err != nil {
		t.Fatal(err)
	}
	store := NewStore()
	if _, err := store.Open(target, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	return store
}
