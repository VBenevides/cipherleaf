package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestRecentVaultLifecycle(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state", recentFilename)
	store := NewRecentVaultStore(file)
	if path, err := store.LastPath(); err != nil || path != "" {
		t.Fatalf("empty LastPath() = %q, %v", path, err)
	}

	vaultPath := filepath.Join(t.TempDir(), "Personal vault")
	if err := os.MkdirAll(vaultPath, 0o700); err != nil {
		t.Fatal(err)
	}
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
	if err := os.MkdirAll(vaultPath, 0o700); err != nil {
		t.Fatal(err)
	}
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

func TestNormalizeThemeAcceptsArchivist(t *testing.T) {
	if got := NormalizeTheme(" Archivist "); got != "archivist" {
		t.Fatalf("NormalizeTheme() = %q, want archivist", got)
	}
}

func TestRecentVaultPathsKeepTheFiveMostRecentInAccessOrder(t *testing.T) {
	store := NewRecentVaultStore(filepath.Join(t.TempDir(), recentFilename))
	root := t.TempDir()
	var paths []string
	for index := 1; index <= 6; index++ {
		path := filepath.Join(root, "vault", string(rune('0'+index)))
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
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

func TestRecentVaultPathsExpireMissingAndUnusedVaults(t *testing.T) {
	file := filepath.Join(t.TempDir(), recentFilename)
	store := NewRecentVaultStore(file)
	root := t.TempDir()
	alive := filepath.Join(root, "alive")
	stale := filepath.Join(root, "stale")
	missing := filepath.Join(root, "missing")
	if err := os.MkdirAll(alive, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(recentVault{
		Path:  alive,
		Paths: []string{missing, stale, alive},
		LastOpened: map[string]int64{
			missing: time.Now().Unix(),
			stale:   time.Now().Add(-maxRecentAge - time.Second).Unix(),
			alive:   time.Now().Unix(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatal(err)
	}

	paths, err := store.Paths()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{alive}; !slices.Equal(paths, want) {
		t.Fatalf("Paths() = %#v, want %#v", paths, want)
	}
	if err := store.Remove(alive); err != nil {
		t.Fatal(err)
	}
	if paths, err := store.Paths(); err != nil || len(paths) != 0 {
		t.Fatalf("Paths() after Remove() = %#v, %v; want empty", paths, err)
	}
}

func TestDefaultRecentVaultStoreUsesApplicationConfigDirectory(t *testing.T) {
	store := NewDefaultRecentVaultStore()
	if filepath.Base(store.path) != recentFilename ||
		filepath.Base(filepath.Dir(store.path)) != "Cipherleaf" {
		t.Fatalf("default recent-vault path = %q", store.path)
	}
}
