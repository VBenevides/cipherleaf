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
	totals, err := s.timeDashboardTotals(start, end, filters, location, now)
	if err != nil {
		return TimeDashboard{}, err
	}
	clientNames, projectNames, tagNames := trackingLabelNames(*s.timeTrackingCatalog)
	for id, duration := range totals.clients {
		result.Clients = append(result.Clients, TimeDurationGroup{ID: id, Name: trackingLabelName(clientNames, id, "Deleted client"), TotalSeconds: int64(duration / time.Second)})
	}
	for id, duration := range totals.projects {
		result.Projects = append(result.Projects, TimeDurationGroup{ID: id, Name: trackingLabelName(projectNames, id, "Deleted project"), TotalSeconds: int64(duration / time.Second)})
	}
	for id, duration := range totals.tags {
		result.Tags = append(result.Tags, TimeDurationGroup{ID: id, Name: trackingLabelName(tagNames, id, "Deleted tag"), TotalSeconds: int64(duration / time.Second)})
	}
	for name, duration := range totals.tasks {
		result.Tasks = append(result.Tasks, TimeTaskGroup{Name: name, TotalSeconds: int64(duration / time.Second), EntryCount: totals.taskCounts[name]})
	}
	result.TotalSeconds = totals.totalSeconds
	result.ProjectCount = len(totals.projects)
	result.TagCount = len(totals.tags)
	if len(result.Days) > 0 {
		result.AverageDaySeconds = result.TotalSeconds / int64(len(result.Days))
	}
	for index := range result.Days {
		result.Days[index].TotalSeconds = int64(totals.days[result.Days[index].LocalDate] / time.Second)
	}
	sortTimeDashboard(&result)
	return result, nil
}

type timeDashboardTotals struct {
	clients, projects, tags, tasks map[string]time.Duration
	taskCounts                     map[string]int
	days                           map[string]time.Duration
	totalSeconds                   int64
}

type timeDashboardEntryContext struct {
	start, end time.Time
	filters    TimeEntryFilters
	location   *time.Location
	now        time.Time
	catalog    timeTrackingCatalog
}

func (s *Store) timeDashboardTotals(start, end time.Time, filters TimeEntryFilters, location *time.Location, now time.Time) (timeDashboardTotals, error) {
	totals := timeDashboardTotals{
		clients: make(map[string]time.Duration), projects: make(map[string]time.Duration),
		tags: make(map[string]time.Duration), tasks: make(map[string]time.Duration),
		taskCounts: make(map[string]int), days: make(map[string]time.Duration),
	}
	context := timeDashboardEntryContext{start: start, end: end, filters: filters, location: location, now: now, catalog: *s.timeTrackingCatalog}
	for _, summary := range s.timeTrackingCatalog.Buckets {
		selected, err := timeTrackingBucketIntersects(summary, start, end)
		if err != nil {
			return timeDashboardTotals{}, err
		}
		if !selected {
			continue
		}
		bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
		if err != nil {
			return timeDashboardTotals{}, err
		}
		for _, entry := range bucket.Entries {
			if err := addTimeDashboardEntry(&totals, entry, context); err != nil {
				return timeDashboardTotals{}, err
			}
		}
	}
	return totals, nil
}

func addTimeDashboardEntry(totals *timeDashboardTotals, entry TimeEntry, context timeDashboardEntryContext) error {
	clippedStart, clippedEnd, ok, err := clippedTimeEntryRange(entry, context.start, context.end, context.now)
	if err != nil {
		return err
	}
	if !ok || !timeEntryMatchesFilters(entry, context.filters, context.catalog) {
		return nil
	}
	duration := clippedEnd.Sub(clippedStart)
	totals.totalSeconds += int64(duration / time.Second)
	clientID := entry.ClientID
	if clientID == "" {
		clientID = trackingProjectClientID(context.catalog, entry.ProjectID)
	}
	if clientID != "" {
		totals.clients[clientID] += duration
	}
	if entry.ProjectID != "" {
		totals.projects[entry.ProjectID] += duration
	}
	for _, id := range entry.TagIDs {
		totals.tags[id] += duration
	}
	name := strings.TrimSpace(entry.Name)
	totals.tasks[name] += duration
	totals.taskCounts[name]++
	addTimeEntryLocalDays(totals.days, clippedStart, clippedEnd, context.location)
	return nil
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
	return s.listTimeDashboardGroupEntriesLocked(name, start, end, filters)
}

func (s *Store) listTimeDashboardGroupEntriesLocked(name string, start, end time.Time, filters TimeEntryFilters) ([]TimeEntryRangeItem, error) {
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
			if strings.TrimSpace(entry.Name) != name || !timeEntryMatchesFilters(entry, filters, *s.timeTrackingCatalog) {
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
	result := TimeDashboard{Clients: []TimeDurationGroup{}, Projects: []TimeDurationGroup{}, Tags: []TimeDurationGroup{}, Tasks: []TimeTaskGroup{}, Days: []TimeDashboardDay{}}
	local := start.In(location)
	cursor := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	for cursor.Before(end) {
		result.Days = append(result.Days, TimeDashboardDay{LocalDate: cursor.Format("2006-01-02")})
		cursor = cursor.AddDate(0, 0, 1)
	}
	return result
}

func trackingLabelNames(catalog timeTrackingCatalog) (map[string]string, map[string]string, map[string]string) {
	clients := make(map[string]string, len(catalog.Clients))
	for _, client := range catalog.Clients {
		clients[client.ID] = client.Name
	}
	projects := make(map[string]string, len(catalog.Projects))
	for _, project := range catalog.Projects {
		projects[project.ID] = project.Name
	}
	tags := make(map[string]string, len(catalog.Tags))
	for _, tag := range catalog.Tags {
		tags[tag.ID] = tag.Name
	}
	return clients, projects, tags
}

func trackingLabelName(names map[string]string, id, fallback string) string {
	if name := names[id]; name != "" {
		return name
	}
	return fallback
}

func sortTimeDashboard(result *TimeDashboard) {
	slices.SortFunc(result.Clients, compareDurationGroups)
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
