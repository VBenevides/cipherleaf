package vault

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

func (s *Store) GetVaultStatistics() (VaultStatistics, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return VaultStatistics{}, err
	}

	statistics := VaultStatistics{}
	for _, directory := range []string{"objects", historyDirectory, trashDirectory} {
		size, err := directoryBytes(filepath.Join(s.root, directory))
		if err != nil {
			return VaultStatistics{}, err
		}
		statistics.NotesBytes += size
	}
	var err error
	statistics.AttachmentsBytes, err = directoryBytes(filepath.Join(s.root, "attachments"))
	if err != nil {
		return VaultStatistics{}, err
	}
	statistics.TimeTrackingBytes, err = directoryBytes(filepath.Join(s.root, trackingDirectory))
	return statistics, err
}

func directoryBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			total += info.Size()
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	return total, err
}
