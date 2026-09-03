package app

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"cipherleaf/internal/githubsync"
	appsession "cipherleaf/internal/session"
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

func TestVaultServiceLifecycleAndDiagnostics(t *testing.T) {
	service := NewVaultService()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	parent := t.TempDir()
	secret := "app lifecycle secret"
	session, err := service.CreateVault(parent, "Lifecycle", secret)
	if err != nil {
		t.Fatal(err)
	}
	if last, err := service.GetLastVaultPath(); err != nil || last != session.Path {
		t.Fatalf("last vault = %q, %v", last, err)
	}
	if err := service.RememberTheme("dark"); err != nil {
		t.Fatal(err)
	}
	if last, err := service.GetLastSession(); err != nil || last.Theme != "dark" {
		t.Fatalf("last session = %#v, %v", last, err)
	}
	if _, err := service.SaveNote(mustCreateServiceNote(t, service).ID, "Lifecycle note", "content"); err != nil {
		t.Fatal(err)
	}
	service.LockVault()
	if _, err := service.OpenVault(session.Path, secret); err != nil {
		t.Fatal(err)
	}
	renamed, err := service.RenameVault("Renamed")
	if err != nil || !renamed.Locked {
		t.Fatalf("renamed session = %#v, %v", renamed, err)
	}
	if _, err := service.OpenVault(renamed.Path, secret); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetVaultStatistics(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetApplicationStatistics(); err != nil {
		t.Fatal(err)
	}
	validSecret, err := service.GenerateVaultSecret()
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CopyVaultSecret(validSecret); err == nil {
		t.Fatal("copying without an application unexpectedly succeeded")
	}
	if _, err := service.CloneGitHubVault(parent, "clone", "", "", "main", secret, true); err == nil {
		t.Fatal("cloning while unlocked unexpectedly succeeded")
	}
	if _, err := service.syncNow(); err == nil {
		t.Fatal("sync without a GitHub link unexpectedly succeeded")
	}
	if err := service.OpenGitTerminal(); err == nil {
		t.Fatal("opening an unavailable Git checkout unexpectedly succeeded")
	}

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "data"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	diagnostics := gitDiagnostics(root, githubsync.PullResult{}, githubsync.PushResult{TransportPerformed: true})
	if diagnostics.TransportOperations != 2 || diagnostics.RepositoryFilesBytes != 4 || diagnostics.RepositoryPath != root {
		t.Fatalf("diagnostics = %#v", diagnostics)
	}
}

func mustCreateServiceNote(t *testing.T, service *VaultService) vault.Note {
	t.Helper()
	note, err := service.CreateNote("Lifecycle note")
	if err != nil {
		t.Fatal(err)
	}
	return note
}
