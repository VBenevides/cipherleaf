package vault

import (
	"fmt"
	"testing"
	"time"
)

func TestTimeDashboardAggregatesAndLoadsGroupDetailsLazily(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	clientA, _ := store.CreateClient("Client A")
	clientB, _ := store.CreateClient("Client B")
	projectA, _ := store.CreateProject("Alpha", clientA.ID)
	projectB, _ := store.CreateProject("Beta", clientB.ID)
	tagA, _ := store.CreateTag("Focus")
	tagB, _ := store.CreateTag("Billable")
	store.mu.Lock()
	catalog := cloneTimeTrackingCatalog(*store.timeTrackingCatalog)
	bucket := timeTrackingBucket{FormatVersion: 1, ID: fmt.Sprintf("%032x", 70), Entries: []TimeEntry{
		dashboardTestEntry(1, " Task ", projectA.ID, []string{tagA.ID, tagB.ID}, "2026-07-01T10:00:00Z", "2026-07-01T11:00:00Z"),
		dashboardTestEntry(2, "Task", projectB.ID, []string{tagA.ID}, "2026-07-01T12:00:00Z", "2026-07-01T14:00:00Z"),
		dashboardTestEntry(3, "task", "", nil, "2026-07-02T10:00:00Z", "2026-07-02T10:30:00Z"),
		dashboardTestEntry(4, "Running", "", nil, "2026-07-02T23:30:00Z", ""),
	}}
	if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: bucket.ID, MonthUTC: "2026-07"})
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	oldBucket := timeTrackingBucket{FormatVersion: 1, ID: fmt.Sprintf("%032x", 71), Entries: []TimeEntry{dashboardTestEntry(5, "Old", "", nil, "2020-01-01T00:00:00Z", "2020-01-01T01:00:00Z")}}
	if err := store.writeTimeTrackingBucketLocked(oldBucket); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: oldBucket.ID, MonthUTC: "2020-01"})
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, oldBucket)
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	reads := make(map[string]int)
	store.timeTrackingBucketRead = func(id string) { reads[id]++ }
	start, end, _ := parseTimeTrackingRange("2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z")
	result, err := store.getTimeDashboardLocked(start, end, TimeEntryFilters{}, time.UTC, end)
	store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if result.ProjectCount != 2 || result.TagCount != 2 || result.TotalSeconds != 14400 || result.AverageDaySeconds != 7200 {
		t.Fatalf("unexpected dashboard counters: %#v", result)
	}
	if len(result.Projects) != 2 || result.Projects[0].Name != "Beta" || result.Projects[0].TotalSeconds != 7200 {
		t.Fatalf("unexpected project groups: %#v", result.Projects)
	}
	if len(result.Tags) != 2 || result.Tags[0].Name != "Focus" || result.Tags[0].TotalSeconds != 10800 || result.Tags[1].TotalSeconds != 3600 {
		t.Fatalf("unexpected multi-tag groups: %#v", result.Tags)
	}
	if len(result.Tasks) != 3 || result.Tasks[0].Name != "Task" || result.Tasks[0].EntryCount != 2 || result.Tasks[1].Name != "Running" || result.Tasks[2].Name != "task" {
		t.Fatalf("task names were not grouped case-sensitively: %#v", result.Tasks)
	}
	if len(result.Days) != 2 || result.Days[0].TotalSeconds != 10800 || result.Days[1].TotalSeconds != 3600 {
		t.Fatalf("unexpected daily chart: %#v", result.Days)
	}
	if reads[oldBucket.ID] != 0 || reads[bucket.ID] != 1 {
		t.Fatalf("dashboard read unrelated buckets: %#v", reads)
	}

	details, err := store.ListTimeDashboardGroupEntries("Task", "2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z", TimeEntryFilters{})
	if err != nil || len(details) != 2 {
		t.Fatalf("unexpected lazy details: %#v, %v", details, err)
	}
	filtered, err := store.GetTimeDashboard("2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z", TimeEntryFilters{ProjectIDs: []string{projectA.ID}, TagIDs: []string{tagB.ID}})
	if err != nil || filtered.TotalSeconds != 3600 || filtered.ProjectCount != 1 || filtered.TagCount != 2 {
		t.Fatalf("unexpected filtered dashboard: %#v, %v", filtered, err)
	}
	clientFiltered, err := store.GetTimeDashboard("2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z", TimeEntryFilters{ClientIDs: []string{clientB.ID}})
	if err != nil || clientFiltered.TotalSeconds != 7200 || len(clientFiltered.Projects) != 1 || clientFiltered.Projects[0].ID != projectB.ID {
		t.Fatalf("unexpected client-filtered dashboard: %#v, %v", clientFiltered, err)
	}
}

func TestTimeDashboardKeepsBoundedBucketCache(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	store.mu.Lock()
	catalog := cloneTimeTrackingCatalog(*store.timeTrackingCatalog)
	for month := 1; month <= 12; month++ {
		id := fmt.Sprintf("%032x", month+100)
		start := fmt.Sprintf("2026-%02d-01T00:00:00Z", month)
		end := fmt.Sprintf("2026-%02d-01T01:00:00Z", month)
		bucket := timeTrackingBucket{FormatVersion: 1, ID: id, Entries: []TimeEntry{dashboardTestEntry(month+100, "Large", "", nil, start, end)}}
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
	start, end, _ := parseTimeTrackingRange("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")
	result, err := store.getTimeDashboardLocked(start, end, TimeEntryFilters{}, time.UTC, end)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if result.TotalSeconds != 12*3600 || len(store.timeTrackingBucketCache) > timeTrackingBucketCacheLimit {
		store.mu.Unlock()
		t.Fatalf("dashboard was not bounded: total=%d cache=%d", result.TotalSeconds, len(store.timeTrackingBucketCache))
	}
	store.mu.Unlock()
}

func dashboardTestEntry(number int, name, projectID string, tagIDs []string, start, end string) TimeEntry {
	return TimeEntry{ID: fmt.Sprintf("%032x", number), Name: name, ProjectID: projectID, TagIDs: tagIDs, StartedAtUTC: start, EndedAtUTC: end, CreatedAtUTC: start, UpdatedAtUTC: end, Revision: 1}
}
