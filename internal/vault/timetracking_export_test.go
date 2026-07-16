package vault

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTrackingMutationsChangeSnapshotRevision(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	revision, err := store.SnapshotRevision()
	if err != nil {
		t.Fatal(err)
	}
	assertChanged := func(change func() error) {
		t.Helper()
		if err := change(); err != nil {
			t.Fatal(err)
		}
		next, err := store.SnapshotRevision()
		if err != nil || next == revision {
			t.Fatalf("tracking mutation did not change snapshot revision: %q, %v", next, err)
		}
		revision = next
	}
	var project TimeProject
	assertChanged(func() error { var err error; project, err = store.CreateProject("Snapshot Project"); return err })
	var tag TimeTag
	assertChanged(func() error { var err error; tag, err = store.CreateTag("Snapshot Tag"); return err })
	setTrackingTestNow(store, "2026-07-16T10:00:00Z")
	var entry TimeEntry
	assertChanged(func() error {
		var err error
		entry, err = store.StartTimeEntry("Snapshot Task", project.ID, []string{tag.ID})
		return err
	})
	setTrackingTestNow(store, "2026-07-16T11:00:00Z")
	assertChanged(func() error { var err error; entry, err = store.FinishActiveTimeEntry(); return err })
	assertChanged(func() error {
		var err error
		entry, err = store.UpdateTimeEntry(entry.ID, "Updated Snapshot Task", project.ID, []string{tag.ID}, "2026-07-16T09:00:00Z", "2026-07-16T10:00:00Z")
		return err
	})
	assertChanged(func() error { return store.DeleteTimeEntry(entry.ID) })
}

func TestExportRemoteSnapshotIncludesEncryptedTrackingIncrementally(t *testing.T) {
	store, _ := newTrackingTestStore(t)
	project, _ := store.CreateProject("Private Client")
	tag, _ := store.CreateTag("Secret Tag")
	setTrackingTestNow(store, "2026-07-16T10:00:00Z")
	entry, err := store.StartTimeEntry("Confidential Review", project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	setTrackingTestNow(store, "2026-07-16T11:00:00Z")
	if _, err := store.FinishActiveTimeEntry(); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	inventoryPlaintext, err := store.readEnvelopeFileLocked(filepath.Join(remote, syncDirectory, syncTrackingFile), "sync-tracking", "sync-tracking")
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	var inventory remoteTrackingInventory
	if err := json.Unmarshal(inventoryPlaintext, &inventory); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if len(inventory.Buckets) != 1 || inventory.Catalog.CiphertextHash == "" || inventory.Buckets[0].CiphertextHash == "" {
		store.mu.Unlock()
		t.Fatalf("tracking inventory is incomplete: %#v", inventory)
	}
	bucketID := inventory.Buckets[0].ID
	bucketPath := filepath.Join(remote, trackingDirectory, trackingObjectsDirectory, bucketID[:2], bucketID+".enc")
	if _, err := store.readEnvelopeFileLocked(filepath.Join(remote, trackingDirectory, trackingCatalogFilename), trackingCatalogObjectType, trackingCatalogObjectID); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if _, err := store.readEnvelopeFileLocked(bucketPath, trackingBucketObjectType, bucketID); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()

	paths := []string{filepath.Join(remote, trackingDirectory, trackingCatalogFilename), bucketPath, filepath.Join(remote, syncDirectory, syncTrackingFile)}
	modTimes := make(map[string]time.Time, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		modTimes[path] = info.ModTime()
	}
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		info, _ := os.Stat(path)
		if !info.ModTime().Equal(modTimes[path]) {
			t.Fatalf("unchanged tracking object was rewritten: %s", path)
		}
	}

	staleID := strings.Repeat("d", 32)
	stalePath := filepath.Join(remote, trackingDirectory, trackingObjectsDirectory, staleID[:2], staleID+".enc")
	if err := os.MkdirAll(filepath.Dir(stalePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stalePath, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	localBucket, _, err := store.findTimeTrackingEntryLocked(entry.ID)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	localPath, _ := store.timeTrackingBucketPathLocked(localBucket.ID)
	before, _ := os.ReadFile(bucketPath)
	if err := store.writeTimeTrackingBucketLocked(localBucket); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	localCiphertext, _ := os.ReadFile(localPath)
	store.mu.Unlock()
	if bytes.Equal(before, localCiphertext) {
		t.Fatal("forced local ciphertext refresh did not change the envelope")
	}
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(bucketPath)
	if !bytes.Equal(after, localCiphertext) {
		t.Fatal("forced ciphertext change was not exported")
	}
	if _, err := os.Stat(stalePath); !os.IsNotExist(err) {
		t.Fatal("stale remote tracking object was not removed")
	}

	if err := filepath.WalkDir(remote, func(path string, item os.DirEntry, walkErr error) error {
		if walkErr != nil || item.IsDir() {
			return walkErr
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, secret := range []string{"Private Client", "Secret Tag", "Confidential Review", "2026-07", "2026-07-16"} {
			if bytes.Contains(data, []byte(secret)) || strings.Contains(filepath.ToSlash(path), secret) {
				return fmt.Errorf("plaintext %q leaked into %s", secret, path)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
