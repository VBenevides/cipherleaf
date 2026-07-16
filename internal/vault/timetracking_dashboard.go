package vault

import (
	"errors"
	"slices"
	"strings"
	"time"
)

func (s *Store) GetTimeDashboard(startUTC, endUTC string, filters TimeEntryFilters) (TimeDashboard, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeDashboard{}, err
	}
	start, end, err := parseTimeTrackingRange(startUTC, endUTC)
	if err != nil {
		return TimeDashboard{}, err
	}
	return s.getTimeDashboardLocked(start, end, filters, time.Local, s.timeTrackingNowLocked())
}

func (s *Store) getTimeDashboardLocked(start, end time.Time, filters TimeEntryFilters, location *time.Location, now time.Time) (TimeDashboard, error) {
	result := emptyTimeDashboard(start, end, location)
	if s.timeTrackingCatalog == nil {
		return result, nil
	}
	projects := make(map[string]time.Duration)
	tags := make(map[string]time.Duration)
	tasks := make(map[string]time.Duration)
	taskCounts := make(map[string]int)
	days := make(map[string]time.Duration)
	for _, summary := range s.timeTrackingCatalog.Buckets {
		selected, err := timeTrackingBucketIntersects(summary, start, end)
		if err != nil {
			return TimeDashboard{}, err
		}
		if !selected {
			continue
		}
		bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
		if err != nil {
			return TimeDashboard{}, err
		}
		for _, entry := range bucket.Entries {
			clippedStart, clippedEnd, ok, err := clippedTimeEntryRange(entry, start, end, now)
			if err != nil {
				return TimeDashboard{}, err
			}
			if !ok || !timeEntryMatchesFilters(entry, filters) {
				continue
			}
			duration := clippedEnd.Sub(clippedStart)
			result.TotalSeconds += int64(duration / time.Second)
			if entry.ProjectID != "" {
				projects[entry.ProjectID] += duration
			}
			for _, id := range entry.TagIDs {
				tags[id] += duration
			}
			name := strings.TrimSpace(entry.Name)
			tasks[name] += duration
			taskCounts[name]++
			addTimeEntryLocalDays(days, clippedStart, clippedEnd, location)
		}
	}
	projectNames, tagNames := trackingLabelNames(*s.timeTrackingCatalog)
	for id, duration := range projects {
		result.Projects = append(result.Projects, TimeDurationGroup{ID: id, Name: projectNames[id], TotalSeconds: int64(duration / time.Second)})
	}
	for id, duration := range tags {
		result.Tags = append(result.Tags, TimeDurationGroup{ID: id, Name: tagNames[id], TotalSeconds: int64(duration / time.Second)})
	}
	for name, duration := range tasks {
		result.Tasks = append(result.Tasks, TimeTaskGroup{Name: name, TotalSeconds: int64(duration / time.Second), EntryCount: taskCounts[name]})
	}
	result.ProjectCount = len(projects)
	result.TagCount = len(tags)
	if len(result.Days) > 0 {
		result.AverageDaySeconds = result.TotalSeconds / int64(len(result.Days))
	}
	for index := range result.Days {
		result.Days[index].TotalSeconds = int64(days[result.Days[index].LocalDate] / time.Second)
	}
	sortTimeDashboard(&result)
	return result, nil
}

func (s *Store) ListTimeDashboardGroupEntries(name, startUTC, endUTC string, filters TimeEntryFilters) ([]TimeEntryRangeItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	start, end, err := parseTimeTrackingRange(startUTC, endUTC)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" || s.timeTrackingCatalog == nil {
		return []TimeEntryRangeItem{}, nil
	}
	result := make([]TimeEntryRangeItem, 0)
	now := s.timeTrackingNowLocked()
	for _, summary := range s.timeTrackingCatalog.Buckets {
		selected, err := timeTrackingBucketIntersects(summary, start, end)
		if err != nil {
			return nil, err
		}
		if !selected {
			continue
		}
		bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
		if err != nil {
			return nil, err
		}
		for _, entry := range bucket.Entries {
			if strings.TrimSpace(entry.Name) != name || !timeEntryMatchesFilters(entry, filters) {
				continue
			}
			clippedStart, clippedEnd, ok, err := clippedTimeEntryRange(entry, start, end, now)
			if err != nil {
				return nil, err
			}
			if ok {
				result = append(result, TimeEntryRangeItem{Entry: cloneTimeEntry(entry), StartedAtUTC: clippedStart.Format(time.RFC3339Nano), EndedAtUTC: clippedEnd.Format(time.RFC3339Nano), TotalSeconds: int64(clippedEnd.Sub(clippedStart) / time.Second)})
			}
		}
	}
	slices.SortFunc(result, func(left, right TimeEntryRangeItem) int {
		if compared := stringsCompare(left.StartedAtUTC, right.StartedAtUTC); compared != 0 {
			return compared
		}
		return stringsCompare(left.Entry.ID, right.Entry.ID)
	})
	return result, nil
}

func clippedTimeEntryRange(entry TimeEntry, start, end, now time.Time) (time.Time, time.Time, bool, error) {
	entryStart, err := time.Parse(time.RFC3339Nano, entry.StartedAtUTC)
	if err != nil {
		return time.Time{}, time.Time{}, false, errors.New("stored time entry has an invalid start")
	}
	entryEnd := now
	if entry.EndedAtUTC != "" {
		entryEnd, err = time.Parse(time.RFC3339Nano, entry.EndedAtUTC)
		if err != nil {
			return time.Time{}, time.Time{}, false, errors.New("stored time entry has an invalid end")
		}
	}
	clippedStart := maxTime(entryStart, start)
	clippedEnd := minTime(entryEnd, end)
	return clippedStart, clippedEnd, clippedEnd.After(clippedStart), nil
}

func emptyTimeDashboard(start, end time.Time, location *time.Location) TimeDashboard {
	result := TimeDashboard{Projects: []TimeDurationGroup{}, Tags: []TimeDurationGroup{}, Tasks: []TimeTaskGroup{}, Days: []TimeDashboardDay{}}
	local := start.In(location)
	cursor := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	for cursor.Before(end) {
		result.Days = append(result.Days, TimeDashboardDay{LocalDate: cursor.Format("2006-01-02")})
		cursor = cursor.AddDate(0, 0, 1)
	}
	return result
}

func trackingLabelNames(catalog timeTrackingCatalog) (map[string]string, map[string]string) {
	projects := make(map[string]string, len(catalog.Projects))
	for _, project := range catalog.Projects {
		projects[project.ID] = project.Name
	}
	tags := make(map[string]string, len(catalog.Tags))
	for _, tag := range catalog.Tags {
		tags[tag.ID] = tag.Name
	}
	return projects, tags
}

func sortTimeDashboard(result *TimeDashboard) {
	slices.SortFunc(result.Projects, compareDurationGroups)
	slices.SortFunc(result.Tags, compareDurationGroups)
	slices.SortFunc(result.Tasks, func(left, right TimeTaskGroup) int {
		if left.TotalSeconds != right.TotalSeconds {
			return int(right.TotalSeconds - left.TotalSeconds)
		}
		return stringsCompare(left.Name, right.Name)
	})
}

func compareDurationGroups(left, right TimeDurationGroup) int {
	if left.TotalSeconds != right.TotalSeconds {
		return int(right.TotalSeconds - left.TotalSeconds)
	}
	if compared := stringsCompare(left.Name, right.Name); compared != 0 {
		return compared
	}
	return stringsCompare(left.ID, right.ID)
}
