package vault

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"cipherleaf/internal/secure"
)

func TestCoverageValidationAndMetadataHelpers(t *testing.T) {
	id := strings.Repeat("a", 32)
	for _, test := range []struct {
		name string
		id   string
		want bool
	}{
		{"valid", id, true}, {"short", "abc", false}, {"bad hex", strings.Repeat("g", 32), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := validID(test.id); got != test.want {
				t.Fatalf("validID(%q) = %v, want %v", test.id, got, test.want)
			}
		})
	}

	if got, err := normalizeTitle("  "); err != nil || got != "Untitled" {
		t.Fatalf("normalizeTitle(blank) = %q, %v", got, err)
	}
	if _, err := normalizeTitle(strings.Repeat("x", maxTitleRunes+1)); err == nil {
		t.Fatal("expected long title to fail")
	}
	if got, err := normalizeFolderName(" Folder "); err != nil || got != "Folder" {
		t.Fatalf("normalizeFolderName() = %q, %v", got, err)
	}
	for _, name := range []string{"", "a/b", strings.Repeat("x", maxFolderRunes+1)} {
		if _, err := normalizeFolderName(name); err == nil {
			t.Fatalf("normalizeFolderName(%q) unexpectedly succeeded", name)
		}
	}
	if got, err := normalizeVaultName(" Notes "); err != nil || got != "Notes" {
		t.Fatalf("normalizeVaultName() = %q, %v", got, err)
	}
	for _, name := range []string{"", ".", "..", "a/b", strings.Repeat("x", maxFolderRunes+1)} {
		if _, err := normalizeVaultName(name); err == nil {
			t.Fatalf("normalizeVaultName(%q) unexpectedly succeeded", name)
		}
	}
	for _, mode := range []string{"title", "updated", "created", "unknown"} {
		want := mode
		if mode == "unknown" {
			want = "manual"
		}
		if got := normalizeSortMode(mode); got != want {
			t.Fatalf("normalizeSortMode(%q) = %q, want %q", mode, got, want)
		}
	}

	config := vaultConfig{FormatVersion: FormatVersion, VaultID: id, Algorithm: Algorithm,
		Key: keyConfiguration{KDF: kdfConfiguration{Name: "Argon2id", Time: 3, MemoryKiB: 64 * 1024, Parallelism: 2}}}
	if err := validateConfig(config); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*vaultConfig){
		func(c *vaultConfig) { c.FormatVersion++ },
		func(c *vaultConfig) { c.VaultID = "bad" },
		func(c *vaultConfig) { c.Algorithm = "bad" },
		func(c *vaultConfig) { c.Key.KDF.Name = "bad" },
		func(c *vaultConfig) { c.Key.KDF.Time = 2 },
	} {
		invalid := config
		mutate(&invalid)
		if err := validateConfig(invalid); err == nil {
			t.Fatal("invalid vault config unexpectedly accepted")
		}
	}

	root := Folder{ID: id, Name: "Root"}
	child := Folder{ID: strings.Repeat("b", 32), Name: "Child", ParentID: id}
	if err := validateFolderHierarchy([]Folder{root, child}); err != nil {
		t.Fatal(err)
	}
	for _, folders := range [][]Folder{
		{{ID: id}, {ID: id}},
		{{ID: id, Name: "Same"}, {ID: strings.Repeat("b", 32), Name: "same"}},
		{{ID: id, ParentID: id}},
		{{ID: id, ParentID: strings.Repeat("c", 32)}},
		{{ID: id, ParentID: strings.Repeat("b", 32)}, {ID: strings.Repeat("b", 32), ParentID: id}},
	} {
		if err := validateFolderHierarchy(folders); err == nil {
			t.Fatalf("invalid folder hierarchy %#v unexpectedly accepted", folders)
		}
	}
	if !folderHasChild([]Folder{child}, id) || folderHasChild([]Folder{child}, child.ID) {
		t.Fatal("folderHasChild returned an unexpected result")
	}
	if !folderIDExists([]Folder{child}, child.ID) || folderIDExists([]Folder{child}, id) {
		t.Fatal("folderIDExists returned an unexpected result")
	}
	if !noteReferencesFolder([]NoteSummary{{FolderID: id}}, id) || noteReferencesFolder(nil, id) {
		t.Fatal("noteReferencesFolder returned an unexpected result")
	}

	summaries := []NoteSummary{{Title: "z", Order: 1}, {Title: "B", Order: 0}, {Title: "a", Order: 0}}
	sortSummaries(summaries)
	if got := []string{summaries[0].Title, summaries[1].Title, summaries[2].Title}; !reflect.DeepEqual(got, []string{"a", "B", "z"}) {
		t.Fatalf("sorted summaries = %v", got)
	}
	folders := []Folder{{Name: "z", Order: 1}, {Name: "B", Order: 0}, {Name: "a", Order: 0}}
	sortFolders(folders)
	if got := []string{folders[0].Name, folders[1].Name, folders[2].Name}; !reflect.DeepEqual(got, []string{"a", "B", "z"}) {
		t.Fatalf("sorted folders = %v", got)
	}

	tombstones := []Tombstone{{ID: id, Revision: 1, ModifiedAt: 1}}
	tombstones = upsertTombstone(tombstones, Tombstone{ID: id, Revision: 2, ModifiedAt: 1})
	tombstones = upsertTombstone(tombstones, Tombstone{ID: id, Revision: 1, ModifiedAt: 0})
	tombstones = upsertTombstone(tombstones, Tombstone{ID: strings.Repeat("b", 32), Revision: 1, ModifiedAt: 1})
	if len(tombstones) != 2 || tombstones[0].Revision != 2 {
		t.Fatalf("upserted tombstones = %#v", tombstones)
	}
	if value, ok := findTombstone(tombstones, id); !ok || value.Revision != 2 {
		t.Fatalf("findTombstone = %#v, %v", value, ok)
	}
	if _, ok := findTombstone(tombstones, strings.Repeat("c", 32)); ok {
		t.Fatal("missing tombstone was found")
	}
	tombstones = removeTombstone(tombstones, id)
	if len(tombstones) != 1 || len(removeTombstone(tombstones, id)) != 1 {
		t.Fatalf("removeTombstone = %#v", tombstones)
	}
	if !versionIsNewer(2, 1, 1, 100) || versionIsNewer(1, 1, 2, 0) ||
		!versionIsNewer(0, 2, 0, 1) || versionIsNewer(0, 1, 0, 2) {
		t.Fatal("versionIsNewer returned an unexpected result")
	}
	remote := map[string]remoteSyncObject{
		"deleted": {ID: id, Deleted: true, Revision: 2},
		"live":    {ID: strings.Repeat("b", 32)},
	}
	if got := tombstonesFromRemoteObjects(remote); len(got) != 1 || got[0].ID != id {
		t.Fatalf("remote tombstones = %#v", got)
	}
}

func TestCoverageContentReferenceHelpers(t *testing.T) {
	ids := strings.Repeat("a", 32)
	otherID := strings.Repeat("b", 32)
	if got := extractTags("#Go #go ( #Two) #bad! #go"); !reflect.DeepEqual(got, []string{"bad", "go", "two"}) {
		t.Fatalf("tags = %v", got)
	}
	if got := extractAttachmentIDs("attachment:" + otherID + " attachment:" + ids + " attachment:" + ids); !reflect.DeepEqual(got, []string{ids, otherID}) {
		t.Fatalf("attachments = %v", got)
	}
	if got := extractOutgoingLinks("[[ Alpha ]] `[[ignored]]` [[alpha]] [[Beta]]"); !reflect.DeepEqual(got, []string{"alpha", "beta"}) {
		t.Fatalf("outgoing links = %v", got)
	}
	if label, gotID, ok := parseNoteReference("Alpha | note:" + ids); !ok || label != "Alpha" || gotID != ids {
		t.Fatalf("explicit note reference = %q, %q, %v", label, gotID, ok)
	}
	if _, _, ok := parseNoteReference("Alpha | note:not-an-id"); ok {
		t.Fatal("invalid note reference accepted")
	}
	if !outgoingLinkMatches("note:"+ids, ids, nil) ||
		!outgoingLinkMatches("alpha", otherID, map[string]struct{}{"alpha": {}}) ||
		outgoingLinkMatches("Beta", otherID, map[string]struct{}{"alpha": {}}) {
		t.Fatal("outgoingLinkMatches returned an unexpected result")
	}
}

func TestCoverageRemoteValidationAndKeyHelpers(t *testing.T) {
	id := strings.Repeat("a", 32)
	now := time.Now().UTC().Format(time.RFC3339Nano)

	validFolder := Folder{ID: id, Name: "Folder", CreatedAt: now, UpdatedAt: now}
	if err := validateRemoteFolderMetadataItem(validFolder, map[string]struct{}{}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []Folder{
		{ID: "bad", Name: "Folder", CreatedAt: now, UpdatedAt: now},
		{ID: id, Name: " Folder", CreatedAt: now, UpdatedAt: now},
		{ID: id, Name: "Folder", CreatedAt: "bad", UpdatedAt: now},
		{ID: id, Name: "Folder", CreatedAt: now, UpdatedAt: "bad"},
	} {
		if err := validateRemoteFolderMetadataItem(invalid, map[string]struct{}{}); err == nil {
			t.Fatalf("invalid remote folder %#v accepted", invalid)
		}
	}
	if err := validateRemoteFolderMetadataItem(validFolder, map[string]struct{}{id: {}}); err == nil {
		t.Fatal("duplicate remote folder accepted")
	}
	for _, invalid := range []Tombstone{{ID: "bad"}, {ID: id, ModifiedAt: -1}} {
		if err := validateRemoteFolderTombstone(invalid, map[string]struct{}{}); err == nil {
			t.Fatalf("invalid remote tombstone %#v accepted", invalid)
		}
	}
	if err := validateRemoteFolderTombstone(Tombstone{ID: id}, map[string]struct{}{id: {}}); err == nil {
		t.Fatal("live remote tombstone accepted")
	}
	seen := map[string]struct{}{}
	if err := validateRemoteFolderTombstone(Tombstone{ID: id}, seen); err != nil {
		t.Fatal(err)
	}
	if err := validateRemoteFolderTombstone(Tombstone{ID: id}, seen); err == nil {
		t.Fatal("duplicate remote tombstone accepted")
	}

	if err := validateRemoteInventoryObject(remoteSyncObject{ID: id, Revision: 1}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []remoteSyncObject{{ID: "bad", Revision: 1}, {ID: id}, {ID: id, Revision: 1, ModifiedAt: -1}} {
		if err := validateRemoteInventoryObject(invalid); err == nil {
			t.Fatalf("invalid remote object %#v accepted", invalid)
		}
	}
	if err := validateRemoteDeletedSnapshotObject(remoteSyncObject{}); err != nil {
		t.Fatal(err)
	}
	if err := validateRemoteDeletedSnapshotObject(remoteSyncObject{CiphertextHash: "hash"}); err == nil {
		t.Fatal("hashed deleted object accepted")
	}

	note := Note{ID: id, Title: "Note", Content: "body #tag", CreatedAt: now, UpdatedAt: now, Revision: 1, ModifiedAt: 7}
	item := remoteSyncObject{ID: id, Revision: 1, ModifiedAt: 7, Summary: &NoteSummary{
		Tags: extractTags(note.Content), AttachmentIDs: extractAttachmentIDs(note.Content), OutgoingLinks: extractOutgoingLinks(note.Content),
	}}
	if err := validateRemoteNote(note, item, nil, true); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []Note{
		{Title: strings.Repeat("x", maxTitleRunes+1), CreatedAt: now, UpdatedAt: now, Revision: 1},
		{Title: "Note", CreatedAt: "bad", UpdatedAt: now, Revision: 1},
		{Title: "Note", CreatedAt: now, UpdatedAt: "bad", Revision: 1},
		{Title: "Note", CreatedAt: now, UpdatedAt: now, Revision: 0},
	} {
		if err := validateRemoteNote(invalid, item, nil, false); err == nil {
			t.Fatalf("invalid remote note %#v accepted", invalid)
		}
	}
	if err := validateRemoteNote(note, remoteSyncObject{ID: id, Revision: 2, ModifiedAt: 7}, nil, false); err == nil {
		t.Fatal("inconsistent remote note revision accepted")
	}
	missingFolderNote := note
	missingFolderNote.FolderID = strings.Repeat("b", 32)
	if err := validateRemoteNote(missingFolderNote, remoteSyncObject{ID: id, Revision: 1, ModifiedAt: 7}, []Folder{validFolder}, false); err == nil {
		t.Fatal("missing remote note folder was not rejected")
	}
	item.Summary.Tags = []string{"wrong"}
	if err := validateRemoteNote(note, item, nil, true); err == nil {
		t.Fatal("inconsistent derived metadata accepted")
	}

	params := secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	masterKey := bytes.Repeat([]byte("k"), secure.KeySize)
	config, err := buildConfig(id, masterKey, "test passphrase", params)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := unwrapMasterKey(config, "test passphrase"); err != nil || !bytes.Equal(got, masterKey) {
		t.Fatalf("unwrapped key = %x, %v", got, err)
	}
	if _, err := unwrapMasterKey(config, "wrong passphrase"); err == nil {
		t.Fatal("wrong passphrase accepted")
	}
	for _, mutate := range []func(*vaultConfig){
		func(c *vaultConfig) { c.Key.KDF.Salt = "bad" },
		func(c *vaultConfig) { c.Key.WrappedKey.Nonce = "bad" },
		func(c *vaultConfig) { c.Key.WrappedKey.Ciphertext = "bad" },
	} {
		invalid := config
		mutate(&invalid)
		if _, err := unwrapMasterKey(invalid, "test passphrase"); err == nil {
			t.Fatal("invalid wrapped key data accepted")
		}
	}
}

func TestCoverageManifestAndLegacyBranches(t *testing.T) {
	id := strings.Repeat("a", 32)
	otherID := strings.Repeat("b", 32)
	valid := Tombstone{ID: id, Revision: 1, ModifiedAt: 1}
	if err := validateManifestTombstoneSet(nil, []Tombstone{{ID: id}}, false, "invalid", "live", "duplicate"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []Tombstone{{ID: "bad"}, {ID: id, Revision: 0}, {ID: id, ModifiedAt: -1}} {
		if err := validateManifestTombstoneSet(nil, []Tombstone{invalid}, true, "invalid", "live", "duplicate"); err == nil {
			t.Fatalf("invalid manifest tombstone %#v accepted", invalid)
		}
	}
	if err := validateManifestTombstoneSet(map[string]struct{}{id: {}}, []Tombstone{valid}, false, "invalid", "live", "duplicate"); err == nil {
		t.Fatal("live manifest tombstone accepted")
	}
	if err := validateManifestTombstoneSet(nil, []Tombstone{valid, valid}, false, "invalid", "live", "duplicate"); err == nil {
		t.Fatal("duplicate manifest tombstone accepted")
	}
	if err := validateManifestTombstones(manifest{
		Notes: []NoteSummary{{ID: id}}, Folders: []Folder{{ID: otherID}},
		DeletedNotes: []Tombstone{{ID: otherID, Revision: 1}}, DeletedFolders: []Tombstone{{ID: id}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := validateManifestFolders(&manifest{Folders: []Folder{{ID: "bad"}}}); err == nil {
		t.Fatal("invalid manifest folder accepted")
	}
	if err := validateManifestFolders(&manifest{Folders: []Folder{{ID: id, Name: "Folder", Locked: true}}}); err == nil {
		t.Fatal("locked manifest folder without verifier accepted")
	}
	if err := validateManifestNotes(manifest{Folders: []Folder{{ID: id}}, Notes: []NoteSummary{{ID: otherID, FolderID: id}}}); err != nil {
		t.Fatal(err)
	}
	if err := validateManifestNotes(manifest{Notes: []NoteSummary{{ID: "bad"}}}); err == nil {
		t.Fatal("invalid manifest note accepted")
	}
	if err := validateManifestNotes(manifest{Notes: []NoteSummary{{ID: id, FolderID: otherID}}}); err == nil {
		t.Fatal("manifest note with missing folder accepted")
	}

	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "legacy note secret"); err != nil {
		t.Fatal(err)
	}
	note := Note{ID: id, Title: "Legacy", Content: "legacy content", Revision: 1, ModifiedAt: 1}
	payload, err := json.Marshal(note)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(store.notePathLocked(id)), 0o700); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	if err := store.writeEnvelopeLocked(store.notePathLocked(id), "note", id, payload); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	legacy, err := store.readLegacyNoteAtLocked(store.root, id)
	store.mu.Unlock()
	if err != nil || legacy.Title != note.Title || legacy.Content != note.Content {
		t.Fatalf("legacy note = %#v, %v", legacy, err)
	}
	if _, err := store.readLegacyNoteAtLocked(store.root, "bad"); err == nil {
		t.Fatal("invalid legacy note ID accepted")
	}
	_ = canonicalCheckedText("task", false)
	if canonicalCheckedText("task", true) != "[x] task" {
		t.Fatal("checked canonical text is incorrect")
	}
	p := canonicalMarkdownParser{
		lines:      []string{"- item", " ", "  continuation"},
		parsedByID: map[string]parsedCanonicalLine{"item-id": {contentIndent: 2}},
		stack:      []*canonicalObjectNode{{ID: "item-id", Text: "item"}},
	}
	if !p.consumeBlankLine(1, " ") || p.stack[0].Text != "item\n" {
		t.Fatalf("blank continuation = %q", p.stack[0].Text)
	}
	if p.consumeBlankLine(0, "") || p.consumeBlankLine(0, "not blank") {
		t.Fatal("non-blank line consumed as blank")
	}
}

func TestCoverageFilesystemAndCompressionHelpers(t *testing.T) {
	root := t.TempDir()
	if _, err := prepareRoot(""); err == nil {
		t.Fatal("blank root unexpectedly accepted")
	}
	if _, err := prepareRoot(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing root unexpectedly accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareRoot(file); err == nil {
		t.Fatal("file root unexpectedly accepted")
	}
	if got, err := prepareRoot(root); err != nil || got != root {
		t.Fatalf("prepareRoot() = %q, %v", got, err)
	}

	if err := ensureNewVaultPathAvailable(filepath.Join(root, "new")); err != nil {
		t.Fatal(err)
	}
	if err := ensureNewVaultPathAvailable(file); !errors.Is(err, ErrVaultFolderExists) {
		t.Fatalf("file destination error = %v", err)
	}
	existing := filepath.Join(root, "existing")
	if err := os.Mkdir(existing, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ensureNewVaultPathAvailable(existing); !errors.Is(err, ErrVaultFolderExists) {
		t.Fatalf("folder destination error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(existing, configFilename), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureNewVaultPathAvailable(existing); !errors.Is(err, ErrVaultAlreadyExists) {
		t.Fatalf("vault destination error = %v", err)
	}

	jsonPath := filepath.Join(root, "value.json")
	if err := writeJSONAtomic(jsonPath, map[string]string{"value": "one"}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(jsonPath, map[string]string{"value": "two"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jsonPath, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err := readJSON(jsonPath, 1024, &decoded); err != nil || decoded["value"] != "two" {
		t.Fatalf("backup JSON = %#v, %v", decoded, err)
	}
	if err := readJSONFile(jsonPath+".bak", 1, &decoded); err == nil {
		t.Fatal("oversized JSON unexpectedly accepted")
	}
	if err := os.WriteFile(jsonPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jsonPath+".bak", []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := readJSON(jsonPath, 1024, &decoded); err == nil {
		t.Fatal("invalid primary and backup JSON unexpectedly accepted")
	}

	cleanupRoot := filepath.Join(root, "cleanup")
	if err := os.MkdirAll(filepath.Join(cleanupRoot, "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{manifestFilename, manifestFilename + ".bak", configFilename, configFilename + ".bak"} {
		if err := os.WriteFile(filepath.Join(cleanupRoot, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cleanupNewVaultFolder(cleanupRoot)
	if _, err := os.Stat(cleanupRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cleanup folder remains: %v", err)
	}

	source := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	if err := os.WriteFile(source, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFileAtomic(source, target); err != nil {
		t.Fatal(err)
	}
	if err := copyFileIfChangedFast(source, target); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFileIfChangedFast(source, target); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "two" {
		t.Fatalf("copied file = %q, %v", got, err)
	}

	objects := filepath.Join(root, "objects")
	staleDir := filepath.Join(objects, "aa")
	if err := os.MkdirAll(staleDir, 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(staleDir, "keep")
	stale := filepath.Join(staleDir, "stale")
	if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeUnexpectedSnapshotObjects(objects, map[string]struct{}{keep: {}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale object still exists: %v", err)
	}
	if err := removeUnexpectedSyncFiles(root); err != nil {
		t.Fatal(err)
	}

	outside := t.TempDir()
	inside := filepath.Join(root, "child")
	if err := os.Mkdir(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := rejectLiveVaultDestination(root, inside); err == nil {
		t.Fatal("live vault destination accepted")
	}
	if err := rejectLiveVaultDestination(root, outside); err != nil {
		t.Fatal(err)
	}

	small := []byte("small")
	if got, compression, err := compressNotePayload(small); err != nil || compression != "" || !bytes.Equal(got, small) {
		t.Fatalf("small compression = %q, %q, %v", got, compression, err)
	}
	large := bytes.Repeat([]byte("repeat"), 2048)
	compressed, compression, err := compressNotePayload(large)
	if err != nil || compression != "gzip" {
		t.Fatalf("large compression = %q, %v", compression, err)
	}
	if got, err := decompressNotePayload(compressed); err != nil || !bytes.Equal(got, large) {
		t.Fatalf("decompressed payload = %d bytes, %v", len(got), err)
	}
	if _, err := decompressNotePayload([]byte("damaged")); err == nil {
		t.Fatal("damaged compressed payload accepted")
	}
	incompressible := make([]byte, 4096)
	if _, err := rand.Read(incompressible); err != nil {
		t.Fatal(err)
	}
	if got, compression, err := compressNotePayload(incompressible); err != nil || compression != "" || !bytes.Equal(got, incompressible) {
		t.Fatalf("incompressible compression = %q, %q, %v", got, compression, err)
	}

	var oversized bytes.Buffer
	writer := gzip.NewWriter(&oversized)
	if _, err := writer.Write(bytes.Repeat([]byte("x"), maxNoteBytes+1024*1024+1)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := decompressNotePayload(oversized.Bytes()); err == nil {
		t.Fatal("oversized compressed payload accepted")
	}
}

func TestCoverageFolderAndNoteOperations(t *testing.T) {
	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "coverage operation secret"); err != nil {
		t.Fatal(err)
	}
	root, err := store.CreateFolder("Root")
	if err != nil {
		t.Fatal(err)
	}
	child, err := store.CreateFolder("Child", root.ID)
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := store.CreateFolder("Sibling")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateFolder("Root"); err == nil {
		t.Fatal("duplicate folder unexpectedly accepted")
	}
	if err := store.ReorderFolders(nil); err == nil {
		t.Fatal("incomplete folder order accepted")
	}
	if err := store.ReorderFolders([]string{"bad", root.ID, child.ID}); err == nil {
		t.Fatal("unknown folder order entry accepted")
	}
	if err := store.ReorderFolders([]string{root.ID, root.ID, sibling.ID}); err == nil {
		t.Fatal("duplicate folder order entry accepted")
	}
	if err := store.ReorderFolders([]string{sibling.ID, root.ID, child.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveFolder(root.ID, root.ID); err == nil {
		t.Fatal("folder moved into itself")
	}
	if _, err := store.MoveFolder(root.ID, "bad"); err == nil {
		t.Fatal("folder moved under unknown parent")
	}
	if _, err := store.MoveFolder(root.ID, child.ID); err == nil {
		t.Fatal("folder moved under descendant")
	}
	if _, err := store.MoveFolder(child.ID, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveFolder(child.ID, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveFolder(child.ID, sibling.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveFolder(child.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RenameFolder(sibling.ID, "Root"); err == nil {
		t.Fatal("duplicate folder rename accepted")
	}
	if _, err := store.RenameFolder(sibling.ID, "Renamed"); err != nil {
		t.Fatal(err)
	}
	if folder, err := store.SetFolderHidden(root.ID, true); err != nil || !folder.Hidden {
		t.Fatalf("hidden folder = %#v, %v", folder, err)
	}
	if folder, err := store.SetFolderSortMode(root.ID, "updated"); err != nil || folder.SortMode != "updated" {
		t.Fatalf("sort mode = %#v, %v", folder, err)
	}
	if _, err := store.LockFolder(child.ID, "child-pass"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UnlockFolder(child.ID, "wrong-pass"); err == nil {
		t.Fatal("wrong folder password accepted")
	}
	if _, err := store.UnlockFolder(child.ID, "child-pass"); err != nil {
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
	nested, err := store.CreateNoteInFolder("Nested", child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateNoteInFolder("Missing", "bad"); err == nil {
		t.Fatal("note created in unknown folder")
	}
	if _, err := store.SaveNote(source.ID, source.Title, "[[Target]] and [[Target|note:"+target.ID+"]]"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveNote(source.ID, child.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveNote(source.ID, child.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.ReorderNotes(child.ID, nil); err == nil {
		t.Fatal("incomplete note order accepted")
	}
	if err := store.ReorderNotes(child.ID, []string{"bad", nested.ID}); err == nil {
		t.Fatal("unknown note order entry accepted")
	}
	if err := store.ReorderNotes(child.ID, []string{target.ID, nested.ID}); err == nil {
		t.Fatal("note from another folder accepted in order")
	}
	if err := store.ReorderNotes(child.ID, []string{source.ID, source.ID}); err == nil {
		t.Fatal("duplicate note order entry accepted")
	}
	if err := store.ReorderNotes(child.ID, []string{nested.ID, source.ID}); err != nil {
		t.Fatal(err)
	}
	if notes, err := store.Search(""); err != nil || len(notes) != 3 {
		t.Fatalf("empty search = %#v, %v", notes, err)
	}
	if notes, err := store.Search("source"); err != nil || len(notes) != 1 || notes[0].ID != source.ID {
		t.Fatalf("title search = %#v, %v", notes, err)
	}
	if notes, err := store.Search("note:"); err != nil || len(notes) != 1 || notes[0].ID != source.ID {
		t.Fatalf("content search = %#v, %v", notes, err)
	}
	if summary, err := store.ResolveNoteReference("note:" + target.ID); err != nil || summary.ID != target.ID {
		t.Fatalf("explicit reference = %#v, %v", summary, err)
	}
	if summary, err := store.ResolveNoteReference("Target"); err != nil || summary.ID != target.ID {
		t.Fatalf("title reference = %#v, %v", summary, err)
	}
	if _, err := store.ResolveNoteReference("note:" + strings.Repeat("c", 32)); err == nil {
		t.Fatal("missing explicit reference accepted")
	}
	if backlinks, err := store.ListBacklinks(target.ID); err != nil || len(backlinks) == 0 {
		t.Fatalf("backlinks = %#v, %v", backlinks, err)
	}
	store.mu.Lock()
	if index, found := store.findNoteLocked(source.ID); found {
		store.manifest.Notes[index].OutgoingLinks = nil
	}
	store.mu.Unlock()
	if backlinks, err := store.ListBacklinks(target.ID); err != nil || len(backlinks) == 0 {
		t.Fatalf("legacy backlinks = %#v, %v", backlinks, err)
	}
	if err := store.PruneStaleAttachments(); err != nil {
		t.Fatal(err)
	}

	orphan := filepath.Join(store.root, "attachments", strings.Repeat("d", 32))
	if err := os.MkdirAll(orphan, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := store.PruneStaleAttachments(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan attachment folder remains: %v", err)
	}
}

func TestCoverageCreateRollback(t *testing.T) {
	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	root := t.TempDir()
	store := NewStore()
	if err := os.Mkdir(filepath.Join(root, manifestFilename), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(root, "create rollback secret"); err == nil {
		t.Fatal("Create succeeded despite manifest failure")
	}
	if _, err := os.Stat(filepath.Join(root, configFilename)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("configuration remains after failed create: %v", err)
	}
}

func TestCoverageAttachmentPruningBranches(t *testing.T) {
	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "attachment pruning secret"); err != nil {
		t.Fatal(err)
	}
	note, err := store.CreateNote("Attachment note")
	if err != nil {
		t.Fatal(err)
	}
	keepID := strings.Repeat("a", 32)
	staleID := strings.Repeat("b", 32)
	noteDir := filepath.Join(store.root, "attachments", note.ID)
	if err := os.MkdirAll(noteDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{keepID + ".enc", keepID + ".enc.bak", staleID + ".enc"} {
		if err := os.WriteFile(filepath.Join(noteDir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.pruneNoteAttachmentsLocked(note.ID, "attachment:"+keepID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(noteDir, staleID+".enc")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale note attachment remains: %v", err)
	}

	sharedDir := filepath.Join(store.root, "attachments", sharedAttachmentFolder)
	if err := os.MkdirAll(sharedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sharedID := strings.Repeat("c", 32)
	if err := os.WriteFile(filepath.Join(sharedDir, sharedID+".enc"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	if err := store.pruneSharedAttachmentsForSaveLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()
	if _, err := os.Stat(filepath.Join(sharedDir, sharedID+".enc")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale shared attachment remains: %v", err)
	}

	store.mu.Lock()
	store.manifest.Notes[0].AttachmentIDs = []string{keepID}
	if err := os.WriteFile(filepath.Join(sharedDir, keepID+".enc"), []byte("x"), 0o600); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	if err := store.pruneSharedAttachmentsForSaveLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.manifest.Notes[0].AttachmentIDs = nil
	ids, err := store.attachmentIDsForSummaryLocked(store.manifest.Notes[0])
	store.mu.Unlock()
	if err != nil || len(ids) != 0 {
		t.Fatalf("derived attachment IDs = %v, %v", ids, err)
	}
}

func TestCoverageTrackingValidators(t *testing.T) {
	a, b, c, d, e := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("c", 32), strings.Repeat("d", 32), strings.Repeat("e", 32)
	client := TimeClient{ID: a, Name: "Client", Revision: 1}
	project := TimeProject{ID: b, Name: "Project", ClientID: a, Revision: 1}
	tag := TimeTag{ID: c, Name: "Tag", Revision: 1}
	if _, err := validateTrackingClients([]TimeClient{client}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]TimeClient{{{ID: "bad", Name: "Client", Revision: 1}}, {{ID: a, Name: "Client"}}, {{ID: a, Name: " Client", Revision: 1}}, {client, client}} {
		if _, err := validateTrackingClients(invalid); err == nil {
			t.Fatalf("invalid clients %#v accepted", invalid)
		}
	}
	if _, err := validateTrackingProjects([]TimeProject{project}, map[string]struct{}{a: {}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := validateTrackingProjects([]TimeProject{{ID: d, Name: "Project", ClientID: e, Revision: 1}}, nil, []Tombstone{{ID: e, Revision: 1}}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]TimeProject{
		{{ID: "bad", Name: "Project", Revision: 1}},
		{{ID: b, Name: "Project", Revision: 1}, {ID: b, Name: "Project", Revision: 1}},
		{{ID: b, Name: "Project", ClientID: e, Revision: 1}},
	} {
		if _, err := validateTrackingProjects(invalid, map[string]struct{}{a: {}}, nil); err == nil {
			t.Fatalf("invalid projects %#v accepted", invalid)
		}
	}
	if _, err := validateTrackingTags([]TimeTag{tag}); err != nil {
		t.Fatal(err)
	}
	if _, err := validateTrackingTags([]TimeTag{{ID: c, Name: "Tag", Revision: 1}, tag}); err == nil {
		t.Fatal("duplicate tags accepted")
	}
	for _, invalid := range []TimeTag{{ID: "bad", Name: "Tag", Revision: 1}, {ID: c, Name: "Tag"}, {ID: c, Name: " Tag", Revision: 1}} {
		if _, err := validateTrackingTags([]TimeTag{invalid}); err == nil {
			t.Fatalf("invalid tag %#v accepted", invalid)
		}
	}
	bucket := timeTrackingBucketSummary{ID: d, MonthUTC: "2026-09"}
	if err := validateTrackingBuckets([]timeTrackingBucketSummary{bucket}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]timeTrackingBucketSummary{
		{{ID: "bad", MonthUTC: "2026-09"}},
		{{ID: d, MonthUTC: "bad"}},
		{bucket, bucket},
		{{ID: e, MonthUTC: "2026-09"}, {ID: d, MonthUTC: "2026-09"}},
	} {
		if err := validateTrackingBuckets(invalid); err == nil {
			t.Fatalf("invalid buckets %#v accepted", invalid)
		}
	}
	validTombstone := Tombstone{ID: e, Revision: 1}
	if err := validateTrackingTombstones([]Tombstone{validTombstone}, nil); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]Tombstone{{{ID: "bad", Revision: 1}}, {{ID: e}}, {{ID: e, Revision: 1, ModifiedAt: -1}}, {validTombstone, validTombstone}} {
		if err := validateTrackingTombstones(invalid, nil); err == nil {
			t.Fatalf("invalid tracking tombstones %#v accepted", invalid)
		}
	}
	if err := validateTrackingTombstones([]Tombstone{validTombstone}, map[string]struct{}{e: {}}); err == nil {
		t.Fatal("live tracking tombstone accepted")
	}
	if err := validateTrackingCatalogObjects(timeTrackingCatalog{Clients: []TimeClient{client}, Projects: []TimeProject{project}, Tags: []TimeTag{tag}, Buckets: []timeTrackingBucketSummary{bucket}}); err != nil {
		t.Fatal(err)
	}
	if err := validateTrackingCatalogObjects(timeTrackingCatalog{Clients: []TimeClient{{ID: "bad", Name: "Client", Revision: 1}}}); err == nil {
		t.Fatal("invalid tracking catalog accepted")
	}

	if name, err := normalizeTimeEntryName(" Entry "); err != nil || name != "Entry" {
		t.Fatalf("normalized entry name = %q, %v", name, err)
	}
	for _, name := range []string{"", "line\nbreak", strings.Repeat("x", 201)} {
		if _, err := normalizeTimeEntryName(name); err == nil {
			t.Fatalf("invalid entry name %q accepted", name)
		}
	}
	entry := TimeEntry{ID: d, Name: "Entry", StartedAtUTC: "2026-09-01T00:00:00Z", Revision: 1}
	if err := validateStoredTimeEntry(entry, "2026-09"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []TimeEntry{{ID: "bad", Name: "Entry", StartedAtUTC: entry.StartedAtUTC, Revision: 1}, {ID: d, Name: "Entry", StartedAtUTC: "bad", Revision: 1}, {ID: d, Name: "Entry", StartedAtUTC: entry.StartedAtUTC, Revision: 1, EndedAtUTC: "2026-08-01T00:00:00Z"}} {
		if err := validateStoredTimeEntry(invalid, "2026-09"); err == nil {
			t.Fatalf("invalid stored entry %#v accepted", invalid)
		}
	}
	completed := entry
	completed.EndedAtUTC = "2026-09-01T01:00:00Z"
	if err := validateStoredTimeEntry(completed, "2026-09"); err != nil {
		t.Fatal(err)
	}
	if got := compareTimeEntryRangeItems(TimeEntryRangeItem{StartedAtUTC: "2026-09-02", Entry: TimeEntry{ID: b}}, TimeEntryRangeItem{StartedAtUTC: "2026-09-03", Entry: TimeEntry{ID: a}}); got >= 0 {
		t.Fatalf("range item comparison = %d", got)
	}
	if got := compareTimeEntryRangeItems(TimeEntryRangeItem{StartedAtUTC: "2026-09-03", Entry: TimeEntry{ID: b}}, TimeEntryRangeItem{StartedAtUTC: "2026-09-02", Entry: TimeEntry{ID: a}}); got <= 0 {
		t.Fatalf("range item comparison = %d", got)
	}
	if got := compareTimeEntryRangeItems(TimeEntryRangeItem{StartedAtUTC: "same", Entry: TimeEntry{ID: a}}, TimeEntryRangeItem{StartedAtUTC: "same", Entry: TimeEntry{ID: b}}); got >= 0 {
		t.Fatalf("equal-time comparison = %d", got)
	}
	compressed, err := compressTimeTrackingPayload([]byte("tracking payload"))
	if err != nil || len(compressed) == 0 {
		t.Fatalf("compressed tracking payload = %d bytes, %v", len(compressed), err)
	}
	if matches, err := (&Store{}).timeTrackingSnapshotMatchesLocked(nil); err != nil || !matches {
		t.Fatalf("nil tracking snapshot = %v, %v", matches, err)
	}
	if matches, err := (&Store{}).timeTrackingSnapshotMatchesLocked(&authenticatedTrackingSnapshot{}); err != nil || matches {
		t.Fatalf("non-nil tracking snapshot = %v, %v", matches, err)
	}
	merged, entries, conflicts := mergeTimeTrackingCatalogs(
		timeTrackingCatalog{VaultID: a, Revision: 1, ModifiedAt: 2},
		timeTrackingCatalog{VaultID: a, Revision: 3, ModifiedAt: 4},
		map[string]timeTrackingBucket{}, map[string]timeTrackingBucket{},
	)
	if merged.Revision != 4 || merged.ModifiedAt != 4 || len(entries) != 0 || len(conflicts) != 0 {
		t.Fatalf("merged tracking catalogs = %#v, %#v, %#v", merged, entries, conflicts)
	}
}

func TestCoverageTimeEntryMutations(t *testing.T) {
	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "time entry mutation secret"); err != nil {
		t.Fatal(err)
	}
	client, err := store.CreateClient("Mutation client")
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject("Mutation project", client.ID)
	if err != nil {
		t.Fatal(err)
	}
	tag, err := store.CreateTag("Mutation tag")
	if err != nil {
		t.Fatal(err)
	}
	entry, err := store.StartTimeEntry("Running", project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	started, err := time.Parse(time.RFC3339Nano, entry.StartedAtUTC)
	if err != nil {
		t.Fatal(err)
	}
	activeEnd := started.Add(time.Hour).Format(time.RFC3339Nano)
	if _, err := store.UpdateTimeEntry(entry.ID, "not allowed", project.ID, nil, entry.StartedAtUTC, activeEnd); err == nil {
		t.Fatal("active time entry was updated")
	}
	finished, err := store.FinishActiveTimeEntry()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.FinishActiveTimeEntry(); err == nil {
		t.Fatal("finished time entry was finished again")
	}
	updated, err := store.UpdateTimeEntry(entry.ID, "Updated", project.ID, []string{tag.ID}, entry.StartedAtUTC, finished.EndedAtUTC)
	if err != nil || updated.Name != "Updated" {
		t.Fatalf("updated time entry = %#v, %v", updated, err)
	}
	if _, err := store.UpdateTimeEntry("bad", "Updated", project.ID, nil, entry.StartedAtUTC, finished.EndedAtUTC); err == nil {
		t.Fatal("missing time entry updated")
	}
	if err := store.DeleteTimeEntry(entry.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteTimeEntry(entry.ID); err == nil {
		t.Fatal("deleted time entry deleted again")
	}
}

func TestCoverageTrackingSnapshotHashes(t *testing.T) {
	previous := defaultKDF
	defaultKDF = secure.KDFParams{Time: 1, Memory: 8 * 1024, Threads: 2}
	t.Cleanup(func() { defaultKDF = previous })
	store := NewStore()
	if _, err := store.Create(t.TempDir(), "tracking snapshot secret"); err != nil {
		t.Fatal(err)
	}
	bucketID := strings.Repeat("a", 32)
	catalogData := []byte("catalog ciphertext")
	bucketData := []byte("bucket ciphertext")
	if err := os.MkdirAll(filepath.Join(store.root, trackingDirectory, trackingObjectsDirectory, bucketID[:2]), 0o700); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(store.root, trackingDirectory, trackingCatalogFilename)
	if err := os.WriteFile(catalogPath, catalogData, 0o600); err != nil {
		t.Fatal(err)
	}
	bucketPath := filepath.Join(store.root, trackingDirectory, trackingObjectsDirectory, bucketID[:2], bucketID+".enc")
	if err := os.WriteFile(bucketPath, bucketData, 0o600); err != nil {
		t.Fatal(err)
	}
	store.timeTrackingCatalog = &timeTrackingCatalog{Buckets: []timeTrackingBucketSummary{{ID: bucketID}}}
	remote := &authenticatedTrackingSnapshot{Inventory: remoteTrackingInventory{
		Catalog: remoteTrackingObject{CiphertextHash: ciphertextHash(catalogData)},
		Buckets: []remoteTrackingObject{{ID: bucketID, CiphertextHash: ciphertextHash(bucketData)}},
	}}
	if matches, err := store.timeTrackingSnapshotMatchesLocked(remote); err != nil || !matches {
		t.Fatalf("matching tracking snapshot = %v, %v", matches, err)
	}
	remote.Inventory.Catalog.CiphertextHash = "bad"
	if matches, err := store.timeTrackingSnapshotMatchesLocked(remote); err != nil || matches {
		t.Fatalf("mismatched catalog snapshot = %v, %v", matches, err)
	}
	remote.Inventory.Catalog.CiphertextHash = ciphertextHash(catalogData)
	remote.Inventory.Buckets[0].CiphertextHash = "bad"
	if matches, err := store.timeTrackingSnapshotMatchesLocked(remote); err != nil || matches {
		t.Fatalf("mismatched bucket snapshot = %v, %v", matches, err)
	}
	remote.Inventory.Buckets = nil
	if matches, err := store.timeTrackingSnapshotMatchesLocked(remote); err != nil || matches {
		t.Fatalf("missing bucket snapshot = %v, %v", matches, err)
	}
}

func TestCoverageClearLocked(t *testing.T) {
	store := &Store{key: bytes.Repeat([]byte("k"), secure.KeySize), root: "root", vaultID: "vault", manifest: manifest{FormatVersion: 1}, searchIndex: map[string]string{"id": "text"}, authorizedFolders: map[string]struct{}{"folder": {}}, exportBaselines: map[string]manifest{"path": {}}, hasSavedManifestHash: true, timeTrackingCatalog: &timeTrackingCatalog{}}
	store.clearLocked()
	if store.key != nil || store.root != "" || store.vaultID != "" || store.searchIndex != nil || store.timeTrackingCatalog != nil || store.hasSavedManifestHash {
		t.Fatalf("store was not cleared: %#v", store)
	}
}

func TestCoverageTrackingLabelUpdateBranches(t *testing.T) {
	now := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	a, b := strings.Repeat("a", 32), strings.Repeat("b", 32)
	client := TimeClient{ID: a, Name: "Client", Revision: 1}
	if err := updateClient(&client, []TimeClient{client}, "Renamed", trackingLabelRename, now); err != nil || client.Name != "Renamed" {
		t.Fatalf("renamed client = %#v, %v", client, err)
	}
	if err := updateClient(&client, []TimeClient{{ID: b, Name: "Other", Revision: 1}}, "Final", trackingLabelRename, now); err != nil {
		t.Fatal(err)
	}
	if err := updateClient(&client, []TimeClient{{ID: b, Name: client.Name, Revision: 1}}, client.Name, trackingLabelRename, now); err == nil {
		t.Fatal("duplicate client rename accepted")
	}
	if err := updateClient(&client, nil, "\n", trackingLabelRename, now); err == nil {
		t.Fatal("invalid client rename accepted")
	}
	if err := updateClient(&client, nil, "", trackingLabelArchive, now); err != nil {
		t.Fatal(err)
	}
	if err := updateClient(&client, nil, "", trackingLabelArchive, now); err == nil {
		t.Fatal("client archived twice")
	}
	if err := updateClient(&client, nil, "", trackingLabelRestore, now); err != nil {
		t.Fatal(err)
	}
	if err := updateClient(&client, nil, "", trackingLabelRestore, now); err == nil {
		t.Fatal("client restored twice")
	}
	if err := updateClient(&client, nil, "", trackingLabelAction(99), now); err == nil {
		t.Fatal("invalid client action accepted")
	}

	project := TimeProject{ID: a, Name: "Project", ClientID: b, Revision: 1}
	clients := []TimeClient{{ID: b, Name: "Client", Revision: 1}}
	clientID := b
	if err := updateProject(&project, []TimeProject{project}, clients, "Renamed", &clientID, trackingLabelRename, now); err != nil {
		t.Fatal(err)
	}
	if err := updateProject(&project, nil, clients, "", nil, trackingLabelArchive, now); err != nil {
		t.Fatal(err)
	}
	if err := updateProject(&project, nil, clients, "", nil, trackingLabelRestore, now); err != nil {
		t.Fatal(err)
	}
	if err := updateProject(&project, nil, clients, "", nil, trackingLabelAction(99), now); err == nil {
		t.Fatal("invalid project action accepted")
	}

	tag := TimeTag{ID: a, Name: "Tag", Revision: 1}
	if err := updateTag(&tag, []TimeTag{tag}, "Renamed", trackingLabelRename, now); err != nil {
		t.Fatal(err)
	}
	if err := updateTag(&tag, nil, "", trackingLabelArchive, now); err != nil {
		t.Fatal(err)
	}
	if err := updateTag(&tag, nil, "", trackingLabelRestore, now); err != nil {
		t.Fatal(err)
	}
	if err := updateTag(&tag, nil, "", trackingLabelAction(99), now); err == nil {
		t.Fatal("invalid tag action accepted")
	}
	conflict := newClientTrackingConflict(a, &client, &client)
	if conflict.Kind != TimeClientRenameConflict || conflict.ObjectID != a || conflict.ID == "" {
		t.Fatalf("client conflict = %#v", conflict)
	}
}
