package vault

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *Store) StartTimeEntry(name, projectID string, tagIDs []string) (TimeEntry, error) {
	clientID := ""
	s.mu.RLock()
	if s.timeTrackingCatalog != nil {
		clientID = trackingProjectClientID(*s.timeTrackingCatalog, projectID)
	}
	s.mu.RUnlock()
	return s.StartTimeEntryForClient(name, clientID, projectID, tagIDs)
}

func (s *Store) StartTimeEntryForClient(name, clientID, projectID string, tagIDs []string) (TimeEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeEntry{}, err
	}
	if err := s.ensureTimeTrackingEnabledLocked(); err != nil {
		return TimeEntry{}, err
	}
	if s.timeTrackingCatalog.ActiveEntry != nil {
		return TimeEntry{}, errors.New("a time entry is already active")
	}
	name, err := normalizeTimeEntryName(name)
	if err != nil {
		return TimeEntry{}, err
	}
	if err := validateTimeEntryReferences(*s.timeTrackingCatalog, clientID, projectID, tagIDs, true); err != nil {
		return TimeEntry{}, err
	}
	now := s.timeTrackingNowLocked()
	id, err := randomID(16)
	if err != nil {
		return TimeEntry{}, err
	}
	stamp := now.Format(time.RFC3339Nano)
	entry := TimeEntry{
		ID: id, Name: name, ClientID: clientID, ProjectID: projectID, TagIDs: slices.Clone(tagIDs),
		StartedAtUTC: stamp, CreatedAtUTC: stamp, UpdatedAtUTC: stamp,
		ModifiedAt: now.UnixMilli(), Revision: 1,
	}
	catalog := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
	bucket, err := s.timeTrackingBucketForMonthLocked(&catalog, now.Format("2006-01"))
	if err != nil {
		return TimeEntry{}, err
	}
	previous := cloneTimeTrackingBucket(bucket)
	bucket.Entries = append(bucket.Entries, entry)
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	catalog.ActiveEntry = &timeTrackingEntryLocation{EntryID: id, BucketID: bucket.ID}
	advanceTrackingCatalogRevision(&catalog, now)
	if err := s.commitTimeTrackingBucketLocked(previous, bucket, catalog); err != nil {
		return TimeEntry{}, err
	}
	return entry, nil
}

func (s *Store) GetActiveTimeEntry() (*TimeEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	if s.timeTrackingCatalog == nil || s.timeTrackingCatalog.ActiveEntry == nil {
		return nil, nil
	}
	location := s.timeTrackingCatalog.ActiveEntry
	bucket, err := s.readTimeTrackingBucketLocked(location.BucketID)
	if err != nil {
		return nil, err
	}
	index := slices.IndexFunc(bucket.Entries, func(entry TimeEntry) bool { return entry.ID == location.EntryID })
	if index < 0 || bucket.Entries[index].EndedAtUTC != "" {
		return nil, errors.New("active time entry location is invalid")
	}
	entry := cloneTimeEntry(bucket.Entries[index])
	return &entry, nil
}

func (s *Store) FinishActiveTimeEntry() (TimeEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeEntry{}, err
	}
	if s.timeTrackingCatalog == nil || s.timeTrackingCatalog.ActiveEntry == nil {
		return TimeEntry{}, errors.New("no time entry is active")
	}
	location := *s.timeTrackingCatalog.ActiveEntry
	bucket, err := s.readTimeTrackingBucketLocked(location.BucketID)
	if err != nil {
		return TimeEntry{}, err
	}
	index := slices.IndexFunc(bucket.Entries, func(entry TimeEntry) bool { return entry.ID == location.EntryID })
	if index < 0 || bucket.Entries[index].EndedAtUTC != "" {
		return TimeEntry{}, errors.New("active time entry location is invalid")
	}
	previous := cloneTimeTrackingBucket(bucket)
	entry := cloneTimeEntry(bucket.Entries[index])
	now := s.timeTrackingNowLocked()
	started, _ := time.Parse(time.RFC3339Nano, entry.StartedAtUTC)
	if !now.After(started) {
		return TimeEntry{}, errors.New("time entry end must be later than its start")
	}
	entry.EndedAtUTC = now.Format(time.RFC3339Nano)
	entry.UpdatedAtUTC = entry.EndedAtUTC
	entry.ModifiedAt = now.UnixMilli()
	entry.Revision++
	bucket.Entries[index] = entry
	catalog := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
	catalog.ActiveEntry = nil
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	advanceTrackingCatalogRevision(&catalog, now)
	if err := s.commitTimeTrackingBucketLocked(previous, bucket, catalog); err != nil {
		return TimeEntry{}, err
	}
	return entry, nil
}

func (s *Store) UpdateTimeEntry(id, name, projectID string, tagIDs []string, startedAtUTC, endedAtUTC string) (TimeEntry, error) {
	clientID := ""
	s.mu.RLock()
	if s.timeTrackingCatalog != nil {
		clientID = trackingProjectClientID(*s.timeTrackingCatalog, projectID)
	}
	s.mu.RUnlock()
	return s.UpdateTimeEntryForClient(id, name, clientID, projectID, tagIDs, startedAtUTC, endedAtUTC)
}

func (s *Store) UpdateTimeEntryForClient(id, name, clientID, projectID string, tagIDs []string, startedAtUTC, endedAtUTC string) (TimeEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeEntry{}, err
	}
	if s.timeTrackingCatalog == nil {
		return TimeEntry{}, errors.New("time entry not found")
	}
	name, err := normalizeTimeEntryName(name)
	if err != nil {
		return TimeEntry{}, err
	}
	if err := validateTimeEntryReferences(*s.timeTrackingCatalog, clientID, projectID, tagIDs, false); err != nil {
		return TimeEntry{}, err
	}
	started, ended, err := parseCompletedTimeEntryRange(startedAtUTC, endedAtUTC)
	if err != nil {
		return TimeEntry{}, err
	}
	bucket, index, err := s.findTimeTrackingEntryLocked(id)
	if err != nil {
		return TimeEntry{}, err
	}
	if bucket.Entries[index].EndedAtUTC == "" {
		return TimeEntry{}, errors.New("an active time entry cannot be corrected")
	}
	previous := cloneTimeTrackingBucket(bucket)
	entry := cloneTimeEntry(bucket.Entries[index])
	now := s.timeTrackingNowLocked()
	entry.Name = name
	entry.ClientID = clientID
	entry.ProjectID = projectID
	entry.TagIDs = slices.Clone(tagIDs)
	entry.StartedAtUTC = started.Format(time.RFC3339Nano)
	entry.EndedAtUTC = ended.Format(time.RFC3339Nano)
	entry.UpdatedAtUTC = now.Format(time.RFC3339Nano)
	entry.ModifiedAt = now.UnixMilli()
	entry.Revision++
	oldMonth, _ := timeEntryMonthUTC(bucket.Entries[index])
	newMonth := started.Format("2006-01")
	if oldMonth != newMonth {
		if err := s.moveTimeTrackingEntryLocked(entry, bucket.ID); err != nil {
			return TimeEntry{}, err
		}
		return entry, nil
	}
	bucket.Entries[index] = entry
	catalog := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	advanceTrackingCatalogRevision(&catalog, now)
	if err := s.commitTimeTrackingBucketLocked(previous, bucket, catalog); err != nil {
		return TimeEntry{}, err
	}
	return entry, nil
}

func (s *Store) DeleteTimeEntry(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if s.timeTrackingCatalog == nil {
		return errors.New("time entry not found")
	}
	bucket, index, err := s.findTimeTrackingEntryLocked(id)
	if err != nil {
		return err
	}
	entry := bucket.Entries[index]
	if entry.EndedAtUTC == "" {
		return errors.New("an active time entry cannot be deleted")
	}
	previous := cloneTimeTrackingBucket(bucket)
	bucket.Entries = append(bucket.Entries[:index], bucket.Entries[index+1:]...)
	now := s.timeTrackingNowLocked()
	catalog := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
	catalog.DeletedEntries = append(catalog.DeletedEntries, Tombstone{ID: id, Revision: entry.Revision + 1, ModifiedAt: now.UnixMilli()})
	sortTombstones(catalog.DeletedEntries)
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, bucket)
	advanceTrackingCatalogRevision(&catalog, now)
	return s.commitTimeTrackingBucketLocked(previous, bucket, catalog)
}

func (s *Store) commitTimeTrackingBucketLocked(previous, next timeTrackingBucket, catalog timeTrackingCatalog) error {
	if err := s.writeTimeTrackingBucketLocked(next); err != nil {
		return err
	}
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		if rollbackErr := s.writeTimeTrackingBucketLocked(previous); rollbackErr != nil {
			return fmt.Errorf("write tracking catalog: %v (bucket rollback failed: %w)", err, rollbackErr)
		}
		return err
	}
	s.timeTrackingCatalog = &catalog
	return nil
}

func (s *Store) timeTrackingBucketForMonthLocked(catalog *timeTrackingCatalog, month string) (timeTrackingBucket, error) {
	for _, summary := range catalog.Buckets {
		if summary.MonthUTC == month {
			bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
			return bucket, err
		}
	}
	id, err := randomID(16)
	if err != nil {
		return timeTrackingBucket{}, err
	}
	catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: id, MonthUTC: month})
	return timeTrackingBucket{FormatVersion: TimeTrackingCatalogFormatVersion, ID: id, Entries: []TimeEntry{}}, nil
}

func (s *Store) findTimeTrackingEntryLocked(id string) (timeTrackingBucket, int, error) {
	if !validID(id) {
		return timeTrackingBucket{}, -1, errors.New("invalid time entry ID")
	}
	for _, summary := range s.timeTrackingCatalog.Buckets {
		bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
		if err != nil {
			return timeTrackingBucket{}, -1, err
		}
		if index := slices.IndexFunc(bucket.Entries, func(entry TimeEntry) bool { return entry.ID == id }); index >= 0 {
			return bucket, index, nil
		}
	}
	return timeTrackingBucket{}, -1, errors.New("time entry not found")
}

func validateTimeEntryReferences(catalog timeTrackingCatalog, clientID, projectID string, tagIDs []string, activeOnly bool) error {
	if err := validateProjectClient(catalog.Clients, clientID, activeOnly); err != nil && (activeOnly || !trackingTombstoneExists(catalog.DeletedClients, clientID)) {
		return err
	}
	if projectID != "" {
		index := slices.IndexFunc(catalog.Projects, func(project TimeProject) bool { return project.ID == projectID })
		if (index < 0 && (activeOnly || !trackingTombstoneExists(catalog.DeletedProjects, projectID))) || (index >= 0 && activeOnly && catalog.Projects[index].ArchivedAtUTC != "") {
			return errors.New("project not found or archived")
		}
		if activeOnly && index >= 0 && catalog.Projects[index].ClientID != clientID {
			return errors.New("project does not belong to the selected client")
		}
	}
	seen := make(map[string]struct{}, len(tagIDs))
	for _, id := range tagIDs {
		if _, duplicate := seen[id]; duplicate {
			return errors.New("time entry contains a duplicate tag")
		}
		seen[id] = struct{}{}
		index := slices.IndexFunc(catalog.Tags, func(tag TimeTag) bool { return tag.ID == id })
		if (index < 0 && (activeOnly || !trackingTombstoneExists(catalog.DeletedTags, id))) || (index >= 0 && activeOnly && catalog.Tags[index].ArchivedAtUTC != "") {
			return errors.New("tag not found or archived")
		}
	}
	return nil
}

func trackingTombstoneExists(tombstones []Tombstone, id string) bool {
	_, found := findTombstone(tombstones, id)
	return found
}

func trackingProjectClientID(catalog timeTrackingCatalog, projectID string) string {
	index := slices.IndexFunc(catalog.Projects, func(project TimeProject) bool { return project.ID == projectID })
	if index < 0 {
		return ""
	}
	return catalog.Projects[index].ClientID
}

func normalizeTimeEntryName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("time entry name is required")
	}
	if utf8.RuneCountInString(name) > 200 || strings.ContainsAny(name, "\r\n") {
		return "", errors.New("time entry name is invalid or too long")
	}
	return name, nil
}

func parseCompletedTimeEntryRange(startedAtUTC, endedAtUTC string) (time.Time, time.Time, error) {
	started, err := time.Parse(time.RFC3339Nano, startedAtUTC)
	if err != nil || utcOffset(started) != 0 {
		return time.Time{}, time.Time{}, errors.New("time entry start must be UTC RFC 3339")
	}
	ended, err := time.Parse(time.RFC3339Nano, endedAtUTC)
	if err != nil || utcOffset(ended) != 0 || !ended.After(started) {
		return time.Time{}, time.Time{}, errors.New("time entry end must be later than its start")
	}
	return started, ended, nil
}

func cloneTimeTrackingCatalog(catalog timeTrackingCatalog) timeTrackingCatalog {
	catalog.Clients = slices.Clone(catalog.Clients)
	catalog.Projects = slices.Clone(catalog.Projects)
	catalog.Tags = slices.Clone(catalog.Tags)
	catalog.Buckets = slices.Clone(catalog.Buckets)
	catalog.DeletedEntries = slices.Clone(catalog.DeletedEntries)
	catalog.DeletedClients = slices.Clone(catalog.DeletedClients)
	catalog.DeletedProjects = slices.Clone(catalog.DeletedProjects)
	catalog.DeletedTags = slices.Clone(catalog.DeletedTags)
	catalog.Conflicts = slices.Clone(catalog.Conflicts)
	return catalog
}

func cloneTimeEntry(entry TimeEntry) TimeEntry {
	entry.TagIDs = slices.Clone(entry.TagIDs)
	return entry
}

func (s *Store) timeTrackingNowLocked() time.Time {
	if s.timeTrackingNow != nil {
		return s.timeTrackingNow().UTC()
	}
	return time.Now().UTC()
}
