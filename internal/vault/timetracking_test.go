package vault

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTimeTrackingStorageRoundTripAndPrivacy(t *testing.T) {
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}

	store.mu.Lock()
	if err := enableTimeTrackingCapability(&store.manifest); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := store.saveManifestLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	bucketID := strings.Repeat("a", 32)
	bucket := timeTrackingBucket{
		FormatVersion: TimeTrackingCatalogFormatVersion,
		ID:            bucketID,
		Entries: []TimeEntry{{
			ID: strings.Repeat("b", 32), Name: "Private client review", TagIDs: []string{},
			StartedAtUTC: "2026-07-01T12:00:00Z", CreatedAtUTC: "2026-07-01T12:00:00Z",
			UpdatedAtUTC: "2026-07-01T12:00:00Z", ModifiedAt: 1, Revision: 1,
		}},
	}
	if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	catalog := *store.timeTrackingCatalog
	catalog.Buckets = append(catalog.Buckets, timeTrackingBucketSummary{ID: bucketID, MonthUTC: "2026-07"})
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	got, err := store.readTimeTrackingBucketLocked(bucketID)
	store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Entries) != 1 || got.Entries[0].Name != bucket.Entries[0].Name {
		t.Fatalf("unexpected bucket round trip: %#v", got)
	}

	bucketPath := filepath.Join(root, trackingDirectory, trackingObjectsDirectory, bucketID[:2], bucketID+".enc")
	for _, path := range []string{
		filepath.Join(root, trackingDirectory),
		filepath.Join(root, trackingDirectory, trackingObjectsDirectory),
		filepath.Dir(bucketPath),
	} {
		assertFileMode(t, path, 0o700)
	}
	for _, path := range []string{
		filepath.Join(root, trackingDirectory, trackingCatalogFilename),
		filepath.Join(root, trackingDirectory, trackingCatalogFilename+".bak"),
		bucketPath,
		bucketPath + ".bak",
	} {
		assertFileMode(t, path, 0o600)
	}

	data, err := os.ReadFile(bucketPath)
	if err != nil {
		t.Fatal(err)
	}
	var value envelope
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if value.ObjectType != trackingBucketObjectType || value.Compression != "gzip" {
		t.Fatalf("unexpected tracking envelope: %#v", value)
	}
	if strings.Contains(bucketPath, "2026-07") {
		t.Fatalf("month leaked into opaque path: %s", bucketPath)
	}
	if err := filepath.WalkDir(filepath.Join(root, trackingDirectory), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		contents, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		for _, secret := range []string{"Private client review", "2026-07", "2026-07-01"} {
			if strings.Contains(string(contents), secret) {
				t.Fatalf("plaintext %q leaked into %s", secret, path)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	store.Lock()
	if err := os.WriteFile(bucketPath, []byte("damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatalf("opening should load only the catalog: %v", err)
	}
	store.mu.Lock()
	got, err = store.readTimeTrackingBucketLocked(bucketID)
	store.mu.Unlock()
	if err != nil || len(got.Entries) != 1 {
		t.Fatalf("encrypted bucket backup was not recovered: %#v, %v", got, err)
	}
}

func TestTimeTrackingStorageRejectsTamperingAndObjectSubstitution(t *testing.T) {
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	if err := enableTimeTrackingCapability(&store.manifest); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := store.saveManifestLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	id := strings.Repeat("c", 32)
	if err := store.writeTimeTrackingBucketLocked(timeTrackingBucket{FormatVersion: 1, ID: id, Entries: []TimeEntry{}}); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	path, _ := store.timeTrackingBucketPathLocked(id)
	primary, err := os.ReadFile(path)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	var tampered envelope
	if err := json.Unmarshal(primary, &tampered); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if tampered.Ciphertext[0] == 'A' {
		tampered.Ciphertext = "B" + tampered.Ciphertext[1:]
	} else {
		tampered.Ciphertext = "A" + tampered.Ciphertext[1:]
	}
	primary, err = json.Marshal(tampered)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := os.WriteFile(path, primary, 0o600); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".bak", []byte("damaged"), 0o600); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if _, err := store.readTimeTrackingBucketLocked(id); err == nil {
		store.mu.Unlock()
		t.Fatal("tampered bucket unexpectedly authenticated")
	}
	catalogData, err := os.ReadFile(filepath.Join(root, trackingDirectory, trackingCatalogFilename))
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := os.WriteFile(path, catalogData, 0o600); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if _, err := store.readTimeTrackingBucketLocked(id); err == nil {
		store.mu.Unlock()
		t.Fatal("tracking catalog unexpectedly authenticated as a bucket")
	}
	store.mu.Unlock()
}

func assertFileMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s permissions = %o, want %o", path, got, want)
	}
}
