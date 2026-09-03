package githubsync

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoverageChangedRemotePathsAndTransportErrors(t *testing.T) {
	id := strings.Repeat("a", 32)
	otherID := strings.Repeat("b", 32)
	oldPath := "objects/aa/" + id + ".enc"
	newPath := "objects/bb/" + otherID + ".enc"
	for _, test := range []struct {
		status  string
		fields  [][]byte
		count   int
		deleted bool
	}{
		{"A", [][]byte{[]byte(oldPath)}, 1, false},
		{"M", [][]byte{[]byte(oldPath)}, 1, false},
		{"T", [][]byte{[]byte(oldPath)}, 1, false},
		{"D", [][]byte{[]byte(oldPath)}, 1, true},
		{"R100", [][]byte{[]byte(oldPath), []byte(newPath)}, 2, true},
		{"C100", [][]byte{[]byte(oldPath), []byte(newPath)}, 1, false},
	} {
		changes, _, err := parseChangedRemotePath(test.fields, 0, test.status)
		if err != nil || len(changes) != test.count {
			t.Fatalf("status %q changes = %#v, %v", test.status, changes, err)
		}
		if changes[0].deleted != test.deleted {
			t.Fatalf("status %q deleted = %v", test.status, changes[0].deleted)
		}
	}
	for _, test := range []struct {
		fields [][]byte
		status string
	}{
		{nil, "A"},
		{[][]byte{[]byte("bad")}, "A"},
		{[][]byte{[]byte(oldPath)}, "U"},
		{[][]byte{[]byte("bad"), []byte(newPath)}, "R100"},
		{[][]byte{[]byte(oldPath)}, "R100"},
	} {
		if _, _, err := parseChangedRemotePath(test.fields, 0, test.status); err == nil {
			t.Fatalf("malformed status %q unexpectedly accepted", test.status)
		}
	}
	if changes, err := parseChangedRemotePaths([]byte("A\x00" + oldPath + "\x00D\x00" + newPath + "\x00\x00")); err != nil || len(changes) != 2 {
		t.Fatalf("parsed changes = %#v, %v", changes, err)
	}

	for _, test := range []struct {
		ctx  context.Context
		out  string
		want string
	}{
		{deadlineContext(t), "private output", "timed out"},
		{cancelledContext(), "private output", "cancelled"},
		{context.Background(), "repository not found: secret", "repository was not found"},
	} {
		if err := transportError(test.ctx, []byte(test.out)); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("transport error = %v, want %q", err, test.want)
		}
	}

	for _, test := range []struct {
		output string
		want   string
	}{
		{"Permission denied (publickey)", "rejected the selected SSH key"},
		{"repository not found", "repository was not found"},
		{"host key verification failed", "host identity verification failed"},
		{"connection refused", "could not be reached"},
		{"non-fast-forward", "branch changed"},
		{"unknown", "could not be completed"},
	} {
		if err := RedactCommandError(test.output); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("redacted error = %v, want %q", err, test.want)
		}
	}
}

func deadlineContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	t.Cleanup(cancel)
	return ctx
}

func cancelledContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func TestCoverageFileSettingsStore(t *testing.T) {
	store := NewFileSettingsStore(t.TempDir())
	if _, err := store.Load("bad"); err == nil {
		t.Fatal("invalid vault ID accepted")
	}
	if _, err := store.Load("vault123"); !errors.Is(err, ErrSettingsNotFound) {
		t.Fatalf("missing settings error = %v", err)
	}
	settings := DefaultSettings("vault123")
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.PrivateKeyPath = "/tmp/key"
	settings.RepositoryPrivate = true
	if err := store.Save(settings); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(settings.VaultID)
	if err != nil || loaded != settings {
		t.Fatalf("loaded settings = %#v, %v; want %#v", loaded, err, settings)
	}
	if err := store.Remove(settings.VaultID); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(settings.VaultID); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.root, settings.VaultID, settingsFilename)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{"{", `{"format_version":99}`} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Load(settings.VaultID); err == nil {
			t.Fatal("invalid settings accepted")
		}
	}
	invalid := settings
	invalid.RepositorySSH = "not-ssh"
	if err := store.Save(invalid); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(settings.VaultID); err == nil {
		t.Fatal("invalid repository settings accepted")
	}
	if err := store.Save(settings); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*SyncSettings){
		func(value *SyncSettings) { value.Branch = "bad..branch" },
		func(value *SyncSettings) { value.RepositoryPrivate = false },
	} {
		invalid = settings
		mutate(&invalid)
		if err := store.Save(invalid); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Load(settings.VaultID); err == nil {
			t.Fatal("invalid persisted settings accepted")
		}
	}
	if _, err := store.path("bad"); err == nil {
		t.Fatal("invalid settings path accepted")
	}
	if got := DefaultConfigRoot(); got == "" {
		t.Fatal("default config root is empty")
	}
}

func TestCoverageManagerUnlinkedPaths(t *testing.T) {
	store := NewFileSettingsStore(t.TempDir())
	manager := NewManager(store, &successfulConnectionTester{})
	vaultID := "vault123"
	if settings, err := manager.GetSettings(vaultID); err != nil || settings.VaultID != vaultID {
		t.Fatalf("default manager settings = %#v, %v", settings, err)
	}
	if err := manager.PrefetchVault(context.Background(), vaultID); !errors.Is(err, ErrSettingsNotFound) {
		t.Fatalf("missing prefetch error = %v", err)
	}
	if _, err := manager.GitWorkingDirectory(vaultID); err == nil {
		t.Fatal("unlinked checkout unexpectedly returned")
	}
	if _, err := manager.PullVault(context.Background(), vaultID); err == nil {
		t.Fatal("missing pull settings unexpectedly succeeded")
	}
	if _, err := manager.PushVault(context.Background(), vaultID, &revisionSnapshot{revision: "r"}); err == nil {
		t.Fatal("missing push settings unexpectedly succeeded")
	}
	if _, err := manager.ForcePushVault(context.Background(), vaultID, &revisionSnapshot{revision: "r"}); err == nil {
		t.Fatal("missing force push settings unexpectedly succeeded")
	}
	if err := manager.RemoveSettings(vaultID); err != nil {
		t.Fatal(err)
	}

	settings := DefaultSettings(vaultID)
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.PrivateKeyPath = "/tmp/key"
	settings.RepositoryPrivate = true
	if err := store.Save(settings); err != nil {
		t.Fatal(err)
	}
	if err := manager.PrefetchVault(context.Background(), vaultID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.GitWorkingDirectory(vaultID); err == nil {
		t.Fatal("unlinked Git checkout unexpectedly returned")
	}
	if _, err := manager.PullVault(context.Background(), vaultID); err == nil {
		t.Fatal("unlinked pull unexpectedly succeeded")
	}
	if _, err := manager.PushVault(context.Background(), vaultID, &revisionSnapshot{revision: "r"}); err == nil {
		t.Fatal("unlinked push unexpectedly succeeded")
	}
	if _, err := manager.ForcePushVault(context.Background(), vaultID, &revisionSnapshot{revision: "r"}); err == nil {
		t.Fatal("unlinked force push unexpectedly succeeded")
	}
	if err := manager.RemoveSettings(vaultID); err != nil {
		t.Fatal(err)
	}
}
