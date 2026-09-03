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

func TestBackupHelpersValidateNamesAndPruneExpiredBackups(t *testing.T) {
	parent := t.TempDir()
	if got, err := backupDestination(parent); err != nil || got != parent {
		t.Fatalf("backupDestination() = %q, %v", got, err)
	}
	file := filepath.Join(parent, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{file, filepath.Join(parent, "missing")} {
		if _, err := backupDestination(invalid); err == nil {
			t.Fatalf("backupDestination(%q) unexpectedly succeeded", invalid)
		}
	}
	prefix := "Cipherleaf Encrypted Backup test "
	valid := prefix + "20260903T110000Z"
	for _, name := range []string{valid, prefix + "invalid", "other"} {
		if err := os.Mkdir(filepath.Join(parent, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(parent, prefix+"20260901T120000Z"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	names, err := scheduledBackupNames(parent, prefix)
	if err != nil || len(names) != 1 || names[0] != valid {
		t.Fatalf("scheduledBackupNames() = %#v, %v", names, err)
	}
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	if !scheduledBackupDue(nil, prefix, now) || scheduledBackupDue([]string{valid}, prefix, now) || !scheduledBackupDue([]string{prefix + "20260901T120000Z"}, prefix, now) || !scheduledBackupDue([]string{prefix + "invalid"}, prefix, now) {
		t.Fatal("scheduledBackupDue() returned an unexpected result")
	}
	if !scheduledBackupDue([]string{prefix + "20260904T120000Z"}, prefix, now) {
		t.Fatal("future backup should be considered due")
	}
	created, err := trimExpiredBackups(parent, []string{valid, prefix + "20260901T120000Z"}, 1, "created")
	if err != nil || created != "created" {
		t.Fatalf("trimExpiredBackups() = %q, %v", created, err)
	}
	if _, err := os.Stat(filepath.Join(parent, valid)); !os.IsNotExist(err) {
		t.Fatalf("expired backup still exists: %v", err)
	}
}
