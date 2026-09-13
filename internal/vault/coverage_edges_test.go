package vault

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoverageStorageEdgeHelpers(t *testing.T) {
	store := NewStore()
	root := t.TempDir()
	if _, err := store.Create(root, "coverage storage secret"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Documents")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Readme", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "body"); err != nil {
		t.Fatal(err)
	}
	if resolved, err := store.ResolveNoteReference("Documents/Readme"); err != nil || resolved.ID != note.ID {
		t.Fatalf("folder note reference = %#v, %v", resolved, err)
	}

	if _, err := store.ListTimeEntries("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", TimeEntryFilters{}); err != nil {
		t.Fatal(err)
	}
	for _, state := range []ScratchpadState{
		{}, {Revision: 1, Content: "content", CaretOffset: 2, ModifiedAt: 1},
	} {
		if err := validateScratchpadState(state); err != nil {
			t.Fatalf("valid scratchpad state rejected: %#v: %v", state, err)
		}
	}
	for _, state := range []ScratchpadState{
		{Revision: 0, Content: "content"},
		{Revision: 1, CaretOffset: -1},
		{Revision: 1, ModifiedAt: -1},
		{Revision: 1, Content: strings.Repeat("x", maxScratchpadBytes+1)},
	} {
		if err := validateScratchpadState(state); err == nil {
			t.Fatalf("invalid scratchpad state accepted: %#v", state)
		}
	}

	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(24 * time.Hour)
	for _, test := range []struct {
		name    string
		summary timeTrackingBucketSummary
		want    bool
		wantErr bool
	}{
		{"month", timeTrackingBucketSummary{MonthUTC: "2026-07"}, true, false},
		{"outside empty", timeTrackingBucketSummary{MonthUTC: "2026-01"}, false, false},
		{"invalid month", timeTrackingBucketSummary{MonthUTC: "bad"}, false, true},
		{"invalid minimum", timeTrackingBucketSummary{MonthUTC: "2026-01", MinStartedAt: "bad"}, false, true},
		{"after range", timeTrackingBucketSummary{MonthUTC: "2026-01", MinStartedAt: "2027-01-01T00:00:00Z"}, false, false},
		{"active", timeTrackingBucketSummary{MonthUTC: "2026-01", MinStartedAt: "2026-01-01T00:00:00Z", HasActiveEntry: true}, true, false},
		{"invalid maximum", timeTrackingBucketSummary{MonthUTC: "2026-01", MinStartedAt: "2026-01-01T00:00:00Z", MaxEndedAt: "bad"}, false, true},
		{"ended outside", timeTrackingBucketSummary{MonthUTC: "2026-01", MinStartedAt: "2026-01-01T00:00:00Z", MaxEndedAt: "2025-12-01T00:00:00Z"}, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := timeTrackingBucketIntersects(test.summary, start, end)
			if got != test.want || (err != nil) != test.wantErr {
				t.Fatalf("intersects = %v, %v; want %v, error=%v", got, err, test.want, test.wantErr)
			}
		})
	}

	compressed, err := compressTimeTrackingPayload([]byte("private tracking payload"))
	if err != nil {
		t.Fatal(err)
	}
	decompressed, err := decompressPayload(compressed, 1024, "coverage")
	if err != nil || !bytes.Equal(decompressed, []byte("private tracking payload")) {
		t.Fatalf("tracking compression round trip = %q, %v", decompressed, err)
	}
	if _, err := decompressPayload([]byte("damaged"), 1024, "coverage"); err == nil {
		t.Fatal("damaged compressed payload accepted")
	}
	var oversized bytes.Buffer
	writer := gzip.NewWriter(&oversized)
	_, _ = writer.Write(bytes.Repeat([]byte("x"), 32))
	_ = writer.Close()
	if _, err := decompressPayload(oversized.Bytes(), 4, "coverage"); err == nil {
		t.Fatal("oversized compressed payload accepted")
	}

	store.mu.Lock()
	emptyRemote := t.TempDir()
	if inventory, trackingRoot, err := store.readRemoteTrackingInventoryLocked(emptyRemote); err != nil || inventory != nil || trackingRoot != filepath.Join(emptyRemote, trackingDirectory) {
		t.Fatalf("empty tracking inventory = %#v, %q, %v", inventory, trackingRoot, err)
	}
	if err := os.Mkdir(filepath.Join(emptyRemote, trackingDirectory), 0o700); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if _, _, err := store.readRemoteTrackingInventoryLocked(emptyRemote); err == nil {
		store.mu.Unlock()
		t.Fatal("tracking folder without inventory accepted")
	}
	store.mu.Unlock()

	validCatalog := timeTrackingCatalog{FormatVersion: TimeTrackingCatalogFormatVersion, VaultID: store.vaultID}
	if err := validateTrackingCatalogObjects(validCatalog); err != nil {
		t.Fatal(err)
	}
	if err := validateTrackingCatalogObjects(timeTrackingCatalog{FormatVersion: TimeTrackingCatalogFormatVersion, VaultID: store.vaultID, Clients: []TimeClient{{ID: "bad", Revision: 1}}}); err == nil {
		t.Fatal("invalid tracking catalog accepted")
	}
}

func TestCoverageRemoteExportAndAttachmentEdges(t *testing.T) {
	store := NewStore()
	root := t.TempDir()
	if _, err := store.Create(root, "coverage export secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Exported")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "exported body"); err != nil {
		t.Fatal(err)
	}
	remote := filepath.Join(t.TempDir(), "remote")
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if matches, err := store.ValidateRemoteSnapshot(remote); err != nil || !matches {
		t.Fatalf("exported snapshot = %v, %v", matches, err)
	}
	if err := store.ExportRemoteSnapshot(""); err == nil {
		t.Fatal("empty export destination accepted")
	}
	if err := store.ExportRemoteSnapshot(root); err == nil {
		t.Fatal("live vault export destination accepted")
	}
	if _, err := store.ValidateRemoteSnapshot(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing remote snapshot accepted")
	}

	source := filepath.Join(t.TempDir(), "attachment.txt")
	if err := os.WriteFile(source, []byte("attachment"), 0o600); err != nil {
		t.Fatal(err)
	}
	attachment, err := store.ImportFileAttachment(note.ID, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "attachment:"+attachment.ID); err != nil {
		t.Fatal(err)
	}
	destination := t.TempDir()
	if _, err := store.ExportFileAttachment(note.ID, attachment.ID, destination); err != nil {
		t.Fatal(err)
	}
	if path, err := store.ExportFileAttachment(note.ID, attachment.ID, destination); err != nil || !strings.Contains(path, "(2)") {
		t.Fatalf("duplicate attachment export = %q, %v", path, err)
	}
	if _, err := store.ExportFileAttachment(note.ID, attachment.ID, filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("file attachment exported into missing destination")
	}
}

func TestCoverageReferenceAndRangeErrors(t *testing.T) {
	entry := TimeEntry{ID: strings.Repeat("a", 32), StartedAtUTC: "bad", EndedAtUTC: ""}
	if _, _, _, _, err := timeEntryRangeItem(entry, time.Time{}, time.Time{}, time.Now()); err == nil {
		t.Fatal("invalid time entry start accepted")
	}
	entry.StartedAtUTC = "2026-01-01T00:00:00Z"
	entry.EndedAtUTC = "bad"
	if _, _, _, _, err := timeEntryRangeItem(entry, time.Time{}, time.Now(), time.Now()); err == nil {
		t.Fatal("invalid time entry end accepted")
	}
	entry.EndedAtUTC = "2026-01-01T01:00:00Z"
	if _, _, _, ok, err := timeEntryRangeItem(entry, time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC), time.Now()); err != nil || ok {
		t.Fatalf("non-overlapping time entry = %v, %v", ok, err)
	}

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "reference error secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveNoteReference("missing"); err == nil {
		t.Fatal("missing note reference resolved")
	}
	if _, err := store.ResolveNoteReference("note:bad"); err == nil {
		t.Fatal("missing explicit note reference resolved")
	}
	if _, err := store.ListTimeEntries("2026-01-01T00:00:00+01:00", "2026-01-02T00:00:00Z", TimeEntryFilters{}); err == nil {
		t.Fatal("non-UTC time range accepted")
	}
}
