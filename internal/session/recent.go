package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const recentFilename = "last-vault.json"

type recentVault struct {
	Path  string `json:"path"`
	Theme string `json:"theme,omitempty"`
}

// ErrNoLastVault is returned when an operation expects a previously opened
// vault but the recent-session file does not contain one.
var ErrNoLastVault = errors.New("no last opened vault is remembered")

type RecentVaultStore struct {
	path string
}

func NewRecentVaultStore(path string) *RecentVaultStore {
	return &RecentVaultStore{path: path}
}

func NewDefaultRecentVaultStore() *RecentVaultStore {
	root, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(root) == "" {
		root = filepath.Join(os.TempDir(), "cipherleaf-config")
	}
	return NewRecentVaultStore(filepath.Join(root, "Cipherleaf", recentFilename))
}

// NormalizeTheme clamps a user-supplied theme identifier to a known value.
func NormalizeTheme(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "light", "dark":
		return strings.ToLower(strings.TrimSpace(value))
	}
	return ""
}

func (s *RecentVaultStore) Remember(path string) error {
	theme := ""
	data, err := os.ReadFile(s.path)
	if err == nil {
		var existing recentVault
		if json.Unmarshal(data, &existing) == nil {
			theme = NormalizeTheme(existing.Theme)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read previous recent vault file: %w", err)
	}
	return s.RememberWithTheme(path, theme)
}

func (s *RecentVaultStore) RememberWithTheme(path, theme string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("recent vault path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve recent vault path: %w", err)
	}
	data, err := json.Marshal(recentVault{Path: filepath.Clean(absolute), Theme: NormalizeTheme(theme)})
	if err != nil {
		return fmt.Errorf("encode recent vault file: %w", err)
	}
	directory := filepath.Dir(s.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create recent vault directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("protect recent vault directory: %w", err)
	}
	temp, err := os.CreateTemp(directory, ".recent-vault-*")
	if err != nil {
		return fmt.Errorf("create recent vault temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("protect recent vault file: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write recent vault file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("flush recent vault file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close recent vault file: %w", err)
	}
	if err := os.Rename(tempPath, s.path); err != nil {
		return fmt.Errorf("replace recent vault file: %w", err)
	}
	return nil
}

func (s *RecentVaultStore) LastPath() (string, error) {
	path, _, err := s.read()
	return path, err
}

func (s *RecentVaultStore) LastTheme() string {
	_, theme, err := s.read()
	if err != nil {
		return ""
	}
	return theme
}

func (s *RecentVaultStore) read() (string, string, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("read recent vault file: %w", err)
	}
	var recent recentVault
	if err := json.Unmarshal(data, &recent); err != nil {
		return "", "", fmt.Errorf("decode recent vault file: %w", err)
	}
	return filepath.Clean(recent.Path), NormalizeTheme(recent.Theme), nil
}

func (s *RecentVaultStore) Forget() error {
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove recent vault file: %w", err)
	}
	return nil
}
