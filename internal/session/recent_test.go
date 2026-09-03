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

func TestRecentVaultValidationAndCorruptState(t *testing.T) {
	store := NewRecentVaultStore(filepath.Join(t.TempDir(), recentFilename))
	if err := store.Remember(" "); err == nil {
		t.Fatal("expected empty path error")
	}
	if err := store.RememberWithTheme(" ", "dark"); err == nil {
		t.Fatal("expected empty themed path error")
	}
	if err := store.Remove(" "); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Paths(); err == nil {
		t.Fatal("expected corrupt recent state error")
	}
	if got := NormalizeTheme(" LIGHT "); got != "light" {
		t.Fatalf("NormalizeTheme() = %q", got)
	}
	if got := NormalizeTheme("unknown"); got != "" {
		t.Fatalf("NormalizeTheme(unknown) = %q", got)
	}
}

func TestRecentVaultHandlesLegacyEntriesAndFilesystemErrors(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	file := filepath.Join(t.TempDir(), recentFilename)
	store := NewRecentVaultStore(file)
	write := func(value recentVault) {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(recentVault{Path: root})
	if paths, err := store.Paths(); err != nil || !slices.Equal(paths, []string{root}) {
		t.Fatalf("legacy Paths() = %#v, %v", paths, err)
	}
	write(recentVault{Paths: []string{root, root, "", other}})
	if paths, err := store.Paths(); err != nil || !slices.Equal(paths, []string{root, other}) {
		t.Fatalf("duplicate Paths() = %#v, %v", paths, err)
	}
	if err := store.Remove(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(root); err != nil {
		t.Fatal(err)
	}
	if paths, err := store.Paths(); err != nil || !slices.Equal(paths, []string{other}) {
		t.Fatalf("remaining Paths() = %#v, %v", paths, err)
	}
	if err := store.Remove(other); err != nil {
		t.Fatal(err)
	}
	if paths, err := store.Paths(); err != nil || len(paths) != 0 {
		t.Fatalf("empty Paths() = %#v, %v", paths, err)
	}
	if err := os.WriteFile(file, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if store.LastTheme() != "" || store.Remember(root) == nil || store.Remove(root) == nil {
		t.Fatal("corrupt recent state was accepted")
	}
	parent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(parent, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewRecentVaultStore(filepath.Join(parent, recentFilename)).Remember(root); err == nil {
		t.Fatal("recent state write unexpectedly succeeded below a file")
	}
	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "child"), []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewRecentVaultStore(nonEmpty).Forget(); err == nil {
		t.Fatal("Forget() unexpectedly removed a non-empty directory")
	}
}
