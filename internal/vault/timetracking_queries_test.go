package vault

import (
	"fmt"
	"testing"
	"time"
)

func TestListTimeEntriesClipsFiltersAndIncludesRunning(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	projectID := fmt.Sprintf("%032x", 90)
	tagID := fmt.Sprintf("%032x", 91)
	store.mu.Lock()
	catalog := cloneTimeTrackingCatalog(*store.timeTrackingCatalog)
	entriesByMonth := map[string][]TimeEntry{
		"2026-06": {{
			ID: fmt.Sprintf("%032x", 1), Name: "Spanning", ProjectID: projectID, TagIDs: []string{tagID},
			StartedAtUTC: "2026-06-30T23:30:00Z", EndedAtUTC: "2026-07-01T00:30:00Z", Revision: 1,
		}},
		"2026-07": {
			{ID: fmt.Sprintf("%032x", 2), Name: "Boundary", TagIDs: []string{}, StartedAtUTC: "2026-07-01T02:00:00Z", EndedAtUTC: "2026-07-01T03:00:00Z", Revision: 1},
			{ID: fmt.Sprintf("%032x", 3), Name: "Running", ProjectID: projectID, TagIDs: []string{tagID}, StartedAtUTC: "2026-07-01T01:30:00Z", Revision: 1},
		},
	}
	for month, entries := range entriesByMonth {
		id := fmt.Sprintf("%032x", len(catalog.Buckets)+10)
		bucket := timeTrackingBucket{FormatVersion: 1, ID: id, Entries: entries}
		if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
			store.mu.Unlock()
			t.Fatal(err)
		}
		catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: id, MonthUTC: month})
		catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	}
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	start, end, _ := parseTimeTrackingRange("2026-07-01T00:00:00Z", "2026-07-01T02:00:00Z")
	result, err := store.listTimeEntriesLocked(start, end, TimeEntryFilters{ProjectIDs: []string{projectID}, TagIDs: []string{tagID}}, time.UTC, time.Date(2026, 7, 1, 2, 30, 0, 0, time.UTC))
	store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 2 || result.TotalSeconds != 3600 || len(result.Days) != 1 || result.Days[0].TotalSeconds != 3600 {
		t.Fatalf("unexpected clipped result: %#v", result)
	}
	if result.Entries[0].StartedAtUTC != "2026-07-01T00:00:00Z" || result.Entries[0].TotalSeconds != 1800 {
		t.Fatalf("spanning entry was not clipped: %#v", result.Entries[0])
	}
	if result.Entries[1].EndedAtUTC != "2026-07-01T02:00:00Z" || result.Entries[1].TotalSeconds != 1800 {
		t.Fatalf("running entry was not clipped: %#v", result.Entries[1])
	}
}

func TestTimeEntryLocalDayAccountingHandlesDST(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		start      string
		end        string
		date       string
		wantSecond int64
	}{
		{name: "spring forward", start: "2026-03-08T05:00:00Z", end: "2026-03-09T04:00:00Z", date: "2026-03-08", wantSecond: 23 * 3600},
		{name: "ordinary", start: "2026-03-09T04:00:00Z", end: "2026-03-10T04:00:00Z", date: "2026-03-09", wantSecond: 24 * 3600},
		{name: "fall back", start: "2026-11-01T04:00:00Z", end: "2026-11-02T05:00:00Z", date: "2026-11-01", wantSecond: 25 * 3600},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			start, _ := time.Parse(time.RFC3339, test.start)
			end, _ := time.Parse(time.RFC3339, test.end)
			days := make(map[string]time.Duration)
			addTimeEntryLocalDays(days, start, end, location)
			if got := int64(days[test.date] / time.Second); got != test.wantSecond {
				t.Fatalf("duration = %d, want %d", got, test.wantSecond)
			}
		})
	}
}

func TestLocalWeekAndMonthRanges(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	reference := time.Date(2026, 3, 8, 16, 0, 0, 0, time.UTC)
	week := localWeekRangeUTC(reference, location)
	if week.StartUTC != "2026-03-02T05:00:00Z" || week.EndUTC != "2026-03-09T04:00:00Z" {
		t.Fatalf("unexpected Monday week: %#v", week)
	}
	month := localMonthRangeUTC(reference, location)
	if month.StartUTC != "2026-03-01T05:00:00Z" || month.EndUTC != "2026-04-01T04:00:00Z" {
		t.Fatalf("unexpected local month: %#v", month)
	}
}

func TestListTimeEntriesRejectsInvalidAndEmptyRanges(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	for _, value := range []TimeEntryRange{
		{StartUTC: "bad", EndUTC: "2026-01-01T01:00:00Z"},
		{StartUTC: "2026-01-01T01:00:00Z", EndUTC: "2026-01-01T01:00:00Z"},
		{StartUTC: "2026-01-01T02:00:00Z", EndUTC: "2026-01-01T01:00:00Z"},
	} {
		if _, err := store.ListTimeEntries(value.StartUTC, value.EndUTC, TimeEntryFilters{}); err == nil {
			t.Fatalf("invalid range was accepted: %#v", value)
		}
	}
}

func TestTimeEntryClientFilterUsesProjectRelationship(t *testing.T) {
	clientID := fmt.Sprintf("%032x", 200)
	projectID := fmt.Sprintf("%032x", 201)
	catalog := newTimeTrackingCatalog(fmt.Sprintf("%032x", 202))
	catalog.Clients = append(catalog.Clients, TimeClient{ID: clientID, Name: "Acme", Revision: 1})
	catalog.Projects = append(catalog.Projects, TimeProject{ID: projectID, Name: "Website", ClientID: clientID, Revision: 1})
	entry := TimeEntry{ProjectID: projectID}
	if !timeEntryMatchesFilters(entry, TimeEntryFilters{ClientIDs: []string{clientID}}, catalog) {
		t.Fatal("entry did not match its project's client")
	}
	if timeEntryMatchesFilters(entry, TimeEntryFilters{ClientIDs: []string{fmt.Sprintf("%032x", 203)}}, catalog) {
		t.Fatal("entry matched a different client")
	}
	if !timeEntryMatchesFilters(TimeEntry{ClientID: clientID}, TimeEntryFilters{ClientIDs: []string{clientID}}, catalog) {
		t.Fatal("client-only entry did not match its client")
	}
}
