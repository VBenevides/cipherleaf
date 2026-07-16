package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"
)

func (s *Store) readRemoteTimeTrackingLocked(source string) (*authenticatedTrackingSnapshot, error) {
	inventoryPath := filepath.Join(source, syncDirectory, syncTrackingFile)
	trackingRoot := filepath.Join(source, trackingDirectory)
	if _, err := os.Stat(inventoryPath); errors.Is(err, os.ErrNotExist) {
		if directoryExists(trackingRoot) {
			return nil, errors.New("remote tracking folder is absent from its inventory")
		}
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("inspect remote tracking inventory: %w", err)
	}
	plaintext, err := s.readEnvelopeFileLocked(inventoryPath, "sync-tracking", "sync-tracking")
	if err != nil {
		return nil, fmt.Errorf("authenticate remote tracking inventory: %w", err)
	}
	var inventory remoteTrackingInventory
	if err := json.Unmarshal(plaintext, &inventory); err != nil ||
		inventory.FormatVersion != TimeTrackingCatalogFormatVersion || inventory.VaultID != s.vaultID {
		return nil, errors.New("remote tracking inventory is damaged or belongs to another vault")
	}
	if inventory.Catalog.ID != trackingCatalogObjectID || !validTrackingHash(inventory.Catalog.CiphertextHash) {
		return nil, errors.New("remote tracking inventory contains an invalid catalog")
	}
	catalogPath := filepath.Join(trackingRoot, trackingCatalogFilename)
	catalogCiphertext, err := os.ReadFile(catalogPath)
	if err != nil || ciphertextHash(catalogCiphertext) != inventory.Catalog.CiphertextHash {
		return nil, errors.New("remote tracking catalog does not match its inventory hash")
	}
	catalogPlaintext, err := s.readEnvelopeFileLocked(catalogPath, trackingCatalogObjectType, trackingCatalogObjectID)
	if err != nil {
		return nil, fmt.Errorf("authenticate remote tracking catalog: %w", err)
	}
	var catalog timeTrackingCatalog
	if err := json.Unmarshal(catalogPlaintext, &catalog); err != nil ||
		catalog.FormatVersion != TimeTrackingCatalogFormatVersion || catalog.VaultID != s.vaultID ||
		catalog.Revision != inventory.Catalog.Revision || catalog.ModifiedAt != inventory.Catalog.ModifiedAt {
		return nil, errors.New("remote tracking catalog metadata is inconsistent")
	}
	if catalog.PendingMove != nil {
		return nil, errors.New("remote tracking catalog contains an unfinished local move")
	}
	if err := validateTrackingCatalogObjects(catalog); err != nil {
		return nil, err
	}
	summaries := make(map[string]timeTrackingBucketSummary, len(catalog.Buckets))
	for _, summary := range catalog.Buckets {
		summaries[summary.ID] = summary
	}
	buckets := make(map[string]timeTrackingBucket, len(inventory.Buckets))
	seenEntries := make(map[string]struct{})
	for _, item := range inventory.Buckets {
		summary, found := summaries[item.ID]
		if !found || !validID(item.ID) || !validTrackingHash(item.CiphertextHash) ||
			item.Revision != summary.Revision || item.ModifiedAt != summary.ModifiedAt {
			return nil, errors.New("remote tracking inventory contains an invalid bucket")
		}
		if _, duplicate := buckets[item.ID]; duplicate {
			return nil, errors.New("remote tracking inventory contains a duplicate bucket")
		}
		path := filepath.Join(trackingRoot, trackingObjectsDirectory, item.ID[:2], item.ID+".enc")
		ciphertext, err := os.ReadFile(path)
		if err != nil || ciphertextHash(ciphertext) != item.CiphertextHash {
			return nil, fmt.Errorf("remote tracking bucket %s does not match its inventory hash", item.ID)
		}
		bucketPlaintext, err := s.readEnvelopeFileLocked(path, trackingBucketObjectType, item.ID)
		if err != nil {
			return nil, fmt.Errorf("authenticate remote tracking bucket %s: %w", item.ID, err)
		}
		var bucket timeTrackingBucket
		if err := json.Unmarshal(bucketPlaintext, &bucket); err != nil || bucket.FormatVersion != TimeTrackingCatalogFormatVersion || bucket.ID != item.ID {
			return nil, errors.New("remote tracking bucket is damaged")
		}
		for _, entry := range bucket.Entries {
			if err := validateStoredTimeEntry(entry, summary.MonthUTC); err != nil {
				return nil, err
			}
			if _, duplicate := seenEntries[entry.ID]; duplicate {
				return nil, errors.New("remote tracking data contains a duplicate entry")
			}
			seenEntries[entry.ID] = struct{}{}
			if err := validateTimeEntryReferences(catalog, entry.ProjectID, entry.TagIDs, false); err != nil {
				return nil, errors.New("remote tracking entry references a missing label")
			}
		}
		computed := updateTimeTrackingBucketSummary([]timeTrackingBucketSummary{{ID: summary.ID, MonthUTC: summary.MonthUTC}}, bucket)[0]
		if computed.MinStartedAt != summary.MinStartedAt || computed.MaxEndedAt != summary.MaxEndedAt || computed.HasActiveEntry != summary.HasActiveEntry {
			return nil, errors.New("remote tracking bucket coverage is inconsistent")
		}
		buckets[item.ID] = bucket
	}
	if len(buckets) != len(catalog.Buckets) {
		return nil, errors.New("remote tracking inventory is missing a bucket")
	}
	for _, deleted := range catalog.DeletedEntries {
		if _, live := seenEntries[deleted.ID]; live {
			return nil, errors.New("remote tracking entry is both live and deleted")
		}
	}
	if err := validateRemoteTrackingPaths(trackingRoot, buckets); err != nil {
		return nil, err
	}
	if active := catalog.ActiveEntry; active != nil {
		bucket, found := buckets[active.BucketID]
		if !found || !slices.ContainsFunc(bucket.Entries, func(entry TimeEntry) bool { return entry.ID == active.EntryID && entry.EndedAtUTC == "" }) {
			return nil, errors.New("remote tracking active entry location is invalid")
		}
	}
	return &authenticatedTrackingSnapshot{Inventory: inventory, Catalog: catalog, Buckets: buckets}, nil
}

func (s *Store) timeTrackingSnapshotMatchesLocked(remote *authenticatedTrackingSnapshot) (bool, error) {
	if s.timeTrackingCatalog == nil || remote == nil {
		return s.timeTrackingCatalog == nil && remote == nil, nil
	}
	data, err := os.ReadFile(filepath.Join(s.root, trackingDirectory, trackingCatalogFilename))
	if err != nil {
		return false, err
	}
	if ciphertextHash(data) != remote.Inventory.Catalog.CiphertextHash || len(s.timeTrackingCatalog.Buckets) != len(remote.Inventory.Buckets) {
		return false, nil
	}
	remoteBuckets := make(map[string]remoteTrackingObject, len(remote.Inventory.Buckets))
	for _, item := range remote.Inventory.Buckets {
		remoteBuckets[item.ID] = item
	}
	for _, summary := range s.timeTrackingCatalog.Buckets {
		item, found := remoteBuckets[summary.ID]
		if !found {
			return false, nil
		}
		path, err := s.timeTrackingBucketPathLocked(summary.ID)
		if err != nil {
			return false, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return false, err
		}
		if ciphertextHash(data) != item.CiphertextHash {
			return false, nil
		}
	}
	return true, nil
}

func validateTrackingCatalogObjects(catalog timeTrackingCatalog) error {
	projectIDs := make(map[string]struct{}, len(catalog.Projects))
	for _, project := range catalog.Projects {
		name, nameErr := normalizeTrackingLabelName(project.Name)
		if !validID(project.ID) || project.Revision == 0 || nameErr != nil || name != project.Name {
			return errors.New("remote tracking catalog contains an invalid project")
		}
		if _, duplicate := projectIDs[project.ID]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate project")
		}
		projectIDs[project.ID] = struct{}{}
	}
	tagIDs := make(map[string]struct{}, len(catalog.Tags))
	for _, tag := range catalog.Tags {
		name, nameErr := normalizeTrackingLabelName(tag.Name)
		if !validID(tag.ID) || tag.Revision == 0 || nameErr != nil || name != tag.Name {
			return errors.New("remote tracking catalog contains an invalid tag")
		}
		if _, duplicate := tagIDs[tag.ID]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate tag")
		}
		tagIDs[tag.ID] = struct{}{}
	}
	bucketIDs := make(map[string]struct{}, len(catalog.Buckets))
	months := make(map[string]struct{}, len(catalog.Buckets))
	for _, bucket := range catalog.Buckets {
		if !validID(bucket.ID) {
			return errors.New("remote tracking catalog contains an invalid bucket")
		}
		if _, err := time.Parse("2006-01", bucket.MonthUTC); err != nil {
			return errors.New("remote tracking catalog contains an invalid bucket month")
		}
		if _, duplicate := bucketIDs[bucket.ID]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate bucket")
		}
		if _, duplicate := months[bucket.MonthUTC]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate month")
		}
		bucketIDs[bucket.ID] = struct{}{}
		months[bucket.MonthUTC] = struct{}{}
	}
	if err := validateTrackingTombstones(catalog.DeletedEntries, nil); err != nil {
		return err
	}
	if err := validateTrackingTombstones(catalog.DeletedProjects, projectIDs); err != nil {
		return err
	}
	if err := validateTrackingTombstones(catalog.DeletedTags, tagIDs); err != nil {
		return err
	}
	return nil
}

func validateTrackingTombstones(values []Tombstone, live map[string]struct{}) error {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validID(value.ID) || value.Revision == 0 || value.ModifiedAt < 0 {
			return errors.New("remote tracking catalog contains an invalid tombstone")
		}
		if _, duplicate := seen[value.ID]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate tombstone")
		}
		if _, found := live[value.ID]; found {
			return errors.New("remote tracking object is both live and deleted")
		}
		seen[value.ID] = struct{}{}
	}
	return nil
}

func validateStoredTimeEntry(entry TimeEntry, month string) error {
	if !validID(entry.ID) || entry.Revision == 0 || strings.TrimSpace(entry.Name) == "" {
		return errors.New("remote tracking bucket contains an invalid entry")
	}
	entryMonth, err := timeEntryMonthUTC(entry)
	if err != nil || entryMonth != month {
		return errors.New("remote tracking entry is stored in the wrong bucket")
	}
	if entry.EndedAtUTC != "" {
		if _, _, err := parseCompletedTimeEntryRange(entry.StartedAtUTC, entry.EndedAtUTC); err != nil {
			return errors.New("remote tracking bucket contains an invalid entry range")
		}
	}
	return nil
}

func validateRemoteTrackingPaths(root string, buckets map[string]timeTrackingBucket) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if filepath.ToSlash(relative) == trackingCatalogFilename {
			return nil
		}
		parts := strings.Split(filepath.ToSlash(relative), "/")
		if len(parts) != 3 || parts[0] != trackingObjectsDirectory || !strings.HasSuffix(parts[2], ".enc") {
			return errors.New("remote tracking folder contains an unknown file")
		}
		id := strings.TrimSuffix(parts[2], ".enc")
		if !validID(id) || parts[1] != id[:2] {
			return errors.New("remote tracking folder contains an invalid path")
		}
		if _, found := buckets[id]; !found {
			return errors.New("remote tracking folder contains an object absent from its inventory")
		}
		return nil
	})
}

func validTrackingHash(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func ciphertextHash(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func (s *Store) mergeTimeTrackingSnapshotLocked(remote *authenticatedTrackingSnapshot) ([]TimeTrackingConflict, bool, error) {
	if remote == nil {
		return nil, false, nil
	}
	localCatalog := newTimeTrackingCatalog(s.vaultID)
	localBuckets := make(map[string]timeTrackingBucket)
	if s.timeTrackingCatalog != nil {
		localCatalog = cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
		for _, summary := range localCatalog.Buckets {
			bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
			if err != nil {
				return nil, false, err
			}
			localBuckets[summary.ID] = bucket
		}
	}
	localEntries := trackingEntriesByID(localBuckets)
	remoteEntries := trackingEntriesByID(remote.Buckets)
	projects, projectConflicts := mergeTimeProjects(localCatalog.Projects, remote.Catalog.Projects, localCatalog.DeletedProjects, remote.Catalog.DeletedProjects)
	tags, tagConflicts := mergeTimeTags(localCatalog.Tags, remote.Catalog.Tags, localCatalog.DeletedTags, remote.Catalog.DeletedTags)
	deletedProjects := mergeTrackingTombstones(localCatalog.DeletedProjects, remote.Catalog.DeletedProjects)
	deletedTags := mergeTrackingTombstones(localCatalog.DeletedTags, remote.Catalog.DeletedTags)
	deletedEntries := mergeTrackingTombstones(localCatalog.DeletedEntries, remote.Catalog.DeletedEntries)
	entries, entryConflicts := mergeTimeEntries(localEntries, remoteEntries, deletedEntries)
	projects = removeDeletedProjects(projects, deletedProjects)
	tags = removeDeletedTags(tags, deletedTags)
	entries = removeDeletedTimeEntries(entries, deletedEntries)
	conflicts := append(projectConflicts, tagConflicts...)
	conflicts = append(conflicts, entryConflicts...)
	conflicts = append(conflicts, detectTimeEntryInvariantConflicts(entries)...)
	conflicts = appendUniqueTrackingConflicts(localCatalog.Conflicts, conflicts...)

	merged := newTimeTrackingCatalog(s.vaultID)
	merged.Projects = projects
	merged.Tags = tags
	merged.DeletedProjects = deletedProjects
	merged.DeletedTags = deletedTags
	merged.DeletedEntries = deletedEntries
	merged.Conflicts = conflicts
	merged.Revision = max(localCatalog.Revision, remote.Catalog.Revision) + 1
	merged.ModifiedAt = max(localCatalog.ModifiedAt, remote.Catalog.ModifiedAt)
	monthIDs := trackingMonthIDs(localCatalog, remote.Catalog)
	mergedBuckets := make(map[string]timeTrackingBucket)
	entryIDs := make([]string, 0, len(entries))
	for id := range entries {
		entryIDs = append(entryIDs, id)
	}
	slices.Sort(entryIDs)
	for _, id := range entryIDs {
		entry := entries[id]
		month, _ := timeEntryMonthUTC(entry)
		bucketID := monthIDs[month]
		if bucketID == "" {
			var err error
			bucketID, err = randomID(16)
			if err != nil {
				return nil, false, err
			}
			monthIDs[month] = bucketID
		}
		bucket := mergedBuckets[bucketID]
		if bucket.ID == "" {
			bucket = timeTrackingBucket{FormatVersion: TimeTrackingCatalogFormatVersion, ID: bucketID, Entries: []TimeEntry{}}
			merged.Buckets = append(merged.Buckets, timeTrackingBucketSummary{ID: bucketID, MonthUTC: month})
		}
		bucket.Entries = append(bucket.Entries, entry)
		mergedBuckets[bucketID] = bucket
	}
	for id, bucket := range mergedBuckets {
		merged.Buckets = updateTimeTrackingBucketSummary(merged.Buckets, bucket)
		mergedBuckets[id] = bucket
	}
	slices.SortFunc(merged.Buckets, func(left, right timeTrackingBucketSummary) int { return stringsCompare(left.MonthUTC, right.MonthUTC) })
	running := make([]timeTrackingEntryLocation, 0)
	for _, summary := range merged.Buckets {
		for _, entry := range mergedBuckets[summary.ID].Entries {
			if entry.EndedAtUTC == "" {
				running = append(running, timeTrackingEntryLocation{EntryID: entry.ID, BucketID: summary.ID})
			}
		}
	}
	if len(running) > 0 {
		merged.ActiveEntry = &running[0]
	}
	if s.timeTrackingCatalog != nil && trackingCatalogLogicalEqual(localCatalog, merged) {
		return conflicts, false, nil
	}
	rollbackBuckets := func() {
		for _, bucket := range localBuckets {
			_ = s.writeTimeTrackingBucketLocked(bucket)
		}
	}
	for _, bucket := range mergedBuckets {
		if err := s.writeTimeTrackingBucketLocked(bucket); err != nil {
			rollbackBuckets()
			return nil, false, err
		}
	}
	if err := s.writeTimeTrackingCatalogLocked(merged); err != nil {
		rollbackBuckets()
		return nil, false, err
	}
	s.timeTrackingCatalog = &merged
	if err := enableTimeTrackingCapability(&s.manifest); err != nil {
		return nil, false, err
	}
	return conflicts, true, nil
}

func trackingEntriesByID(buckets map[string]timeTrackingBucket) map[string]TimeEntry {
	result := make(map[string]TimeEntry)
	for _, bucket := range buckets {
		for _, entry := range bucket.Entries {
			result[entry.ID] = cloneTimeEntry(entry)
		}
	}
	return result
}

func mergeTimeProjects(local, remote []TimeProject, _, _ []Tombstone) ([]TimeProject, []TimeTrackingConflict) {
	result := make(map[string]TimeProject, len(local)+len(remote))
	for _, value := range local {
		result[value.ID] = value
	}
	conflicts := []TimeTrackingConflict{}
	for _, value := range remote {
		current, found := result[value.ID]
		if found && value.Revision == current.Revision && !reflect.DeepEqual(value, current) {
			conflicts = append(conflicts, newTrackingConflict(TimeProjectRenameConflict, value.ID, "Project edits conflicted.", nil, nil, &current, &value, nil, nil))
		} else if !found || versionIsNewer(value.Revision, value.ModifiedAt, current.Revision, current.ModifiedAt) {
			result[value.ID] = value
		}
	}
	values := make([]TimeProject, 0, len(result))
	for _, value := range result {
		values = append(values, value)
	}
	slices.SortFunc(values, func(a, b TimeProject) int { return stringsCompare(a.ID, b.ID) })
	return values, conflicts
}

func mergeTimeTags(local, remote []TimeTag, _, _ []Tombstone) ([]TimeTag, []TimeTrackingConflict) {
	result := make(map[string]TimeTag, len(local)+len(remote))
	for _, value := range local {
		result[value.ID] = value
	}
	conflicts := []TimeTrackingConflict{}
	for _, value := range remote {
		current, found := result[value.ID]
		if found && value.Revision == current.Revision && !reflect.DeepEqual(value, current) {
			conflicts = append(conflicts, newTrackingConflict(TimeTagRenameConflict, value.ID, "Tag edits conflicted.", nil, nil, nil, nil, &current, &value))
		} else if !found || versionIsNewer(value.Revision, value.ModifiedAt, current.Revision, current.ModifiedAt) {
			result[value.ID] = value
		}
	}
	values := make([]TimeTag, 0, len(result))
	for _, value := range result {
		values = append(values, value)
	}
	slices.SortFunc(values, func(a, b TimeTag) int { return stringsCompare(a.ID, b.ID) })
	return values, conflicts
}

func mergeTimeEntries(local, remote map[string]TimeEntry, deleted []Tombstone) (map[string]TimeEntry, []TimeTrackingConflict) {
	result := make(map[string]TimeEntry, len(local)+len(remote))
	for id, value := range local {
		result[id] = value
	}
	conflicts := []TimeTrackingConflict{}
	for id, value := range remote {
		current, found := result[id]
		if found && value.Revision == current.Revision && !reflect.DeepEqual(value, current) {
			localCopy, remoteCopy := current, value
			conflicts = append(conflicts, newTrackingConflict(TimeEntryEditConflict, id, "Time entry edits conflicted.", &localCopy, &remoteCopy, nil, nil, nil, nil))
		} else if !found || versionIsNewer(value.Revision, value.ModifiedAt, current.Revision, current.ModifiedAt) {
			result[id] = value
		}
	}
	return result, conflicts
}

func mergeTrackingTombstones(left, right []Tombstone) []Tombstone {
	result := slices.Clone(left)
	for _, value := range right {
		result = upsertTombstone(result, value)
	}
	sortTombstones(result)
	return result
}
func removeDeletedProjects(values []TimeProject, deleted []Tombstone) []TimeProject {
	return slices.DeleteFunc(values, func(v TimeProject) bool {
		t, ok := findTombstone(deleted, v.ID)
		return ok && !versionIsNewer(v.Revision, v.ModifiedAt, t.Revision, t.ModifiedAt)
	})
}
func removeDeletedTags(values []TimeTag, deleted []Tombstone) []TimeTag {
	return slices.DeleteFunc(values, func(v TimeTag) bool {
		t, ok := findTombstone(deleted, v.ID)
		return ok && !versionIsNewer(v.Revision, v.ModifiedAt, t.Revision, t.ModifiedAt)
	})
}
func removeDeletedTimeEntries(values map[string]TimeEntry, deleted []Tombstone) map[string]TimeEntry {
	for id, v := range values {
		if t, ok := findTombstone(deleted, id); ok && !versionIsNewer(v.Revision, v.ModifiedAt, t.Revision, t.ModifiedAt) {
			delete(values, id)
		}
	}
	return values
}

func detectTimeEntryInvariantConflicts(entries map[string]TimeEntry) []TimeTrackingConflict {
	values := make([]TimeEntry, 0, len(entries))
	for _, v := range entries {
		values = append(values, v)
	}
	slices.SortFunc(values, func(a, b TimeEntry) int { return stringsCompare(a.ID, b.ID) })
	conflicts := []TimeTrackingConflict{}
	active := []TimeEntry{}
	for _, v := range values {
		if v.EndedAtUTC == "" {
			active = append(active, v)
		}
	}
	if len(active) > 1 {
		a, b := active[0], active[1]
		conflicts = append(conflicts, newTrackingConflict(TimeActiveEntriesConflict, a.ID, "Multiple active timers require resolution.", &a, &b, nil, nil, nil, nil))
	}
	for i := 0; i < len(values); i++ {
		if values[i].EndedAtUTC == "" {
			continue
		}
		aStart, aEnd, _ := parseCompletedTimeEntryRange(values[i].StartedAtUTC, values[i].EndedAtUTC)
		for j := i + 1; j < len(values); j++ {
			if values[j].EndedAtUTC == "" {
				continue
			}
			bStart, bEnd, _ := parseCompletedTimeEntryRange(values[j].StartedAtUTC, values[j].EndedAtUTC)
			if aStart.Before(bEnd) && bStart.Before(aEnd) {
				a, b := values[i], values[j]
				conflicts = append(conflicts, newTrackingConflict(TimeEntryOverlapConflict, a.ID, "Merged time entries overlap.", &a, &b, nil, nil, nil, nil))
			}
		}
	}
	return conflicts
}

func newTrackingConflict(kind TimeTrackingConflictKind, objectID, message string, localEntry, remoteEntry *TimeEntry, localProject, remoteProject *TimeProject, localTag, remoteTag *TimeTag) TimeTrackingConflict {
	raw, _ := json.Marshal([]any{kind, objectID, localEntry, remoteEntry, localProject, remoteProject, localTag, remoteTag})
	hash := sha256.Sum256(raw)
	return TimeTrackingConflict{ID: hex.EncodeToString(hash[:16]), Kind: kind, ObjectID: objectID, Message: message, LocalEntry: localEntry, RemoteEntry: remoteEntry, LocalProject: localProject, RemoteProject: remoteProject, LocalTag: localTag, RemoteTag: remoteTag}
}
func appendUniqueTrackingConflicts(existing []TimeTrackingConflict, additions ...TimeTrackingConflict) []TimeTrackingConflict {
	result := slices.Clone(existing)
	seen := map[string]struct{}{}
	for _, v := range result {
		seen[v.ID] = struct{}{}
	}
	for _, v := range additions {
		if _, ok := seen[v.ID]; !ok {
			result = append(result, v)
			seen[v.ID] = struct{}{}
		}
	}
	return result
}
func trackingMonthIDs(catalogs ...timeTrackingCatalog) map[string]string {
	result := map[string]string{}
	for _, catalog := range catalogs {
		for _, summary := range catalog.Buckets {
			if result[summary.MonthUTC] == "" {
				result[summary.MonthUTC] = summary.ID
			}
		}
	}
	return result
}
func trackingCatalogLogicalEqual(left, right timeTrackingCatalog) bool {
	a := cloneTimeTrackingCatalog(left)
	b := cloneTimeTrackingCatalog(right)
	a.Revision = 0
	a.ModifiedAt = 0
	a.CiphertextHash = ""
	b.Revision = 0
	b.ModifiedAt = 0
	b.CiphertextHash = ""
	return reflect.DeepEqual(a, b)
}
