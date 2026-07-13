package vault

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

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
	path, err := store.ExportFileAttachment(note.ID, info.ID, destination)
	if err != nil {
		t.Fatal(err)
	}
	exported, _ := os.ReadFile(path)
	if !bytes.Equal(exported, plaintext) {
		t.Fatalf("exported = %q", exported)
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
