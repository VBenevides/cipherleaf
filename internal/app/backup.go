package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const backupTimestampFormat = "20060102T150405Z"

// CreateScheduledBackup creates at most one encrypted snapshot per day.
func (s *VaultService) CreateScheduledBackup(parent string, retention int) (string, error) {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()

	session := s.store.Session()
	if session.Locked {
		return "", errors.New("unlock the vault before creating a backup")
	}
	if retention < 1 || retention > 30 {
		return "", errors.New("backup retention must be between 1 and 30")
	}
	parent, err := filepath.Abs(strings.TrimSpace(parent))
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(parent); err != nil || !info.IsDir() {
		return "", errors.New("backup destination is not a directory")
	}

	prefix := "Cipherleaf Encrypted Backup " + session.VaultID + " "
	entries, err := os.ReadDir(parent)
	if err != nil {
		return "", err
	}
	backups := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		if _, err := time.Parse(backupTimestampFormat, strings.TrimPrefix(entry.Name(), prefix)); err == nil {
			backups = append(backups, entry.Name())
		}
	}
	sort.Strings(backups)

	created := ""
	now := time.Now().UTC()
	latest := time.Time{}
	if len(backups) > 0 {
		latest, _ = time.Parse(backupTimestampFormat, strings.TrimPrefix(backups[len(backups)-1], prefix))
	}
	if latest.IsZero() || now.Before(latest) || now.Sub(latest) >= 24*time.Hour {
		name := prefix + now.Format(backupTimestampFormat)
		created = filepath.Join(parent, name)
		if err := s.store.ExportRemoteSnapshot(created); err != nil {
			return "", fmt.Errorf("create encrypted backup: %w", err)
		}
		backups = append(backups, name)
	}
	for len(backups) > retention {
		path := filepath.Join(parent, backups[0])
		if err := os.RemoveAll(path); err != nil {
			return created, fmt.Errorf("remove expired encrypted backup: %w", err)
		}
		backups = backups[1:]
	}
	return created, nil
}
