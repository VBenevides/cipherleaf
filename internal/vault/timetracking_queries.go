package vault

import (
	"errors"
	"slices"
	"time"
)

func (s *Store) ListTimeEntries(startUTC, endUTC string, filters TimeEntryFilters) (TimeEntryRangeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeEntryRangeResult{}, err
	}
	start, end, err := parseTimeTrackingRange(startUTC, endUTC)
	if err != nil {
		return TimeEntryRangeResult{}, err
	}
	if s.timeTrackingCatalog == nil {
		return emptyTimeEntryRangeResult(), nil
	}
	return s.listTimeEntriesLocked(start, end, filters, time.Local, s.timeTrackingNowLocked())
}

func (s *Store) listTimeEntriesLocked(start, end time.Time, filters TimeEntryFilters, location *time.Location, now time.Time) (TimeEntryRangeResult, error) {
	buckets, err := s.readTimeTrackingBucketsForRangeLocked(start.Format(time.RFC3339Nano), end.Format(time.RFC3339Nano))
	if err != nil {
		return TimeEntryRangeResult{}, err
	}
	entries := make(map[string]TimeEntry)
	for _, bucket := range buckets {
		for _, entry := range bucket.Entries {
			if !timeEntryMatchesFilters(entry, filters) {
				continue
			}
			if current, found := entries[entry.ID]; !found || entry.Revision > current.Revision ||
				(entry.Revision == current.Revision && entry.ModifiedAt > current.ModifiedAt) {
				entries[entry.ID] = cloneTimeEntry(entry)
			}
		}
	}
	result := emptyTimeEntryRangeResult()
	dayDurations := make(map[string]time.Duration)
	for _, entry := range entries {
		entryStart, err := time.Parse(time.RFC3339Nano, entry.StartedAtUTC)
		if err != nil {
			return TimeEntryRangeResult{}, errors.New("stored time entry has an invalid start")
		}
		entryEnd := now
		if entry.EndedAtUTC != "" {
			entryEnd, err = time.Parse(time.RFC3339Nano, entry.EndedAtUTC)
			if err != nil {
				return TimeEntryRangeResult{}, errors.New("stored time entry has an invalid end")
			}
		}
		clippedStart := maxTime(entryStart, start)
		clippedEnd := minTime(entryEnd, end)
		if !clippedEnd.After(clippedStart) {
			continue
		}
		duration := clippedEnd.Sub(clippedStart)
		result.Entries = append(result.Entries, TimeEntryRangeItem{
			Entry: entry, StartedAtUTC: clippedStart.Format(time.RFC3339Nano),
			EndedAtUTC: clippedEnd.Format(time.RFC3339Nano), TotalSeconds: int64(duration / time.Second),
		})
		result.TotalSeconds += int64(duration / time.Second)
		addTimeEntryLocalDays(dayDurations, clippedStart, clippedEnd, location)
	}
	slices.SortFunc(result.Entries, func(left, right TimeEntryRangeItem) int {
		if left.StartedAtUTC < right.StartedAtUTC {
			return -1
		}
		if left.StartedAtUTC > right.StartedAtUTC {
			return 1
		}
		return stringsCompare(left.Entry.ID, right.Entry.ID)
	})
	dates := make([]string, 0, len(dayDurations))
	for date := range dayDurations {
		dates = append(dates, date)
	}
	slices.Sort(dates)
	for _, date := range dates {
		result.Days = append(result.Days, TimeDashboardDay{LocalDate: date, TotalSeconds: int64(dayDurations[date] / time.Second)})
	}
	return result, nil
}

func parseTimeTrackingRange(startUTC, endUTC string) (time.Time, time.Time, error) {
	start, err := time.Parse(time.RFC3339Nano, startUTC)
	if err != nil || utcOffset(start) != 0 {
		return time.Time{}, time.Time{}, errors.New("invalid tracking range start")
	}
	end, err := time.Parse(time.RFC3339Nano, endUTC)
	if err != nil || utcOffset(end) != 0 || !end.After(start) {
		return time.Time{}, time.Time{}, errors.New("invalid tracking range end")
	}
	return start, end, nil
}

func timeEntryMatchesFilters(entry TimeEntry, filters TimeEntryFilters) bool {
	if len(filters.ProjectIDs) > 0 && !slices.Contains(filters.ProjectIDs, entry.ProjectID) {
		return false
	}
	if len(filters.TagIDs) == 0 {
		return true
	}
	return slices.ContainsFunc(entry.TagIDs, func(id string) bool { return slices.Contains(filters.TagIDs, id) })
}

func addTimeEntryLocalDays(days map[string]time.Duration, start, end time.Time, location *time.Location) {
	cursor := start
	for cursor.Before(end) {
		local := cursor.In(location)
		nextMidnight := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, location)
		segmentEnd := minTime(end, nextMidnight)
		days[local.Format("2006-01-02")] += segmentEnd.Sub(cursor)
		cursor = segmentEnd
	}
}

func localWeekRangeUTC(reference time.Time, location *time.Location) TimeEntryRange {
	local := reference.In(location)
	daysSinceMonday := (int(local.Weekday()) + 6) % 7
	start := time.Date(local.Year(), local.Month(), local.Day()-daysSinceMonday, 0, 0, 0, 0, location)
	return TimeEntryRange{StartUTC: start.UTC().Format(time.RFC3339Nano), EndUTC: start.AddDate(0, 0, 7).UTC().Format(time.RFC3339Nano)}
}

func localMonthRangeUTC(reference time.Time, location *time.Location) TimeEntryRange {
	local := reference.In(location)
	start := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, location)
	return TimeEntryRange{StartUTC: start.UTC().Format(time.RFC3339Nano), EndUTC: start.AddDate(0, 1, 0).UTC().Format(time.RFC3339Nano)}
}

func emptyTimeEntryRangeResult() TimeEntryRangeResult {
	return TimeEntryRangeResult{Entries: []TimeEntryRangeItem{}, Days: []TimeDashboardDay{}}
}

func minTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}

func maxTime(left, right time.Time) time.Time {
	if left.After(right) {
		return left
	}
	return right
}

func stringsCompare(left, right string) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}
