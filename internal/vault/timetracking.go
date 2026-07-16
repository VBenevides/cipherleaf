package vault

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"
)

const (
	trackingDirectory            = "tracking"
	trackingObjectsDirectory     = "objects"
	trackingCatalogFilename      = "catalog.enc"
	trackingCatalogObjectType    = "tracking-catalog"
	trackingBucketObjectType     = "tracking-bucket"
	trackingCatalogObjectID      = "catalog"
	timeTrackingBucketCacheLimit = 4
)

func (s *Store) loadTimeTrackingCatalogLocked() error {
	catalog, err := s.readTimeTrackingCatalogLocked()
	if err != nil {
		return err
	}
	s.timeTrackingCatalog = &catalog
	if catalog.PendingMove != nil {
		return s.recoverTimeTrackingMoveLocked()
	}
	return nil
}

func (s *Store) readTimeTrackingCatalogLocked() (timeTrackingCatalog, error) {
	plaintext, err := s.readEnvelopeLocked(
		filepath.Join(s.root, trackingDirectory, trackingCatalogFilename),
		trackingCatalogObjectType,
		trackingCatalogObjectID,
	)
	if err != nil {
		return timeTrackingCatalog{}, err
	}
	var catalog timeTrackingCatalog
	if err := json.Unmarshal(plaintext, &catalog); err != nil {
		return timeTrackingCatalog{}, fmt.Errorf("decode tracking catalog: %w", err)
	}
	if catalog.FormatVersion != TimeTrackingCatalogFormatVersion || catalog.VaultID != s.vaultID {
		return timeTrackingCatalog{}, errors.New("tracking catalog belongs to another vault or format version")
	}
	for _, bucket := range catalog.Buckets {
		if !validID(bucket.ID) {
			return timeTrackingCatalog{}, errors.New("tracking catalog contains an invalid bucket ID")
		}
	}
	if pending := catalog.PendingMove; pending != nil {
		if !validID(pending.Entry.ID) || !validID(pending.SourceBucketID) ||
			!validID(pending.DestinationBucketID) || pending.Entry.Revision == 0 {
			return timeTrackingCatalog{}, errors.New("tracking catalog contains an invalid pending move")
		}
		if month, err := timeEntryMonthUTC(pending.Entry); err != nil || month != pending.DestinationMonthUTC {
			return timeTrackingCatalog{}, errors.New("tracking catalog contains an invalid pending move month")
		}
	}
	return catalog, nil
}

func (s *Store) writeTimeTrackingCatalogLocked(catalog timeTrackingCatalog) error {
	if catalog.FormatVersion != TimeTrackingCatalogFormatVersion || catalog.VaultID != s.vaultID {
		return errors.New("tracking catalog belongs to another vault or format version")
	}
	if err := ensurePrivateDirectory(filepath.Join(s.root, trackingDirectory)); err != nil {
		return err
	}
	if err := ensurePrivateDirectory(filepath.Join(s.root, trackingDirectory, trackingObjectsDirectory)); err != nil {
		return err
	}
	plaintext, err := json.Marshal(catalog)
	if err != nil {
		return fmt.Errorf("encode tracking catalog: %w", err)
	}
	if s.timeTrackingWriteHook != nil {
		if err := s.timeTrackingWriteHook("catalog", trackingCatalogObjectID); err != nil {
			return err
		}
	}
	err = s.writeEnvelopeLocked(
		filepath.Join(s.root, trackingDirectory, trackingCatalogFilename),
		trackingCatalogObjectType,
		trackingCatalogObjectID,
		plaintext,
	)
	if err == nil {
		s.clearTimeTrackingBucketCacheLocked()
	}
	return err
}

func (s *Store) readTimeTrackingBucketLocked(id string) (timeTrackingBucket, error) {
	if bucket, found := s.timeTrackingBucketCache[id]; found {
		s.touchTimeTrackingBucketLocked(id)
		return cloneTimeTrackingBucket(bucket), nil
	}
	path, err := s.timeTrackingBucketPathLocked(id)
	if err != nil {
		return timeTrackingBucket{}, err
	}
	plaintext, err := s.readEnvelopeLocked(path, trackingBucketObjectType, id)
	if err != nil {
		return timeTrackingBucket{}, err
	}
	var bucket timeTrackingBucket
	if err := json.Unmarshal(plaintext, &bucket); err != nil {
		return timeTrackingBucket{}, fmt.Errorf("decode tracking bucket: %w", err)
	}
	if bucket.FormatVersion != TimeTrackingCatalogFormatVersion || bucket.ID != id {
		return timeTrackingBucket{}, errors.New("tracking bucket has an invalid identity or format version")
	}
	if s.timeTrackingBucketRead != nil {
		s.timeTrackingBucketRead(id)
	}
	s.cacheTimeTrackingBucketLocked(bucket)
	return cloneTimeTrackingBucket(bucket), nil
}

func (s *Store) writeTimeTrackingBucketLocked(bucket timeTrackingBucket) error {
	path, err := s.timeTrackingBucketPathLocked(bucket.ID)
	if err != nil {
		return err
	}
	if bucket.FormatVersion != TimeTrackingCatalogFormatVersion {
		return errors.New("tracking bucket has an invalid format version")
	}
	if err := ensurePrivateDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	plaintext, err := json.Marshal(bucket)
	if err != nil {
		return fmt.Errorf("encode tracking bucket: %w", err)
	}
	compressed, err := compressTimeTrackingPayload(plaintext)
	if err != nil {
		return err
	}
	if s.timeTrackingWriteHook != nil {
		if err := s.timeTrackingWriteHook("bucket", bucket.ID); err != nil {
			return err
		}
	}
	err = s.writeEnvelopePayloadLocked(path, trackingBucketObjectType, bucket.ID, compressed, "gzip")
	if err == nil {
		s.clearTimeTrackingBucketCacheLocked()
	}
	return err
}

func (s *Store) readTimeTrackingBucketsForRangeLocked(startUTC, endUTC string) ([]timeTrackingBucket, error) {
	start, err := time.Parse(time.RFC3339Nano, startUTC)
	if err != nil || utcOffset(start) != 0 {
		return nil, errors.New("invalid tracking range start")
	}
	end, err := time.Parse(time.RFC3339Nano, endUTC)
	if err != nil || utcOffset(end) != 0 || !end.After(start) {
		return nil, errors.New("invalid tracking range end")
	}
	result := make([]timeTrackingBucket, 0)
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
		result = append(result, bucket)
	}
	return result, nil
}

func (s *Store) moveTimeTrackingEntryLocked(entry TimeEntry, sourceBucketID string) error {
	if s.timeTrackingCatalog == nil || s.timeTrackingCatalog.PendingMove != nil {
		return errors.New("tracking catalog is unavailable or already recovering a move")
	}
	month, err := timeEntryMonthUTC(entry)
	if err != nil {
		return err
	}
	destinationID := ""
	for _, summary := range s.timeTrackingCatalog.Buckets {
		if summary.MonthUTC == month {
			destinationID = summary.ID
			break
		}
	}
	if destinationID == sourceBucketID {
		return errors.New("tracking entry remains in its current UTC month")
	}
	if destinationID == "" {
		destinationID, err = randomID(16)
		if err != nil {
			return err
		}
	}
	catalog := *s.timeTrackingCatalog
	catalog.Buckets = slices.Clone(catalog.Buckets)
	if !hasTimeTrackingBucket(catalog.Buckets, destinationID) {
		catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: destinationID, MonthUTC: month})
	}
	catalog.PendingMove = &timeTrackingPendingMove{
		Entry: entry, SourceBucketID: sourceBucketID,
		DestinationBucketID: destinationID, DestinationMonthUTC: month,
	}
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		return err
	}
	s.timeTrackingCatalog = &catalog
	return s.recoverTimeTrackingMoveLocked()
}

func (s *Store) recoverTimeTrackingMoveLocked() error {
	pending := s.timeTrackingCatalog.PendingMove
	if pending == nil {
		return nil
	}
	source, err := s.readTimeTrackingBucketLocked(pending.SourceBucketID)
	if err != nil {
		return fmt.Errorf("read tracking move source: %w", err)
	}
	destination, err := s.readTimeTrackingBucketLocked(pending.DestinationBucketID)
	if err != nil {
		if !hasTimeTrackingBucketEntries(s.timeTrackingCatalog.Buckets, pending.DestinationBucketID) {
			destination = timeTrackingBucket{FormatVersion: TimeTrackingCatalogFormatVersion, ID: pending.DestinationBucketID, Entries: []TimeEntry{}}
		} else {
			return fmt.Errorf("read tracking move destination: %w", err)
		}
	}
	authoritative := pending.Entry
	for _, bucket := range []timeTrackingBucket{source, destination} {
		for _, candidate := range bucket.Entries {
			if candidate.ID == authoritative.ID && (candidate.Revision > authoritative.Revision ||
				(candidate.Revision == authoritative.Revision && candidate.ModifiedAt > authoritative.ModifiedAt)) {
				authoritative = candidate
			}
		}
	}
	source.Entries = removeTimeTrackingEntry(source.Entries, authoritative.ID)
	destination.Entries = removeTimeTrackingEntry(destination.Entries, authoritative.ID)
	authoritativeMonth, err := timeEntryMonthUTC(authoritative)
	if err != nil {
		return err
	}
	if authoritativeMonth == pending.DestinationMonthUTC {
		destination.Entries = append(destination.Entries, authoritative)
	} else {
		source.Entries = append(source.Entries, authoritative)
	}
	if err := s.writeTimeTrackingBucketLocked(destination); err != nil {
		return err
	}
	if err := s.writeTimeTrackingBucketLocked(source); err != nil {
		return err
	}
	catalog := *s.timeTrackingCatalog
	catalog.Buckets = slices.Clone(catalog.Buckets)
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, source)
	catalog.Buckets = updateTimeTrackingBucketSummary(catalog.Buckets, destination)
	catalog.PendingMove = nil
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		return err
	}
	s.timeTrackingCatalog = &catalog
	return nil
}

func (s *Store) timeTrackingBucketPathLocked(id string) (string, error) {
	if !validID(id) {
		return "", errors.New("invalid tracking bucket ID")
	}
	return filepath.Join(s.root, trackingDirectory, trackingObjectsDirectory, id[:2], id+".enc"), nil
}

func (s *Store) clearTimeTrackingBucketCacheLocked() {
	s.timeTrackingBucketCache = nil
	s.timeTrackingBucketOrder = nil
}

func (s *Store) cacheTimeTrackingBucketLocked(bucket timeTrackingBucket) {
	if s.timeTrackingBucketCache == nil {
		s.timeTrackingBucketCache = make(map[string]timeTrackingBucket)
	}
	s.timeTrackingBucketCache[bucket.ID] = cloneTimeTrackingBucket(bucket)
	s.touchTimeTrackingBucketLocked(bucket.ID)
	for len(s.timeTrackingBucketOrder) > timeTrackingBucketCacheLimit {
		oldest := s.timeTrackingBucketOrder[0]
		s.timeTrackingBucketOrder = s.timeTrackingBucketOrder[1:]
		delete(s.timeTrackingBucketCache, oldest)
	}
}

func (s *Store) touchTimeTrackingBucketLocked(id string) {
	for index, cachedID := range s.timeTrackingBucketOrder {
		if cachedID == id {
			s.timeTrackingBucketOrder = append(s.timeTrackingBucketOrder[:index], s.timeTrackingBucketOrder[index+1:]...)
			break
		}
	}
	s.timeTrackingBucketOrder = append(s.timeTrackingBucketOrder, id)
}

func cloneTimeTrackingBucket(bucket timeTrackingBucket) timeTrackingBucket {
	result := bucket
	result.Entries = slices.Clone(bucket.Entries)
	for index := range result.Entries {
		result.Entries[index].TagIDs = slices.Clone(result.Entries[index].TagIDs)
	}
	return result
}

func timeTrackingBucketIntersects(summary timeTrackingBucketSummary, start, end time.Time) (bool, error) {
	month, err := time.Parse("2006-01", summary.MonthUTC)
	if err != nil || month.Format("2006-01") != summary.MonthUTC {
		return false, errors.New("tracking catalog contains an invalid bucket month")
	}
	monthEnd := month.AddDate(0, 1, 0)
	if month.Before(end) && monthEnd.After(start) {
		return true, nil
	}
	if summary.MinStartedAt == "" {
		return false, nil
	}
	minStarted, err := time.Parse(time.RFC3339Nano, summary.MinStartedAt)
	if err != nil {
		return false, errors.New("tracking catalog contains invalid bucket coverage")
	}
	if !minStarted.Before(end) {
		return false, nil
	}
	if summary.HasActiveEntry {
		return true, nil
	}
	maxEnded, err := time.Parse(time.RFC3339Nano, summary.MaxEndedAt)
	if err != nil {
		return false, errors.New("tracking catalog contains invalid bucket coverage")
	}
	return maxEnded.After(start), nil
}

func timeEntryMonthUTC(entry TimeEntry) (string, error) {
	started, err := time.Parse(time.RFC3339Nano, entry.StartedAtUTC)
	if err != nil || utcOffset(started) != 0 {
		return "", errors.New("tracking entry start must be UTC RFC 3339")
	}
	return started.Format("2006-01"), nil
}

func utcOffset(value time.Time) int {
	_, offset := value.Zone()
	return offset
}

func hasTimeTrackingBucket(summaries []timeTrackingBucketSummary, id string) bool {
	return slices.ContainsFunc(summaries, func(summary timeTrackingBucketSummary) bool {
		return summary.ID == id
	})
}

func hasTimeTrackingBucketEntries(summaries []timeTrackingBucketSummary, id string) bool {
	for _, summary := range summaries {
		if summary.ID == id {
			return summary.MinStartedAt != "" || summary.MaxEndedAt != "" || summary.HasActiveEntry || summary.Revision != 0
		}
	}
	return false
}

func removeTimeTrackingEntry(entries []TimeEntry, id string) []TimeEntry {
	result := make([]TimeEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != id {
			result = append(result, entry)
		}
	}
	return result
}

func updateTimeTrackingBucketSummary(summaries []timeTrackingBucketSummary, bucket timeTrackingBucket) []timeTrackingBucketSummary {
	index := slices.IndexFunc(summaries, func(summary timeTrackingBucketSummary) bool {
		return summary.ID == bucket.ID
	})
	if index < 0 {
		return summaries
	}
	summary := summaries[index]
	summary.MinStartedAt = ""
	summary.MaxEndedAt = ""
	summary.HasActiveEntry = false
	for _, entry := range bucket.Entries {
		if summary.MinStartedAt == "" || trackingTimestampBefore(entry.StartedAtUTC, summary.MinStartedAt) {
			summary.MinStartedAt = entry.StartedAtUTC
		}
		if entry.EndedAtUTC == "" {
			summary.HasActiveEntry = true
		} else if summary.MaxEndedAt == "" || trackingTimestampBefore(summary.MaxEndedAt, entry.EndedAtUTC) {
			summary.MaxEndedAt = entry.EndedAtUTC
		}
		if entry.ModifiedAt > summary.ModifiedAt {
			summary.ModifiedAt = entry.ModifiedAt
		}
		if entry.Revision > summary.Revision {
			summary.Revision = entry.Revision
		}
	}
	summary.CiphertextHash = ""
	summaries[index] = summary
	return summaries
}

func trackingTimestampBefore(left, right string) bool {
	leftTime, leftErr := time.Parse(time.RFC3339Nano, left)
	rightTime, rightErr := time.Parse(time.RFC3339Nano, right)
	if leftErr == nil && rightErr == nil {
		return leftTime.Before(rightTime)
	}
	return left < right
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create private tracking folder: %w", err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("set tracking folder permissions: %w", err)
	}
	return nil
}

func compressTimeTrackingPayload(plaintext []byte) ([]byte, error) {
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return nil, fmt.Errorf("create tracking compressor: %w", err)
	}
	if _, err := writer.Write(plaintext); err != nil {
		writer.Close()
		return nil, fmt.Errorf("compress tracking bucket: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("finish tracking compression: %w", err)
	}
	return compressed.Bytes(), nil
}

func decompressPayload(compressed []byte, limit int64, name string) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("compressed encrypted %s is damaged", name)
	}
	defer reader.Close()
	plaintext, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, fmt.Errorf("decompress encrypted %s", name)
	}
	if int64(len(plaintext)) > limit {
		return nil, fmt.Errorf("compressed encrypted %s exceeds the supported size", name)
	}
	return plaintext, nil
}
