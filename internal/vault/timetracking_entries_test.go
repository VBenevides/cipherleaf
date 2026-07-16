package vault

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestTimeEntryStartReopenAndFinish(t *testing.T) {
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	client, err := store.CreateClient("Client")
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject("Project", client.ID)
	if err != nil {
		t.Fatal(err)
	}
	tag, err := store.CreateTag("Tag")
	if err != nil {
		t.Fatal(err)
	}
	setTrackingTestNow(store, "2026-07-16T10:00:00Z")
	entry, err := store.StartTimeEntry("  Review  ", project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	if entry.Name != "Review" || entry.ClientID != client.ID || entry.EndedAtUTC != "" || entry.Revision != 1 {
		t.Fatalf("unexpected active entry: %#v", entry)
	}
	if _, err := store.StartTimeEntry("Second", "", nil); err == nil {
		t.Fatal("second active entry was accepted")
	}
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	active, err := store.GetActiveTimeEntry()
	if err != nil || active == nil || active.ID != entry.ID {
		t.Fatalf("active entry was not restored: %#v, %v", active, err)
	}
	setTrackingTestNow(store, "2026-07-16T11:30:00Z")
	finished, err := store.FinishActiveTimeEntry()
	if err != nil {
		t.Fatal(err)
	}
	if finished.EndedAtUTC != "2026-07-16T11:30:00Z" || finished.Revision != 2 {
		t.Fatalf("unexpected finished entry: %#v", finished)
	}
	active, err = store.GetActiveTimeEntry()
	if err != nil || active != nil {
		t.Fatalf("finished entry remained active: %#v, %v", active, err)
	}
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	stored, _, err := store.findTimeTrackingEntryLocked(entry.ID)
	store.mu.Unlock()
	if err != nil || len(stored.Entries) != 1 || stored.Entries[0].EndedAtUTC == "" {
		t.Fatalf("finished entry was not persisted: %#v, %v", stored, err)
	}
}

func TestTimeEntryValidationCorrectionAndDeletion(t *testing.T) {
	store, root := newTrackingTestStore(t)
	project, _ := store.CreateProject("Project")
	tag, _ := store.CreateTag("Tag")
	if _, err := store.StartTimeEntry("Missing", strings.Repeat("f", 32), nil); err == nil {
		t.Fatal("missing project reference was accepted")
	}
	if _, err := store.StartTimeEntry("Duplicate tags", project.ID, []string{tag.ID, tag.ID}); err == nil {
		t.Fatal("duplicate tag reference was accepted")
	}

	first := createCompletedTrackingEntry(t, store, "First", project.ID, []string{tag.ID}, "2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z")
	second := createCompletedTrackingEntry(t, store, "Second", "", nil, "2026-07-10T12:00:00Z", "2026-07-10T13:00:00Z")
	if _, err := store.UpdateTimeEntry(second.ID, "Second", "", nil, "2026-07-10T10:30:00Z", "2026-07-10T12:30:00Z"); err == nil {
		t.Fatal("overlapping correction was accepted")
	}
	if _, err := store.UpdateTimeEntry(second.ID, "Second", "", nil, "2026-07-10T14:00:00Z", "2026-07-10T14:00:00Z"); err == nil {
		t.Fatal("zero-duration correction was accepted")
	}
	if _, err := store.ArchiveProject(project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveTag(tag.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartTimeEntry("Archived", project.ID, []string{tag.ID}); err == nil {
		t.Fatal("archived references were accepted for a new entry")
	}
	corrected, err := store.UpdateTimeEntry(first.ID, "Corrected", project.ID, []string{tag.ID}, "2026-06-30T22:00:00Z", "2026-06-30T23:00:00Z")
	if err != nil {
		t.Fatal("historical archived references should remain valid:", err)
	}
	if corrected.Revision != 3 || corrected.Name != "Corrected" {
		t.Fatalf("unexpected correction: %#v", corrected)
	}
	store.mu.Lock()
	movedBucket, _, err := store.findTimeTrackingEntryLocked(first.ID)
	store.mu.Unlock()
	if err != nil || movedBucket.ID == "" || movedBucket.Entries[0].StartedAtUTC != "2026-06-30T22:00:00Z" {
		t.Fatalf("cross-month correction was not persisted: %#v, %v", movedBucket, err)
	}
	if err := store.DeleteTimeEntry(first.ID); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	if _, _, err := store.findTimeTrackingEntryLocked(first.ID); err == nil {
		store.mu.Unlock()
		t.Fatal("deleted entry remained live")
	}
	deleted := slicesCloneTombstones(store.timeTrackingCatalog.DeletedEntries)
	store.mu.Unlock()
	if len(deleted) != 1 || deleted[0].ID != first.ID || deleted[0].Revision != corrected.Revision+1 {
		t.Fatalf("unexpected deletion tombstone: %#v", deleted)
	}
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, _, err := store.findTimeTrackingEntryLocked(first.ID); err == nil || len(store.timeTrackingCatalog.DeletedEntries) != 1 {
		t.Fatal("deletion did not survive reopen")
	}
}

func TestTimeEntryInvalidFinishAndWriteRollback(t *testing.T) {
	store, root := newTrackingTestStore(t)
	setTrackingTestNow(store, "2026-07-16T10:00:00Z")
	entry, err := store.StartTimeEntry("Running", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.FinishActiveTimeEntry(); err == nil {
		t.Fatal("finish at the start instant was accepted")
	}
	if err := store.DeleteTimeEntry(entry.ID); err == nil {
		t.Fatal("active entry deletion was accepted")
	}
	if _, err := store.UpdateTimeEntry(entry.ID, "Running", "", nil, entry.StartedAtUTC, "2026-07-16T11:00:00Z"); err == nil {
		t.Fatal("active entry correction was accepted")
	}
	setTrackingTestNow(store, "2026-07-16T11:00:00Z")
	store.mu.Lock()
	store.timeTrackingWriteHook = func(kind, _ string) error {
		if kind == "catalog" {
			return errors.New("injected catalog failure")
		}
		return nil
	}
	store.mu.Unlock()
	if _, err := store.FinishActiveTimeEntry(); err == nil {
		t.Fatal("finish unexpectedly survived injected failure")
	}
	active, err := store.GetActiveTimeEntry()
	if err != nil || active == nil || active.ID != entry.ID || active.EndedAtUTC != "" || active.Revision != 1 {
		t.Fatalf("failed finish changed memory: %#v, %v", active, err)
	}
	store.mu.Lock()
	store.timeTrackingWriteHook = nil
	store.mu.Unlock()
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	active, err = store.GetActiveTimeEntry()
	if err != nil || active == nil || active.EndedAtUTC != "" || active.Revision != 1 {
		t.Fatalf("failed finish changed disk: %#v, %v", active, err)
	}
}

func createCompletedTrackingEntry(t *testing.T, store *Store, name, projectID string, tagIDs []string, start, end string) TimeEntry {
	t.Helper()
	setTrackingTestNow(store, start)
	entry, err := store.StartTimeEntry(name, projectID, tagIDs)
	if err != nil {
		t.Fatal(err)
	}
	setTrackingTestNow(store, end)
	entry, err = store.FinishActiveTimeEntry()
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func setTrackingTestNow(store *Store, value string) {
	instant := time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		instant = parsed
	}
	store.mu.Lock()
	store.timeTrackingNow = func() time.Time { return instant }
	store.mu.Unlock()
}

func slicesCloneTombstones(values []Tombstone) []Tombstone {
	return append([]Tombstone(nil), values...)
}
