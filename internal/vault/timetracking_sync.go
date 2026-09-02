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
	inventory, trackingRoot, err := s.readRemoteTrackingInventoryLocked(source)
	if err != nil || inventory == nil {
		return nil, err
	}
	catalog, err := s.readRemoteTrackingCatalogLocked(trackingRoot, *inventory)
	if err != nil {
		return nil, err
	}
	buckets, err := s.readRemoteTrackingBucketsLocked(trackingRoot, *inventory, catalog)
	if err != nil {
		return nil, err
	}
	if err := validateRemoteTrackingPaths(trackingRoot, buckets); err != nil {
		return nil, err
	}
	if err := validateRemoteActiveTrackingEntry(catalog, buckets); err != nil {
		return nil, err
	}
	return &authenticatedTrackingSnapshot{Inventory: *inventory, Catalog: catalog, Buckets: buckets}, nil
}

func (s *Store) readRemoteTrackingInventoryLocked(source string) (*remoteTrackingInventory, string, error) {
	inventoryPath := filepath.Join(source, syncDirectory, syncTrackingFile)
	trackingRoot := filepath.Join(source, trackingDirectory)
	if _, err := os.Stat(inventoryPath); errors.Is(err, os.ErrNotExist) {
		if directoryExists(trackingRoot) {
			return nil, trackingRoot, errors.New("remote tracking folder is absent from its inventory")
		}
		return nil, trackingRoot, nil
	} else if err != nil {
		return nil, trackingRoot, fmt.Errorf("inspect remote tracking inventory: %w", err)
	}
	plaintext, err := s.readEnvelopeFileLocked(inventoryPath, "sync-tracking", "sync-tracking")
	if err != nil {
		return nil, trackingRoot, fmt.Errorf("authenticate remote tracking inventory: %w", err)
	}
	var inventory remoteTrackingInventory
	if err := json.Unmarshal(plaintext, &inventory); err != nil ||
		inventory.FormatVersion != TimeTrackingCatalogFormatVersion || inventory.VaultID != s.vaultID {
		return nil, trackingRoot, errors.New("remote tracking inventory is damaged or belongs to another vault")
	}
	if inventory.Catalog.ID != trackingCatalogObjectID || !validTrackingHash(inventory.Catalog.CiphertextHash) {
		return nil, trackingRoot, errors.New("remote tracking inventory contains an invalid catalog")
	}
	return &inventory, trackingRoot, nil
}

func (s *Store) readRemoteTrackingCatalogLocked(root string, inventory remoteTrackingInventory) (timeTrackingCatalog, error) {
	catalogPath := filepath.Join(root, trackingCatalogFilename)
	catalogCiphertext, err := os.ReadFile(catalogPath)
	if err != nil || ciphertextHash(catalogCiphertext) != inventory.Catalog.CiphertextHash {
		return timeTrackingCatalog{}, errors.New("remote tracking catalog does not match its inventory hash")
	}
	catalogPlaintext, err := s.readEnvelopeFileLocked(catalogPath, trackingCatalogObjectType, trackingCatalogObjectID)
	if err != nil {
		return timeTrackingCatalog{}, fmt.Errorf("authenticate remote tracking catalog: %w", err)
	}
	var catalog timeTrackingCatalog
	if err := json.Unmarshal(catalogPlaintext, &catalog); err != nil ||
		catalog.FormatVersion != TimeTrackingCatalogFormatVersion || catalog.VaultID != s.vaultID ||
		catalog.Revision != inventory.Catalog.Revision || catalog.ModifiedAt != inventory.Catalog.ModifiedAt {
		return timeTrackingCatalog{}, errors.New("remote tracking catalog metadata is inconsistent")
	}
	if catalog.PendingMove != nil {
		return timeTrackingCatalog{}, errors.New("remote tracking catalog contains an unfinished local move")
	}
	if err := validateTrackingCatalogObjects(catalog); err != nil {
		return timeTrackingCatalog{}, err
	}
	return catalog, nil
}

func (s *Store) readRemoteTrackingBucketsLocked(
	root string,
	inventory remoteTrackingInventory,
	catalog timeTrackingCatalog,
) (map[string]timeTrackingBucket, error) {
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
		bucket, err := s.readRemoteTrackingBucketLocked(root, item, summary, catalog, seenEntries)
		if err != nil {
			return nil, err
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
	return buckets, nil
}

func (s *Store) readRemoteTrackingBucketLocked(
	root string,
	item remoteTrackingObject,
	summary timeTrackingBucketSummary,
	catalog timeTrackingCatalog,
	seenEntries map[string]struct{},
) (timeTrackingBucket, error) {
	path := filepath.Join(root, trackingObjectsDirectory, item.ID[:2], item.ID+".enc")
	ciphertext, err := os.ReadFile(path)
	if err != nil || ciphertextHash(ciphertext) != item.CiphertextHash {
		return timeTrackingBucket{}, fmt.Errorf("remote tracking bucket %s does not match its inventory hash", item.ID)
	}
	bucketPlaintext, err := s.readEnvelopeFileLocked(path, trackingBucketObjectType, item.ID)
	if err != nil {
		return timeTrackingBucket{}, fmt.Errorf("authenticate remote tracking bucket %s: %w", item.ID, err)
	}
	var bucket timeTrackingBucket
	if err := json.Unmarshal(bucketPlaintext, &bucket); err != nil || bucket.FormatVersion != TimeTrackingCatalogFormatVersion || bucket.ID != item.ID {
		return timeTrackingBucket{}, errors.New("remote tracking bucket is damaged")
	}
	for _, entry := range bucket.Entries {
		if err := validateStoredTimeEntry(entry, summary.MonthUTC); err != nil {
			return timeTrackingBucket{}, err
		}
		if _, duplicate := seenEntries[entry.ID]; duplicate {
			return timeTrackingBucket{}, errors.New("remote tracking data contains a duplicate entry")
		}
		seenEntries[entry.ID] = struct{}{}
		clientID := entry.ClientID
		if clientID == "" {
			clientID = trackingProjectClientID(catalog, entry.ProjectID)
		}
		if err := validateTimeEntryReferences(catalog, clientID, entry.ProjectID, entry.TagIDs, false); err != nil {
			return timeTrackingBucket{}, errors.New("remote tracking entry references a missing label")
		}
	}
	return bucket, nil
}

func validateRemoteActiveTrackingEntry(catalog timeTrackingCatalog, buckets map[string]timeTrackingBucket) error {
	if catalog.ActiveEntry == nil {
		return nil
	}
	bucket, found := buckets[catalog.ActiveEntry.BucketID]
	if !found || !slices.ContainsFunc(bucket.Entries, func(entry TimeEntry) bool {
		return entry.ID == catalog.ActiveEntry.EntryID && entry.EndedAtUTC == ""
	}) {
		return errors.New("remote tracking active entry location is invalid")
	}
	return nil
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

func restoreTrackingCiphertext(source, target string, remote *authenticatedTrackingSnapshot) error {
	sourceRoot := filepath.Join(source, trackingDirectory)
	targetRoot := filepath.Join(target, trackingDirectory)
	if err := ensurePrivateDirectory(filepath.Join(targetRoot, trackingObjectsDirectory)); err != nil {
		return err
	}
	for _, relative := range []string{trackingCatalogFilename, trackingCatalogFilename + ".bak"} {
		data, err := os.ReadFile(filepath.Join(sourceRoot, trackingCatalogFilename))
		if err != nil {
			return fmt.Errorf("read restored tracking catalog: %w", err)
		}
		if err := writeBytesAtomic(filepath.Join(targetRoot, relative), data); err != nil {
			return fmt.Errorf("stage restored tracking catalog: %w", err)
		}
	}
	for id := range remote.Buckets {
		sourcePath := filepath.Join(sourceRoot, trackingObjectsDirectory, id[:2], id+".enc")
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			return fmt.Errorf("read restored tracking bucket: %w", err)
		}
		directory := filepath.Join(targetRoot, trackingObjectsDirectory, id[:2])
		if err := ensurePrivateDirectory(directory); err != nil {
			return err
		}
		for _, suffix := range []string{".enc", ".enc.bak"} {
			if err := writeBytesAtomic(filepath.Join(directory, id+suffix), data); err != nil {
				return fmt.Errorf("stage restored tracking bucket: %w", err)
			}
		}
	}
	return nil
}

func validateTrackingCatalogObjects(catalog timeTrackingCatalog) error {
	clientIDs, err := validateTrackingClients(catalog.Clients)
	if err != nil {
		return err
	}
	projectIDs, err := validateTrackingProjects(catalog.Projects, clientIDs, catalog.DeletedClients)
	if err != nil {
		return err
	}
	tagIDs, err := validateTrackingTags(catalog.Tags)
	if err != nil {
		return err
	}
	if err := validateTrackingBuckets(catalog.Buckets); err != nil {
		return err
	}
	if err := validateTrackingTombstones(catalog.DeletedEntries, nil); err != nil {
		return err
	}
	if err := validateTrackingTombstones(catalog.DeletedClients, clientIDs); err != nil {
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

func validateTrackingClients(values []TimeClient) (map[string]struct{}, error) {
	ids := make(map[string]struct{}, len(values))
	for _, value := range values {
		name, nameErr := normalizeTrackingLabelName(value.Name)
		if !validID(value.ID) || value.Revision == 0 || nameErr != nil || name != value.Name {
			return nil, errors.New("remote tracking catalog contains an invalid client")
		}
		if _, duplicate := ids[value.ID]; duplicate {
			return nil, errors.New("remote tracking catalog contains a duplicate client")
		}
		ids[value.ID] = struct{}{}
	}
	return ids, nil
}

func validateTrackingProjects(values []TimeProject, clientIDs map[string]struct{}, deleted []Tombstone) (map[string]struct{}, error) {
	ids := make(map[string]struct{}, len(values))
	for _, value := range values {
		name, nameErr := normalizeTrackingLabelName(value.Name)
		if !validID(value.ID) || value.Revision == 0 || nameErr != nil || name != value.Name {
			return nil, errors.New("remote tracking catalog contains an invalid project")
		}
		if _, duplicate := ids[value.ID]; duplicate {
			return nil, errors.New("remote tracking catalog contains a duplicate project")
		}
		if value.ClientID != "" {
			if _, found := clientIDs[value.ClientID]; !found && !trackingTombstoneExists(deleted, value.ClientID) {
				return nil, errors.New("remote tracking project references a missing client")
			}
		}
		ids[value.ID] = struct{}{}
	}
	return ids, nil
}

func validateTrackingTags(values []TimeTag) (map[string]struct{}, error) {
	ids := make(map[string]struct{}, len(values))
	for _, value := range values {
		name, nameErr := normalizeTrackingLabelName(value.Name)
		if !validID(value.ID) || value.Revision == 0 || nameErr != nil || name != value.Name {
			return nil, errors.New("remote tracking catalog contains an invalid tag")
		}
		if _, duplicate := ids[value.ID]; duplicate {
			return nil, errors.New("remote tracking catalog contains a duplicate tag")
		}
		ids[value.ID] = struct{}{}
	}
	return ids, nil
}

func validateTrackingBuckets(values []timeTrackingBucketSummary) error {
	ids := make(map[string]struct{}, len(values))
	months := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validID(value.ID) {
			return errors.New("remote tracking catalog contains an invalid bucket")
		}
		if _, err := time.Parse("2006-01", value.MonthUTC); err != nil {
			return errors.New("remote tracking catalog contains an invalid bucket month")
		}
		if _, duplicate := ids[value.ID]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate bucket")
		}
		if _, duplicate := months[value.MonthUTC]; duplicate {
			return errors.New("remote tracking catalog contains a duplicate month")
		}
		ids[value.ID] = struct{}{}
		months[value.MonthUTC] = struct{}{}
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
	localCatalog, localBuckets, hadLocalCatalog, err := s.readLocalTimeTrackingStateLocked()
	if err != nil {
		return nil, false, err
	}
	merged, entries, conflicts := mergeTimeTrackingCatalogs(localCatalog, remote.Catalog, localBuckets, remote.Buckets)
	mergedBuckets, err := buildMergedTimeTrackingBuckets(localCatalog, remote.Catalog, entries, &merged)
	if err != nil {
		return nil, false, err
	}
	if s.timeTrackingCatalog != nil && trackingCatalogLogicalEqual(localCatalog, merged) {
		return conflicts, false, nil
	}
	rollbackBuckets := func() error {
		return s.rollbackTimeTrackingMergeLocked(localCatalog, localBuckets, mergedBuckets, hadLocalCatalog)
	}
	for _, bucket := range mergedBuckets {
		if err := s.writeTimeTrackingBucketLocked(bucket); err != nil {
			return nil, false, errors.Join(err, rollbackBuckets())
		}
	}
	if err := s.writeTimeTrackingCatalogLocked(merged); err != nil {
		return nil, false, errors.Join(err, rollbackBuckets())
	}
	s.timeTrackingCatalog = &merged
	if err := enableTimeTrackingCapability(&s.manifest); err != nil {
		return nil, false, err
	}
	return conflicts, true, nil
}

func (s *Store) readLocalTimeTrackingStateLocked() (timeTrackingCatalog, map[string]timeTrackingBucket, bool, error) {
	localCatalog := newTimeTrackingCatalog(s.vaultID)
	localBuckets := make(map[string]timeTrackingBucket)
	if s.timeTrackingCatalog == nil {
		return localCatalog, localBuckets, false, nil
	}
	localCatalog = cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
	for _, summary := range localCatalog.Buckets {
		bucket, err := s.readTimeTrackingBucketLocked(summary.ID)
		if err != nil {
			return timeTrackingCatalog{}, nil, false, err
		}
		localBuckets[summary.ID] = bucket
	}
	return localCatalog, localBuckets, true, nil
}

func mergeTimeTrackingCatalogs(
	localCatalog, remoteCatalog timeTrackingCatalog,
	localBuckets, remoteBuckets map[string]timeTrackingBucket,
) (timeTrackingCatalog, map[string]TimeEntry, []TimeTrackingConflict) {
	localEntries := trackingEntriesByID(localBuckets)
	remoteEntries := trackingEntriesByID(remoteBuckets)
	clients, clientConflicts := mergeTimeClients(localCatalog.Clients, remoteCatalog.Clients, localCatalog.DeletedClients, remoteCatalog.DeletedClients)
	projects, projectConflicts := mergeTimeProjects(localCatalog.Projects, remoteCatalog.Projects, localCatalog.DeletedProjects, remoteCatalog.DeletedProjects)
	tags, tagConflicts := mergeTimeTags(localCatalog.Tags, remoteCatalog.Tags, localCatalog.DeletedTags, remoteCatalog.DeletedTags)
	deletedClients := mergeTrackingTombstones(localCatalog.DeletedClients, remoteCatalog.DeletedClients)
	deletedProjects := mergeTrackingTombstones(localCatalog.DeletedProjects, remoteCatalog.DeletedProjects)
	deletedTags := mergeTrackingTombstones(localCatalog.DeletedTags, remoteCatalog.DeletedTags)
	deletedEntries := mergeTrackingTombstones(localCatalog.DeletedEntries, remoteCatalog.DeletedEntries)
	entries, entryConflicts := mergeTimeEntries(localEntries, remoteEntries, deletedEntries)
	clients = removeDeletedClients(clients, deletedClients)
	projects = removeDeletedProjects(projects, deletedProjects)
	tags = removeDeletedTags(tags, deletedTags)
	entries = removeDeletedTimeEntries(entries, deletedEntries)
	conflicts := append(clientConflicts, projectConflicts...)
	conflicts = append(conflicts, tagConflicts...)
	conflicts = append(conflicts, entryConflicts...)
	conflicts = append(conflicts, detectTimeEntryInvariantConflicts(entries)...)
	conflicts = appendUniqueTrackingConflicts(localCatalog.Conflicts, conflicts...)
	merged := newTimeTrackingCatalog(localCatalog.VaultID)
	merged.Clients = clients
	merged.Projects = projects
	merged.Tags = tags
	merged.DeletedClients = deletedClients
	merged.DeletedProjects = deletedProjects
	merged.DeletedTags = deletedTags
	merged.DeletedEntries = deletedEntries
	merged.Conflicts = conflicts
	merged.Revision = max(localCatalog.Revision, remoteCatalog.Revision) + 1
	merged.ModifiedAt = max(localCatalog.ModifiedAt, remoteCatalog.ModifiedAt)
	return merged, entries, conflicts
}

func buildMergedTimeTrackingBuckets(
	localCatalog, remoteCatalog timeTrackingCatalog,
	entries map[string]TimeEntry,
	merged *timeTrackingCatalog,
) (map[string]timeTrackingBucket, error) {
	monthIDs := trackingMonthIDs(localCatalog, remoteCatalog)
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
				return nil, err
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
	for _, summary := range merged.Buckets {
		for _, entry := range mergedBuckets[summary.ID].Entries {
			if entry.EndedAtUTC == "" {
				merged.ActiveEntry = &timeTrackingEntryLocation{EntryID: entry.ID, BucketID: summary.ID}
				return mergedBuckets, nil
			}
		}
	}
	return mergedBuckets, nil
}

func removeTimeTrackingFiles(path string) error {
	var removeErr error
	for _, candidate := range []string{path, path + ".bak"} {
		if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
			removeErr = errors.Join(removeErr, err)
		}
	}
	return removeErr
}

func (s *Store) rollbackTimeTrackingMergeLocked(
	localCatalog timeTrackingCatalog,
	localBuckets, mergedBuckets map[string]timeTrackingBucket,
	hadLocalCatalog bool,
) error {
	var rollbackErr error
	for id := range mergedBuckets {
		if _, existed := localBuckets[id]; existed {
			continue
		}
		path, err := s.timeTrackingBucketPathLocked(id)
		if err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		rollbackErr = errors.Join(rollbackErr, removeTimeTrackingFiles(path))
	}
	for _, bucket := range localBuckets {
		rollbackErr = errors.Join(rollbackErr, s.writeTimeTrackingBucketLocked(bucket))
	}
	if hadLocalCatalog {
		rollbackErr = errors.Join(rollbackErr, s.writeTimeTrackingCatalogLocked(localCatalog))
	} else {
		path := filepath.Join(s.root, trackingDirectory, trackingCatalogFilename)
		rollbackErr = errors.Join(rollbackErr, removeTimeTrackingFiles(path))
	}
	s.clearTimeTrackingBucketCacheLocked()
	return rollbackErr
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

func mergeTimeClients(local, remote []TimeClient, _, _ []Tombstone) ([]TimeClient, []TimeTrackingConflict) {
	result := make(map[string]TimeClient, len(local)+len(remote))
	for _, value := range local {
		result[value.ID] = value
	}
	conflicts := []TimeTrackingConflict{}
	for _, value := range remote {
		current, found := result[value.ID]
		if found && value.Revision == current.Revision && !reflect.DeepEqual(value, current) {
			localCopy, remoteCopy := current, value
			conflicts = append(conflicts, newClientTrackingConflict(value.ID, &localCopy, &remoteCopy))
		} else if !found || versionIsNewer(value.Revision, value.ModifiedAt, current.Revision, current.ModifiedAt) {
			result[value.ID] = value
		}
	}
	values := make([]TimeClient, 0, len(result))
	for _, value := range result {
		values = append(values, value)
	}
	slices.SortFunc(values, func(a, b TimeClient) int { return stringsCompare(a.ID, b.ID) })
	return values, conflicts
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
			conflicts = append(conflicts, newTrackingConflict(TimeProjectRenameConflict, value.ID, "Project edits conflicted.", trackingConflictDetails{localProject: &current, remoteProject: &value}))
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
			conflicts = append(conflicts, newTrackingConflict(TimeTagRenameConflict, value.ID, "Tag edits conflicted.", trackingConflictDetails{localTag: &current, remoteTag: &value}))
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
			conflicts = append(conflicts, newTrackingConflict(TimeEntryEditConflict, id, "Time entry edits conflicted.", trackingConflictDetails{localEntry: &localCopy, remoteEntry: &remoteCopy}))
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
func removeDeletedClients(values []TimeClient, deleted []Tombstone) []TimeClient {
	return slices.DeleteFunc(values, func(v TimeClient) bool {
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
		conflicts = append(conflicts, newTrackingConflict(TimeActiveEntriesConflict, a.ID, "Multiple active timers require resolution.", trackingConflictDetails{localEntry: &a, remoteEntry: &b}))
	}
	return conflicts
}

type trackingConflictDetails struct {
	localEntry, remoteEntry     *TimeEntry
	localProject, remoteProject *TimeProject
	localTag, remoteTag         *TimeTag
}

func newTrackingConflict(kind TimeTrackingConflictKind, objectID, message string, details trackingConflictDetails) TimeTrackingConflict {
	raw, _ := json.Marshal([]any{kind, objectID, details.localEntry, details.remoteEntry, details.localProject, details.remoteProject, details.localTag, details.remoteTag})
	hash := sha256.Sum256(raw)
	return TimeTrackingConflict{ID: hex.EncodeToString(hash[:16]), Kind: kind, ObjectID: objectID, Message: message, LocalEntry: details.localEntry, RemoteEntry: details.remoteEntry, LocalProject: details.localProject, RemoteProject: details.remoteProject, LocalTag: details.localTag, RemoteTag: details.remoteTag}
}
func newClientTrackingConflict(objectID string, local, remote *TimeClient) TimeTrackingConflict {
	raw, _ := json.Marshal([]any{TimeClientRenameConflict, objectID, local, remote})
	hash := sha256.Sum256(raw)
	return TimeTrackingConflict{ID: hex.EncodeToString(hash[:16]), Kind: TimeClientRenameConflict, ObjectID: objectID, Message: "Client edits conflicted.", LocalClient: local, RemoteClient: remote}
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
