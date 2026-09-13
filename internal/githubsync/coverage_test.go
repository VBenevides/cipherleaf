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
	onRun   func([]string)
}

func (r *sequenceGitRunner) Run(_ context.Context, _ string, args []string, _ []string) ([]byte, error) {
	index := r.calls
	r.calls++
	if r.onRun != nil {
		r.onRun(args)
	}
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

func TestCoverageAcceptExistingRepository(t *testing.T) {
	settings := DefaultSettings(strings.Repeat("a", 32))
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	runner := &sequenceGitRunner{outputs: [][]byte{
		[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil,
		nil, nil, nil, nil, []byte(""), []byte(strings.Repeat("a", 40)),
	}}
	provider := &GitHubSSHProvider{runner: runner, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}
	commit, err := provider.acceptExistingRepository(
		context.Background(), settings, coverageRemoteSnapshot{}, t.TempDir(),
		"refs/remotes/origin/main", t.TempDir(), nil,
	)
	if err != nil || commit != strings.Repeat("a", 40) {
		t.Fatalf("accepted repository commit = %q, %v", commit, err)
	}
}

type coverageSnapshotError struct {
	validateErr error
	exportErr   error
	match       bool
}

func (s coverageSnapshotError) ExportRemoteSnapshot(root string) error {
	if s.exportErr != nil {
		return s.exportErr
	}
	return (coverageRemoteSnapshot{}).ExportRemoteSnapshot(root)
}

func (s coverageSnapshotError) ValidateRemoteSnapshot(string) (bool, error) {
	return s.match, s.validateErr
}

type coverageUnsafeSnapshot struct{}

func (coverageUnsafeSnapshot) ExportRemoteSnapshot(root string) error {
	if err := (coverageRemoteSnapshot{}).ExportRemoteSnapshot(root); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "unsafe.txt"), []byte("unsafe"), 0o600)
}

func (coverageUnsafeSnapshot) ValidateRemoteSnapshot(string) (bool, error) { return true, nil }

func TestCoverageGitRemainingProviderBranches(t *testing.T) {
	settings := DefaultSettings(strings.Repeat("a", 32))
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	if got := NewGitHubSSHProvider(t.TempDir(), t.TempDir()); got == nil {
		t.Fatal("provider constructor returned nil")
	}
	if git, ssh := ToolVersions(); git == "" || ssh == "" {
		t.Fatalf("tool versions = %q, %q", git, ssh)
	}
	if knownHosts, wrapper, err := prepareSSHFiles(t.TempDir()); err != nil || knownHosts == "" || wrapper == "" {
		t.Fatalf("SSH files = %q, %q, %v", knownHosts, wrapper, err)
	}

	accept := func(t *testing.T, runner GitRunner, snapshot RemoteSnapshotStore, wantErr bool) {
		t.Helper()
		provider := &GitHubSSHProvider{runner: runner, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}
		_, err := provider.acceptExistingRepository(context.Background(), settings, snapshot, t.TempDir(), "refs/remotes/origin/main", t.TempDir(), nil)
		if (err != nil) != wantErr {
			t.Fatalf("accept existing error = %v, want error=%v", err, wantErr)
		}
	}
	accept(t, &sequenceGitRunner{}, coverageSnapshotError{}, true)
	accept(t, &sequenceGitRunner{errors: []error{errors.New("inspect")}}, coverageSnapshotError{}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil}}, coverageSnapshotError{validateErr: errors.New("validate")}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil}}, coverageSnapshotError{}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil}, errors: []error{nil, nil, errors.New("prepare")}}, coverageSnapshotError{match: true}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil}, errors: []error{nil, nil, nil, nil, nil}}, coverageSnapshotError{match: true, exportErr: errors.New("export")}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil}, errors: []error{nil, nil, nil, nil, nil}}, coverageUnsafeSnapshot{}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil}, errors: []error{nil, nil, nil, nil, nil, errors.New("stage")}}, coverageSnapshotError{match: true}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil, nil}, errors: []error{nil, nil, nil, nil, nil, nil, errors.New("diff")}}, coverageSnapshotError{match: true}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil, nil, []byte("vault.json")}, errors: []error{nil, nil, nil, nil, nil, nil, nil, errors.New("commit")}}, coverageSnapshotError{match: true}, true)
	accept(t, &sequenceGitRunner{outputs: [][]byte{[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil, nil, []byte("vault.json"), nil}, errors: []error{nil, nil, nil, nil, nil, nil, nil, nil, errors.New("push")}}, coverageSnapshotError{match: true}, true)

	workingTree := t.TempDir()
	if err := os.WriteFile(filepath.Join(workingTree, "vault.json"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := &GitHubSSHProvider{runner: &sequenceGitRunner{}, runtimeDir: t.TempDir(), cacheRoot: t.TempDir()}
	if err := provider.materializeChangedRepository(context.Background(), workingTree, "origin/main", []changedRemotePath{
		{path: "missing.enc", deleted: true}, {path: "vault.json"},
	}); err != nil {
		t.Fatal(err)
	}
	statuses := make([]byte, 0, 257*4)
	for index := 0; index < 257; index++ {
		statuses = append(statuses, []byte(" M file")...)
		statuses = append(statuses, 0)
	}
	provider.runner = &sequenceGitRunner{outputs: [][]byte{statuses, nil, nil}}
	if err := provider.stageChangedSnapshot(context.Background(), workingTree); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.resolveReference(context.Background(), workingTree, "HEAD"); err == nil {
		t.Fatal("missing commit output accepted")
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

type coverageManagerSettingsStore struct {
	settings  SyncSettings
	loadErr   error
	saveErr   error
	removeErr error
}

func (s *coverageManagerSettingsStore) Load(string) (SyncSettings, error) {
	if s.loadErr != nil {
		return SyncSettings{}, s.loadErr
	}
	if s.settings.VaultID == "" {
		return SyncSettings{}, ErrSettingsNotFound
	}
	return s.settings, nil
}

func (s *coverageManagerSettingsStore) Save(settings SyncSettings) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	s.settings = settings
	return nil
}

func (s *coverageManagerSettingsStore) Remove(string) error { return s.removeErr }

type coverageManagerProvider struct {
	link             LinkResult
	linkErr          error
	download         DownloadedVault
	downloadErr      error
	push             PushResult
	pushErr          error
	pull             PullResult
	pullErr          error
	force            PushResult
	forceErr         error
	prefetchErr      error
	workingDirectory string
}

func (p *coverageManagerProvider) Link(context.Context, SyncSettings, RemoteSnapshotStore) (LinkResult, error) {
	return p.link, p.linkErr
}

func (p *coverageManagerProvider) Download(context.Context, SyncSettings) (DownloadedVault, error) {
	return p.download, p.downloadErr
}

func (p *coverageManagerProvider) Push(context.Context, SyncSettings, RemoteSnapshotStore) (PushResult, error) {
	return p.push, p.pushErr
}

func (p *coverageManagerProvider) Pull(context.Context, SyncSettings) (PullResult, error) {
	return p.pull, p.pullErr
}

func (p *coverageManagerProvider) ForcePush(context.Context, SyncSettings, RemoteSnapshotStore) (PushResult, error) {
	return p.force, p.forceErr
}

func (p *coverageManagerProvider) Prefetch(context.Context, SyncSettings) error { return p.prefetchErr }

func (p *coverageManagerProvider) GitWorkingDirectory(SyncSettings) string {
	return p.workingDirectory
}

type coverageManagerRevisionSnapshot struct {
	revision string
	err      error
}

func (s coverageManagerRevisionSnapshot) SnapshotRevision() (string, error)         { return s.revision, s.err }
func (coverageManagerRevisionSnapshot) ExportRemoteSnapshot(string) error           { return nil }
func (coverageManagerRevisionSnapshot) ValidateRemoteSnapshot(string) (bool, error) { return true, nil }

func coverageManagerLinkedSettings(vaultID string) SyncSettings {
	settings := DefaultSettings(vaultID)
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.PrivateKeyPath = "/key"
	settings.RepositoryPrivate = true
	settings.Linked = true
	return settings
}

func TestCoverageManagerBranches(t *testing.T) {
	vaultID := "manager-vault"
	valid := coverageManagerLinkedSettings(vaultID)
	valid.PrivateKeyPath = filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(valid.PrivateKeyPath, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot := coverageManagerRevisionSnapshot{revision: "revision"}

	if _, err := (&Manager{settings: &coverageManagerSettingsStore{loadErr: errors.New("load")}}).GetSettings(vaultID); err == nil {
		t.Fatal("settings load error was ignored")
	}
	if got, err := NewManager(&coverageManagerSettingsStore{}, nil).GetSettings(vaultID); err != nil || got.VaultID != vaultID {
		t.Fatalf("default settings = %#v, %v", got, err)
	}

	provider := &coverageManagerProvider{}
	store := &coverageManagerSettingsStore{settings: valid}
	manager := NewManager(store, &successfulConnectionTester{})
	manager.provider = provider
	if err := manager.PrefetchVault(context.Background(), vaultID); err != nil {
		t.Fatal(err)
	}
	provider.prefetchErr = errors.New("prefetch")
	if err := manager.PrefetchVault(context.Background(), vaultID); !errors.Is(err, provider.prefetchErr) {
		t.Fatalf("prefetch error = %v", err)
	}
	if path, err := manager.GitWorkingDirectory(vaultID); err != nil || path != "" {
		t.Fatalf("working directory = %q, %v", path, err)
	}
	provider.workingDirectory = "/checkout"
	if path, err := manager.GitWorkingDirectory(vaultID); err != nil || path != "/checkout" {
		t.Fatalf("working directory = %q, %v", path, err)
	}

	provider.link = LinkResult{Linked: true, Branch: "main", LastCommit: "commit"}
	if result, err := manager.LinkVault(context.Background(), vaultID, valid, &snapshot); err != nil || result.LastCommit != "commit" {
		t.Fatalf("link result = %#v, %v", result, err)
	}
	provider.linkErr = errors.New("link")
	if _, err := manager.LinkVault(context.Background(), vaultID, valid, &snapshot); !errors.Is(err, provider.linkErr) {
		t.Fatalf("link error = %v", err)
	}
	provider.linkErr = nil
	if _, err := manager.LinkVault(context.Background(), vaultID, SyncSettings{}, &snapshot); err == nil {
		t.Fatal("invalid link settings accepted")
	}
	manager.provider = nil
	if _, err := manager.LinkVault(context.Background(), vaultID, valid, &snapshot); err == nil {
		t.Fatal("missing link provider accepted")
	}
	manager.provider = provider
	if _, err := manager.LinkVault(context.Background(), vaultID, valid, &coverageManagerRevisionSnapshot{err: errors.New("revision")}); err == nil {
		t.Fatal("revision error was ignored")
	}
	store.saveErr = errors.New("save")
	if _, err := manager.LinkVault(context.Background(), vaultID, valid, &snapshot); err == nil {
		t.Fatal("link save error was ignored")
	}
	store.saveErr = nil

	provider.download = DownloadedVault{VaultID: vaultID, CachePath: "/cache", Branch: "main"}
	if downloaded, linked, err := manager.DownloadVault(context.Background(), valid); err != nil || linked.VaultID != vaultID || downloaded.CachePath != "/cache" {
		t.Fatalf("download = %#v, %#v, %v", downloaded, linked, err)
	}
	provider.downloadErr = errors.New("download")
	if _, _, err := manager.DownloadVault(context.Background(), valid); !errors.Is(err, provider.downloadErr) {
		t.Fatalf("download error = %v", err)
	}
	provider.downloadErr = nil
	manager.provider = nil
	if _, _, err := manager.DownloadVault(context.Background(), valid); err == nil {
		t.Fatal("missing download provider accepted")
	}
	manager.provider = provider
	if _, _, err := manager.DownloadVault(context.Background(), SyncSettings{}); err == nil {
		t.Fatal("invalid download settings accepted")
	}
	if err := manager.ActivateDownloadedVault(SyncSettings{}); err == nil {
		t.Fatal("invalid downloaded settings accepted")
	}
	store.saveErr = errors.New("save")
	if err := manager.ActivateDownloadedVault(valid); err == nil {
		t.Fatal("download settings save error was ignored")
	}
	store.saveErr = nil

	connection := &successfulConnectionTester{}
	manager.connection = connection
	if result, err := manager.TestConnection(context.Background(), vaultID, valid); err != nil || !result.Success {
		t.Fatalf("connection result = %#v, %v", result, err)
	}
	manager.connection = failingConnectionTester{}
	if _, err := manager.TestConnection(context.Background(), vaultID, valid); err == nil {
		t.Fatal("connection error was ignored")
	}
	manager.connection = connection
	if _, err := manager.TestConnection(context.Background(), vaultID, SyncSettings{}); err == nil {
		t.Fatal("invalid connection settings accepted")
	}

	store.settings = valid
	provider.push = PushResult{Linked: true, Branch: "main", LastCommit: "pushed"}
	if result, err := manager.PushVault(context.Background(), vaultID, &snapshot); err != nil || result.LastCommit != "pushed" {
		t.Fatalf("push result = %#v, %v", result, err)
	}
	provider.pushErr = errors.New("push")
	if _, err := manager.PushVault(context.Background(), vaultID, &coverageManagerRevisionSnapshot{revision: "changed"}); !errors.Is(err, provider.pushErr) {
		t.Fatalf("push error = %v", err)
	}
	provider.pushErr = nil
	manager.provider = nil
	if _, err := manager.PushVault(context.Background(), vaultID, &snapshot); err == nil {
		t.Fatal("missing push provider accepted")
	}
	manager.provider = provider
	if _, err := manager.PushVault(context.Background(), vaultID, &coverageManagerRevisionSnapshot{err: errors.New("revision")}); err == nil {
		t.Fatal("push revision error was ignored")
	}
	store.saveErr = errors.New("save")
	if _, err := manager.PushVault(context.Background(), vaultID, &coverageManagerRevisionSnapshot{revision: "changed"}); err == nil {
		t.Fatal("push save error was ignored")
	}
	store.saveErr = nil

	provider.force = PushResult{Linked: true, Branch: "main", LastCommit: "forced"}
	if result, err := manager.ForcePushVault(context.Background(), vaultID, &snapshot); err != nil || result.LastCommit != "forced" {
		t.Fatalf("force push result = %#v, %v", result, err)
	}
	provider.forceErr = errors.New("force")
	if _, err := manager.ForcePushVault(context.Background(), vaultID, &snapshot); !errors.Is(err, provider.forceErr) {
		t.Fatalf("force push error = %v", err)
	}
	provider.forceErr = nil
	store.saveErr = errors.New("save")
	if _, err := manager.ForcePushVault(context.Background(), vaultID, &snapshot); err == nil {
		t.Fatal("force push save error was ignored")
	}
	store.saveErr = nil

	provider.pull = PullResult{Linked: true, Branch: "main"}
	if result, err := manager.PullVault(context.Background(), vaultID); err != nil || !result.Linked {
		t.Fatalf("pull result = %#v, %v", result, err)
	}
	provider.pullErr = errors.New("pull")
	if _, err := manager.PullVault(context.Background(), vaultID); !errors.Is(err, provider.pullErr) {
		t.Fatalf("pull error = %v", err)
	}
	provider.pullErr = nil
	manager.provider = nil
	if _, err := manager.PullVault(context.Background(), vaultID); err == nil {
		t.Fatal("missing pull provider accepted")
	}
	manager.provider = provider

	store.loadErr = errors.New("load")
	if _, err := manager.PushVault(context.Background(), vaultID, &snapshot); err == nil {
		t.Fatal("push load error was ignored")
	}
	if _, err := manager.ForcePushVault(context.Background(), vaultID, &snapshot); err == nil {
		t.Fatal("force push load error was ignored")
	}
	if _, err := manager.PullVault(context.Background(), vaultID); err == nil {
		t.Fatal("pull load error was ignored")
	}
	manager.MarkSynced(vaultID)
}

type failingConnectionTester struct{}

func (failingConnectionTester) TestConnection(context.Context, SyncSettings) (ConnectionResult, error) {
	return ConnectionResult{}, errors.New("connection")
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

type coverageRemoteSnapshot struct{}

func (coverageRemoteSnapshot) ExportRemoteSnapshot(root string) error {
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o700); err != nil {
		return err
	}
	for _, path := range []string{"vault.json", "sync/manifest.enc", "sync/folders.enc"} {
		fullPath := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			return err
		}
		data := []byte("data")
		if path == "vault.json" {
			data = []byte(`{"format_version":1,"vault_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","algorithm":"XChaCha20-Poly1305"}`)
		}
		if err := os.WriteFile(fullPath, data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (coverageRemoteSnapshot) ValidateRemoteSnapshot(string) (bool, error) { return true, nil }

func TestCoverageGitHubProviderTopLevelSeams(t *testing.T) {
	settings := DefaultSettings(strings.Repeat("a", 32))
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.Branch = "main"
	settings.PrivateKeyPath = filepath.Join(t.TempDir(), "id")

	linkRunner := &sequenceGitRunner{outputs: [][]byte{
		{}, nil, nil, nil, nil, nil, []byte(strings.Repeat("b", 40)),
	}, onRun: func(args []string) {
		if len(args) > 0 && args[0] == "clone" {
			_ = os.MkdirAll(filepath.Join(args[len(args)-1], ".git"), 0o700)
		}
	}}
	linkProvider := &GitHubSSHProvider{runner: linkRunner, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}
	if result, err := linkProvider.Link(context.Background(), settings, coverageRemoteSnapshot{}); err != nil || !result.Linked {
		t.Fatalf("scripted empty link = %#v, %v", result, err)
	}

	failedLink := &GitHubSSHProvider{
		runner:     &coverageGitRunner{err: errors.New("transport failed")},
		runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second,
	}
	if _, err := failedLink.Link(context.Background(), settings, coverageRemoteSnapshot{}); err == nil {
		t.Fatal("failed scripted link unexpectedly succeeded")
	}

	failedDownload := &GitHubSSHProvider{
		runner:     &coverageGitRunner{connectionOutput: []byte("dead refs/heads/main\n")},
		runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second,
	}
	if _, err := failedDownload.Download(context.Background(), settings); err == nil {
		t.Fatal("scripted download without a branch reference unexpectedly succeeded")
	}
	emptyDownload := &GitHubSSHProvider{
		runner:     &coverageGitRunner{},
		runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second,
	}
	if _, err := emptyDownload.Download(context.Background(), settings); err == nil {
		t.Fatal("empty scripted download unexpectedly succeeded")
	}

	downloadRunner := &sequenceGitRunner{outputs: [][]byte{
		[]byte("deadbeef\trefs/heads/main\n"), nil,
		[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), nil, nil, nil, nil,
		[]byte(strings.Repeat("c", 40)),
	}, onRun: func(args []string) {
		if len(args) > 0 && args[0] == "clone" {
			root := args[len(args)-1]
			_ = (coverageRemoteSnapshot{}).ExportRemoteSnapshot(root)
		}
	}}
	downloadProvider := &GitHubSSHProvider{runner: downloadRunner, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}
	if result, err := downloadProvider.Download(context.Background(), settings); err != nil || result.VaultID != settings.VaultID || result.LastCommit != strings.Repeat("c", 40) {
		t.Fatalf("scripted download = %#v, %v", result, err)
	}

	pushProvider := &GitHubSSHProvider{runner: &sequenceGitRunner{outputs: [][]byte{
		[]byte(" M vault.json\x00"), nil, []byte("vault.json\n"), nil, nil,
		[]byte(strings.Repeat("d", 40)), nil,
	}}, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}
	pushSettings := settings
	if err := os.MkdirAll(filepath.Join(pushProvider.cacheRepositoryPath(pushSettings), ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if result, err := pushProvider.Push(context.Background(), pushSettings, coverageRemoteSnapshot{}); err != nil || result.UpToDate || result.LastCommit != strings.Repeat("d", 40) {
		t.Fatalf("scripted push = %#v, %v", result, err)
	}
	if _, err := (&GitHubSSHProvider{runtimeDir: t.TempDir(), cacheRoot: t.TempDir()}).Push(context.Background(), settings, coverageRemoteSnapshot{}); err == nil {
		t.Fatal("push without a linked cache unexpectedly succeeded")
	}

	pullRunner := &sequenceGitRunner{outputs: [][]byte{
		nil, []byte(strings.Repeat("e", 40)), nil, []byte(strings.Repeat("f", 40)),
		[]byte("vault.json\x00sync/manifest.enc\x00sync/folders.enc\x00"), []byte("A\x00vault.json\x00"), nil, nil, nil, nil,
		[]byte(strings.Repeat("f", 40)),
	}, onRun: func(args []string) {
		if len(args) > 0 && args[0] == "clone" {
			_ = (coverageRemoteSnapshot{}).ExportRemoteSnapshot(args[len(args)-1])
		}
	}}
	pullProvider := &GitHubSSHProvider{runner: pullRunner, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}
	if result, err := pullProvider.Pull(context.Background(), settings); err != nil || result.UpToDate || result.LastCommit != strings.Repeat("f", 40) {
		t.Fatalf("scripted pull = %#v, %v", result, err)
	}
	if _, err := (&GitHubSSHProvider{runner: &coverageGitRunner{err: errors.New("clone failed")}, runtimeDir: t.TempDir(), cacheRoot: t.TempDir(), timeout: time.Second}).Pull(context.Background(), settings); err == nil {
		t.Fatal("failed scripted pull unexpectedly succeeded")
	}

	for _, output := range []string{strings.Repeat("a", 40), strings.Repeat("b", 64)} {
		provider := &GitHubSSHProvider{runner: &sequenceGitRunner{outputs: [][]byte{[]byte(output)}}}
		if got, err := provider.resolveReference(context.Background(), "cache", "HEAD"); err != nil || got != output {
			t.Fatalf("resolveReference(%d) = %q, %v", len(output), got, err)
		}
	}
	for _, output := range []string{"", "short", strings.Repeat("a", 65)} {
		provider := &GitHubSSHProvider{runner: &sequenceGitRunner{outputs: [][]byte{[]byte(output)}}}
		if _, err := provider.resolveCommit(context.Background(), "cache"); err == nil {
			t.Fatalf("invalid commit %q accepted", output)
		}
	}
	if _, err := (&GitHubSSHProvider{runner: &sequenceGitRunner{errors: []error{errors.New("rev parse failed")}}}).resolveCommit(context.Background(), "cache"); err == nil {
		t.Fatal("failed commit resolution unexpectedly succeeded")
	}
}
