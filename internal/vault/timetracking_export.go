package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

func (s *Store) exportTimeTrackingLocked(destination string) error {
	targetRoot := filepath.Join(destination, trackingDirectory)
	inventoryPath := filepath.Join(destination, syncDirectory, syncTrackingFile)
	if s.timeTrackingCatalog == nil {
		if err := os.RemoveAll(targetRoot); err != nil {
			return fmt.Errorf("remove stale remote tracking folder: %w", err)
		}
		if err := os.Remove(inventoryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale remote tracking inventory: %w", err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Join(targetRoot, trackingObjectsDirectory), 0o700); err != nil {
		return fmt.Errorf("create remote tracking folder: %w", err)
	}
	catalogSource := filepath.Join(s.root, trackingDirectory, trackingCatalogFilename)
	catalogTarget := filepath.Join(targetRoot, trackingCatalogFilename)
	catalogHash, err := copyAndHashTrackingCiphertext(catalogSource, catalogTarget)
	if err != nil {
		return fmt.Errorf("stage encrypted tracking catalog: %w", err)
	}
	inventory := remoteTrackingInventory{
		FormatVersion: TimeTrackingCatalogFormatVersion,
		VaultID:       s.vaultID,
		Catalog: remoteTrackingObject{
			ID: trackingCatalogObjectID, CiphertextHash: catalogHash,
			Revision: s.timeTrackingCatalog.Revision, ModifiedAt: s.timeTrackingCatalog.ModifiedAt,
		},
		Buckets: make([]remoteTrackingObject, 0, len(s.timeTrackingCatalog.Buckets)),
	}
	expected := make(map[string]struct{}, len(s.timeTrackingCatalog.Buckets))
	for _, summary := range s.timeTrackingCatalog.Buckets {
		source, err := s.timeTrackingBucketPathLocked(summary.ID)
		if err != nil {
			return err
		}
		target := filepath.Join(targetRoot, trackingObjectsDirectory, summary.ID[:2], summary.ID+".enc")
		hash, err := copyAndHashTrackingCiphertext(source, target)
		if err != nil {
			return fmt.Errorf("stage encrypted tracking bucket %s: %w", summary.ID, err)
		}
		expected[filepath.Clean(target)] = struct{}{}
		inventory.Buckets = append(inventory.Buckets, remoteTrackingObject{ID: summary.ID, CiphertextHash: hash, Revision: summary.Revision, ModifiedAt: summary.ModifiedAt})
	}
	slices.SortFunc(inventory.Buckets, func(left, right remoteTrackingObject) int { return stringsCompare(left.ID, right.ID) })
	if err := removeUnexpectedSnapshotObjects(filepath.Join(targetRoot, trackingObjectsDirectory), expected); err != nil {
		return err
	}
	plaintext, err := json.Marshal(inventory)
	if err != nil {
		return fmt.Errorf("encode remote tracking inventory: %w", err)
	}
	if err := s.writeRemoteEnvelopeIfChangedLocked(inventoryPath, "sync-tracking", "sync-tracking", plaintext); err != nil {
		return fmt.Errorf("encrypt remote tracking inventory: %w", err)
	}
	if err := os.Remove(inventoryPath + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove remote tracking inventory backup: %w", err)
	}
	return nil
}

func copyAndHashTrackingCiphertext(source, target string) (string, error) {
	data, err := os.ReadFile(source)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := writeBytesIfChangedFast(target, data); err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}
