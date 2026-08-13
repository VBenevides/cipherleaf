package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScheduledBackupCreatesEncryptedSnapshotAndAppliesRetention(t *testing.T) {
	service := NewVaultService()
	session, err := service.store.Create(t.TempDir(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.store.CreateNote("Backed up"); err != nil {
		t.Fatal(err)
	}
	destination := t.TempDir()
	created, err := service.CreateScheduledBackup(destination, 2)
	if err != nil || created == "" {
		t.Fatalf("CreateScheduledBackup() = %q, %v", created, err)
	}
	manifest, err := os.ReadFile(filepath.Join(created, "sync", "manifest.enc"))
	if err != nil || strings.Contains(string(manifest), "Backed up") {
		t.Fatal("backup manifest is missing or contains plaintext")
	}
	if duplicate, err := service.CreateScheduledBackup(destination, 2); err != nil || duplicate != "" {
		t.Fatalf("duplicate scheduled backup = %q, %v", duplicate, err)
	}

	prefix := "Cipherleaf Encrypted Backup " + session.VaultID + " "
	for _, age := range []time.Duration{72 * time.Hour, 48 * time.Hour} {
		path := filepath.Join(destination, prefix+time.Now().UTC().Add(-age).Format(backupTimestampFormat))
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.CreateScheduledBackup(destination, 2); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(destination)
	if err != nil || len(entries) != 2 {
		t.Fatalf("retained backups = %d, %v; want 2", len(entries), err)
	}
}
