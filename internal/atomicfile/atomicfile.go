package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func Write(path string, data []byte, syncFile bool) (writeErr error) {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".cipherleaf-write-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		if removeErr := os.Remove(tempPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			writeErr = errors.Join(writeErr, fmt.Errorf("remove temporary file: %w", removeErr))
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary file: %w", errors.Join(err, temp.Close()))
	}
	if _, err := temp.Write(data); err != nil {
		return fmt.Errorf("write temporary file: %w", errors.Join(err, temp.Close()))
	}
	if syncFile {
		if err := temp.Sync(); err != nil {
			return fmt.Errorf("flush temporary file: %w", errors.Join(err, temp.Close()))
		}
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace file: %w", err)
	}
	if syncFile && runtime.GOOS != "windows" {
		dir, err := os.Open(directory)
		if err != nil {
			return fmt.Errorf("open parent directory: %w", err)
		}
		err = dir.Sync()
		closeErr := dir.Close()
		if err != nil {
			return fmt.Errorf("flush parent directory: %w", errors.Join(err, closeErr))
		}
		if closeErr != nil {
			return fmt.Errorf("close parent directory: %w", closeErr)
		}
	}
	return nil
}
