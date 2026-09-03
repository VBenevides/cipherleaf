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

func backupDestination(parent string) (string, error) {
	parent, err := filepath.Abs(strings.TrimSpace(parent))
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(parent); err != nil || !info.IsDir() {
		return "", errors.New("backup destination is not a directory")
	}
	return parent, nil
}

func scheduledBackupNames(parent, prefix string) ([]string, error) {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return nil, err
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
	return backups, nil
}

func scheduledBackupDue(backups []string, prefix string, now time.Time) bool {
	if len(backups) == 0 {
		return true
	}
	latest, err := time.Parse(backupTimestampFormat, strings.TrimPrefix(backups[len(backups)-1], prefix))
	return err != nil || now.Before(latest) || now.Sub(latest) >= 24*time.Hour
}

func trimExpiredBackups(parent string, backups []string, retention int, created string) (string, error) {
	for len(backups) > retention {
		path := filepath.Join(parent, backups[0])
		if err := os.RemoveAll(path); err != nil {
			return created, fmt.Errorf("remove expired encrypted backup: %w", err)
		}
		backups = backups[1:]
	}
	return created, nil
}

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
	parent, err := backupDestination(parent)
	if err != nil {
		return "", err
	}

	prefix := "Cipherleaf Encrypted Backup " + session.VaultID + " "
	backups, err := scheduledBackupNames(parent, prefix)
	if err != nil {
		return "", err
	}

	created := ""
	now := time.Now().UTC()
	if scheduledBackupDue(backups, prefix, now) {
		name := prefix + now.Format(backupTimestampFormat)
		created = filepath.Join(parent, name)
		if err := s.store.ExportRemoteSnapshot(created); err != nil {
			return "", fmt.Errorf("create encrypted backup: %w", err)
		}
		backups = append(backups, name)
	}
	return trimExpiredBackups(parent, backups, retention, created)
}
