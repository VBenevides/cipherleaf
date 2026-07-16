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
)

const (
	trackingDirectory         = "tracking"
	trackingObjectsDirectory  = "objects"
	trackingCatalogFilename   = "catalog.enc"
	trackingCatalogObjectType = "tracking-catalog"
	trackingBucketObjectType  = "tracking-bucket"
	trackingCatalogObjectID   = "catalog"
)

func (s *Store) loadTimeTrackingCatalogLocked() error {
	catalog, err := s.readTimeTrackingCatalogLocked()
	if err != nil {
		return err
	}
	s.timeTrackingCatalog = &catalog
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
	return s.writeEnvelopeLocked(
		filepath.Join(s.root, trackingDirectory, trackingCatalogFilename),
		trackingCatalogObjectType,
		trackingCatalogObjectID,
		plaintext,
	)
}

func (s *Store) readTimeTrackingBucketLocked(id string) (timeTrackingBucket, error) {
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
	return bucket, nil
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
	return s.writeEnvelopePayloadLocked(path, trackingBucketObjectType, bucket.ID, compressed, "gzip")
}

func (s *Store) timeTrackingBucketPathLocked(id string) (string, error) {
	if !validID(id) {
		return "", errors.New("invalid tracking bucket ID")
	}
	return filepath.Join(s.root, trackingDirectory, trackingObjectsDirectory, id[:2], id+".enc"), nil
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
