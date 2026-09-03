package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarkdownExportAndImportRoundTrip(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "export-secret"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Projects")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Plan: 2026", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "# Roadmap\n\nUnicode: café"); err != nil {
		t.Fatal(err)
	}
	result, err := store.ExportMarkdown(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if result.Notes != 1 || result.Folders != 1 {
		t.Fatalf("export result = %#v", result)
	}
	exported := filepath.Join(result.Path, "Projects", "Plan_ 2026.md")
	data, err := os.ReadFile(exported)
	if err != nil || string(data) != "# Roadmap\n\nUnicode: café" {
		t.Fatalf("exported Markdown = %q, %v", data, err)
	}

	imported := NewStore()
	if _, err := imported.Create(t.TempDir(), "import-secret"); err != nil {
		t.Fatal(err)
	}
	importResult, err := imported.ImportMarkdown(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if importResult.Notes != 1 || importResult.Folders != 1 {
		t.Fatalf("import result = %#v", importResult)
	}
	notes, err := imported.ListNotes()
	if err != nil || len(notes) != 1 {
		t.Fatalf("imported notes = %#v, %v", notes, err)
	}
	loaded, err := imported.GetNote(notes[0].ID)
	if err != nil || loaded.Title != "Plan_ 2026" || loaded.Content != "# Roadmap\n\nUnicode: café" {
		t.Fatalf("imported note = %#v, %v", loaded, err)
	}
}

func TestMarkdownExportIncludesDecryptedAttachments(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "attachment-export-secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Image")
	if err != nil {
		t.Fatal(err)
	}
	webp := append([]byte("RIFF\x04\x00\x00\x00WEBP"), []byte("pixels")...)
	id, err := store.SaveAttachment(note.ID, webp)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveNote(note.ID, note.Title, "![image](attachment:"+id+")"); err != nil {
		t.Fatal(err)
	}
	result, err := store.ExportMarkdown(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	markdown, err := os.ReadFile(filepath.Join(result.Path, "Image.md"))
	if err != nil || !strings.Contains(string(markdown), "attachments/"+id+".webp") {
		t.Fatalf("exported attachment link = %q, %v", markdown, err)
	}
	data, err := os.ReadFile(filepath.Join(result.Path, "attachments", id+".webp"))
	if err != nil || string(data) != string(webp) {
		t.Fatalf("exported attachment = %q, %v", data, err)
	}
	imported := NewStore()
	if _, err := imported.Create(t.TempDir(), "attachment-import-secret"); err != nil {
		t.Fatal(err)
	}
	importResult, err := imported.ImportMarkdown(result.Path)
	if err != nil || importResult.Attachments != 1 {
		t.Fatalf("attachment import = %#v, %v", importResult, err)
	}
	notes, _ := imported.ListNotes()
	loaded, err := imported.GetNote(notes[0].ID)
	if err != nil || !strings.Contains(loaded.Content, "attachment:") {
		t.Fatalf("imported attachment note = %#v, %v", loaded, err)
	}
	attachmentID := attachmentReference.FindStringSubmatch(loaded.Content)[1]
	attachment, err := imported.GetAttachment(loaded.ID, attachmentID)
	if err != nil || string(attachment) != string(webp) {
		t.Fatalf("round-trip attachment = %q, %v", attachment, err)
	}
}

func TestMarkdownImportRejectsSymlinks(t *testing.T) {
	source := t.TempDir()
	if err := os.Symlink(filepath.Join(source, "missing.md"), filepath.Join(source, "linked.md")); err != nil {
		t.Skip(err)
	}
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "symlink-test-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ImportMarkdown(source); err == nil || !strings.Contains(err.Error(), "symbolic links") {
		t.Fatalf("ImportMarkdown() error = %v", err)
	}
}

func TestMarkdownImportFailureLeavesVaultUnchanged(t *testing.T) {
	source := t.TempDir()
	if err := os.MkdirAll(filepath.Join(source, "Projects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "Projects", "Valid.md"), []byte("valid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "Broken.md"), []byte("[missing](attachments/missing.txt)"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "atomic-import-secret"); err != nil {
		t.Fatal(err)
	}
	existing, err := store.CreateNote("Existing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ImportMarkdown(source); err == nil {
		t.Fatal("import with a missing attachment succeeded")
	}
	notes, err := store.ListNotes()
	if err != nil || len(notes) != 1 || notes[0].ID != existing.ID {
		t.Fatalf("notes after failed import = %#v, %v", notes, err)
	}
	folders, err := store.ListFolders()
	if err != nil || len(folders) != 0 {
		t.Fatalf("folders after failed import = %#v, %v", folders, err)
	}
}

func TestPortabilityHelperValidation(t *testing.T) {
	if portableName("  report:/  ", "fallback") != "report__" || portableName("...", "fallback") != "fallback" {
		t.Fatal("portableName normalization failed")
	}
	used := map[string]struct{}{}
	first := uniquePortablePath(t.TempDir(), "Report", ".md", used)
	second := uniquePortablePath(filepath.Dir(first), "Report", ".md", used)
	if filepath.Base(first) != "Report.md" || filepath.Base(second) != "Report (2).md" {
		t.Fatalf("unique paths = %q, %q", first, second)
	}

	noMarkdown := t.TempDir()
	if err := os.WriteFile(filepath.Join(noMarkdown, "notes.txt"), []byte("text"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := collectMarkdownImportFiles(noMarkdown); err == nil {
		t.Fatal("folder without Markdown was accepted")
	}
	source := t.TempDir()
	if err := os.MkdirAll(filepath.Join(source, "attachments"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "note.md"), []byte("note"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "ignored.txt"), []byte("ignored"), 0o600); err != nil {
		t.Fatal(err)
	}
	files, folders, err := collectMarkdownImportFiles(source)
	if err != nil || len(files) != 1 || len(folders) != 0 {
		t.Fatalf("collected Markdown = %#v, %#v, %v", files, folders, err)
	}

	file := markdownImportFile{path: filepath.Join(source, "note.md")}
	if _, _, err := importMarkdownImageAttachment(file, strings.Repeat("a", 32)); err == nil {
		t.Fatal("missing image attachment was accepted")
	}
	imageID := strings.Repeat("a", 32)
	if err := os.WriteFile(filepath.Join(source, "attachments", imageID+".webp"), []byte("bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := importMarkdownImageAttachment(file, imageID); err == nil {
		t.Fatal("invalid image attachment was accepted")
	}
	for _, name := range []string{"../escape.txt", "/absolute.txt", ""} {
		if _, _, err := importMarkdownFileAttachment(file, name); err == nil {
			t.Fatalf("unsafe file attachment %q was accepted", name)
		}
	}
	if err := os.WriteFile(filepath.Join(source, "attachments", "plain.txt"), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	attachment, replacement, err := importMarkdownFileAttachment(file, "plain.txt")
	if err != nil || attachment.objectType != "file-attachment" || !strings.HasPrefix(replacement, attachmentLinkPrefix) {
		t.Fatalf("file attachment = %#v, %q, %v", attachment, replacement, err)
	}
}
