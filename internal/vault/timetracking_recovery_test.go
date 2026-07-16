package vault

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestTimeTrackingRangeLoadingAndBoundedCache(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	store.mu.Lock()
	catalog := *store.timeTrackingCatalog
	for month := 1; month <= 6; month++ {
		id := fmt.Sprintf("%032x", month)
		started := fmt.Sprintf("2026-%02d-10T10:00:00Z", month)
		ended := fmt.Sprintf("2026-%02d-10T11:00:00Z", month)
		if month == 1 {
			ended = "2026-03-05T11:00:00Z"
		}
		bucket := timeTrackingBucket{FormatVersion: 1, ID: id, Entries: []TimeEntry{{
			ID: fmt.Sprintf("%032x", month+20), Name: "Task", TagIDs: []string{},
			StartedAtUTC: started, EndedAtUTC: ended, CreatedAtUTC: started,
			UpdatedAtUTC: ended, ModifiedAt: int64(month), Revision: 1,
		}}}
		if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
			store.mu.Unlock()
			t.Fatal(err)
		}
		catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: id, MonthUTC: fmt.Sprintf("2026-%02d", month)})
		catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	}
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	reads := make(map[string]int)
	store.timeTrackingBucketRead = func(id string) { reads[id]++ }
	buckets, err := store.readTimeTrackingBucketsForRangeLocked("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if len(buckets) != 2 || buckets[0].ID != fmt.Sprintf("%032x", 1) ||
		buckets[1].ID != fmt.Sprintf("%032x", 3) || len(reads) != 2 {
		store.mu.Unlock()
		t.Fatalf("range loaded unrelated buckets: buckets=%v reads=%v", buckets, reads)
	}
	for month := 1; month <= 5; month++ {
		if _, err := store.readTimeTrackingBucketLocked(fmt.Sprintf("%032x", month)); err != nil {
			store.mu.Unlock()
			t.Fatal(err)
		}
	}
	if len(store.timeTrackingBucketCache) != timeTrackingBucketCacheLimit {
		store.mu.Unlock()
		t.Fatalf("cache size = %d", len(store.timeTrackingBucketCache))
	}
	firstID := fmt.Sprintf("%032x", 1)
	before := reads[firstID]
	if _, err := store.readTimeTrackingBucketLocked(firstID); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if reads[firstID] != before+1 {
		store.mu.Unlock()
		t.Fatal("least-recently-used bucket was not evicted")
	}
	store.mu.Unlock()
	store.Lock()
	store.mu.Lock()
	if len(store.timeTrackingBucketCache) != 0 {
		store.mu.Unlock()
		t.Fatal("locking the vault did not clear the tracking cache")
	}
	store.mu.Unlock()
}

func TestTimeTrackingCrossBucketMoveRecoversAfterPartialWrite(t *testing.T) {
	store, root := newTrackingTestStore(t)
	sourceID := strings.Repeat("1", 32)
	entryID := strings.Repeat("2", 32)
	store.mu.Lock()
	sourceEntry := trackingTestEntry(entryID, "2026-01-31T23:00:00Z", 1)
	source := timeTrackingBucket{FormatVersion: 1, ID: sourceID, Entries: []TimeEntry{sourceEntry}}
	if err := store.writeTimeTrackingBucketLocked(source); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	catalog := *store.timeTrackingCatalog
	catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: sourceID, MonthUTC: "2026-01"})
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, source)
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	writes := 0
	store.timeTrackingWriteHook = func(kind, _ string) error {
		if kind == "bucket" {
			writes++
			if writes == 2 {
				return errors.New("injected source write failure")
			}
		}
		return nil
	}
	corrected := trackingTestEntry(entryID, "2026-02-01T01:00:00Z", 2)
	if err := store.moveTimeTrackingEntryLocked(corrected, sourceID); err == nil {
		store.mu.Unlock()
		t.Fatal("partial move unexpectedly succeeded")
	}
	destinationID := store.timeTrackingCatalog.PendingMove.DestinationBucketID
	store.mu.Unlock()
	store.Lock()
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatalf("reopen did not recover pending move: %v", err)
	}
	store.mu.Lock()
	source, err := store.readTimeTrackingBucketLocked(sourceID)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	destination, err := store.readTimeTrackingBucketLocked(destinationID)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if len(source.Entries) != 0 || len(destination.Entries) != 1 ||
		destination.Entries[0].ID != entryID || destination.Entries[0].Revision != 2 ||
		store.timeTrackingCatalog.PendingMove != nil {
		store.mu.Unlock()
		t.Fatalf("move recovery left loss or duplication: source=%#v destination=%#v catalog=%#v", source, destination, store.timeTrackingCatalog)
	}
	store.mu.Unlock()
}

func TestTimeTrackingMoveRecoveryKeepsHighestRevision(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	sourceID := strings.Repeat("3", 32)
	destinationID := strings.Repeat("4", 32)
	entryID := strings.Repeat("5", 32)
	store.mu.Lock()
	source := timeTrackingBucket{FormatVersion: 1, ID: sourceID, Entries: []TimeEntry{trackingTestEntry(entryID, "2026-01-20T10:00:00Z", 1)}}
	destination := timeTrackingBucket{FormatVersion: 1, ID: destinationID, Entries: []TimeEntry{trackingTestEntry(entryID, "2026-02-20T10:00:00Z", 3)}}
	for _, bucket := range []timeTrackingBucket{source, destination} {
		if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
			store.mu.Unlock()
			t.Fatal(err)
		}
	}
	catalog := *store.timeTrackingCatalog
	catalog.Buckets = []timeTrackingBucketSummary{{ID: sourceID, MonthUTC: "2026-01"}, {ID: destinationID, MonthUTC: "2026-02"}}
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, source)
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, destination)
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	if err := store.moveTimeTrackingEntryLocked(trackingTestEntry(entryID, "2026-02-15T10:00:00Z", 2), sourceID); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	source, err := store.readTimeTrackingBucketLocked(sourceID)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	destination, err = store.readTimeTrackingBucketLocked(destinationID)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if len(source.Entries) != 0 || len(destination.Entries) != 1 || destination.Entries[0].Revision != 3 {
		store.mu.Unlock()
		t.Fatalf("highest revision was not recovered: source=%#v destination=%#v", source, destination)
	}
	store.mu.Unlock()
}

func newTrackingTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	if err := enableTimeTrackingCapability(&store.manifest); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := store.saveManifestLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()
	return store, root
}

func trackingTestEntry(id, started string, revision uint64) TimeEntry {
	return TimeEntry{
		ID: id, Name: "Moved task", TagIDs: []string{}, StartedAtUTC: started,
		EndedAtUTC: "2026-02-01T02:00:00Z", CreatedAtUTC: started,
		UpdatedAtUTC: "2026-02-01T02:00:00Z", ModifiedAt: int64(revision), Revision: revision,
	}
}
