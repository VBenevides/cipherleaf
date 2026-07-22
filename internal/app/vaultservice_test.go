package app

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"cipherleaf/internal/vault"
)

func TestRepositorySizesSeparatesGitMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git", "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "objects", "pack"), []byte("git"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "vault.enc"), []byte("vault"), 0o600); err != nil {
		t.Fatal(err)
	}

	gitBytes, repositoryBytes := repositorySizes(root)
	if gitBytes != 3 || repositoryBytes != 5 {
		t.Fatalf("sizes = (%d, %d), want (3, 5)", gitBytes, repositoryBytes)
	}
}

func TestInstalledFontFamiliesAreUniqueAndSorted(t *testing.T) {
	fonts := installedFontFamilies("Roboto Condensed,Roboto Condensed Light\nGeorgia\nRoboto Condensed\n")
	want := []string{"Georgia", "Roboto Condensed", "Roboto Condensed Light"}
	if len(fonts) != len(want) {
		t.Fatalf("fonts = %v, want %v", fonts, want)
	}
	for index := range want {
		if fonts[index] != want[index] {
			t.Fatalf("fonts = %v, want %v", fonts, want)
		}
	}
}

func TestVaultServiceDelegatesTimeTrackingAPIs(t *testing.T) {
	service := NewVaultService()
	if _, err := service.GetTimeTrackingCatalog(); !errors.Is(err, vault.ErrLocked) {
		t.Fatalf("locked catalog error = %v", err)
	}
	if _, err := service.store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	project, err := service.CreateProject("Service Project")
	if err != nil {
		t.Fatal(err)
	}
	tag, err := service.CreateTag("Service Tag")
	if err != nil {
		t.Fatal(err)
	}
	entry, err := service.StartTimeEntry("Service Entry", project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	active, err := service.GetActiveTimeEntry()
	if err != nil || active == nil || active.ID != entry.ID {
		t.Fatalf("active delegation failed: %#v, %v", active, err)
	}
	if _, err := service.FinishActiveTimeEntry(); err != nil {
		t.Fatal(err)
	}
	rangeResult, err := service.ListTimeEntries("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", vault.TimeEntryFilters{})
	if err != nil || len(rangeResult.Entries) != 1 {
		t.Fatalf("range delegation failed: %#v, %v", rangeResult, err)
	}
	dashboard, err := service.GetTimeDashboard("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", vault.TimeEntryFilters{})
	if err != nil || dashboard.TotalSeconds < 0 {
		t.Fatalf("dashboard delegation failed: %#v, %v", dashboard, err)
	}
	catalog, err := service.GetTimeTrackingCatalog()
	if err != nil || len(catalog.Projects) != 1 || len(catalog.Tags) != 1 {
		t.Fatalf("catalog delegation failed: %#v, %v", catalog, err)
	}
	if _, err := service.ArchiveProject(project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RestoreProject(project.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteTimeEntry(entry.ID); err != nil {
		t.Fatal(err)
	}
}

func TestApplicationStatisticsMemoryUsageIsSorted(t *testing.T) {
	statistics, err := NewVaultService().GetApplicationStatistics()
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.MemoryUsage) == 0 || statistics.MemoryBytes == 0 {
		t.Fatal("expected application memory usage")
	}
	for index := 1; index < len(statistics.MemoryUsage); index++ {
		if statistics.MemoryUsage[index-1].MemoryBytes < statistics.MemoryUsage[index].MemoryBytes {
			t.Fatal("memory usage is not sorted descending")
		}
	}
}

func TestClearClipboardIfUnchanged(t *testing.T) {
	value := "vault-secret"
	clearClipboardIfUnchanged(
		value,
		func() (string, bool) { return value, true },
		func(next string) bool {
			value = next
			return true
		},
	)
	if value != "" {
		t.Fatalf("clipboard value = %q, want cleared", value)
	}

	value = "new user value"
	clearClipboardIfUnchanged(
		"vault-secret",
		func() (string, bool) { return value, true },
		func(next string) bool {
			value = next
			return true
		},
	)
	if value != "new user value" {
		t.Fatal("clipboard clear overwrote a newer value")
	}
}

func TestSelectClipboardImageType(t *testing.T) {
	if got := selectClipboardImageType("text/plain\nimage/jpeg\nimage/png\n"); got != "image/png" {
		t.Fatalf("selected MIME type = %q, want image/png", got)
	}
	if got := selectClipboardImageType("text/plain\ntext/html\n"); got != "" {
		t.Fatalf("selected non-image MIME type %q", got)
	}
}
