package app

import (
	"os"
	"path/filepath"
	"testing"
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
