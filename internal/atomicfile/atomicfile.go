package atomicfile

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func Write(path string, data []byte, syncFile bool) error {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".cipherleaf-write-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("protect temporary file: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write temporary file: %w", err)
	}
	if syncFile {
		if err := temp.Sync(); err != nil {
			temp.Close()
			return fmt.Errorf("flush temporary file: %w", err)
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
			return fmt.Errorf("flush parent directory: %w", err)
		}
		if closeErr != nil {
			return fmt.Errorf("close parent directory: %w", closeErr)
		}
	}
	return nil
}
