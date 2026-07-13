package vault

import "testing"

func TestTypedFrontmatterPropertiesAndAdvancedSearch(t *testing.T) {
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "properties-test-secret"); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder("Work")
	if err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNoteInFolder("Launch Plan", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	content := "---\nstatus: active\npriority: 3\npublished: true\nlabels: [alpha, beta]\n---\nSecret launch details #roadmap"
	if _, err := store.SaveNote(note.ID, note.Title, content); err != nil {
		t.Fatal(err)
	}
	summaries, _ := store.ListNotes()
	properties := summaries[0].Properties
	if properties["status"] != "active" || properties["priority"] != float64(3) || properties["published"] != true {
		t.Fatalf("properties = %#v", properties)
	}
	for _, query := range []string{"property:status=active", "tag:roadmap folder:Work", "title:Launch", "re:Secret.*details", "case:true Secret"} {
		matches, err := store.FindInNotes(query, 20)
		if err != nil || len(matches) != 1 {
			t.Fatalf("query %q = %#v, %v", query, matches, err)
		}
	}
	if matches, err := store.FindInNotes("case:true secret", 20); err != nil || len(matches) != 0 {
		t.Fatalf("case-sensitive query = %#v, %v", matches, err)
	}
}

func TestFrontmatterUnknownLinesRemainInContent(t *testing.T) {
	content := "---\nknown: yes\ncustom nested: { untouched: value }\n---\nBody"
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "frontmatter-roundtrip-secret"); err != nil {
		t.Fatal(err)
	}
	note, _ := store.CreateNote("Frontmatter")
	saved, err := store.SaveNote(note.ID, note.Title, content)
	if err != nil || derivedMarkdownContent(saved.Content) != content {
		t.Fatalf("saved = %#v, %v", saved, err)
	}
}
