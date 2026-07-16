package vault

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestTimeTrackingProjectAndTagCRUD(t *testing.T) {
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject("  Client Work  ")
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "Client Work" || project.Revision != 1 || !hasTimeTrackingCapability(store.manifest) {
		t.Fatalf("unexpected created project: %#v", project)
	}
	assertUTCTrackingTimestamp(t, project.CreatedAtUTC)
	if _, err := store.CreateProject("client work"); err == nil {
		t.Fatal("case-insensitive duplicate project was accepted")
	}
	project, err = store.RenameProject(project.ID, "  Primary Client ")
	if err != nil || project.Name != "Primary Client" || project.Revision != 2 {
		t.Fatalf("unexpected renamed project: %#v, %v", project, err)
	}
	project, err = store.ArchiveProject(project.ID)
	if err != nil || project.ArchivedAtUTC == "" || project.Revision != 3 {
		t.Fatalf("unexpected archived project: %#v, %v", project, err)
	}
	activeProject, err := store.CreateProject("primary client")
	if err != nil {
		t.Fatal("archived project name should be reusable:", err)
	}
	if _, err := store.RestoreProject(project.ID); err == nil {
		t.Fatal("restored project duplicated an active name")
	}
	project, err = store.RenameProject(project.ID, "Historical Client")
	if err != nil {
		t.Fatal(err)
	}
	project, err = store.RestoreProject(project.ID)
	if err != nil || project.ArchivedAtUTC != "" || project.Revision != 5 {
		t.Fatalf("unexpected restored project: %#v, %v", project, err)
	}

	tag, err := store.CreateTag("  Billable  ")
	if err != nil || tag.Name != "Billable" || tag.Revision != 1 {
		t.Fatalf("unexpected created tag: %#v, %v", tag, err)
	}
	if _, err := store.CreateTag("BILLABLE"); err == nil {
		t.Fatal("case-insensitive duplicate tag was accepted")
	}
	tag, err = store.RenameTag(tag.ID, "Customer")
	if err != nil || tag.Revision != 2 {
		t.Fatalf("unexpected renamed tag: %#v, %v", tag, err)
	}
	tag, err = store.ArchiveTag(tag.ID)
	if err != nil || tag.ArchivedAtUTC == "" || tag.Revision != 3 {
		t.Fatalf("unexpected archived tag: %#v, %v", tag, err)
	}
	if _, err := store.RestoreTag(tag.ID); err != nil {
		t.Fatal(err)
	}

	catalog, err := store.GetTimeTrackingCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Projects) != 2 || len(catalog.Tags) != 1 || activeProject.ID == "" {
		t.Fatalf("catalog did not retain active and archived labels: %#v", catalog)
	}
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	catalog, err = store.GetTimeTrackingCatalog()
	if err != nil || len(catalog.Projects) != 2 || catalog.Tags[0].ArchivedAtUTC != "" {
		t.Fatalf("labels did not persist: %#v, %v", catalog, err)
	}
}

func TestTimeTrackingLabelRenamePreservesHistoricalReferences(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	project, err := store.CreateProject("Original Project")
	if err != nil {
		t.Fatal(err)
	}
	tag, err := store.CreateTag("Original Tag")
	if err != nil {
		t.Fatal(err)
	}
	bucketID := strings.Repeat("8", 32)
	entryID := strings.Repeat("9", 32)
	store.mu.Lock()
	bucket := timeTrackingBucket{FormatVersion: 1, ID: bucketID, Entries: []TimeEntry{{
		ID: entryID, Name: "Historical", ProjectID: project.ID, TagIDs: []string{tag.ID},
		StartedAtUTC: "2026-07-01T10:00:00Z", EndedAtUTC: "2026-07-01T11:00:00Z",
		CreatedAtUTC: "2026-07-01T10:00:00Z", UpdatedAtUTC: "2026-07-01T11:00:00Z", Revision: 1,
	}}}
	if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()
	if _, err := store.RenameProject(project.ID, "Renamed Project"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RenameTag(tag.ID, "Renamed Tag"); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	stored, err := store.readTimeTrackingBucketLocked(bucketID)
	store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Entries[0].ProjectID != project.ID || stored.Entries[0].TagIDs[0] != tag.ID {
		t.Fatalf("rename rewrote historical references: %#v", stored.Entries[0])
	}
	catalog, _ := store.GetTimeTrackingCatalog()
	if catalog.Projects[0].Name != "Renamed Project" || catalog.Tags[0].Name != "Renamed Tag" {
		t.Fatalf("historical IDs did not resolve renamed labels: %#v", catalog)
	}
}

func TestTimeTrackingLabelMutationRollsBackAfterWriteFailure(t *testing.T) {
	store, root := newTrackingTestStore(t)
	project, err := store.CreateProject("Stable")
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	beforeRevision := store.timeTrackingCatalog.Revision
	store.timeTrackingWriteHook = func(kind, _ string) error {
		if kind == "catalog" {
			return errors.New("injected catalog failure")
		}
		return nil
	}
	store.mu.Unlock()
	if _, err := store.RenameProject(project.ID, "Lost Rename"); err == nil {
		t.Fatal("rename unexpectedly survived injected failure")
	}
	catalog, err := store.GetTimeTrackingCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Projects[0].Name != "Stable" || catalog.Projects[0].Revision != 1 || store.timeTrackingCatalog.Revision != beforeRevision {
		t.Fatalf("failed mutation changed memory: %#v", catalog)
	}
	store.mu.Lock()
	store.timeTrackingWriteHook = nil
	store.mu.Unlock()
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	catalog, _ = store.GetTimeTrackingCatalog()
	if catalog.Projects[0].Name != "Stable" || catalog.Projects[0].Revision != 1 {
		t.Fatalf("failed mutation changed disk: %#v", catalog)
	}
}

func TestTimeTrackingLabelValidation(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	for _, name := range []string{"", "   ", "bad\nname", strings.Repeat("x", 121)} {
		if _, err := store.CreateProject(name); err == nil {
			t.Fatalf("invalid project name %q was accepted", name)
		}
		if _, err := store.CreateTag(name); err == nil {
			t.Fatalf("invalid tag name %q was accepted", name)
		}
	}
	if _, err := store.RenameProject(strings.Repeat("f", 32), "Missing"); err == nil {
		t.Fatal("missing project rename was accepted")
	}
	if _, err := store.RestoreTag(strings.Repeat("e", 32)); err == nil {
		t.Fatal("missing tag restore was accepted")
	}
}

func assertUTCTrackingTimestamp(t *testing.T, value string) {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || utcOffset(parsed) != 0 {
		t.Fatalf("timestamp is not UTC RFC 3339: %q", value)
	}
}
