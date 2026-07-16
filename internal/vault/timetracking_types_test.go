package vault

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTimeTrackingDomainJSONShape(t *testing.T) {
	entry := TimeEntry{
		ID: strings.Repeat("a", 32), Name: "Review", TagIDs: []string{strings.Repeat("b", 32)},
		StartedAtUTC: "2026-07-15T12:00:00Z", CreatedAtUTC: "2026-07-15T12:00:00Z",
		UpdatedAtUTC: "2026-07-15T12:00:00Z", ModifiedAt: 1, Revision: 1,
	}
	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"id", "name", "tagIds", "startedAtUtc", "createdAtUtc", "updatedAtUtc", "modifiedAt", "revision"} {
		if _, found := value[field]; !found {
			t.Fatalf("missing JSON field %q in %s", field, data)
		}
	}
	for _, field := range []string{"projectId", "endedAtUtc"} {
		if _, found := value[field]; found {
			t.Fatalf("optional JSON field %q unexpectedly present in %s", field, data)
		}
	}
}

func TestNewTimeTrackingCatalogDefaults(t *testing.T) {
	vaultID := strings.Repeat("c", 32)
	catalog := newTimeTrackingCatalog(vaultID)
	if catalog.FormatVersion != TimeTrackingCatalogFormatVersion || catalog.VaultID != vaultID {
		t.Fatalf("unexpected catalog identity: %#v", catalog)
	}
	if catalog.Projects == nil || catalog.Tags == nil || catalog.Buckets == nil ||
		catalog.DeletedEntries == nil || catalog.DeletedProjects == nil || catalog.DeletedTags == nil {
		t.Fatalf("catalog collections must default to empty arrays: %#v", catalog)
	}
	if catalog.ActiveEntry != nil || catalog.Revision != 0 || catalog.ModifiedAt != 0 {
		t.Fatalf("unexpected active or revision defaults: %#v", catalog)
	}
}

func TestManifestCapabilityValidation(t *testing.T) {
	tests := []struct {
		name         string
		format       int
		capabilities []string
		wantError    bool
	}{
		{name: "legacy", format: FormatVersion},
		{name: "tracking", format: TimeTrackingManifestFormatVersion, capabilities: []string{TimeTrackingCapability}},
		{name: "legacy with capability", format: FormatVersion, capabilities: []string{TimeTrackingCapability}, wantError: true},
		{name: "tracking without capability", format: TimeTrackingManifestFormatVersion, wantError: true},
		{name: "unknown capability", format: TimeTrackingManifestFormatVersion, capabilities: []string{"unknown"}, wantError: true},
		{name: "duplicate capability", format: TimeTrackingManifestFormatVersion, capabilities: []string{TimeTrackingCapability, TimeTrackingCapability}, wantError: true},
		{name: "future format", format: TimeTrackingManifestFormatVersion + 1, capabilities: []string{TimeTrackingCapability}, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateManifestCapabilities(test.format, test.capabilities)
			if (err != nil) != test.wantError {
				t.Fatalf("validateManifestCapabilities() error = %v, wantError %v", err, test.wantError)
			}
		})
	}
}

func TestEnableTimeTrackingCapabilityUsesNewManifestFormat(t *testing.T) {
	value := manifest{FormatVersion: FormatVersion}
	if err := enableTimeTrackingCapability(&value); err != nil {
		t.Fatal(err)
	}
	if !hasTimeTrackingCapability(value) {
		t.Fatalf("time-tracking capability not enabled: %#v", value)
	}
	if value.FormatVersion == FormatVersion {
		t.Fatal("tracking manifest must be rejected by legacy readers")
	}
	if err := enableTimeTrackingCapability(&value); err != nil {
		t.Fatalf("enabling an existing capability must be idempotent: %v", err)
	}
}

func TestStoreReopensTimeTrackingManifestButLegacyReaderRejectsIt(t *testing.T) {
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
	store.mu.Unlock()
	store.Lock()

	if _, err := store.Open(root, "secret-secret-secret"); err != nil {
		t.Fatalf("current reader rejected tracking manifest: %v", err)
	}
	if store.manifest.FormatVersion == FormatVersion {
		t.Fatal("legacy reader would unexpectedly accept tracking manifest")
	}
}
