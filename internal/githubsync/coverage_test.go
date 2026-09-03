package githubsync

import (
	"bytes"
	"context"
	"encoding/json"
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

type coverageGitRunner struct {
	connectionOutput []byte
	err              error
	calls            int
}

type sequenceGitRunner struct {
	outputs [][]byte
	errors  []error
	calls   int
}

func (r *sequenceGitRunner) Run(_ context.Context, _ string, _ []string, _ []string) ([]byte, error) {
	index := r.calls
	r.calls++
	var output []byte
	if index < len(r.outputs) {
		output = r.outputs[index]
	}
	var err error
	if index < len(r.errors) {
		err = r.errors[index]
	}
	return output, err
}

func (r *coverageGitRunner) Run(_ context.Context, _ string, args []string, _ []string) ([]byte, error) {
	r.calls++
	if len(args) > 0 && args[0] == gitLsRemoteCommand {
		return r.connectionOutput, r.err
	}
	return nil, r.err
}

func TestCoverageGitConnectionAndPrefetch(t *testing.T) {
	settings := DefaultSettings(strings.Repeat("a", 32))
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.PrivateKeyPath = filepath.Join(t.TempDir(), "id_cipherleaf")
	settings.RepositoryPrivate = true

	connection := &GitConnectionTester{runtimeDir: t.TempDir(), timeout: time.Second, runner: &coverageGitRunner{
		connectionOutput: []byte("ref: refs/heads/main\tHEAD\n"),
	}}
	result, err := connection.TestConnection(context.Background(), settings)
	if err != nil || !result.Success || result.Branch != settings.Branch {
		t.Fatalf("connection result = %#v, %v", result, err)
	}

	provider := &GitHubSSHProvider{
		runner:     &coverageGitRunner{},
		runtimeDir: t.TempDir(),
		cacheRoot:  t.TempDir(),
		timeout:    time.Second,
		prefetched: make(map[string]time.Time),
	}
	cachePath := provider.cacheRepositoryPath(settings)
	if err := os.MkdirAll(filepath.Join(cachePath, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := provider.Prefetch(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	if _, ok := provider.prefetched[cachePath]; !ok {
		t.Fatal("prefetch timestamp was not recorded")
	}
	if got := provider.GitWorkingDirectory(settings); got != cachePath {
		t.Fatalf("Git working directory = %q, want %q", got, cachePath)
	}

	failed := &GitConnectionTester{runtimeDir: t.TempDir(), timeout: time.Second, runner: &coverageGitRunner{
		connectionOutput: []byte("repository not found"), err: errors.New("exit status 1"),
	}}
	if _, err := failed.TestConnection(context.Background(), settings); err == nil {
		t.Fatal("failed Git connection unexpectedly succeeded")
	}
}

func TestCoverageGitProviderErrorBranches(t *testing.T) {
	badRuntime := filepath.Join(t.TempDir(), "runtime")
	if err := os.WriteFile(badRuntime, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepareSSHFiles(badRuntime); err == nil {
		t.Fatal("file accepted as SSH runtime directory")
	}

	badCacheRoot := filepath.Join(t.TempDir(), "cache")
	if err := os.WriteFile(badCacheRoot, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := &GitHubSSHProvider{cacheRoot: badCacheRoot, runner: &coverageGitRunner{}}
	if _, err := provider.ensureLinkedCache(context.Background(), DefaultSettings("vault"), nil); err == nil {
		t.Fatal("file accepted as Git cache root")
	}
	provider = &GitHubSSHProvider{cacheRoot: t.TempDir(), runner: &coverageGitRunner{err: errors.New("clone failed")}}
	if _, err := provider.ensureLinkedCache(context.Background(), DefaultSettings("vault"), nil); err == nil {
		t.Fatal("failed cache clone unexpectedly succeeded")
	}
	provider.runner = &coverageGitRunner{err: errors.New("git failed")}
	if err := provider.recordPushedTip(context.Background(), t.TempDir(), DefaultSettings("vault")); err == nil {
		t.Fatal("failed Git reference update unexpectedly succeeded")
	}

	workingTree := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workingTree, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"vault.json", "sync/manifest.enc", "sync/folders.enc"} {
		fullPath := filepath.Join(workingTree, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte("data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (&GitHubSSHProvider{runner: &coverageGitRunner{err: errors.New("git failed")}}).initializeEmptyRepository(
		context.Background(), DefaultSettings("vault"), &revisionSnapshot{}, workingTree, t.TempDir(), nil,
	); err == nil {
		t.Fatal("failed branch creation unexpectedly succeeded")
	}
	if _, err := (&GitHubSSHProvider{runner: &sequenceGitRunner{errors: []error{nil, errors.New("stage failed")}}}).initializeEmptyRepository(
		context.Background(), DefaultSettings("vault"), &revisionSnapshot{}, workingTree, t.TempDir(), nil,
	); err == nil {
		t.Fatal("failed snapshot staging unexpectedly succeeded")
	}
	if _, err := (&GitHubSSHProvider{runner: &sequenceGitRunner{errors: []error{nil, nil, errors.New("commit failed")}}}).initializeEmptyRepository(
		context.Background(), DefaultSettings("vault"), &revisionSnapshot{}, workingTree, t.TempDir(), nil,
	); err == nil {
		t.Fatal("failed snapshot commit unexpectedly succeeded")
	}
	if _, err := (&GitHubSSHProvider{runner: &sequenceGitRunner{errors: []error{nil, nil, nil, errors.New("push failed")}}}).initializeEmptyRepository(
		context.Background(), DefaultSettings("vault"), &revisionSnapshot{}, workingTree, t.TempDir(), nil,
	); err == nil {
		t.Fatal("failed snapshot push unexpectedly succeeded")
	}

	validPaths := []byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00")
	if err := (&GitHubSSHProvider{runner: &sequenceGitRunner{outputs: [][]byte{validPaths}, errors: []error{nil, errors.New("checkout failed")}}}).materializeExistingRepository(context.Background(), workingTree, "refs/remotes/origin/main"); err == nil {
		t.Fatal("failed repository checkout unexpectedly succeeded")
	}
	if _, err := (&GitHubSSHProvider{runner: &coverageGitRunner{err: errors.New("ls-tree failed")}}).changedRemotePaths(context.Background(), workingTree, "old", "new"); err == nil {
		t.Fatal("failed remote path inspection unexpectedly succeeded")
	}
	if _, err := (&GitHubSSHProvider{runner: &sequenceGitRunner{outputs: [][]byte{validPaths}, errors: []error{nil, errors.New("diff failed")}}}).changedRemotePaths(context.Background(), workingTree, "old", "new"); err == nil {
		t.Fatal("failed remote diff inspection unexpectedly succeeded")
	}
	if err := (&GitHubSSHProvider{runner: &coverageGitRunner{err: errors.New("checkout failed")}}).materializeChangedRepository(
		context.Background(), workingTree, "refs/remotes/origin/main", []changedRemotePath{{path: "vault.json"}},
	); err == nil {
		t.Fatal("failed changed repository checkout unexpectedly succeeded")
	}
	if err := (&GitHubSSHProvider{runner: &sequenceGitRunner{errors: []error{errors.New("cache failed")}}}).prepareExistingCache(context.Background(), workingTree, "main", "refs/remotes/origin/main"); err == nil {
		t.Fatal("failed cache preparation unexpectedly succeeded")
	}
}

type coverageSyncProvider struct{}

func (coverageSyncProvider) Link(context.Context, SyncSettings, RemoteSnapshotStore) (LinkResult, error) {
	return LinkResult{Linked: true, LastCommit: strings.Repeat("c", 40), Branch: "main"}, nil
}

func (coverageSyncProvider) Download(context.Context, SyncSettings) (DownloadedVault, error) {
	return DownloadedVault{}, errors.New("not used")
}

func (coverageSyncProvider) Push(context.Context, SyncSettings, RemoteSnapshotStore) (PushResult, error) {
	return PushResult{}, errors.New("not used")
}

func (coverageSyncProvider) Pull(context.Context, SyncSettings) (PullResult, error) {
	return PullResult{}, errors.New("not used")
}

func TestCoverageManagerLinkVault(t *testing.T) {
	vaultID := strings.Repeat("d", 32)
	store := NewFileSettingsStore(t.TempDir())
	manager := NewManager(store, &successfulConnectionTester{})
	manager.provider = coverageSyncProvider{}
	keyPath := filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(keyPath, []byte("test key"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := DefaultSettings(vaultID)
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.PrivateKeyPath = keyPath
	settings.RepositoryPrivate = true
	result, err := manager.LinkVault(context.Background(), vaultID, settings, &revisionSnapshot{revision: "revision"})
	if err != nil || !result.Linked || result.LastCommit == "" {
		t.Fatalf("link result = %#v, %v", result, err)
	}
	saved, err := store.Load(vaultID)
	if err != nil || !saved.Linked || saved.LastSnapshotRev != "revision" {
		t.Fatalf("saved settings = %#v, %v", saved, err)
	}
}

func TestCoverageGitLayoutIdentityAndCacheHelpers(t *testing.T) {
	id := strings.Repeat("a", 32)
	for _, test := range []struct {
		path string
		want bool
	}{
		{"vault.json", true},
		{"sync/manifest.enc", true},
		{"objects/aa/" + id + ".enc", true},
		{"objects/bb/" + id + ".enc", false},
		{"objects/aa/bad.enc", false},
		{"unsafe.txt", false},
	} {
		if got := validRemotePath(test.path); got != test.want {
			t.Fatalf("validRemotePath(%q) = %v, want %v", test.path, got, test.want)
		}
	}
	if branch := findRemoteBranch([]byte("deadbeef\trefs/heads/main\n"), "main"); branch != "refs/heads/main" {
		t.Fatalf("findRemoteBranch() = %q", branch)
	}
	if findRemoteBranch([]byte("deadbeef refs/heads/main\n"), "main") != "" {
		t.Fatal("malformed branch reference accepted")
	}

	root := t.TempDir()
	validConfig, err := json.Marshal(map[string]any{
		"format_version": FormatVersion, "vault_id": id, "algorithm": "XChaCha20-Poly1305",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, gitVaultConfigPath), validConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := readRemoteVaultID(root); err != nil || got != id {
		t.Fatalf("readRemoteVaultID() = %q, %v", got, err)
	}
	for _, data := range [][]byte{[]byte("{"), []byte(`{"format_version":99}`), bytes.Repeat([]byte("x"), 1024*1024+1)} {
		if err := os.WriteFile(filepath.Join(root, gitVaultConfigPath), data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := readRemoteVaultID(root); err == nil {
			t.Fatal("invalid remote vault identity accepted")
		}
	}

	layout := t.TempDir()
	if err := os.Mkdir(filepath.Join(layout, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout, gitVaultConfigPath), validConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkingTreeLayout(layout); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout, "unsafe.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkingTreeLayout(layout); err == nil {
		t.Fatal("unsafe working tree layout accepted")
	}

	source := filepath.Join(t.TempDir(), "source")
	destination := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := installCache(source, destination); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := installCache(source, destination); err != nil {
		t.Fatal(err)
	}
	if err := installCache(filepath.Join(t.TempDir(), "missing"), destination); err == nil {
		t.Fatal("missing cache source accepted")
	}

	buffer := &limitedBuffer{limit: 3}
	if written, err := buffer.Write([]byte("12345")); err != nil || written != 5 || string(buffer.Bytes()) != "123" {
		t.Fatalf("limited buffer = %q, %d, %v", buffer.Bytes(), written, err)
	}
}
