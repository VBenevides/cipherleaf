package githubsync

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"cipherleaf/internal/vault"
)

func TestParseGitHubSSHRepository(t *testing.T) {
	tests := []struct {
		value string
		want  string
	}{
		{"git@github.com:owner/repository.git", "git@github.com:owner/repository.git"},
		{"ssh://git@github.com/owner/repository.git", "git@github.com:owner/repository.git"},
		{"ssh://git@github.com:22/owner/repository", "git@github.com:owner/repository.git"},
	}
	for _, test := range tests {
		parsed, err := ParseGitHubSSHRepository(test.value)
		if err != nil {
			t.Fatalf("ParseGitHubSSHRepository(%q): %v", test.value, err)
		}
		if parsed.Canonical != test.want {
			t.Fatalf("canonical repository = %q, want %q", parsed.Canonical, test.want)
		}
	}

	invalid := []string{
		"",
		"https://github.com/owner/repository",
		"git@gitlab.com:owner/repository.git",
		"git@github.com:owner/too/many.git",
		"ssh://owner@github.com/owner/repository.git",
		"ssh://git@github.com:2222/owner/repository.git",
		"git@github.com:owner/repo name.git",
	}
	for _, value := range invalid {
		if _, err := ParseGitHubSSHRepository(value); err == nil {
			t.Fatalf("ParseGitHubSSHRepository(%q) unexpectedly succeeded", value)
		}
	}
}

func TestValidateSettings(t *testing.T) {
	keyPath := filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(keyPath, []byte("not-a-real-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	value := DefaultSettings("vault-id-123")
	value.RepositorySSH = "ssh://git@github.com/acme/notes"
	value.PrivateKeyPath = keyPath
	value.RepositoryPrivate = true

	validated, warning, err := ValidateSettings(value, "vault-id-123")
	if err != nil {
		t.Fatal(err)
	}
	if validated.RepositorySSH != "git@github.com:acme/notes.git" {
		t.Fatalf("repository = %q", validated.RepositorySSH)
	}
	if validated.PrivateKeyPath != keyPath {
		t.Fatalf("key path = %q, want %q", validated.PrivateKeyPath, keyPath)
	}
	if warning != "" {
		t.Fatalf("unexpected key permission warning: %s", warning)
	}
	downloadSettings := value
	downloadSettings.VaultID = ""
	downloadSettings.Linked = false
	if validatedDownload, _, err := ValidateDownloadSettings(downloadSettings); err != nil {
		t.Fatal(err)
	} else if validatedDownload.VaultID != "" {
		t.Fatalf("download settings unexpectedly contain vault ID %q", validatedDownload.VaultID)
	}

	value.RepositoryPrivate = false
	if _, _, err := ValidateSettings(value, "vault-id-123"); err == nil {
		t.Fatal("unconfirmed private repository unexpectedly validated")
	}
	value.RepositoryPrivate = true
	value.PrivateKeyPath += ".pub"
	if _, _, err := ValidateSettings(value, "vault-id-123"); err == nil ||
		!strings.Contains(err.Error(), ".pub") {
		t.Fatalf("public key validation error = %v", err)
	}
}

func TestValidateSettingsWarnsAboutBroadKeyPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions are not exposed on Windows")
	}
	keyPath := filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(keyPath, []byte("not-a-real-key"), 0o644); err != nil {
		t.Fatal(err)
	}
	value := DefaultSettings("vault-id-123")
	value.RepositorySSH = "git@github.com:acme/notes.git"
	value.PrivateKeyPath = keyPath
	value.RepositoryPrivate = true
	_, warning, err := ValidateSettings(value, "vault-id-123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(warning, "chmod 600") {
		t.Fatalf("warning = %q", warning)
	}
}

func TestFileSettingsStoreRoundTripIsOwnerOnly(t *testing.T) {
	root := t.TempDir()
	store := NewFileSettingsStore(root)
	value := DefaultSettings("vault-id-123")
	value.RepositorySSH = "git@github.com:acme/notes.git"
	value.PrivateKeyPath = "/home/person/.ssh/id_cipherleaf"
	value.RepositoryPrivate = true
	if err := store.Save(value); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(value.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != value {
		t.Fatalf("loaded settings = %#v, want %#v", loaded, value)
	}
	path := filepath.Join(root, value.VaultID, settingsFilename)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("settings permissions are too broad: %o", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "not-a-real-key") {
		t.Fatal("settings unexpectedly contain private key bytes")
	}
	if !strings.Contains(string(data), `"private_key_path"`) ||
		strings.Contains(string(data), `"privateKeyPath"`) {
		t.Fatalf("settings do not use the documented disk schema: %s", data)
	}
	if err := store.Remove(value.VaultID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(value.VaultID); !errors.Is(err, ErrSettingsNotFound) {
		t.Fatalf("Load() after remove error = %v", err)
	}
}

func TestRedactCommandErrorDoesNotReturnRawOutput(t *testing.T) {
	keyPath := "/home/person/.ssh/secret-key"
	repository := "git@github.com:secret/private.git"
	err := RedactCommandError("fatal: strange failure " + keyPath + " " + repository)
	if strings.Contains(err.Error(), keyPath) || strings.Contains(err.Error(), repository) {
		t.Fatalf("error leaked sensitive input: %v", err)
	}
}

func TestMergedEnvironmentRemovesGitOverrides(t *testing.T) {
	merged := mergedEnvironment(
		[]string{
			"PATH=/usr/bin",
			"GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=no",
			"GIT_DIR=/tmp/attacker",
		},
		[]string{"GIT_SSH_COMMAND", "GIT_DIR", "GIT_SSH=/safe/wrapper"},
	)
	joined := strings.Join(merged, "\n")
	if strings.Contains(joined, "StrictHostKeyChecking=no") ||
		strings.Contains(joined, "GIT_DIR=") {
		t.Fatalf("unsafe Git environment survived merge: %s", joined)
	}
	if !strings.Contains(joined, "GIT_SSH=/safe/wrapper") {
		t.Fatalf("secure Git wrapper missing after merge: %s", joined)
	}
}

func TestSecureGitEnvironmentIsolatesMultiplexSockets(t *testing.T) {
	first := SyncSettings{VaultID: "vault-one", RepositorySSH: "git@github.com:a/one.git", PrivateKeyPath: "/key"}
	second := first
	second.VaultID = "vault-two"
	firstEnv := strings.Join(secureGitEnvironment(first, "/known", "/runtime/wrapper"), "\n")
	secondEnv := strings.Join(secureGitEnvironment(second, "/known", "/runtime/wrapper"), "\n")
	if !strings.Contains(firstEnv, "CIPHERLEAF_SSH_CONTROL_PATH=/runtime/mux-") || firstEnv == secondEnv {
		t.Fatalf("multiplex environments are missing or not isolated:\n%s\n%s", firstEnv, secondEnv)
	}
}

func BenchmarkGitHubSSHConnection(b *testing.B) {
	if runtime.GOOS == "windows" {
		b.Skip("SSH multiplexing uses the Unix wrapper")
	}
	repository := os.Getenv("CIPHERLEAF_BENCH_REPOSITORY")
	key := os.Getenv("CIPHERLEAF_BENCH_SSH_KEY")
	if repository == "" || key == "" {
		b.Skip("set CIPHERLEAF_BENCH_REPOSITORY and CIPHERLEAF_BENCH_SSH_KEY")
	}
	runtimeDir := b.TempDir()
	knownHosts, wrapper, err := prepareSSHFiles(runtimeDir)
	if err != nil {
		b.Fatal(err)
	}
	settings := SyncSettings{VaultID: "connection-benchmark", RepositorySSH: repository, PrivateKeyPath: key}
	environment := secureGitEnvironment(settings, knownHosts, wrapper)
	controlPath := ""
	for _, value := range environment {
		if strings.HasPrefix(value, "CIPHERLEAF_SSH_CONTROL_PATH=") {
			controlPath = strings.TrimPrefix(value, "CIPHERLEAF_SSH_CONTROL_PATH=")
		}
	}
	runner := ExecCommandRunner{}
	b.Run("cold", func(b *testing.B) {
		for b.Loop() {
			_ = os.Remove(controlPath)
			if _, err := runner.Run(context.Background(), "git", []string{"ls-remote", repository, "HEAD"}, environment); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("reused", func(b *testing.B) {
		for b.Loop() {
			if _, err := runner.Run(context.Background(), "git", []string{"ls-remote", repository, "HEAD"}, environment); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func TestParseRemotePathsAcceptsEncryptedAttachments(t *testing.T) {
	objectID := strings.Repeat("a", 32)
	attachmentID := strings.Repeat("b", 32)
	data := strings.Join([]string{
		"vault.json",
		"sync/manifest.enc",
		"sync/folders.enc",
		"objects/aa/" + objectID + ".enc",
		"attachments/" + objectID + "/" + attachmentID + ".enc",
		"",
	}, "\x00")

	if _, err := parseRemotePaths([]byte(data)); err != nil {
		t.Fatalf("encrypted attachment path was rejected: %v", err)
	}
}

func TestDetectsNonFastForwardPushOutput(t *testing.T) {
	for _, output := range [][]byte{
		[]byte("! [rejected] HEAD -> main (non-fast-forward)"),
		[]byte("Updates were rejected because the remote contains work; fetch first"),
	} {
		if !isNonFastForward(output) {
			t.Fatalf("non-fast-forward output was not detected: %q", output)
		}
	}
	if isNonFastForward([]byte("Permission denied (publickey)")) {
		t.Fatal("authentication failure misclassified as non-fast-forward")
	}
}

type successfulConnectionTester struct {
	settings SyncSettings
}

type countingGitTransport struct {
	showCalls int
}

type recordingGitTransport struct {
	arguments [][]string
	output    []byte
}

func (r *recordingGitTransport) Run(
	_ context.Context,
	_ string,
	args []string,
	_ []string,
) ([]byte, error) {
	r.arguments = append(r.arguments, slices.Clone(args))
	return r.output, nil
}

func TestStageChangedSnapshotUsesChangedPathsOnly(t *testing.T) {
	runner := &recordingGitTransport{output: []byte(" M sync/manifest.enc\x00?? objects/aa/" + strings.Repeat("a", 32) + ".enc\x00")}
	provider := &GitHubSSHProvider{runner: runner}
	if err := provider.stageChangedSnapshot(context.Background(), "/cache"); err != nil {
		t.Fatal(err)
	}
	if len(runner.arguments) != 2 {
		t.Fatalf("commands = %d, want status and add", len(runner.arguments))
	}
	add := strings.Join(runner.arguments[1], " ")
	if strings.Contains(add, " -- .") || !strings.Contains(add, "sync/manifest.enc") || !strings.Contains(add, "objects/aa/") {
		t.Fatalf("incremental add command = %q", add)
	}
}

func TestRecordPushedTipUsesNoNetworkOrGarbageCollection(t *testing.T) {
	runner := &recordingGitTransport{}
	provider := &GitHubSSHProvider{runner: runner}
	settings := SyncSettings{Branch: "main"}
	if err := provider.recordPushedTip(context.Background(), "/cache", settings); err != nil {
		t.Fatal(err)
	}
	if len(runner.arguments) != 1 {
		t.Fatalf("commands = %d, want 1", len(runner.arguments))
	}
	joined := strings.Join(runner.arguments[0], " ")
	if joined != "-C /cache update-ref refs/remotes/origin/main HEAD" {
		t.Fatalf("command = %q", joined)
	}
}

func (c *countingGitTransport) Run(
	ctx context.Context,
	name string,
	args []string,
	environment []string,
) ([]byte, error) {
	for _, argument := range args {
		if argument == "show" {
			c.showCalls++
		}
	}
	return (ExecCommandRunner{}).Run(ctx, name, args, environment)
}

func (t *successfulConnectionTester) TestConnection(
	_ context.Context,
	settings SyncSettings,
) (ConnectionResult, error) {
	t.settings = settings
	return ConnectionResult{Success: true, Message: "ok", Branch: settings.Branch}, nil
}

func TestManagerUsesValidatedSettingsForConnection(t *testing.T) {
	keyPath := filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(keyPath, []byte("not-a-real-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	tester := &successfulConnectionTester{}
	manager := NewManager(NewFileSettingsStore(t.TempDir()), tester)
	value := DefaultSettings("vault-id-123")
	value.RepositorySSH = "ssh://git@github.com/acme/notes"
	value.PrivateKeyPath = keyPath
	value.RepositoryPrivate = true
	result, err := manager.TestConnection(context.Background(), "vault-id-123", value)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success || tester.settings.RepositorySSH != "git@github.com:acme/notes.git" {
		t.Fatalf("connection result = %#v, settings = %#v", result, tester.settings)
	}
}

type successfulDownloadProvider struct{}

func (successfulDownloadProvider) Link(
	_ context.Context,
	_ SyncSettings,
	_ RemoteSnapshotStore,
) (LinkResult, error) {
	return LinkResult{}, errors.New("not used")
}

type successfulPullProvider struct{ successfulDownloadProvider }

func (successfulPullProvider) Pull(
	_ context.Context,
	settings SyncSettings,
) (PullResult, error) {
	return PullResult{Linked: true, Branch: settings.Branch}, nil
}

func TestPullTimestampIsRecordedOnlyAfterMergeConfirmation(t *testing.T) {
	settingsStore := NewFileSettingsStore(t.TempDir())
	settings := DefaultSettings("vault-id-123")
	settings.RepositorySSH = "git@github.com:acme/notes.git"
	settings.PrivateKeyPath = "/home/person/.ssh/id_cipherleaf"
	settings.RepositoryPrivate = true
	settings.Linked = true
	if err := settingsStore.Save(settings); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(settingsStore, &successfulConnectionTester{})
	manager.provider = successfulPullProvider{}
	if _, err := manager.PullVault(context.Background(), settings.VaultID); err != nil {
		t.Fatal(err)
	}
	beforeMerge, err := settingsStore.Load(settings.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	if beforeMerge.LastSyncedAt != 0 {
		t.Fatalf("pull transport prematurely recorded sync time %d", beforeMerge.LastSyncedAt)
	}
	manager.MarkSynced(settings.VaultID)
	afterMerge, err := settingsStore.Load(settings.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	if afterMerge.LastSyncedAt == 0 {
		t.Fatal("confirmed merge did not record sync time")
	}
}

func (successfulDownloadProvider) Download(
	_ context.Context,
	settings SyncSettings,
) (DownloadedVault, error) {
	if settings.VaultID != "" || settings.RepositorySSH != "git@github.com:acme/notes.git" {
		return DownloadedVault{}, errors.New("provider received unvalidated download settings")
	}
	return DownloadedVault{
		VaultID:    strings.Repeat("a", 32),
		CachePath:  "/encrypted/cache",
		LastCommit: strings.Repeat("b", 40),
		Branch:     settings.Branch,
	}, nil
}

func (successfulDownloadProvider) Push(
	_ context.Context,
	_ SyncSettings,
	_ RemoteSnapshotStore,
) (PushResult, error) {
	return PushResult{}, errors.New("not used")
}

func (successfulDownloadProvider) Pull(
	_ context.Context,
	_ SyncSettings,
) (PullResult, error) {
	return PullResult{}, errors.New("not used")
}

type revisionSnapshot struct{ revision string }

func (s *revisionSnapshot) SnapshotRevision() (string, error) { return s.revision, nil }
func (s *revisionSnapshot) ExportRemoteSnapshot(string) error { return nil }
func (s *revisionSnapshot) ValidateRemoteSnapshot(string) (bool, error) {
	return true, nil
}

type countingPushProvider struct {
	successfulDownloadProvider
	pushes int
}

func (p *countingPushProvider) Push(
	_ context.Context,
	settings SyncSettings,
	_ RemoteSnapshotStore,
) (PushResult, error) {
	p.pushes++
	return PushResult{Linked: true, Branch: settings.Branch, LastCommit: strings.Repeat("c", 40)}, nil
}

func TestRetryableSyncErrors(t *testing.T) {
	for _, err := range []error{
		context.DeadlineExceeded,
		errors.New("GitHub could not be reached over SSH"),
		errors.New("connection reset by peer"),
	} {
		if !IsRetryableError(err) {
			t.Fatalf("error is not retryable: %v", err)
		}
	}
	for _, err := range []error{context.Canceled, errors.New("permission denied"), errors.New("invalid branch")} {
		if IsRetryableError(err) {
			t.Fatalf("error is unexpectedly retryable: %v", err)
		}
	}
}

func TestManagerSkipsPushForUnchangedSnapshotRevision(t *testing.T) {
	vaultID := strings.Repeat("a", 32)
	settingsStore := NewFileSettingsStore(t.TempDir())
	settings := DefaultSettings(vaultID)
	settings.Linked = true
	settings.RepositorySSH = "git@github.com:acme/notes.git"
	settings.PrivateKeyPath = "/key"
	settings.RepositoryPrivate = true
	settings.LastSnapshotRev = "same"
	settings.LastCommit = strings.Repeat("b", 40)
	if err := settingsStore.Save(settings); err != nil {
		t.Fatal(err)
	}
	provider := &countingPushProvider{}
	manager := NewManager(settingsStore, &successfulConnectionTester{})
	manager.provider = provider
	snapshot := &revisionSnapshot{revision: "same"}
	result, err := manager.PushVault(context.Background(), vaultID, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !result.UpToDate || provider.pushes != 0 {
		t.Fatalf("unchanged result = %#v, pushes = %d", result, provider.pushes)
	}
	snapshot.revision = "changed"
	if _, err := manager.PushVault(context.Background(), vaultID, snapshot); err != nil {
		t.Fatal(err)
	}
	if provider.pushes != 1 {
		t.Fatalf("changed snapshot pushes = %d, want 1", provider.pushes)
	}
}

func TestManagerDownloadsThenActivatesVaultSettings(t *testing.T) {
	keyPath := filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(keyPath, []byte("not-a-real-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	settingsStore := NewFileSettingsStore(t.TempDir())
	manager := NewManager(settingsStore, &successfulConnectionTester{})
	manager.provider = successfulDownloadProvider{}
	value := DefaultSettings("")
	value.RepositorySSH = "ssh://git@github.com/acme/notes"
	value.PrivateKeyPath = keyPath
	value.RepositoryPrivate = true
	downloaded, linkedSettings, err := manager.DownloadVault(
		context.Background(),
		value,
	)
	if err != nil {
		t.Fatal(err)
	}
	if downloaded.VaultID != strings.Repeat("a", 32) ||
		linkedSettings.VaultID != downloaded.VaultID ||
		!linkedSettings.Linked {
		t.Fatalf("download = %#v, settings = %#v", downloaded, linkedSettings)
	}
	if err := manager.ActivateDownloadedVault(linkedSettings); err != nil {
		t.Fatal(err)
	}
	saved, err := settingsStore.Load(downloaded.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.Linked || saved.RepositorySSH != "git@github.com:acme/notes.git" {
		t.Fatalf("saved downloaded settings = %#v", saved)
	}
}

func TestGitHubSSHProviderInitializesAndReopensEncryptedRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git is not installed")
	}
	remote := filepath.Join(t.TempDir(), "remote.git")
	runGitTestCommand(t, "", "init", "--quiet", "--bare", "--initial-branch=main", remote)

	store := vault.NewStore()
	session, err := store.Create(t.TempDir(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Provider private folder")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Provider private title", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "Provider private content"); err != nil {
		t.Fatal(err)
	}

	settings := DefaultSettings(session.VaultID)
	settings.RepositorySSH = remote
	settings.PrivateKeyPath = filepath.Join(t.TempDir(), "unused-test-key")
	settings.RepositoryPrivate = true
	provider := NewGitHubSSHProvider(t.TempDir(), t.TempDir())
	transport := &countingGitTransport{}
	provider.runner = transport
	result, err := provider.Link(context.Background(), settings, store)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Linked || len(result.LastCommit) < 40 {
		t.Fatalf("link result = %#v", result)
	}

	tree := runGitTestCommand(t, "", "--git-dir="+remote, "ls-tree", "-r", "--name-only", "main")
	for _, required := range []string{
		"vault.json",
		"sync/folders.enc",
		"sync/manifest.enc",
		"objects/" + note.ID[:2] + "/" + note.ID + ".enc",
	} {
		if !strings.Contains(tree, required+"\n") {
			t.Fatalf("repository tree is missing %q:\n%s", required, tree)
		}
	}
	if strings.Contains(tree, ".bak") {
		t.Fatalf("repository tree contains local-only files:\n%s", tree)
	}
	for _, path := range strings.Fields(tree) {
		if path == "manifest.enc" {
			t.Fatalf("repository tree contains the local manifest:\n%s", tree)
		}
		data := runGitTestCommand(t, "", "--git-dir="+remote, "show", "main:"+path)
		for _, plaintext := range []string{
			"Provider private folder",
			"Provider private title",
			"Provider private content",
		} {
			if strings.Contains(data, plaintext) {
				t.Fatalf("Git object %q leaked plaintext %q", path, plaintext)
			}
		}
	}

	downloaded, err := provider.Download(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	if downloaded.VaultID != session.VaultID ||
		downloaded.LastCommit != result.LastCommit {
		t.Fatalf("download result = %#v, link result = %#v", downloaded, result)
	}
	restoredStore := vault.NewStore()
	restoredSession, err := restoredStore.RestoreRemoteSnapshot(
		downloaded.CachePath,
		t.TempDir(),
		"Restored from Git",
		"correct horse battery staple",
	)
	if err != nil {
		t.Fatal(err)
	}
	if restoredSession.VaultID != session.VaultID {
		t.Fatalf("restored vault ID = %q, want %q", restoredSession.VaultID, session.VaultID)
	}
	restoredNote, err := restoredStore.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restoredNote.Content != "Provider private content" {
		t.Fatalf("restored content = %q", restoredNote.Content)
	}
	restoredStore.Lock()

	reopened, err := provider.Link(context.Background(), settings, store)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.LastCommit != result.LastCommit {
		t.Fatalf("reopened commit = %q, want %q", reopened.LastCommit, result.LastCommit)
	}
	unchanged, err := provider.Push(context.Background(), settings, store)
	if err != nil {
		t.Fatal(err)
	}
	if !unchanged.UpToDate || unchanged.LastCommit != result.LastCommit {
		t.Fatalf("unchanged push = %#v, want commit %q", unchanged, result.LastCommit)
	}
	if err := store.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	deleted, err := provider.Push(context.Background(), settings, store)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.UpToDate {
		t.Fatal("deleting the final note unexpectedly produced an up-to-date push")
	}
	cacheRemoteTip := strings.TrimSpace(runGitTestCommand(
		t,
		"",
		"-C", provider.cacheRepositoryPath(settings),
		"rev-parse", "origin/main",
	))
	if cacheRemoteTip != deleted.LastCommit {
		t.Fatalf("cached remote tip = %q, want pushed commit %q", cacheRemoteTip, deleted.LastCommit)
	}
	tree = runGitTestCommand(t, "", "--git-dir="+remote, "ls-tree", "-r", "--name-only", "main")
	if strings.Contains(tree, note.ID+".enc") {
		t.Fatalf("repository retained deleted final note:\n%s", tree)
	}
	downloaded, err = provider.Download(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	matches, err := store.ValidateRemoteSnapshot(downloaded.CachePath)
	if err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("downloaded empty repository does not match local vault")
	}
	if transport.showCalls != 0 {
		t.Fatalf("provider spawned %d per-file git show commands", transport.showCalls)
	}

	otherStore := vault.NewStore()
	otherSession, err := otherStore.Create(t.TempDir(), "another correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	otherSettings := settings
	otherSettings.VaultID = otherSession.VaultID
	if _, err := provider.Link(context.Background(), otherSettings, otherStore); err == nil ||
		!strings.Contains(err.Error(), "another vault") {
		t.Fatalf("vault mismatch link error = %v", err)
	}
}

func TestPullAdvancesPersistentCacheBeforeFollowingPush(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git is not installed")
	}
	remote := filepath.Join(t.TempDir(), "remote.git")
	runGitTestCommand(t, "", "init", "--quiet", "--bare", "--initial-branch=main", remote)
	const secret = "correct horse battery staple"

	firstStore := vault.NewStore()
	firstSession, err := firstStore.Create(t.TempDir(), secret)
	if err != nil {
		t.Fatal(err)
	}
	note, err := firstStore.CreateNote("Shared note")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := firstStore.SaveNote(note.ID, note.Title, "first"); err != nil {
		t.Fatal(err)
	}
	settings := DefaultSettings(firstSession.VaultID)
	settings.RepositorySSH = remote
	settings.PrivateKeyPath = filepath.Join(t.TempDir(), "unused-test-key")
	settings.RepositoryPrivate = true

	firstProvider := NewGitHubSSHProvider(t.TempDir(), t.TempDir())
	if _, err := firstProvider.Link(context.Background(), settings, firstStore); err != nil {
		t.Fatal(err)
	}
	secondProvider := NewGitHubSSHProvider(t.TempDir(), t.TempDir())
	downloaded, err := secondProvider.Download(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	secondStore := vault.NewStore()
	if _, err := secondStore.RestoreRemoteSnapshot(
		downloaded.CachePath,
		t.TempDir(),
		"Second device",
		secret,
	); err != nil {
		t.Fatal(err)
	}

	time.Sleep(time.Second)
	if _, err := firstStore.SaveNote(note.ID, note.Title, "from first device"); err != nil {
		t.Fatal(err)
	}
	if _, err := firstProvider.Push(context.Background(), settings, firstStore); err != nil {
		t.Fatal(err)
	}
	pulled, err := secondProvider.Pull(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	if pulled.Temporary || pulled.StagingPath != secondProvider.cacheRepositoryPath(settings) {
		t.Fatalf("pull did not return persistent cache: %#v", pulled)
	}
	if _, err := secondStore.MergeRemoteSnapshot(pulled.StagingPath); err != nil {
		t.Fatal(err)
	}
	received, err := secondStore.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if received.Content != "from first device" {
		t.Fatalf("second device content = %q", received.Content)
	}

	time.Sleep(time.Second)
	if _, err := secondStore.SaveNote(note.ID, note.Title, "from second device"); err != nil {
		t.Fatal(err)
	}
	if _, err := secondProvider.Push(context.Background(), settings, secondStore); err != nil {
		t.Fatalf("push after pull used a stale Git base: %v", err)
	}
	unchanged, err := secondProvider.Pull(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	if !unchanged.UpToDate {
		t.Fatalf("unchanged pull did not use its fast path: %#v", unchanged)
	}
}

func TestGitLifecycleCarriesEncryptedTimeTracking(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git is not installed")
	}
	remote := filepath.Join(t.TempDir(), "tracking.git")
	runGitTestCommand(t, "", "init", "--quiet", "--bare", "--initial-branch=main", remote)
	const secret = "correct horse battery staple"
	first := vault.NewStore()
	session, err := first.Create(t.TempDir(), secret)
	if err != nil {
		t.Fatal(err)
	}
	project, err := first.CreateProject("Git Project")
	if err != nil {
		t.Fatal(err)
	}
	tag, err := first.CreateTag("Git Tag")
	if err != nil {
		t.Fatal(err)
	}
	active, err := first.StartTimeEntry("Git Running", project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	settings := DefaultSettings(session.VaultID)
	settings.RepositorySSH = remote
	settings.PrivateKeyPath = filepath.Join(t.TempDir(), "unused-key")
	settings.RepositoryPrivate = true
	firstProvider := NewGitHubSSHProvider(t.TempDir(), t.TempDir())
	if _, err := firstProvider.Link(context.Background(), settings, first); err != nil {
		t.Fatal(err)
	}
	tree := runGitTestCommand(t, "", "--git-dir="+remote, "ls-tree", "-r", "--name-only", "main")
	for _, required := range []string{"sync/tracking.enc", "tracking/catalog.enc", "tracking/objects/"} {
		if !strings.Contains(tree, required) {
			t.Fatalf("Git snapshot is missing tracking path %q:\n%s", required, tree)
		}
	}
	secondProvider := NewGitHubSSHProvider(t.TempDir(), t.TempDir())
	downloaded, err := secondProvider.Download(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	second := vault.NewStore()
	if _, err := second.RestoreRemoteSnapshot(downloaded.CachePath, t.TempDir(), "Second Tracking Device", secret); err != nil {
		t.Fatal(err)
	}
	restoredActive, err := second.GetActiveTimeEntry()
	if err != nil || restoredActive == nil || restoredActive.ID != active.ID {
		t.Fatalf("clone did not restore active tracking entry: %#v, %v", restoredActive, err)
	}
	if _, err := second.FinishActiveTimeEntry(); err != nil {
		t.Fatal(err)
	}
	if _, err := secondProvider.ForcePush(context.Background(), settings, second); err != nil {
		t.Fatal(err)
	}
	pulled, err := firstProvider.Pull(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.MergeRemoteSnapshot(pulled.StagingPath); err != nil {
		t.Fatal(err)
	}
	remaining, err := first.GetActiveTimeEntry()
	if err != nil || remaining != nil {
		t.Fatalf("pull did not reproduce finished timer: %#v, %v", remaining, err)
	}
	catalog, err := first.GetTimeTrackingCatalog()
	if err != nil || len(catalog.Projects) != 1 || len(catalog.Tags) != 1 {
		t.Fatalf("pull lost tracking labels: %#v, %v", catalog, err)
	}
}

func runGitTestCommand(t *testing.T, directory string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", arguments...)
	if directory != "" {
		command.Dir = directory
	}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(arguments, " "), err, output)
	}
	return string(output)
}
