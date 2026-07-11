package githubsync

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"time"
)

type Manager struct {
	mu         sync.Mutex
	settings   SettingsStore
	connection ConnectionTester
	provider   SyncProvider
}

type SyncProvider interface {
	Link(
		ctx context.Context,
		settings SyncSettings,
		snapshot RemoteSnapshotStore,
	) (LinkResult, error)
	Download(
		ctx context.Context,
		settings SyncSettings,
	) (DownloadedVault, error)
	Push(
		ctx context.Context,
		settings SyncSettings,
		snapshot RemoteSnapshotStore,
	) (PushResult, error)
	Pull(
		ctx context.Context,
		settings SyncSettings,
	) (PullResult, error)
}

type ForcePushProvider interface {
	ForcePush(
		ctx context.Context,
		settings SyncSettings,
		snapshot RemoteSnapshotStore,
	) (PushResult, error)
}

type GitWorkingDirectoryProvider interface {
	GitWorkingDirectory(settings SyncSettings) string
}

type RemotePrefetchProvider interface {
	Prefetch(ctx context.Context, settings SyncSettings) error
}

func (m *Manager) PrefetchVault(ctx context.Context, vaultID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	settings, err := m.settings.Load(vaultID)
	if err != nil || !settings.Linked {
		return err
	}
	provider, ok := m.provider.(RemotePrefetchProvider)
	if !ok {
		return nil
	}
	return provider.Prefetch(ctx, settings)
}

func NewManager(settings SettingsStore, connection ConnectionTester) *Manager {
	return &Manager{settings: settings, connection: connection}
}

func NewDefaultManager() *Manager {
	configRoot := DefaultConfigRoot()
	manager := NewManager(
		NewFileSettingsStore(configRoot),
		NewGitConnectionTester(filepath.Join(configRoot, "runtime")),
	)
	manager.provider = NewGitHubSSHProvider(
		filepath.Join(configRoot, "runtime"),
		DefaultCacheRoot(),
	)
	return manager
}

func (m *Manager) GetSettings(vaultID string) (SyncSettings, error) {
	value, err := m.settings.Load(vaultID)
	if errors.Is(err, ErrSettingsNotFound) {
		return DefaultSettings(vaultID), nil
	}
	return value, err
}

// GitWorkingDirectory returns the persistent checkout used for a linked vault.
func (m *Manager) GitWorkingDirectory(vaultID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	settings, err := m.settings.Load(vaultID)
	if err != nil || !settings.Linked {
		return "", errors.New("link this vault to GitHub before opening its Git checkout")
	}
	provider, ok := m.provider.(GitWorkingDirectoryProvider)
	if !ok {
		return "", errors.New("GitHub synchronization provider does not expose a Git checkout")
	}
	return provider.GitWorkingDirectory(settings), nil
}

type RemoteSnapshotStore interface {
	ExportRemoteSnapshot(destination string) error
	ValidateRemoteSnapshot(source string) (bool, error)
}

type snapshotRevisionStore interface {
	SnapshotRevision() (string, error)
}

func snapshotRevision(snapshot RemoteSnapshotStore) (string, error) {
	versioned, ok := snapshot.(snapshotRevisionStore)
	if !ok {
		return "", nil
	}
	return versioned.SnapshotRevision()
}

func (m *Manager) LinkVault(
	ctx context.Context,
	vaultID string,
	value SyncSettings,
	snapshot RemoteSnapshotStore,
) (LinkResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	validated, warning, err := ValidateSettings(value, vaultID)
	if err != nil {
		return LinkResult{}, err
	}
	if m.provider == nil {
		return LinkResult{}, errors.New("GitHub synchronization provider is not available")
	}
	result, err := m.provider.Link(ctx, validated, snapshot)
	if err != nil {
		return LinkResult{}, err
	}
	validated.Linked = true
	validated.LastCommit = result.LastCommit
	validated.LastSnapshotRev, _ = snapshotRevision(snapshot)
	if err := m.settings.Save(validated); err != nil {
		return LinkResult{}, err
	}
	result.Warning = warning
	return result, nil
}

func (m *Manager) DownloadVault(
	ctx context.Context,
	value SyncSettings,
) (DownloadedVault, SyncSettings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	validated, warning, err := ValidateDownloadSettings(value)
	if err != nil {
		return DownloadedVault{}, SyncSettings{}, err
	}
	if m.provider == nil {
		return DownloadedVault{}, SyncSettings{}, errors.New("GitHub synchronization provider is not available")
	}
	downloaded, err := m.provider.Download(ctx, validated)
	if err != nil {
		return DownloadedVault{}, SyncSettings{}, err
	}
	validated.VaultID = downloaded.VaultID
	validated.Linked = true
	downloaded.Warning = warning
	return downloaded, validated, nil
}

func (m *Manager) ActivateDownloadedVault(settings SyncSettings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	validated, _, err := ValidateSettings(settings, settings.VaultID)
	if err != nil {
		return err
	}
	validated.Linked = true
	return m.settings.Save(validated)
}

func (m *Manager) TestConnection(
	ctx context.Context,
	vaultID string,
	value SyncSettings,
) (ConnectionResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	validated, warning, err := ValidateSettings(value, vaultID)
	if err != nil {
		return ConnectionResult{}, err
	}
	result, err := m.connection.TestConnection(ctx, validated)
	if err != nil {
		return ConnectionResult{}, err
	}
	result.Warning = warning
	return result, nil
}

func (m *Manager) RemoveSettings(vaultID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings.Remove(vaultID)
}

// recordSync stamps the current UTC time as the last successful sync for the
// vault. It never overwrites Linked or other fields, and failures are silent
// (best-effort metadata).
func (m *Manager) recordSync(vaultID string) {
	settings, err := m.settings.Load(vaultID)
	if err != nil {
		return
	}
	settings.LastSyncedAt = time.Now().UTC().Unix()
	_ = m.settings.Save(settings)
}

func (m *Manager) MarkSynced(vaultID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recordSync(vaultID)
}

func (m *Manager) PushVault(
	ctx context.Context,
	vaultID string,
	snapshot RemoteSnapshotStore,
) (PushResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	settings, err := m.settings.Load(vaultID)
	if err != nil {
		if errors.Is(err, ErrSettingsNotFound) {
			return PushResult{}, errors.New("link this vault to GitHub before pushing")
		}
		return PushResult{}, err
	}
	if !settings.Linked {
		return PushResult{}, errors.New("link this vault to GitHub before pushing")
	}
	if m.provider == nil {
		return PushResult{}, errors.New("GitHub synchronization provider is not available")
	}
	revision, err := snapshotRevision(snapshot)
	if err != nil {
		return PushResult{}, err
	}
	if revision != "" && revision == settings.LastSnapshotRev && settings.LastCommit != "" {
		return PushResult{
			Linked: true, Branch: settings.Branch,
			Message: "The local vault is already in sync with GitHub.", UpToDate: true,
		}, nil
	}
	result, err := m.provider.Push(ctx, settings, snapshot)
	if err != nil {
		return PushResult{}, err
	}
	settings.LastSyncedAt = time.Now().UTC().Unix()
	settings.LastSnapshotRev = revision
	settings.LastCommit = result.LastCommit
	_ = m.settings.Save(settings)
	return result, nil
}

func (m *Manager) ForcePushVault(
	ctx context.Context,
	vaultID string,
	snapshot RemoteSnapshotStore,
) (PushResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	settings, err := m.settings.Load(vaultID)
	if err != nil {
		if errors.Is(err, ErrSettingsNotFound) {
			return PushResult{}, errors.New("link this vault to GitHub before pushing")
		}
		return PushResult{}, err
	}
	if !settings.Linked {
		return PushResult{}, errors.New("link this vault to GitHub before pushing")
	}
	provider, ok := m.provider.(ForcePushProvider)
	if !ok {
		return PushResult{}, errors.New("GitHub synchronization provider does not support force push")
	}
	result, err := provider.ForcePush(ctx, settings, snapshot)
	if err != nil {
		return PushResult{}, err
	}
	m.recordSync(vaultID)
	return result, nil
}

func (m *Manager) PullVault(
	ctx context.Context,
	vaultID string,
) (PullResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	settings, err := m.settings.Load(vaultID)
	if err != nil {
		if errors.Is(err, ErrSettingsNotFound) {
			return PullResult{}, errors.New("link this vault to GitHub before pulling")
		}
		return PullResult{}, err
	}
	if !settings.Linked {
		return PullResult{}, errors.New("link this vault to GitHub before pulling")
	}
	if m.provider == nil {
		return PullResult{}, errors.New("GitHub synchronization provider is not available")
	}
	result, err := m.provider.Pull(ctx, settings)
	if err != nil {
		return PullResult{}, err
	}
	return result, nil
}
