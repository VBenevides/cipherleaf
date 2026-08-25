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
	"slices"
	"strings"
	"testing"
	"time"

	"cipherleaf/internal/secure"
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

func BenchmarkSnapshotRevision(b *testing.B) {
	for _, noteCount := range []int{0, 100, 1000} {
		b.Run(fmt.Sprintf("notes_%d", noteCount), func(b *testing.B) {
			store := NewStore()
			if _, err := store.Create(b.TempDir(), "benchmark-secret"); err != nil {
				b.Fatal(err)
			}
			for index := 0; index < noteCount; index++ {
				note, err := store.CreateNote(fmt.Sprintf("Note %d", index))
				if err != nil {
					b.Fatal(err)
				}
				if _, err := store.SaveNote(note.ID, note.Title, "benchmark content"); err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for b.Loop() {
				if _, err := store.SnapshotRevision(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestLockedFolderRequiresBackendAuthorization(t *testing.T) {
	store := NewStore()
	root := t.TempDir()
	if _, err := store.Create(root, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	public, err := store.CreateNote("Public")
	if err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Private")
	if err != nil {
		t.Fatal(err)
	}
	private, err := store.CreateNoteInFolder("Private title", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(private.ID, private.Title, "private content"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LockFolder(folder.ID, "folder password"); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetNote(private.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() error = %v, want ErrFolderLocked", err)
	}
	notes, err := store.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 || notes[0].ID != public.ID {
		t.Fatalf("ListNotes() = %#v, want only public note", notes)
	}
	if matches, err := store.FindInNotes("private", 10); err != nil || len(matches) != 0 {
		t.Fatalf("FindInNotes() = %#v, %v; want no locked-folder matches", matches, err)
	}
	if matches, err := store.Search("private"); err != nil || len(matches) != 0 {
		t.Fatalf("Search() = %#v, %v; want no locked-folder matches", matches, err)
	}
	if err := store.CheckFolderPassword(folder.ID, "wrong password"); err == nil {
		t.Fatal("incorrect folder password was accepted")
	}
	if err := store.CheckFolderPassword(folder.ID, "folder password"); err != nil {
		t.Fatal(err)
	}
	if note, err := store.GetNote(private.ID); err != nil || note.Content != "private content" {
		t.Fatalf("GetNote() = %#v, %v", note, err)
	}
	if err := store.LockFolderSession(folder.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(private.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() after session lock error = %v, want ErrFolderLocked", err)
	}
	if err := store.CheckFolderPassword(folder.ID, "folder password"); err != nil {
		t.Fatal(err)
	}

	store.Lock()
	if _, err := store.Open(root, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(private.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() after reopening error = %v, want ErrFolderLocked", err)
	}
}

func TestFolderPasswordValidationAndLegacyVerifierRejection(t *testing.T) {
	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "folder-migration-secret"); err != nil {
		t.Fatal(err)
	}
	folder, _ := store.CreateFolder("Private")
	if _, err := store.LockFolder(folder.ID, "short"); err == nil {
		t.Fatal("short folder password accepted")
	}
	legacy := "sha256-salt-v1:0123456789abcdef:" + strings.Repeat("a", 64)
	index, _ := store.findFolderLocked(folder.ID)
	store.manifest.Folders[index].Locked = true
	store.manifest.Folders[index].LockPasswordHash = legacy
	if err := store.saveManifestLocked(); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckFolderPassword(folder.ID, "old"); err == nil {
		t.Fatal("salted legacy folder verifier was accepted")
	}
	if store.manifest.Folders[index].LockPasswordHash != legacy {
		t.Fatal("rejected folder verifier was changed")
	}
	legacy = strings.Repeat("a", 64)
	store.manifest.Folders[index].LockPasswordHash = legacy
	if err := store.saveManifestLocked(); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckFolderPassword(folder.ID, "old"); err == nil {
		t.Fatal("unsalted legacy folder verifier was accepted")
	}
	if store.manifest.Folders[index].LockPasswordHash != legacy {
		t.Fatal("rejected folder verifier was changed")
	}
}

func TestParentFolderLocksNestedFolders(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	parent, err := store.CreateFolder("Projects")
	if err != nil {
		t.Fatal(err)
	}
	child, err := store.CreateFolder("Private", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentID != parent.ID {
		t.Fatalf("child parent = %q, want %q", child.ParentID, parent.ID)
	}
	if _, err := store.CreateFolder("Private"); err != nil {
		t.Fatalf("same name in another folder should be allowed: %v", err)
	}
	note, err := store.CreateNoteInFolder("Plan", child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.LockFolder(child.ID, "child password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LockFolder(parent.ID, "parent password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() = %v, want ErrFolderLocked", err)
	}
	if err := store.CheckFolderPassword(parent.ID, "parent password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() after unlocking parent = %v, want ErrFolderLocked", err)
	}
	if err := store.CheckFolderPassword(child.ID, "child password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); err != nil {
		t.Fatalf("GetNote() after unlocking hierarchy: %v", err)
	}
	if err := store.LockFolderSession(parent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() after locking parent = %v, want ErrFolderLocked", err)
	}
	if err := store.CheckFolderPassword(parent.ID, "parent password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNote(note.ID); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetNote() after reopening parent = %v, want child to remain locked", err)
	}
	if _, err := store.MoveFolder(parent.ID, child.ID); err == nil {
		t.Fatal("moving a folder into a descendant succeeded")
	}
	if err := store.DeleteFolder(parent.ID); err == nil {
		t.Fatal("deleting a folder with subfolders succeeded")
	}
}

func TestWebPAttachmentsAreEncryptedAndRestoredWithTheirNote(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	session, err := store.Create(t.TempDir(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("With image")
	if err != nil {
		t.Fatal(err)
	}
	webp := append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("private pixels")...)
	id, err := store.SaveAttachment(note.ID, webp)
	if err != nil {
		t.Fatal(err)
	}
	duplicateID, err := store.SaveAttachment(note.ID, slices.Clone(webp))
	if err != nil || duplicateID != id {
		t.Fatalf("duplicate attachment ID = %q, %v; want %q", duplicateID, err, id)
	}
	path := filepath.Join(session.Path, "attachments", sharedAttachmentFolder, id+".enc")
	encrypted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, webp) {
		t.Fatal("attachment was stored as plaintext")
	}
	loaded, err := store.GetAttachment(note.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(loaded, webp) {
		t.Fatalf("GetAttachment() = %q, want %q", loaded, webp)
	}
	other, err := store.CreateNote("Other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetAttachment(other.ID, id); err == nil {
		t.Fatal("attachment was readable through a note that does not reference it")
	}
	if _, err := store.SaveNote(other.ID, other.Title, fmt.Sprintf("![shared](attachment:%s)", id)); err != nil {
		t.Fatal(err)
	}
	loadedFromOtherNote, err := store.GetAttachment(other.ID, id)
	if err != nil || !bytes.Equal(loadedFromOtherNote, webp) {
		t.Fatal("shared attachment was not readable through a note that references it")
	}
	staleID, err := store.SaveAttachment(note.ID, append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("stale pixels")...))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(
		note.ID,
		note.Title,
		fmt.Sprintf("![kept](attachment:%s#width=640)", id),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetAttachment(note.ID, staleID); err == nil {
		t.Fatal("unreferenced attachment remains after saving")
	}
	syncStaleID, err := store.SaveAttachment(note.ID, append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("sync stale pixels")...))
	if err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetAttachment(note.ID, syncStaleID); err == nil {
		t.Fatal("unreferenced attachment remains after sync export")
	}
	restored := NewStore()
	if _, err := restored.RestoreRemoteSnapshot(
		remote,
		t.TempDir(),
		"restored attachments",
		"correct horse battery staple",
	); err != nil {
		t.Fatal(err)
	}
	restoredAttachment, err := restored.GetAttachment(note.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restoredAttachment, webp) {
		t.Fatal("restored attachment differs from its source")
	}
	if _, err := restored.SaveNote(note.ID, note.Title, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := restored.GetAttachment(note.ID, id); err == nil {
		t.Fatal("attachment remains readable through a note that removed its reference")
	}
	if _, err := restored.GetAttachment(other.ID, id); err != nil {
		t.Fatal("removing one reference deleted an attachment used by another note")
	}
	if err := store.DeleteNote(note.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.RestoreTrashItem("note", note.ID); err != nil {
		t.Fatal(err)
	}
	restoredAfterDelete, err := store.GetAttachment(note.ID, id)
	if err != nil || !bytes.Equal(restoredAfterDelete, webp) {
		t.Fatalf("restored attachment = %q, %v", restoredAfterDelete, err)
	}
}

func TestLockedFolderAttachmentCannotBeReadThroughAnotherNote(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Private")
	if err != nil {
		t.Fatal(err)
	}
	privateNote, err := store.CreateNoteInFolder("Private note", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	publicNote, err := store.CreateNote("Public note")
	if err != nil {
		t.Fatal(err)
	}
	webp := append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("private pixels")...)
	id, err := store.SaveAttachment(privateNote.ID, webp)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(privateNote.ID, privateNote.Title, fmt.Sprintf("![private](attachment:%s)", id)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LockFolder(folder.ID, "folder password"); err != nil {
		t.Fatal(err)
	}
	if err := store.LockFolderSession(folder.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetAttachment(publicNote.ID, id); err == nil {
		t.Fatal("locked folder attachment was readable through another note")
	}
	if _, err := store.GetAttachment(privateNote.ID, id); !errors.Is(err, ErrFolderLocked) {
		t.Fatalf("GetAttachment() = %v, want ErrFolderLocked", err)
	}
}

func TestMergeRestoresMissingAttachmentForEqualNoteVersion(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	first := NewStore()
	if _, err := first.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	note, err := first.CreateNote("Shared image")
	if err != nil {
		t.Fatal(err)
	}
	webp := append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("synced pixels")...)
	id, err := first.SaveAttachment(note.ID, webp)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.SaveNote(
		note.ID,
		note.Title,
		fmt.Sprintf("![image](attachment:%s#width=640)", id),
	); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	second := NewStore()
	secondSession, err := second.RestoreRemoteSnapshot(remote, t.TempDir(), "second", secret)
	if err != nil {
		t.Fatal(err)
	}
	path := second.sharedAttachmentPathLocked(id)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(path + ".bak")
	if _, err := second.MergeRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	restored, err := second.GetAttachment(note.ID, id)
	if err != nil {
		t.Fatalf("attachment was not repaired in %s: %v", secondSession.Path, err)
	}
	if !bytes.Equal(restored, webp) {
		t.Fatal("repaired attachment differs from the remote attachment")
	}
}

func TestVaultSettingsSyncAndRestore(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	first := NewStore()
	if _, err := first.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	want, err := first.SaveVaultSettings(VaultSettings{
		DailyNoteFormat: "DD-MM-YYYY", AutosaveIntervalSeconds: 90, AutoSyncMinutes: 20,
		AutoLockMinutes: 30, SectionDefault: "expanded",
	})
	if err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	restored := NewStore()
	if _, err := restored.RestoreRemoteSnapshot(remote, t.TempDir(), "restored", secret); err != nil {
		t.Fatal(err)
	}
	got, err := restored.GetVaultSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("restored settings = %#v, want %#v", got, want)
	}

	newer, err := first.SaveVaultSettings(VaultSettings{
		DailyNoteFormat: "YYYY/MM/DD", AutosaveIntervalSeconds: 120, AutoSyncMinutes: 25,
		AutoLockMinutes: 45, SectionDefault: "collapsed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	merge, err := restored.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	if !merge.UpdatedSettings {
		t.Fatal("settings update was not reported")
	}
	got, err = restored.GetVaultSettings()
	if err != nil || got != newer {
		t.Fatalf("merged settings = %#v, %v; want %#v", got, err, newer)
	}
}

func TestVaultSettingsMergePrefersNewerLocalRevision(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	remoteStore := NewStore()
	if _, err := remoteStore.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	remoteSettings, err := remoteStore.SaveVaultSettings(VaultSettings{DailyNoteFormat: "DD-MM-YYYY"})
	if err != nil {
		t.Fatal(err)
	}
	remoteStore.mu.Lock()
	remoteStore.manifest.Settings.ModifiedAt = time.Now().Add(time.Hour).UnixMilli()
	if err := remoteStore.saveManifestLocked(); err != nil {
		remoteStore.mu.Unlock()
		t.Fatal(err)
	}
	remoteStore.mu.Unlock()
	remote := t.TempDir()
	if err := remoteStore.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	localStore := NewStore()
	if _, err := localStore.RestoreRemoteSnapshot(remote, t.TempDir(), "restored", secret); err != nil {
		t.Fatal(err)
	}
	remoteSettings.DailyNoteFormat = "YYYY/MM/DD"
	dark, err := localStore.SaveVaultSettings(remoteSettings)
	if err != nil {
		t.Fatal(err)
	}
	if dark.Revision <= remoteSettings.Revision {
		t.Fatalf("local settings revision = %d, want greater than %d", dark.Revision, remoteSettings.Revision)
	}
	merge, err := localStore.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	if merge.UpdatedSettings {
		t.Fatal("older remote settings replaced newer local settings")
	}
	got, err := localStore.GetVaultSettings()
	if err != nil || got.DailyNoteFormat != "YYYY/MM/DD" {
		t.Fatalf("merged settings = %#v, %v; want local general settings", got, err)
	}
}

func TestVaultSettingsDefaultAutoSyncInterval(t *testing.T) {
	settings := normalizeVaultSettings(VaultSettings{})
	if got := settings.AutoSyncMinutes; got != 15 {
		t.Fatalf("auto-sync interval = %d, want 15", got)
	}
	if got := settings.FileHistoryLimit; got != 10 {
		t.Fatalf("file history limit = %d, want 10", got)
	}
	if got := normalizeVaultSettings(VaultSettings{FileHistoryLimit: 51}).FileHistoryLimit; got != 50 {
		t.Fatalf("file history limit = %d, want 50", got)
	}
}

func TestMergeConflictReturnsBothVersionsWithoutDuplicatingRemote(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	first := NewStore()
	if _, err := first.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	note, err := first.CreateNote("Shared note")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.SaveNote(note.ID, note.Title, "base"); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	second := NewStore()
	if _, err := second.RestoreRemoteSnapshot(remote, t.TempDir(), "second", secret); err != nil {
		t.Fatal(err)
	}
	if _, err := first.SaveNote(note.ID, note.Title, "cloud edit"); err != nil {
		t.Fatal(err)
	}
	if err := first.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if _, err := second.SaveNote(note.ID, note.Title, "local edit"); err != nil {
		t.Fatal(err)
	}

	merged, err := second.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Conflicts) != 1 {
		t.Fatalf("conflicts = %#v, want one", merged.Conflicts)
	}
	conflict := merged.Conflicts[0]
	if conflict.LocalNoteID != note.ID || conflict.RemoteNoteID != note.ID ||
		conflict.LocalContent != "local edit" || conflict.RemoteContent != "cloud edit" {
		t.Fatalf("conflict = %#v", conflict)
	}
	notes, err := second.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 || notes[0].ID != note.ID {
		t.Fatalf("merge created duplicate notes: %#v", notes)
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

func TestNotesKeepCustomOrderInsideFolder(t *testing.T) {
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
	first, _ := store.CreateNoteInFolder("Alpha", folder.ID)
	second, _ := store.CreateNoteInFolder("Beta", folder.ID)
	third, _ := store.CreateNoteInFolder("Gamma", folder.ID)

	if err := store.ReorderNotes(folder.ID, []string{third.ID, first.ID, second.ID}); err != nil {
		t.Fatal(err)
	}
	notes, err := store.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if notes[0].ID != third.ID || notes[1].ID != first.ID || notes[2].ID != second.ID {
		t.Fatalf("unexpected note order: %v", []string{notes[0].ID, notes[1].ID, notes[2].ID})
	}
	loaded, err := store.GetNote(third.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Order != 0 {
		t.Fatalf("got persisted order %d, want 0", loaded.Order)
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

func TestSaveNoteRollsBackWhenManifestWriteFails(t *testing.T) {
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, "manifest-rollback-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Original")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "original content"); err != nil {
		t.Fatal(err)
	}
	store.manifestWriteHook = func() error {
		store.manifestWriteHook = nil
		return errors.New("injected manifest failure")
	}
	if _, err := store.SaveNote(note.ID, "Changed", "changed content"); err == nil {
		t.Fatal("SaveNote succeeded despite manifest failure")
	}
	loaded, err := store.GetNote(note.ID)
	if err != nil || loaded.Title != "Original" || derivedMarkdownContent(loaded.Content) != "original content" {
		t.Fatalf("rolled-back note = %#v, %v", loaded, err)
	}
	store.Lock()
	if _, err := store.Open(root, "manifest-rollback-secret"); err != nil {
		t.Fatal(err)
	}
	loaded, err = store.GetNote(note.ID)
	if err != nil || loaded.Title != "Original" || derivedMarkdownContent(loaded.Content) != "original content" {
		t.Fatalf("reopened note = %#v, %v", loaded, err)
	}
}

func TestSaveVaultSettingsRollsBackWhenManifestWriteFails(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "manifest-rollback-secret"); err != nil {
		t.Fatal(err)
	}
	before, err := store.GetVaultSettings()
	if err != nil {
		t.Fatal(err)
	}
	store.manifestWriteHook = func() error { return errors.New("injected manifest failure") }
	if _, err := store.SaveVaultSettings(VaultSettings{DailyNoteFormat: "DD-MM-YYYY"}); err == nil {
		t.Fatal("SaveVaultSettings succeeded despite manifest failure")
	}
	after, err := store.GetVaultSettings()
	if err != nil || after != before {
		t.Fatalf("settings after failed save = %#v, %v; want %#v", after, err, before)
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

func TestValidateRemoteSnapshotAllowsStaleDerivedSummaryForMatchingObjects(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	store := NewStore()
	if _, err := store.Create(t.TempDir(), "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Linked note")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "content without derived metadata"); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	manifestPath := filepath.Join(remote, syncDirectory, syncManifestFile)
	plaintext, err := store.readEnvelopeFileLocked(manifestPath, "sync-manifest", "sync-manifest")
	if err != nil {
		t.Fatal(err)
	}
	var inventory remoteSyncManifest
	if err := json.Unmarshal(plaintext, &inventory); err != nil {
		t.Fatal(err)
	}
	if len(inventory.Objects) != 1 || inventory.Objects[0].Summary == nil {
		t.Fatalf("remote inventory missing summary: %#v", inventory.Objects)
	}
	inventory.Objects[0].Summary.Tags = []string{"stale"}
	encoded, err := json.Marshal(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.writeEnvelopeLocked(manifestPath, "sync-manifest", "sync-manifest", encoded); err != nil {
		t.Fatal(err)
	}

	matches, err := store.ValidateRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("matching encrypted objects were rejected because summary metadata drifted")
	}
	if merged, err := store.MergeRemoteSnapshot(remote); err != nil {
		t.Fatalf("merge rejected stale derived summary: %v", err)
	} else if !merged.UpToDate {
		t.Fatalf("merge changed a matching snapshot: %#v", merged)
	}

	store.mu.RLock()
	_, err = store.readRemoteSnapshotLocked(remote, true, true)
	store.mu.RUnlock()
	if err == nil || !strings.Contains(err.Error(), "derived metadata is inconsistent") {
		t.Fatalf("strict remote validation error = %v", err)
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

func benchmarkVault(b *testing.B, noteCount int) (*Store, Note) {
	b.Helper()
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	b.Cleanup(func() { defaultKDF = previous })
	return benchmarkVaultFixture(b, noteCount)
}

func benchmarkVaultFixture(b *testing.B, noteCount int) (*Store, Note) {
	b.Helper()
	store := NewStore()
	if _, err := store.Create(b.TempDir(), "benchmark-secret"); err != nil {
		b.Fatal(err)
	}
	var target Note
	for index := 0; index < noteCount; index++ {
		note, err := store.CreateNote(fmt.Sprintf("Note %05d", index))
		if err != nil {
			b.Fatal(err)
		}
		note, err = store.SaveNote(note.ID, note.Title, fmt.Sprintf("searchable content %d", index))
		if err != nil {
			b.Fatal(err)
		}
		target = note
	}
	return store, target
}

func BenchmarkRepresentativeVaultWorkloads(b *testing.B) {
	b.Run("open_1000_notes", func(b *testing.B) {
		store, _ := benchmarkVaultFixture(b, 1000)
		root := store.root
		store.Lock()
		b.ReportAllocs()
		b.ResetTimer()
		for b.Loop() {
			opened := NewStore()
			if _, err := opened.Open(root, "benchmark-secret"); err != nil {
				b.Fatal(err)
			}
			opened.Lock()
		}
	})
	b.Run("save_1_mib_note", func(b *testing.B) {
		store, target := benchmarkVault(b, 1)
		content := strings.Repeat("x", 1<<20)
		for index := range defaultVaultSettings().FileHistoryLimit {
			if _, err := store.SaveNote(target.ID, target.Title, fmt.Sprintf("warmup %d%s", index, content)); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportAllocs()
		b.ResetTimer()
		for index := 0; b.Loop(); index++ {
			if _, err := store.SaveNote(target.ID, target.Title, fmt.Sprintf("%d%s", index, content)); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("search_1000_notes", func(b *testing.B) {
		store, _ := benchmarkVault(b, 1000)
		b.ReportAllocs()
		b.ResetTimer()
		for b.Loop() {
			if _, err := store.Search("searchable"); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkStoreHotPaths(b *testing.B) {
	for _, noteCount := range []int{100, 1000} {
		b.Run(fmt.Sprintf("lookup_%d", noteCount), func(b *testing.B) {
			store, target := benchmarkVault(b, noteCount)
			b.ResetTimer()
			for b.Loop() {
				store.mu.RLock()
				_, _ = store.findNoteLocked(target.ID)
				store.mu.RUnlock()
			}
		})
		b.Run(fmt.Sprintf("search_%d", noteCount), func(b *testing.B) {
			store, _ := benchmarkVault(b, noteCount)
			b.ResetTimer()
			for b.Loop() {
				if _, err := store.FindInNotes("searchable", 5); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
	b.Run("save_1000", func(b *testing.B) {
		store, target := benchmarkVault(b, 1000)
		b.ResetTimer()
		for index := 0; b.Loop(); index++ {
			if _, err := store.SaveNote(target.ID, target.Title, fmt.Sprintf("changed %d", index)); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("shared_attachment_cleanup", func(b *testing.B) {
		store, target := benchmarkVault(b, 200)
		webp := append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("benchmark pixels")...)
		for range 200 {
			if _, err := store.SaveAttachment(target.ID, webp); err != nil {
				b.Fatal(err)
			}
		}
		b.ResetTimer()
		for b.Loop() {
			if _, err := store.SaveNote(target.ID, target.Title, target.Content); err != nil {
				b.Fatal(err)
			}
		}
	})
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

func TestMergePrefersHigherRevisionDespiteClockSkew(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "correct horse battery staple"
	cloud := NewStore()
	if _, err := cloud.Create(t.TempDir(), secret); err != nil {
		t.Fatal(err)
	}
	base, err := cloud.CreateNote("Clock-skewed note")
	if err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := cloud.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	local := NewStore()
	if _, err := local.RestoreRemoteSnapshot(
		remote,
		t.TempDir(),
		"Local",
		secret,
	); err != nil {
		t.Fatal(err)
	}

	updated, err := cloud.SaveNote(base.ID, base.Title, "newer cloud content")
	if err != nil {
		t.Fatal(err)
	}
	cloud.mu.Lock()
	updated.ModifiedAt = base.ModifiedAt - 100
	hash, err := cloud.writeNoteLocked(updated)
	if err == nil {
		index, _ := cloud.findNoteLocked(updated.ID)
		cloud.manifest.Notes[index] = summaryFromNote(updated)
		cloud.manifest.Notes[index].CiphertextHash = hash
		err = cloud.saveManifestLocked()
	}
	cloud.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}

	merged, err := local.MergeRemoteSnapshot(remote)
	if err != nil {
		t.Fatal(err)
	}
	received, err := local.GetNote(base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if merged.UpdatedNotes != 1 || received.Content != "newer cloud content" {
		t.Fatalf("merge=%#v content=%q", merged, received.Content)
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
	config.Key.KDF.Time = 2
	if err := validateConfig(config); err == nil {
		t.Fatal("unsupported KDF profile unexpectedly accepted")
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
		if m.NoteID != alpha.ID || m.FolderID != alpha.FolderID || m.Offset < 0 {
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

func TestFindMatchIncludesUTF16Range(t *testing.T) {
	content := "préfix 😀 needle"
	match := withUTF16Range(FindMatch{Offset: 13, MatchLength: 6}, content)
	if match.UTF16Offset != 10 || match.UTF16MatchLength != 6 {
		t.Fatalf("UTF-16 range = %d:%d; want 10:6", match.UTF16Offset, match.UTF16MatchLength)
	}
}

func TestListUnlinkedMentionsExcludesWikilinks(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "mention-test-secret"); err != nil {
		t.Fatal(err)
	}
	target, err := store.CreateNote("Project Atlas")
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.CreateNote("Meeting")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(source.ID, source.Title, "Project Atlas is discussed. [[Project Atlas]] is linked."); err != nil {
		t.Fatal(err)
	}
	matches, err := store.ListUnlinkedMentions(target.ID)
	if err != nil || len(matches) != 1 || matches[0].NoteID != source.ID || matches[0].Offset != 0 {
		t.Fatalf("unlinked mentions = %#v, %v", matches, err)
	}
}

func TestFindInNotesUsesSessionSearchIndex(t *testing.T) {
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })

	const secret = "secret-secret-secret"
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, secret); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Indexed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "Searchable session content"); err != nil {
		t.Fatal(err)
	}
	store.Lock()

	reopened := NewStore()
	if _, err := reopened.Open(root, secret); err != nil {
		t.Fatal(err)
	}
	path := reopened.notePathLocked(note.ID)
	if err := os.WriteFile(path, []byte("damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".bak", []byte("damaged"), 0o600); err != nil {
		t.Fatal(err)
	}

	matches, err := reopened.FindInNotes("session", 20)
	if err != nil || len(matches) != 1 || matches[0].NoteID != note.ID {
		t.Fatalf("indexed search = %#v, %v", matches, err)
	}
	reopened.Lock()
	if reopened.searchIndex != nil {
		t.Fatal("search index remains after lock")
	}
}

func TestNoteObjectStoresOnlyContentAndManifestMetadata(t *testing.T) {
	store := NewStore()
	session, err := store.Create(t.TempDir(), "secret-secret-secret")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Metadata")
	if err != nil {
		t.Fatal(err)
	}
	content := "# Body\n\n[[Target|note:0123456789abcdef0123456789abcdef]] #Project\n\nattachment:abcdefabcdefabcdefabcdefabcdefab"
	if _, err := store.SaveNote(note.ID, "Renamed", content); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(session.Path, "objects", note.ID[:2], note.ID+".enc")
	plaintext, err := store.readEnvelopeFileLocked(path, "note-content", note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plaintext), `"format": "cipherleaf.object-document"`) {
		t.Fatalf("note object plaintext is not canonical json: %q", plaintext)
	}
	if derivedMarkdownContent(string(plaintext)) != content {
		t.Fatalf("derived markdown = %q, want %q", derivedMarkdownContent(string(plaintext)), content)
	}
	store.searchIndex[note.ID] = "[[Wrong]]"
	summaries, err := store.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 {
		t.Fatalf("summaries = %d, want 1", len(summaries))
	}
	summary := summaries[0]
	if summary.Title != "Renamed" ||
		!slices.Equal(summary.Tags, []string{"project"}) ||
		!slices.Equal(summary.AttachmentIDs, []string{"abcdefabcdefabcdefabcdefabcdefab"}) ||
		!slices.Equal(summary.OutgoingLinks, []string{"target|note:0123456789abcdef0123456789abcdef"}) {
		t.Fatalf("summary metadata not populated: %#v", summary)
	}
}

func TestListBacklinksUsesManifestOutgoingLinks(t *testing.T) {
	store := NewStore()
	session, err := store.Create(t.TempDir(), "secret-secret-secret")
	if err != nil {
		t.Fatal(err)
	}
	target, err := store.CreateNote("Target")
	if err != nil {
		t.Fatal(err)
	}
	source, err := store.CreateNote("Source")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(source.ID, source.Title, "[[Target|note:"+target.ID+"]]"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(session.Path, "objects", source.ID[:2], source.ID+".enc")
	if err := os.WriteFile(path, []byte("not an envelope"), 0o600); err != nil {
		t.Fatal(err)
	}
	matches, err := store.ListBacklinks(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].NoteID != source.ID {
		t.Fatalf("backlinks = %#v, want source match", matches)
	}
}

func TestSearchUsesMemoryIndexWithoutReadingNoteObjects(t *testing.T) {
	store := NewStore()
	session, err := store.Create(t.TempDir(), "secret-secret-secret")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Indexed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "unique indexed phrase"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(session.Path, "objects", note.ID[:2], note.ID+".enc")
	if err := os.WriteFile(path, []byte("not an envelope"), 0o600); err != nil {
		t.Fatal(err)
	}
	matches, err := store.Search("unique indexed phrase")
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].ID != note.ID {
		t.Fatalf("search matches = %#v, want indexed note", matches)
	}
}

func TestSavedNoteSummaryContainsDerivedMetadata(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Metadata")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(
		note.ID,
		note.Title,
		"---\nstatus: active\n---\n#project\n[report](attachment:abcdefabcdefabcdefabcdefabcdefab)\n[[Target|note:0123456789abcdef0123456789abcdef]]",
	); err != nil {
		t.Fatal(err)
	}
	summary, err := store.GetNoteSummary(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(summary.Tags, []string{"project"}) ||
		!slices.Equal(summary.AttachmentIDs, []string{"abcdefabcdefabcdefabcdefabcdefab"}) ||
		!slices.Equal(summary.OutgoingLinks, []string{"target|note:0123456789abcdef0123456789abcdef"}) ||
		summary.Properties["status"] != "active" {
		t.Fatalf("saved summary metadata = %#v", summary)
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

func TestReplaceAcrossNotesPreservesCanonicalDocumentFields(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Replace schema")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "> visible text"); err != nil {
		t.Fatal(err)
	}

	if _, err := store.ReplaceAcrossNotes("text", "words", []string{note.ID}); err != nil {
		t.Fatal(err)
	}
	updated, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Content != "* visible words" {
		t.Fatalf("visible content = %q, want replaced Markdown", updated.Content)
	}

	raw, err := store.readNoteLocked(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !isCanonicalObjectDocument(raw.Content) {
		t.Fatalf("replace corrupted canonical content: %q", raw.Content)
	}
}

func TestSearchAndReplacePreserveUnicodeByteRanges(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Kelvin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "Value K"); err != nil {
		t.Fatal(err)
	}
	matches, err := store.FindInNotes("k", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range matches {
		source := "Value K"
		if match.Field == "title" {
			source = "Kelvin"
		}
		if source[match.Offset:match.Offset+match.MatchLength] != "K" {
			t.Fatalf("match range = %d:%d in %q", match.Offset, match.MatchLength, source)
		}
	}
	if len(matches) != 2 {
		t.Fatalf("matches = %#v, want title and content matches", matches)
	}
	if _, err := store.ReplaceAcrossNotes("k", "K", nil); err != nil {
		t.Fatal(err)
	}
	updated, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Title != "Kelvin" || updated.Content != "Value K" {
		t.Fatalf("updated note = %#v", updated)
	}
}

func TestReplaceAcrossNotesRejectsAdvancedSearchQueries(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "secret-secret-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplaceAcrossNotes("tag:work", "done", nil); err == nil {
		t.Fatal("advanced replacement query was accepted")
	}
}

func TestFindAndReplaceOptionsControlCaseAndWholeWords(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "search-options-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Options")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "Cat concatenate cat café caféine"); err != nil {
		t.Fatal(err)
	}
	matches, err := store.FindInNotesWithOptions("cat", 20, SearchOptions{CaseSensitive: true, WholeWord: true})
	if err != nil || len(matches) != 1 || matches[0].Snippet != "Cat concatenate cat café caféine" {
		t.Fatalf("case-sensitive whole-word matches = %#v, %v", matches, err)
	}
	if _, err := store.ReplaceAcrossNotesWithOptions("Cat", "Dog", nil, SearchOptions{CaseSensitive: true, WholeWord: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplaceAcrossNotesWithOptions("café", "tea", nil, SearchOptions{WholeWord: true}); err != nil {
		t.Fatal(err)
	}
	updated, err := store.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Content != "Dog concatenate cat tea caféine" {
		t.Fatalf("updated content = %q", updated.Content)
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
	content := strings.Repeat(strings.TrimSpace(strings.Repeat("repeated markdown content ", 22))+"\n", 2_000)
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
	if _, err := store.readEnvelopeFileLocked(path, "note-content", note.ID); err == nil {
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

func TestDerivedMarkdownContentPreservesCodeObjects(t *testing.T) {
	parentID := "parent"
	closed := true
	document := canonicalObjectDocument{
		Format:  "cipherleaf.object-document",
		Version: 1,
		Objects: []canonicalObjectNode{
			{
				ID: "parent", Tag: "section", Tags: []string{"section", "text"}, Text: "arsars",
				ChildrenIDs: []string{"code"}, SourcePrefix: "> ",
			},
			{
				ID: "code", Tag: "code", Tags: []string{"code"}, Text: "def main():\n    pass",
				ParentID: &parentID, ChildrenIDs: []string{}, SourcePrefix: "  ```python",
				Language: "python", Closed: &closed, Indent: 2, ContentIndent: 2,
			},
		},
	}
	content, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	want := "> arsars\n  ```python\ndef main():\n    pass\n  ```"
	if got := derivedMarkdownContent(string(content)); got != want {
		t.Fatalf("derived markdown = %q, want %q", got, want)
	}
}

func TestObjectDocumentConformance(t *testing.T) {
	type expectedObject struct {
		Tag, Text, SourcePrefix, Language string
		AttachmentID, AttachmentKind      string
		Tags                              []string
		Indent, ContentIndent             int
		Checked, Closed                   *bool
	}
	type fixture struct {
		Name, Markdown, CanonicalMarkdown string
		Objects                           []expectedObject
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "object_document_conformance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []fixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, item := range fixtures {
		t.Run(item.Name, func(t *testing.T) {
			document := canonicalObjectDocumentFromMarkdown(item.Markdown)
			if len(document.Objects) != len(item.Objects) {
				t.Fatalf("object count = %d, want %d", len(document.Objects), len(item.Objects))
			}
			for index, want := range item.Objects {
				got := document.Objects[index]
				if got.Tag != want.Tag || got.Text != want.Text || got.SourcePrefix != want.SourcePrefix ||
					got.Language != want.Language || got.Indent != want.Indent || got.ContentIndent != want.ContentIndent ||
					got.AttachmentID != want.AttachmentID || got.AttachmentKind != want.AttachmentKind ||
					(want.Tags != nil && !slices.Equal(got.Tags, want.Tags)) ||
					!pointerEqual(got.Checked, want.Checked) || !pointerEqual(got.Closed, want.Closed) {
					t.Fatalf("object %d = %+v, want %+v", index, got, want)
				}
			}
			content, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			want := item.CanonicalMarkdown
			if want == "" {
				want = item.Markdown
			}
			if got := derivedMarkdownContent(string(content)); got != want {
				t.Fatalf("round trip = %q, want %q", got, want)
			}
		})
	}
}

func TestCanonicalObjectDocumentStabilizesEmptyCheckboxes(t *testing.T) {
	tests := []struct {
		name, markdown, want string
	}{
		{name: "bare", markdown: "[] Task", want: "[ ] Task"},
		{name: "bullet", markdown: "- [] Task", want: "- [ ] Task"},
		{name: "empty", markdown: "[]", want: "[ ]"},
		{name: "checked", markdown: "[x] Done", want: "[x] Done"},
		{name: "nested text", markdown: "> Parent\n  [] Child", want: "> Parent\n  [ ] Child"},
		{name: "nested section", markdown: "> Parent\n  > [] Child", want: "> Parent\n  > [ ] Child"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := canonicalObjectDocumentFromMarkdown(test.markdown)
			content, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			if got := derivedMarkdownContent(string(content)); got != test.want {
				t.Fatalf("round trip = %q, want %q", got, test.want)
			}
		})
	}
}

func pointerEqual[T comparable](left, right *T) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func TestExtractOutgoingLinksIgnoresInlineCode(t *testing.T) {
	got := extractOutgoingLinks("Use `[[double brackets]]`, then link [[2026-07-14]].")
	want := []string{"2026-07-14"}
	if !slices.Equal(got, want) {
		t.Fatalf("outgoing links = %v, want %v", got, want)
	}
}
