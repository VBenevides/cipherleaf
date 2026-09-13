package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"cipherleaf/internal/githubsync"
	appsession "cipherleaf/internal/session"
	"cipherleaf/internal/vault"
)

type appCoverageSyncProvider struct {
	download    githubsync.DownloadedVault
	downloadErr error
	pull        githubsync.PullResult
	pullErr     error
	push        githubsync.PushResult
	pushErr     error
	workingDir  string
	pullCalls   int
	pushCalls   int
}

func (p *appCoverageSyncProvider) Link(context.Context, githubsync.SyncSettings, githubsync.RemoteSnapshotStore) (githubsync.LinkResult, error) {
	return githubsync.LinkResult{}, errors.New("not used")
}

func (p *appCoverageSyncProvider) Download(context.Context, githubsync.SyncSettings) (githubsync.DownloadedVault, error) {
	return p.download, p.downloadErr
}

func (p *appCoverageSyncProvider) Pull(context.Context, githubsync.SyncSettings) (githubsync.PullResult, error) {
	p.pullCalls++
	return p.pull, p.pullErr
}

func (p *appCoverageSyncProvider) Push(context.Context, githubsync.SyncSettings, githubsync.RemoteSnapshotStore) (githubsync.PushResult, error) {
	p.pushCalls++
	return p.push, p.pushErr
}

func (p *appCoverageSyncProvider) GitWorkingDirectory(githubsync.SyncSettings) string {
	return p.workingDir
}

func setAppCoverageProvider(manager *githubsync.Manager, provider githubsync.SyncProvider) {
	field := reflect.ValueOf(manager).Elem().FieldByName("provider")
	reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem().Set(reflect.ValueOf(provider))
}

func newAppSyncCoverageService(t *testing.T) (*VaultService, *appCoverageSyncProvider, githubsync.SyncSettings) {
	t.Helper()
	service := NewVaultService()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if _, err := service.store.Create(t.TempDir(), "sync coverage secret"); err != nil {
		t.Fatal(err)
	}
	vaultID := service.store.Session().VaultID
	keyPath := filepath.Join(t.TempDir(), "id_cipherleaf")
	if err := os.WriteFile(keyPath, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := githubsync.DefaultSettings(vaultID)
	settings.RepositorySSH = "git@github.com:owner/repository.git"
	settings.PrivateKeyPath = keyPath
	settings.RepositoryPrivate = true
	settings.Linked = true
	settingsStore := githubsync.NewFileSettingsStore(t.TempDir())
	if err := settingsStore.Save(settings); err != nil {
		t.Fatal(err)
	}
	manager := githubsync.NewManager(settingsStore, nil)
	provider := &appCoverageSyncProvider{workingDir: t.TempDir()}
	setAppCoverageProvider(manager, provider)
	service.sync = manager
	return service, provider, settings
}

func TestVaultServiceSyncCoverage(t *testing.T) {
	service, provider, settings := newAppSyncCoverageService(t)
	if got, err := service.GetSyncSettings(); err != nil || got.VaultID != settings.VaultID {
		t.Fatalf("sync settings = %#v, %v", got, err)
	}
	if err := os.MkdirAll(filepath.Join(provider.workingDir, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(provider.workingDir, "vault.enc"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}

	remote := filepath.Join(t.TempDir(), "remote")
	if err := service.store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	provider.pull = githubsync.PullResult{
		Linked: true, Branch: settings.Branch, LastCommit: strings.Repeat("a", 40),
		StagingPath: remote, Temporary: true,
	}
	provider.push = githubsync.PushResult{
		Linked: true, Branch: settings.Branch, LastCommit: strings.Repeat("b", 40), Message: "pushed",
	}
	result, err := service.syncNow()
	if err != nil {
		t.Fatal(err)
	}
	if result.LastCommit != provider.push.LastCommit || result.Pull.LastCommit != provider.pull.LastCommit ||
		result.Git.RepositoryPath != provider.workingDir || provider.pullCalls != 1 || provider.pushCalls != 1 {
		t.Fatalf("sync result = %#v, provider calls = (%d, %d)", result, provider.pullCalls, provider.pushCalls)
	}

	provider.pull = githubsync.PullResult{Linked: true, Branch: settings.Branch, UpToDate: true}
	provider.push = githubsync.PushResult{Linked: true, Branch: settings.Branch, UpToDate: true, Message: "already current"}
	result, err = service.syncNow()
	if err != nil || result.Message != "The vault is already in sync with GitHub." {
		t.Fatalf("up-to-date sync = %#v, %v", result, err)
	}

	if _, err := service.CreateNote("Changed before warning"); err != nil {
		t.Fatal(err)
	}
	provider.pullErr = errors.New("pull failed")
	if _, err := service.syncNow(); err == nil {
		t.Fatal("pull failure was ignored")
	}
	provider.pullErr = nil
	provider.pull = githubsync.PullResult{Linked: true, Branch: settings.Branch, StagingPath: filepath.Join(t.TempDir(), "missing")}
	if result, err := service.syncNow(); err != nil || !strings.Contains(result.Warning, "remote changes could not be merged") {
		t.Fatalf("merge warning = %#v, %v", result, err)
	}
	provider.pull = githubsync.PullResult{Linked: true, Branch: settings.Branch, UpToDate: true}
	provider.pushErr = errors.New("push failed")
	if result, err := service.syncNow(); err != nil || !strings.Contains(result.Warning, "push could not be completed") {
		t.Fatalf("push warning = %#v, %v", result, err)
	}
	provider.pushErr = nil

	service.LockVault()
	source := vault.NewStore()
	sourceSession, err := source.Create(t.TempDir(), "clone source secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.CreateNote("Downloaded note"); err != nil {
		t.Fatal(err)
	}
	cloneRemote := filepath.Join(t.TempDir(), "clone-remote")
	if err := source.ExportRemoteSnapshot(cloneRemote); err != nil {
		t.Fatal(err)
	}
	provider.download = githubsync.DownloadedVault{
		VaultID: sourceSession.VaultID, CachePath: cloneRemote, Branch: settings.Branch,
		LastCommit: strings.Repeat("c", 40), Message: "downloaded",
	}
	provider.downloadErr = nil
	clone, err := service.CloneGitHubVault(t.TempDir(), "cloned", settings.RepositorySSH, settings.PrivateKeyPath, settings.Branch, "clone source secret", true)
	if err != nil || clone.Session.Locked || !clone.Linked || clone.LastCommit != provider.download.LastCommit {
		t.Fatalf("clone result = %#v, %v", clone, err)
	}

	service.LockVault()
	if _, err := service.store.Open(clone.Session.Path, "clone source secret"); err != nil {
		t.Fatal(err)
	}
	provider.download = githubsync.DownloadedVault{VaultID: strings.Repeat("d", 32), CachePath: cloneRemote}
	if _, err := service.PullAndLinkGitHubVault(settings); err == nil {
		t.Fatal("mismatched pull-and-link vault was accepted")
	}
	provider.download = githubsync.DownloadedVault{
		VaultID: clone.Session.VaultID, CachePath: cloneRemote, Branch: settings.Branch,
		LastCommit: strings.Repeat("e", 40), Message: "pulled",
	}
	provider.push = githubsync.PushResult{
		Linked: true, Branch: settings.Branch, LastCommit: strings.Repeat("f", 40), Message: "pushed",
	}
	result, err = service.PullAndLinkGitHubVault(settings)
	if err != nil || !result.Linked || result.LastCommit != provider.push.LastCommit || result.Push.LastCommit != provider.push.LastCommit {
		t.Fatalf("pull-and-link result = %#v, %v", result, err)
	}
	provider.pull = githubsync.PullResult{Linked: true, Branch: settings.Branch, UpToDate: true}
	provider.push = githubsync.PushResult{Linked: true, Branch: settings.Branch, UpToDate: true, Message: "already current"}
	if result, err := service.SyncNow(); err != nil || result.Message != "The vault is already in sync with GitHub." {
		t.Fatalf("queued sync = %#v, %v", result, err)
	}
}

func TestVaultServiceSyncRetryCoverage(t *testing.T) {
	service, provider, _ := newAppSyncCoverageService(t)
	provider.pull = githubsync.PullResult{Linked: true, UpToDate: true}
	provider.pushErr = githubsync.ErrRemoteAdvanced
	if result, err := service.syncNow(); err != nil || !strings.Contains(result.Warning, "remote branch advanced") || provider.pushCalls != 3 {
		t.Fatalf("repeated remote advancement = %#v, %v, pushes=%d", result, err, provider.pushCalls)
	}
	provider.pushCalls = 0
	provider.pushErr = errors.New("connection reset by peer")
	if result, err := service.syncNow(); err != nil || !strings.Contains(result.Warning, "push could not be completed") || provider.pushCalls != 3 {
		t.Fatalf("repeated retryable failure = %#v, %v, pushes=%d", result, err, provider.pushCalls)
	}
}
