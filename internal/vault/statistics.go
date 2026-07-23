package vault

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

func (s *Store) GetVaultStatistics() (VaultStatistics, error) {
	s.mu.RLock()
	if err := s.requireUnlocked(); err != nil {
		s.mu.RUnlock()
		return VaultStatistics{}, err
	}
	root := s.root
	s.mu.RUnlock()

	statistics := VaultStatistics{}
	for _, directory := range []string{"objects", historyDirectory, trashDirectory} {
		size, err := directoryBytes(filepath.Join(root, directory))
		if err != nil {
			return VaultStatistics{}, err
		}
		statistics.NotesBytes += size
	}
	var err error
	statistics.AttachmentsBytes, err = directoryBytes(filepath.Join(root, "attachments"))
	if err != nil {
		return VaultStatistics{}, err
	}
	statistics.TimeTrackingBytes, err = directoryBytes(filepath.Join(root, trackingDirectory))
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
