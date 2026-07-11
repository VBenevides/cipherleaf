package session

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRecentVaultLifecycle(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state", recentFilename)
	store := NewRecentVaultStore(file)
	if path, err := store.LastPath(); err != nil || path != "" {
		t.Fatalf("empty LastPath() = %q, %v", path, err)
	}

	vaultPath := filepath.Join(t.TempDir(), "Personal vault")
	if err := store.Remember(vaultPath); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.LastPath()
	if err != nil {
		t.Fatal(err)
	}
	if loaded != vaultPath {
		t.Fatalf("LastPath() = %q, want %q", loaded, vaultPath)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("recent vault file permissions are too broad: %o", info.Mode().Perm())
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "secret") {
		t.Fatal("recent vault file unexpectedly contains secret material")
	}

	if err := store.Forget(); err != nil {
		t.Fatal(err)
	}
	if path, err := store.LastPath(); err != nil || path != "" {
		t.Fatalf("LastPath() after Forget() = %q, %v", path, err)
	}
}

func TestRecentVaultPersistsTheme(t *testing.T) {
	file := filepath.Join(t.TempDir(), recentFilename)
	store := NewRecentVaultStore(file)
	vaultPath := filepath.Join(t.TempDir(), "vault")
	if err := store.RememberWithTheme(vaultPath, "dark"); err != nil {
		t.Fatal(err)
	}
	if got := store.LastTheme(); got != "dark" {
		t.Fatalf("LastTheme() = %q, want dark", got)
	}
	if path, _ := store.LastPath(); path != vaultPath {
		t.Fatalf("LastPath() = %q, want %q", path, vaultPath)
	}
	if err := store.Remember(vaultPath); err != nil {
		t.Fatal(err)
	}
	if got := store.LastTheme(); got != "dark" {
		t.Fatalf("theme dropped after plain Remember(): got %q", got)
	}
	if err := store.RememberWithTheme(vaultPath, "garbage"); err != nil {
		t.Fatal(err)
	}
	if got := store.LastTheme(); got != "" {
		t.Fatalf("LastTheme() after invalid input = %q, want empty", got)
	}
}

func TestRecentVaultPathsKeepTheFiveMostRecentInAccessOrder(t *testing.T) {
	store := NewRecentVaultStore(filepath.Join(t.TempDir(), recentFilename))
	root := t.TempDir()
	var paths []string
	for index := 1; index <= 6; index++ {
		path := filepath.Join(root, "vault", string(rune('0'+index)))
		paths = append(paths, path)
		if err := store.Remember(path); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.Paths()
	if err != nil {
		t.Fatal(err)
	}
	if want := paths[1:]; !slices.Equal(got, want) {
		t.Fatalf("Paths() = %#v, want %#v", got, want)
	}
	if err := store.Remember(paths[2]); err != nil {
		t.Fatal(err)
	}
	got, err = store.Paths()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{paths[1], paths[3], paths[4], paths[5], paths[2]}
	if !slices.Equal(got, want) {
		t.Fatalf("Paths() after revisiting = %#v, want %#v", got, want)
	}
	if last, err := store.LastPath(); err != nil || last != paths[2] {
		t.Fatalf("LastPath() = %q, %v; want %q", last, err, paths[2])
	}
}

func TestDefaultRecentVaultStoreUsesApplicationConfigDirectory(t *testing.T) {
	store := NewDefaultRecentVaultStore()
	if filepath.Base(store.path) != recentFilename ||
		filepath.Base(filepath.Dir(store.path)) != "Cipherleaf" {
		t.Fatalf("default recent-vault path = %q", store.path)
	}
}
