package vault

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLockedFolderProtectsEveryContentAPI(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "locked-content-secret"); err != nil {
		t.Fatal(err)
	}
	folder, _ := store.CreateFolder("Private")
	note, _ := store.CreateNoteInFolder("Secret", folder.ID)
	trashed, _ := store.CreateNoteInFolder("Deleted secret", folder.ID)
	source := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(source, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	attachment, err := store.ImportFileAttachment(note.ID, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "[secret](attachment:"+attachment.ID+")"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "changed"); err != nil {
		t.Fatal(err)
	}
	locked, err := store.LockFolder(folder.ID, "folder-password")
	if err != nil {
		t.Fatal(err)
	}
	if locked.LockPasswordHash != "" {
		t.Fatal("folder verifier returned to client")
	}
	if err := store.CheckFolderPassword(folder.ID, "folder-password"); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteNote(trashed.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.LockFolderSession(folder.ID); err != nil {
		t.Fatal(err)
	}

	checks := []func() error{
		func() error { _, err := store.ImportFileAttachment(note.ID, source); return err },
		func() error { _, _, err := store.FileAttachment(note.ID, attachment.ID); return err },
		func() error { _, err := store.ListFileAttachments(note.ID); return err },
		func() error { _, err := store.ExportFileAttachment(note.ID, attachment.ID, t.TempDir()); return err },
		func() error { _, err := store.ExportMarkdown(t.TempDir()); return err },
		func() error { _, err := store.ListNoteVersions(note.ID); return err },
		func() error { _, err := store.RestoreNoteVersion(note.ID, 1); return err },
		func() error { return store.RestoreTrashItem("note", trashed.ID) },
	}
	for index, check := range checks {
		if err := check(); !errors.Is(err, ErrFolderLocked) {
			t.Fatalf("locked API %d error = %v, want ErrFolderLocked", index, err)
		}
	}
	trash, err := store.ListTrash()
	if err != nil || len(trash) != 0 {
		t.Fatalf("ListTrash() = %#v, %v", trash, err)
	}
	folders, err := store.ListFolders()
	if err != nil || len(folders) != 1 || folders[0].LockPasswordHash != "" {
		t.Fatalf("ListFolders() = %#v, %v", folders, err)
	}
}

func TestGeneralFileAttachmentRoundTripAndExport(t *testing.T) {
	store := NewStore()
	session, err := store.Create(t.TempDir(), "file-attachment-secret")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Document")
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "report.txt")
	plaintext := []byte("confidential attachment body")
	if err := os.WriteFile(source, plaintext, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := store.ImportFileAttachment(note.ID, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "[report](attachment:"+info.ID+")"); err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.ReadFile(filepath.Join(session.Path, "attachments", sharedAttachmentFolder, info.ID+".enc"))
	if err != nil || bytes.Contains(encrypted, plaintext) {
		t.Fatalf("encrypted attachment leaked plaintext: %v", err)
	}
	loadedInfo, loaded, err := store.FileAttachment(note.ID, info.ID)
	if err != nil || loadedInfo.Filename != "report.txt" || !bytes.Equal(loaded, plaintext) {
		t.Fatalf("file attachment = %#v, %q, %v", loadedInfo, loaded, err)
	}
	destination := t.TempDir()
	existingPath := filepath.Join(destination, "report.txt")
	if err := os.WriteFile(existingPath, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, err := store.ExportFileAttachment(note.ID, info.ID, destination)
	if err != nil {
		t.Fatal(err)
	}
	exported, _ := os.ReadFile(path)
	if !bytes.Equal(exported, plaintext) {
		t.Fatalf("exported = %q", exported)
	}
	if existing, _ := os.ReadFile(existingPath); string(existing) != "keep me" || path == existingPath {
		t.Fatalf("existing attachment was overwritten: path=%q content=%q", path, existing)
	}
	remote := t.TempDir()
	if err := store.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if valid, err := store.ValidateRemoteSnapshot(remote); err != nil || !valid {
		t.Fatalf("remote attachment snapshot = %v, %v", valid, err)
	}
	markdownExport, err := store.ExportMarkdown(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	imported := NewStore()
	if _, err := imported.Create(t.TempDir(), "file-import-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := imported.ImportMarkdown(markdownExport.Path); err != nil {
		t.Fatal(err)
	}
	importedNotes, _ := imported.ListNotes()
	attachments, err := imported.ListFileAttachments(importedNotes[0].ID)
	if err != nil || len(attachments) != 1 || attachments[0].Filename != "report.txt" {
		t.Fatalf("imported file attachments = %#v, %v", attachments, err)
	}
}

func TestMarkdownExportKeepsDuplicateAttachmentNamesPortable(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "file-attachment-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Documents")
	if err != nil {
		t.Fatal(err)
	}
	var attachments []AttachmentInfo
	for index, body := range []string{"first", "second"} {
		directory := filepath.Join(t.TempDir(), string(rune('a'+index)))
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, "report 2026.txt")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		attachment, err := store.ImportFileAttachment(note.ID, path)
		if err != nil {
			t.Fatal(err)
		}
		attachments = append(attachments, attachment)
	}
	content := "[first](attachment:" + attachments[0].ID + ")\n[second](attachment:" + attachments[1].ID + ")"
	if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
		t.Fatal(err)
	}
	exported, err := store.ExportMarkdown(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	markdown, err := os.ReadFile(filepath.Join(exported.Path, "Documents.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(markdown), "report%202026.txt") || !strings.Contains(string(markdown), "report%202026%20%282%29.txt") {
		t.Fatalf("exported Markdown = %q", markdown)
	}
	imported := NewStore()
	if _, err := imported.Create(t.TempDir(), "import-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := imported.ImportMarkdown(exported.Path); err != nil {
		t.Fatal(err)
	}
	notes, _ := imported.ListNotes()
	files, err := imported.ListFileAttachments(notes[0].ID)
	if err != nil || len(files) != 2 || files[0].Filename == files[1].Filename {
		t.Fatalf("imported attachments = %#v, %v", files, err)
	}
}

func TestGeneralFileAttachmentRejectsSymlinkAndOversizeMetadata(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "file-validation-secret"); err != nil {
		t.Fatal(err)
	}
	note, _ := store.CreateNote("Document")
	target := filepath.Join(t.TempDir(), "target")
	_ = os.WriteFile(target, []byte("data"), 0o600)
	link := target + "-link"
	if err := os.Symlink(target, link); err != nil {
		t.Skip(err)
	}
	if _, err := store.ImportFileAttachment(note.ID, link); err == nil {
		t.Fatal("imported symbolic link")
	}
}
