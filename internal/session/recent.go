package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"cipherleaf/internal/atomicfile"
)

const recentFilename = "last-vault.json"
const maxRecentVaults = 5
const maxRecentAge = 7 * 24 * time.Hour

type recentVault struct {
	Path       string           `json:"path"`
	Paths      []string         `json:"paths,omitempty"`
	LastOpened map[string]int64 `json:"lastOpened,omitempty"`
	Theme      string           `json:"theme,omitempty"`
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
		root, err = os.UserHomeDir()
		if err != nil || strings.TrimSpace(root) == "" {
			return NewRecentVaultStore("")
		}
		root = filepath.Join(root, ".config")
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
	lastOpened := current.LastOpened
	if lastOpened == nil {
		lastOpened = make(map[string]int64)
	}
	lastOpened[cleaned] = time.Now().Unix()
	return s.write(recentVault{
		Path:       cleaned,
		Paths:      paths,
		LastOpened: lastOpened,
		Theme:      NormalizeTheme(theme),
	})
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

func (s *RecentVaultStore) Remove(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve recent vault path: %w", err)
	}
	cleaned := filepath.Clean(absolute)
	recent, err := s.read()
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(recent.Paths))
	found := false
	for _, existing := range recent.Paths {
		if existing == cleaned {
			found = true
			continue
		}
		paths = append(paths, existing)
	}
	if !found {
		return nil
	}
	delete(recent.LastOpened, cleaned)
	recent.Paths = paths
	recent.Path = ""
	if len(paths) > 0 {
		recent.Path = paths[len(paths)-1]
	}
	return s.write(recent)
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
	paths, lastOpened := recentPaths(recent, time.Now().Unix())
	if len(paths) > maxRecentVaults {
		paths = paths[len(paths)-maxRecentVaults:]
	}
	recent.Paths = paths
	recent.LastOpened = lastOpened
	recent.Path = ""
	if len(paths) > 0 {
		recent.Path = paths[len(paths)-1]
	}
	recent.Theme = NormalizeTheme(recent.Theme)
	return recent, nil
}

func recentPaths(recent recentVault, now int64) ([]string, map[string]int64) {
	opened := recent.LastOpened
	if opened == nil {
		opened = make(map[string]int64)
	}
	candidates := append([]string(nil), recent.Paths...)
	if len(candidates) == 0 && strings.TrimSpace(recent.Path) != "" {
		candidates = append(candidates, recent.Path)
	}
	paths := make([]string, 0, maxRecentVaults)
	lastOpened := make(map[string]int64)
	for _, candidate := range candidates {
		path, openedAt, ok := validRecentPath(candidate, opened, now)
		if !ok || slices.Contains(paths, path) {
			continue
		}
		paths = append(paths, path)
		lastOpened[path] = openedAt
	}
	return paths, lastOpened
}

func validRecentPath(value string, opened map[string]int64, now int64) (string, int64, bool) {
	path := strings.TrimSpace(value)
	if path == "" {
		return "", 0, false
	}
	path = filepath.Clean(path)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return "", 0, false
	}
	openedAt, ok := opened[path]
	if !ok {
		openedAt = now
	}
	if now-openedAt > int64(maxRecentAge/time.Second) {
		return "", 0, false
	}
	return path, openedAt, true
}

func (s *RecentVaultStore) write(recent recentVault) error {
	data, err := json.Marshal(recent)
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

func (s *RecentVaultStore) Forget() error {
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove recent vault file: %w", err)
	}
	return nil
}
