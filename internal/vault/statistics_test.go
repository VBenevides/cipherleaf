package vault

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestVaultStatisticsSeparatesStorageDomains(t *testing.T) {
	store := NewStore()
	if _, err := store.GetVaultStatistics(); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked statistics error = %v", err)
	}
	root := t.TempDir()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}

	before, err := store.GetVaultStatistics()
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		filepath.Join(root, "objects", "extra.enc"):                    []byte("notes"),
		filepath.Join(root, "attachments", "extra.enc"):                []byte("attachments"),
		filepath.Join(root, trackingDirectory, "objects", "extra.enc"): []byte("tracking"),
	}
	for path, data := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	after, err := store.GetVaultStatistics()
	if err != nil {
		t.Fatal(err)
	}
	if after.NotesBytes-before.NotesBytes != int64(len("notes")) ||
		after.AttachmentsBytes-before.AttachmentsBytes != int64(len("attachments")) ||
		after.TimeTrackingBytes-before.TimeTrackingBytes != int64(len("tracking")) {
		t.Fatalf("unexpected statistics delta: before=%#v after=%#v", before, after)
	}
}
