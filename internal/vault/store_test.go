package vault

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVaultLifecycleStoresNoPlaintext(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Private folder")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Private title", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "# Extremely private content"); err != nil {
		t.Fatal(err)
	}
	store.Lock()

	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(data), "Private title") ||
			strings.Contains(string(data), "Private folder") ||
			strings.Contains(string(data), "Extremely private content") {
			t.Errorf("plaintext leaked into %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.Open(root, "wrong passphrase value"); err == nil {
		t.Fatal("expected wrong passphrase to fail")
	}
	if _, err := store.Open(root, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Content != "# Extremely private content" {
		t.Fatalf("unexpected content: %q", loaded.Content)
	}
	if loaded.FolderID != folder.ID {
		t.Fatalf("got folder %q, want %q", loaded.FolderID, folder.ID)
	}
}

func TestFolderLifecycleAndNoteMovement(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Projects")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateFolder("projects"); err == nil {
		t.Fatal("expected duplicate folder name to fail")
	}
	note, err := store.CreateNoteInFolder("Roadmap", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if note.FolderID != folder.ID {
		t.Fatalf("got folder %q, want %q", note.FolderID, folder.ID)
	}
	if err := store.DeleteFolder(folder.ID); err == nil {
		t.Fatal("expected deletion of a non-empty folder to fail")
	}
	moved, err := store.MoveNote(note.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if moved.FolderID != "" {
		t.Fatalf("expected note to be unfiled, got %q", moved.FolderID)
	}
	renamed, err := store.RenameFolder(folder.ID, "Archive")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != "Archive" {
		t.Fatalf("got folder name %q", renamed.Name)
	}
	if err := store.DeleteFolder(folder.ID); err != nil {
		t.Fatal(err)
	}
	folders, err := store.ListFolders()
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 {
		t.Fatalf("expected no folders, got %d", len(folders))
	}
}

func TestTamperedNoteFailsAuthentication(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Tamper target")
	if err != nil {
		t.Fatal(err)
	}
	path := store.notePathLocked(note.ID)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	position := len(data) - 5
	data[position] ^= 1
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".bak", data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); err == nil {
		t.Fatal("expected tampered note and backup to fail")
	}
}

func TestAtomicWriteRefreshesBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "value.enc")
	first := map[string]string{"revision": "first"}
	second := map[string]string{"revision": "second"}

	if err := writeJSONAtomic(path, first); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(path, second); err != nil {
		t.Fatal(err)
	}

	for _, candidate := range []string{path, path + ".bak"} {
		data, err := os.ReadFile(candidate)
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]string
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded["revision"] != "second" {
			t.Fatalf("%s contains revision %q, want second", candidate, decoded["revision"])
		}
	}
}

func TestVaultReadsEncryptedBackupAfterPrimaryCorruption(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Recovery target")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.SaveNote(note.ID, note.Title, "latest encrypted content")
	if err != nil {
		t.Fatal(err)
	}
	path := store.notePathLocked(note.ID)
	if err := os.WriteFile(path, []byte("{damaged"), 0o600); err != nil {
		t.Fatal(err)
	}

	recovered, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Content != saved.Content || recovered.Revision != saved.Revision {
		t.Fatalf("recovered note %#v, want %#v", recovered, saved)
	}
}

func TestDeleteNoteRemovesPrimaryAndBackup(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Temporary note")
	if err != nil {
		t.Fatal(err)
	}
	path := store.notePathLocked(note.ID)
	if err := store.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{path, path + ".bak"} {
		if _, err := os.Stat(candidate); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s still exists after DeleteNote()", candidate)
		}
	}
}

func TestCreateVaultInNamedChildFolder(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	parent := t.TempDir()
	store := NewStore()
	session, err := store.CreateIn(parent, "Private Notes", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(parent, "Private Notes")
	if session.Path != expected {
		t.Fatalf("vault path = %q, want %q", session.Path, expected)
	}
	if _, err := os.Stat(filepath.Join(expected, configFilename)); err != nil {
		t.Fatal(err)
	}

	store.Lock()
	if _, err := store.CreateIn(parent, "Private Notes", "another valid passphrase"); !errors.Is(err, ErrVaultAlreadyExists) {
		t.Fatalf("duplicate CreateIn() error = %v, want ErrVaultAlreadyExists", err)
	}
	if _, err := store.CreateIn(expected, "Nested", "another valid passphrase"); !errors.Is(err, ErrVaultAlreadyExists) {
		t.Fatalf("nested CreateIn() error = %v, want ErrVaultAlreadyExists", err)
	}
	if _, err := store.CreateIn(parent, "../escape", "another valid passphrase"); err == nil {
		t.Fatal("expected a path-like vault name to fail")
	}
}

func TestMissingVaultAndNoteErrorsAreClassified(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	emptyFolder := t.TempDir()
	if _, err := NewStore().Open(emptyFolder, "correct horse battery staple"); !errors.Is(err, ErrVaultNotFound) {
		t.Fatalf("Open() error = %v, want ErrVaultNotFound", err)
	}

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Missing file")
	if err != nil {
		t.Fatal(err)
	}
	path := store.notePathLocked(note.ID)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path + ".bak"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); !errors.Is(err, ErrEncryptedFileAbsent) {
		t.Fatalf("GetNote() error = %v, want ErrEncryptedFileAbsent", err)
	}
}

func TestRemoteSnapshotContainsOnlyEncryptedRepositoryLayout(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	session, err := store.Create(t.TempDir(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ExportRemoteSnapshot(session.Path); err == nil {
		t.Fatal("remote export unexpectedly accepted the live vault as its destination")
	}
	folder, err := store.CreateFolder("Remote private folder")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Remote private title", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "Remote private content"); err != nil {
		t.Fatal(err)
	}
	snapshot := t.TempDir()
	if err := store.ExportRemoteSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{
		configFilename: true,
		filepath.Join(syncDirectory, syncManifestFile):        true,
		filepath.Join(syncDirectory, syncFoldersFile):         true,
		filepath.Join("objects", note.ID[:2], note.ID+".enc"): true,
	}
	err = filepath.WalkDir(snapshot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		relative, err := filepath.Rel(snapshot, path)
		if err != nil {
			return err
		}
		if !expected[relative] {
			t.Errorf("unexpected remote snapshot file %q", relative)
		}
		delete(expected, relative)
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, plaintext := range []string{
			"Remote private folder",
			"Remote private title",
			"Remote private content",
		} {
			if strings.Contains(string(data), plaintext) {
				t.Errorf("plaintext %q leaked into %s", plaintext, relative)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(expected) != 0 {
		t.Fatalf("remote snapshot files missing: %#v", expected)
	}
	matches, err := store.ValidateRemoteSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("newly exported remote snapshot does not match local vault")
	}
	if _, err := store.SaveNote(note.ID, note.Title, "new local content"); err != nil {
		t.Fatal(err)
	}
	summaries, err := store.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || len(summaries[0].CiphertextHash) != sha256.Size*2 {
		t.Fatalf("ciphertext hash was not cached in encrypted manifest: %#v", summaries)
	}
	matches, err = store.ValidateRemoteSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if matches {
		t.Fatal("stale remote snapshot unexpectedly matches changed local vault")
	}
	extraID := strings.Repeat("a", 32)
	extraPath := filepath.Join(snapshot, "objects", extraID[:2], extraID+".enc")
	if err := os.MkdirAll(filepath.Dir(extraPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(extraPath, []byte("untracked object"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateRemoteSnapshot(snapshot); err == nil ||
		!strings.Contains(err.Error(), "absent from its inventory") {
		t.Fatalf("extra object validation error = %v", err)
	}
}

func BenchmarkUnchangedRemoteSnapshotExport(b *testing.B) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	b.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(b.TempDir(), "correct horse battery staple"); err != nil {
		b.Fatal(err)
	}
	content := strings.Repeat("encrypted benchmark content\n", 160)
	for index := 0; index < 200; index++ {
		note, err := store.CreateNote(fmt.Sprintf("Note %03d", index))
		if err != nil {
			b.Fatal(err)
		}
		if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
			b.Fatal(err)
		}
	}
	snapshot := b.TempDir()
	if err := store.ExportRemoteSnapshot(snapshot); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if err := store.ExportRemoteSnapshot(snapshot); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkChangedLargeNoteSync(b *testing.B) {
	for _, size := range []int{1024 * 1024, 10*1024*1024 - 1024} {
		b.Run(fmt.Sprintf("%dMiB", size/(1024*1024)), func(b *testing.B) {
			previous := defaultKDF
			defaultKDF.Memory = 8 * 1024
			defaultKDF.Time = 1
			b.Cleanup(func() { defaultKDF = previous })
			store := NewStore()
			if _, err := store.Create(b.TempDir(), "correct horse battery staple"); err != nil {
				b.Fatal(err)
			}
			note, err := store.CreateNote("Large sync benchmark")
			if err != nil {
				b.Fatal(err)
			}
			base := strings.Repeat("markdown benchmark line\n", size/24)
			snapshot := b.TempDir()
			b.ResetTimer()
			for index := 0; index < b.N; index++ {
				content := fmt.Sprintf("revision %d\n%s", index, base)
				if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
					b.Fatal(err)
				}
				if err := store.ExportRemoteSnapshot(snapshot); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestRemoteSnapshotRejectsVaultIDMismatch(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	first := NewStore()
	if _, err := first.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	snapshot := t.TempDir()
	if err := first.ExportRemoteSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	second := NewStore()
	if _, err := second.Create(t.TempDir(), "another correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	if _, err := second.ValidateRemoteSnapshot(snapshot); err == nil ||
		!strings.Contains(err.Error(), "another vault") {
		t.Fatalf("vault mismatch error = %v", err)
	}
}

func TestEmptyRemoteSnapshotRemainsValidWithoutObjectsDirectory(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	snapshot := t.TempDir()
	if err := store.ExportRemoteSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(snapshot, "objects")); err != nil {
		t.Fatal(err)
	}
	matches, err := store.ValidateRemoteSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("empty remote snapshot does not match its local vault")
	}
}

func TestRestoreRemoteSnapshotReconstructsLocalVault(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	sourceStore := NewStore()
	if _, err := sourceStore.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	folder, err := sourceStore.CreateFolder("Restored folder")
	if err != nil {
		t.Fatal(err)
	}
	note, err := sourceStore.CreateNoteInFolder("Restored title", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := sourceStore.SaveNote(note.ID, note.Title, "restored private content")
	if err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := sourceStore.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	parent := t.TempDir()
	restoredStore := NewStore()
	session, err := restoredStore.RestoreRemoteSnapshot(
		remote,
		parent,
		"Downloaded vault",
		secret,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.Path != filepath.Join(parent, "Downloaded vault") ||
		session.NoteCount != 1 {
		t.Fatalf("restored session = %#v", session)
	}
	restored, err := restoredStore.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restored != saved {
		t.Fatalf("restored note = %#v, want %#v", restored, saved)
	}
	folders, err := restoredStore.ListFolders()
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0] != folder {
		t.Fatalf("restored folders = %#v", folders)
	}
	for _, required := range []string{
		configFilename,
		configFilename + ".bak",
		manifestFilename,
		manifestFilename + ".bak",
		filepath.Join("objects", note.ID[:2], note.ID+".enc"),
		filepath.Join("objects", note.ID[:2], note.ID+".enc.bak"),
	} {
		if _, err := os.Stat(filepath.Join(session.Path, required)); err != nil {
			t.Fatalf("restored vault is missing %s: %v", required, err)
		}
	}
	if _, err := os.Stat(filepath.Join(session.Path, syncDirectory)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("restored local vault unexpectedly contains provider sync metadata")
	}
	restoredStore.Lock()
	if _, err := restoredStore.Open(session.Path, secret); err != nil {
		t.Fatalf("reopen restored vault: %v", err)
	}
}

func TestRestoreRemoteSnapshotFailureLeavesNoVault(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	sourceStore := NewStore()
	if _, err := sourceStore.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := sourceStore.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	parent := t.TempDir()
	restoredStore := NewStore()
	if _, err := restoredStore.RestoreRemoteSnapshot(
		remote,
		parent,
		"Wrong secret",
		"incorrect horse battery staple",
	); err == nil {
		t.Fatal("restore unexpectedly accepted the wrong vault secret")
	}
	if _, err := os.Stat(filepath.Join(parent, "Wrong secret")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed restore left a final vault folder")
	}

	manifestPath := filepath.Join(remote, syncDirectory, syncManifestFile)
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-4] ^= 1
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := restoredStore.RestoreRemoteSnapshot(
		remote,
		parent,
		"Tampered remote",
		"correct horse battery staple",
	); err == nil {
		t.Fatal("restore unexpectedly accepted tampered encrypted metadata")
	}
	if _, err := os.Stat(filepath.Join(parent, "Tampered remote")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("tampered restore left a final vault folder")
	}
}

func TestNoteRecordsModifiedAtEpoch(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	before := time.Now().UTC().Unix()
	note, err := store.CreateNote("Epoch note")
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().UTC().Unix()
	if note.ModifiedAt < before || note.ModifiedAt > after {
		t.Fatalf("create ModifiedAt = %d, want within [%d,%d]", note.ModifiedAt, before, after)
	}

	summaries, err := store.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if summaries[0].ModifiedAt != note.ModifiedAt {
		t.Fatalf("summary ModifiedAt = %d, want %d", summaries[0].ModifiedAt, note.ModifiedAt)
	}

	time.Sleep(time.Second)
	saved, err := store.SaveNote(note.ID, note.Title, "newer content")
	if err != nil {
		t.Fatal(err)
	}
	if saved.ModifiedAt <= note.ModifiedAt {
		t.Fatalf("save ModifiedAt = %d, want > %d", saved.ModifiedAt, note.ModifiedAt)
	}

	remote := t.TempDir()
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	plaintext, err := store.readEnvelopeFileLocked(
		filepath.Join(remote, syncDirectory, syncManifestFile),
		"sync-manifest",
		"sync-manifest",
	)
	if err != nil {
		t.Fatal(err)
	}
	var inventory remoteSyncManifest
	if err := json.Unmarshal(plaintext, &inventory); err != nil {
		t.Fatal(err)
	}
	if len(inventory.Objects) != 1 || inventory.Objects[0].ModifiedAt != saved.ModifiedAt {
		t.Fatalf("remote inventory = %#v, want ModifiedAt %d", inventory.Objects, saved.ModifiedAt)
	}
}

func TestValidateConfigRejectsExcessiveKDFResources(t *testing.T) {
	config := vaultConfig{
		FormatVersion: FormatVersion,
		VaultID:       strings.Repeat("a", 32),
		Algorithm:     Algorithm,
		Key: keyConfiguration{KDF: kdfConfiguration{
			Name:        "Argon2id",
			Time:        3,
			MemoryKiB:   64 * 1024,
			Parallelism: 2,
		}},
	}
	if err := validateConfig(config); err != nil {
		t.Fatalf("supported KDF profile rejected: %v", err)
	}
	config.Key.KDF.MemoryKiB = 1024 * 1024
	if err := validateConfig(config); err == nil {
		t.Fatal("1 GiB KDF profile unexpectedly accepted")
	}
	config.Key.KDF.MemoryKiB = 64 * 1024
	config.Key.KDF.Time = 10
	if err := validateConfig(config); err == nil {
		t.Fatal("10-pass KDF profile unexpectedly accepted")
	}
	config.Key.KDF.Time = 3
	config.Key.KDF.Parallelism = 16
	if err := validateConfig(config); err == nil {
		t.Fatal("16-thread KDF profile unexpectedly accepted")
	}
}

func TestFindInNotesReturnsSnippetsAndOffsets(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	alpha, err := store.CreateNote("Alpha meeting")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(alpha.ID, alpha.Title, "Discuss the secret roadmap and the secret launch date."); err != nil {
		t.Fatal(err)
	}
	beta, err := store.CreateNote("Beta")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(beta.ID, beta.Title, "No relevant terms in this file."); err != nil {
		t.Fatal(err)
	}

	matches, err := store.FindInNotes("secret", 10)
	if err != nil {
		t.Fatal(err)
	}
	var titleMatches, contentMatches int
	for _, m := range matches {
		if m.NoteID != alpha.ID || m.Offset < 0 {
			continue
		}
		if m.Field == "title" {
			titleMatches++
		}
		if m.Field == "content" {
			contentMatches++
		}
	}
	if titleMatches != 0 || contentMatches != 2 {
		t.Fatalf("match fields = title:%d content:%d, matches=%#v", titleMatches, contentMatches, matches)
	}
	var found bool
	for _, m := range matches {
		if m.NoteID == beta.ID {
			found = true
		}
	}
	if found {
		t.Fatalf("unexpected match in beta: %#v", matches)
	}
}

func TestReplaceAcrossNotesRewritesAndUpdatesModifiedAt(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	alpha, err := store.CreateNote("Secret plan")
	if err != nil {
		t.Fatal(err)
	}
	original, err := store.SaveNote(alpha.ID, alpha.Title, "keep the secret plan safe and the SECRET backup secure")
	if err != nil {
		t.Fatal(err)
	}
	beta, err := store.CreateNote("Daily log")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(beta.ID, beta.Title, "nothing important here"); err != nil {
		t.Fatal(err)
	}

	time.Sleep(time.Second)
	before := time.Now().UTC().Unix()
	result, err := store.ReplaceAcrossNotes("secret", "REDACTED", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ReplacedNotes != 1 || result.Replacements < 3 {
		t.Fatalf("replace result = %#v, want 1 note and >=3 replacements", result)
	}

	updated, err := store.GetNote(alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(updated.Content), "secret") {
		t.Fatalf("alpha content still contains 'secret': %q", updated.Content)
	}
	if !strings.Contains(updated.Title, "REDACTED") {
		t.Fatalf("alpha title not replaced: %q", updated.Title)
	}
	if updated.ModifiedAt < before {
		t.Fatalf("alpha ModifiedAt = %d, want >= %d", updated.ModifiedAt, before)
	}
	if updated.Revision <= original.Revision {
		t.Fatalf("alpha Revision = %d, want > %d", updated.Revision, original.Revision)
	}

	betaAfter, err := store.GetNote(beta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if betaAfter.Content != "nothing important here" {
		t.Fatalf("beta content unexpectedly modified: %q", betaAfter.Content)
	}

	removed, err := store.ReplaceAcrossNotes("REDACTED", "", []string{alpha.ID})
	if err != nil {
		t.Fatal(err)
	}
	withoutReplacement, err := store.GetNote(alpha.ID)
	if err != nil {
		t.Fatal(err)
	}
	if removed.ReplacedNotes != 1 ||
		strings.Contains(strings.ToLower(withoutReplacement.Content), "redacted") {
		t.Fatalf("empty replacement failed: result=%#v note=%#v", removed, withoutReplacement)
	}
}

func TestRemoteTombstonesDeleteAndDoNotResurrectNotesOrFolders(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	first := NewStore()
	if _, err := first.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	folder, err := first.CreateFolder("Reusable name")
	if err != nil {
		t.Fatal(err)
	}
	note, err := first.CreateNoteInFolder("Reusable title", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.SaveNote(note.ID, note.Title, "private content"); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	second := NewStore()
	if _, err := second.RestoreRemoteSnapshot(
		remote, t.TempDir(), "Second device", secret,
	); err != nil {
		t.Fatal(err)
	}
	if err := first.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	if err := first.DeleteFolder(folder.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := first.MergeRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if _, err := first.GetNote(note.ID); err == nil {
		t.Fatal("pulling the stale remote resurrected a locally deleted note")
	}
	if folders, err := first.ListFolders(); err != nil || len(folders) != 0 {
		t.Fatalf("pulling the stale remote resurrected a locally deleted folder: %#v, %v", folders, err)
	}
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	merged, err := second.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	if merged.DeletedNotes != 1 || merged.DeletedFolders != 1 {
		t.Fatalf("merge result = %#v", merged)
	}
	if _, err := second.GetNote(note.ID); err == nil {
		t.Fatal("deleted remote note was restored")
	}
	folders, err := second.ListFolders()
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 {
		t.Fatalf("deleted remote folder was restored: %#v", folders)
	}

	secondSnapshot := t.TempDir()
	if err := second.ExportRemoteSnapshot(secondSnapshot); err != nil {
		t.Fatal(err)
	}
	if matches, err := first.ValidateRemoteSnapshot(secondSnapshot); err != nil || !matches {
		t.Fatalf("tombstone snapshots did not converge: matches=%v err=%v", matches, err)
	}

	recreatedFolder, err := second.CreateFolder(folder.Name)
	if err != nil {
		t.Fatal(err)
	}
	recreatedNote, err := second.CreateNoteInFolder(note.Title, recreatedFolder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recreatedFolder.ID == folder.ID || recreatedNote.ID == note.ID {
		t.Fatal("recreated item reused a deleted identity")
	}
	if err := second.ExportRemoteSnapshot(secondSnapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := first.MergeRemoteSnapshot(secondSnapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := first.GetNote(recreatedNote.ID); err != nil {
		t.Fatalf("new note with reused title did not sync: %v", err)
	}
}

func TestLargeNoteIsCompressedBeforeEncryption(t *testing.T) {
	store := NewStore()
	session, err := store.Create(t.TempDir(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Large note")
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Repeat("repeated markdown content\n", 50_000)
	if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(session.Path, "objects", note.ID[:2], note.ID+".enc")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) >= len(content)/4 {
		t.Fatalf("compressed encrypted note is unexpectedly large: %d vs %d", len(data), len(content))
	}
	var value envelope
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if value.Compression != "gzip" {
		t.Fatalf("compression = %q, want gzip", value.Compression)
	}
	loaded, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Content != content {
		t.Fatal("compressed note did not round-trip")
	}
	value.Compression = ""
	tampered, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.readEnvelopeFileLocked(path, "note", note.ID); err == nil {
		t.Fatal("compression header tampering unexpectedly authenticated")
	}
}

func TestCompressedNoteDecompressionLimit(t *testing.T) {
	oversized := bytes.Repeat([]byte("a"), maxNoteBytes+1024*1024+1)
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(oversized); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := decompressNotePayload(compressed.Bytes()); err == nil {
		t.Fatal("oversized compressed note unexpectedly decompressed")
	}
}

func TestRenameVaultMovesFolderAndLocksStore(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	parent := t.TempDir()
	root := filepath.Join(parent, "old-name")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	session, err := store.Create(root, "secret-secret-secret")
	if err != nil {
		t.Fatal(err)
	}
	_ = session
	if _, err := store.CreateNote("Keep me"); err != nil {
		t.Fatal(err)
	}

	renamed, err := store.RenameVault("new-name")
	if err != nil {
		t.Fatal(err)
	}
	if !renamed.Locked {
		t.Fatalf("RenameVault session should be locked, got %#v", renamed)
	}
	wantPath := filepath.Join(parent, "new-name")
	if renamed.Path != wantPath {
		t.Fatalf("renamed path = %q, want %q", renamed.Path, wantPath)
	}
	if _, err := os.Stat(filepath.Join(parent, "old-name")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old folder still present: %v", err)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("new folder missing: %v", err)
	}

	if _, err := store.Open(wantPath, "secret-secret-secret"); err != nil {
		t.Fatalf("reopen renamed vault: %v", err)
	}
	notes, err := store.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 || notes[0].Title != "Keep me" {
		t.Fatalf("notes after rename = %#v, want the original note", notes)
	}

	if _, err := store.RenameVault(""); err == nil {
		t.Fatal("expected error for empty name")
	}
	if _, err := store.RenameVault("../escape"); err == nil {
		t.Fatal("expected error for path-traversal name")
	}
	if _, err := store.RenameVault("new-name"); err != nil {
		t.Fatalf("renaming to same name should be a no-op, got %v", err)
	}
}

func TestReadVaultIDFromConfiguration(t *testing.T) {
	root := t.TempDir()
	if _, err := NewStore().Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	id, err := ReadVaultID(root)
	if err != nil {
		t.Fatal(err)
	}
	if id == "" {
		t.Fatal("ReadVaultID returned an empty id")
	}
}

func TestUnlockedSecretAvailability(t *testing.T) {
	store := NewStore()
	if _, ok := store.UnlockedSecret(); ok {
		t.Fatal("UnlockedSecret should be false while the vault is locked")
	}
	root := t.TempDir()
	if _, err := store.Create(root, "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	secret, ok := store.UnlockedSecret()
	if !ok {
		t.Fatal("UnlockedSecret should be true after Create")
	}
	if string(secret) != "secret-secret-secret" {
		t.Fatalf("UnlockedSecret = %q, want the original secret", string(secret))
	}
	store.Lock()
	if _, ok := store.UnlockedSecret(); ok {
		t.Fatal("UnlockedSecret should be false after Lock")
	}
}
