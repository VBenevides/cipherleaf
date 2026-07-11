package githubsync

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const settingsFilename = "settings.json"

var safeVaultID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

type SettingsStore interface {
	Load(vaultID string) (SyncSettings, error)
	Save(settings SyncSettings) error
	Remove(vaultID string) error
}

type FileSettingsStore struct {
	root string
}

type diskSettings struct {
	FormatVersion     int    `json:"format_version"`
	VaultID           string `json:"vault_id"`
	Provider          string `json:"provider"`
	RepositorySSH     string `json:"repository_ssh"`
	PrivateKeyPath    string `json:"private_key_path"`
	Branch            string `json:"branch"`
	RepositoryPrivate bool   `json:"repository_private"`
	Linked            bool   `json:"linked"`
	LastSyncedAt      int64  `json:"last_synced_at"`
	LastSnapshotRev   string `json:"last_snapshot_rev,omitempty"`
	LastCommit        string `json:"last_commit,omitempty"`
}

func NewFileSettingsStore(root string) *FileSettingsStore {
	return &FileSettingsStore{root: root}
}

func DefaultConfigRoot() string {
	root, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(root) == "" {
		root = filepath.Join(os.TempDir(), "cipherleaf-config")
	}
	return filepath.Join(root, "Cipherleaf", "github-sync")
}

func (s *FileSettingsStore) Load(vaultID string) (SyncSettings, error) {
	path, err := s.path(vaultID)
	if err != nil {
		return SyncSettings{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return SyncSettings{}, ErrSettingsNotFound
	}
	if err != nil {
		return SyncSettings{}, fmt.Errorf("read GitHub sync settings: %w", err)
	}
	var value diskSettings
	if err := json.Unmarshal(data, &value); err != nil {
		return SyncSettings{}, errors.New("GitHub sync settings are damaged")
	}
	settings := fromDiskSettings(value)
	if settings.FormatVersion != FormatVersion ||
		settings.Provider != ProviderGitHubSSH ||
		settings.VaultID != vaultID {
		return SyncSettings{}, errors.New("GitHub sync settings use an unsupported format or belong to another vault")
	}
	if _, err := ParseGitHubSSHRepository(settings.RepositorySSH); err != nil {
		return SyncSettings{}, errors.New("saved GitHub sync settings contain an invalid repository")
	}
	if !validBranch(settings.Branch) {
		return SyncSettings{}, errors.New("saved GitHub sync settings contain an invalid branch")
	}
	if !settings.RepositoryPrivate {
		return SyncSettings{}, errors.New("saved GitHub sync settings do not confirm a private repository")
	}
	return settings, nil
}

func (s *FileSettingsStore) Save(settings SyncSettings) error {
	path, err := s.path(settings.VaultID)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(toDiskSettings(settings), "", "  ")
	if err != nil {
		return errors.New("could not encode GitHub sync settings")
	}
	data = append(data, '\n')
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create GitHub sync settings directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("protect GitHub sync settings directory: %w", err)
	}
	temp, err := os.CreateTemp(directory, ".settings-*")
	if err != nil {
		return fmt.Errorf("create GitHub sync settings temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("protect GitHub sync settings: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write GitHub sync settings: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("flush GitHub sync settings: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close GitHub sync settings: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace GitHub sync settings: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("protect GitHub sync settings: %w", err)
	}
	return nil
}

func (s *FileSettingsStore) Remove(vaultID string) error {
	path, err := s.path(vaultID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove GitHub sync settings: %w", err)
	}
	return nil
}

func (s *FileSettingsStore) path(vaultID string) (string, error) {
	if !safeVaultID.MatchString(vaultID) {
		return "", errors.New("invalid vault ID for GitHub sync settings")
	}
	return filepath.Join(s.root, vaultID, settingsFilename), nil
}

func toDiskSettings(value SyncSettings) diskSettings {
	return diskSettings{
		FormatVersion:     value.FormatVersion,
		VaultID:           value.VaultID,
		Provider:          value.Provider,
		RepositorySSH:     value.RepositorySSH,
		PrivateKeyPath:    value.PrivateKeyPath,
		Branch:            value.Branch,
		RepositoryPrivate: value.RepositoryPrivate,
		Linked:            value.Linked,
		LastSyncedAt:      value.LastSyncedAt,
		LastSnapshotRev:   value.LastSnapshotRev,
		LastCommit:        value.LastCommit,
	}
}

func fromDiskSettings(value diskSettings) SyncSettings {
	return SyncSettings{
		FormatVersion:     value.FormatVersion,
		VaultID:           value.VaultID,
		Provider:          value.Provider,
		RepositorySSH:     value.RepositorySSH,
		PrivateKeyPath:    value.PrivateKeyPath,
		Branch:            value.Branch,
		RepositoryPrivate: value.RepositoryPrivate,
		Linked:            value.Linked,
		LastSyncedAt:      value.LastSyncedAt,
		LastSnapshotRev:   value.LastSnapshotRev,
		LastCommit:        value.LastCommit,
	}
}
