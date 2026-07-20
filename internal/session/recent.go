package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"cipherleaf/internal/atomicfile"
)

const recentFilename = "last-vault.json"
const maxRecentVaults = 5

type recentVault struct {
	Path  string   `json:"path"`
	Paths []string `json:"paths,omitempty"`
	Theme string   `json:"theme,omitempty"`
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
	case "light", "dark", "archivist":
		return strings.ToLower(strings.TrimSpace(value))
	}
	return ""
}

func (s *RecentVaultStore) Remember(path string) error {
	theme := ""
	if existing, err := s.read(); err != nil {
		return err
	} else {
		theme = existing.Theme
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
	current, err := s.read()
	if err != nil {
		return err
	}
	cleaned := filepath.Clean(absolute)
	paths := make([]string, 0, maxRecentVaults)
	for _, existing := range current.Paths {
		if existing != cleaned {
			paths = append(paths, existing)
		}
	}
	paths = append(paths, cleaned)
	if len(paths) > maxRecentVaults {
		paths = paths[len(paths)-maxRecentVaults:]
	}
	data, err := json.Marshal(recentVault{Path: cleaned, Paths: paths, Theme: NormalizeTheme(theme)})
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
	if err := atomicfile.Write(s.path, data, true); err != nil {
		return fmt.Errorf("replace recent vault file: %w", err)
	}
	return nil
}

func (s *RecentVaultStore) LastPath() (string, error) {
	recent, err := s.read()
	return recent.Path, err
}

func (s *RecentVaultStore) LastTheme() string {
	recent, err := s.read()
	if err != nil {
		return ""
	}
	return recent.Theme
}

// Paths returns up to five vault paths in access order, from oldest to newest.
func (s *RecentVaultStore) Paths() ([]string, error) {
	recent, err := s.read()
	if err != nil {
		return nil, err
	}
	return append([]string(nil), recent.Paths...), nil
}

func (s *RecentVaultStore) read() (recentVault, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return recentVault{}, nil
	}
	if err != nil {
		return recentVault{}, fmt.Errorf("read recent vault file: %w", err)
	}
	var recent recentVault
	if err := json.Unmarshal(data, &recent); err != nil {
		return recentVault{}, fmt.Errorf("decode recent vault file: %w", err)
	}
	paths := make([]string, 0, maxRecentVaults)
	for _, path := range recent.Paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		cleaned := filepath.Clean(path)
		duplicate := false
		for _, existing := range paths {
			if existing == cleaned {
				duplicate = true
				break
			}
		}
		if !duplicate {
			paths = append(paths, cleaned)
		}
	}
	if len(paths) == 0 && strings.TrimSpace(recent.Path) != "" {
		paths = append(paths, filepath.Clean(recent.Path))
	}
	if len(paths) > maxRecentVaults {
		paths = paths[len(paths)-maxRecentVaults:]
	}
	recent.Paths = paths
	recent.Path = ""
	if len(paths) > 0 {
		recent.Path = paths[len(paths)-1]
	}
	recent.Theme = NormalizeTheme(recent.Theme)
	return recent, nil
}

func (s *RecentVaultStore) Forget() error {
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove recent vault file: %w", err)
	}
	return nil
}
