package vault

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

const scratchpadTestSecret = "correct horse battery staple"

func fastScratchpadKDF(t *testing.T) {
	t.Helper()
	previous := defaultKDF
	defaultKDF.Memory = 8 * 1024
	defaultKDF.Time = 1
	t.Cleanup(func() { defaultKDF = previous })
}

func TestScratchpadPersistsAndChangesSnapshotRevision(t *testing.T) {
	fastScratchpadKDF(t)
	root := t.TempDir()
	store := NewStore()
	if _, err := store.Create(root, scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	before, err := store.SnapshotRevision()
	if err != nil {
		t.Fatal(err)
	}
	want, err := store.SaveScratchpad("draft", 4)
	if err != nil {
		t.Fatal(err)
	}
	store.Lock()
	reopened := NewStore()
	if _, err := reopened.Open(root, scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	got, err := reopened.GetScratchpad()
	if err != nil || got != want {
		t.Fatalf("reopened scratchpad = %#v, %v; want %#v", got, err, want)
	}
	after, err := reopened.SnapshotRevision()
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("scratchpad save did not change snapshot revision")
	}
}

func TestScratchpadMergeManifestFailureRollsBackRemoteWinner(t *testing.T) {
	fastScratchpadKDF(t)
	baseStore := NewStore()
	if _, err := baseStore.Create(t.TempDir(), scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	if err := baseStore.ExportRemoteSnapshot(base); err != nil {
		t.Fatal(err)
	}
	remoteStore, local := NewStore(), NewStore()
	if _, err := remoteStore.RestoreRemoteSnapshot(base, t.TempDir(), "remote", scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	if _, err := local.RestoreRemoteSnapshot(base, t.TempDir(), "local", scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	want, err := local.SaveScratchpad("local", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remoteStore.SaveScratchpad("remote", 2); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := remoteStore.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	local.manifestWriteHook = func() error { return errors.New("injected manifest failure") }
	if _, err := local.MergeRemoteSnapshot(remote); err == nil {
		t.Fatal("MergeRemoteSnapshot succeeded despite manifest failure")
	}
	got, err := local.GetScratchpad()
	if err != nil || got != want {
		t.Fatalf("in-memory scratchpad after failed merge = %#v, %v; want %#v", got, err, want)
	}
	path := local.Session().Path
	local.Lock()
	reopened := NewStore()
	if _, err := reopened.Open(path, scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	got, err = reopened.GetScratchpad()
	if err != nil || got != want {
		t.Fatalf("reopened scratchpad after failed merge = %#v, %v; want %#v", got, err, want)
	}
}

func TestScratchpadRemoteRoundTripAndClear(t *testing.T) {
	fastScratchpadKDF(t)
	source := NewStore()
	if _, err := source.Create(t.TempDir(), scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	want, err := source.SaveScratchpad("remote draft", 7)
	if err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := source.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	restored := NewStore()
	if _, err := restored.RestoreRemoteSnapshot(remote, t.TempDir(), "restored", scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	got, err := restored.GetScratchpad()
	if err != nil || got != want {
		t.Fatalf("restored scratchpad = %#v, %v; want %#v", got, err, want)
	}
	empty, err := source.SaveScratchpad("", 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Revision <= want.Revision || empty.Content != "" {
		t.Fatalf("empty scratchpad = %#v, want a newer empty record", empty)
	}
	if err := source.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	if _, err := restored.MergeRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	got, err = restored.GetScratchpad()
	if err != nil || got != empty {
		t.Fatalf("merged scratchpad = %#v, %v; want %#v", got, err, empty)
	}
}

func TestAbsentRemoteScratchpadDoesNotClearLocal(t *testing.T) {
	fastScratchpadKDF(t)
	source := NewStore()
	if _, err := source.Create(t.TempDir(), scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	remote := t.TempDir()
	if err := source.ExportRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	local := NewStore()
	if _, err := local.RestoreRemoteSnapshot(remote, t.TempDir(), "local", scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	want, err := local.SaveScratchpad("keep me", 2)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(remote, syncDirectory, syncFoldersFile)
	plaintext, err := source.readEnvelopeFileLocked(path, syncFoldersObjectType, syncFoldersObjectType)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(plaintext, &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "scratchpad")
	plaintext, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.writeEnvelopeLocked(path, syncFoldersObjectType, syncFoldersObjectType, plaintext); err != nil {
		t.Fatal(err)
	}
	if _, err := local.MergeRemoteSnapshot(remote); err != nil {
		t.Fatal(err)
	}
	got, err := local.GetScratchpad()
	if err != nil || got != want {
		t.Fatalf("scratchpad after absent remote merge = %#v, %v; want %#v", got, err, want)
	}
}

func TestScratchpadTiesConvergeByContent(t *testing.T) {
	fastScratchpadKDF(t)
	source := NewStore()
	if _, err := source.Create(t.TempDir(), scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	if err := source.ExportRemoteSnapshot(base); err != nil {
		t.Fatal(err)
	}
	left, right := NewStore(), NewStore()
	if _, err := left.RestoreRemoteSnapshot(base, t.TempDir(), "left", scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	if _, err := right.RestoreRemoteSnapshot(base, t.TempDir(), "right", scratchpadTestSecret); err != nil {
		t.Fatal(err)
	}
	leftState := ScratchpadState{Content: "alpha", Revision: 7, ModifiedAt: 99}
	rightState := ScratchpadState{Content: "beta", Revision: 7, ModifiedAt: 99}
	left.mu.Lock()
	left.manifest.Scratchpad = leftState
	if err := left.saveManifestLocked(); err != nil {
		left.mu.Unlock()
		t.Fatal(err)
	}
	left.mu.Unlock()
	right.mu.Lock()
	right.manifest.Scratchpad = rightState
	if err := right.saveManifestLocked(); err != nil {
		right.mu.Unlock()
		t.Fatal(err)
	}
	right.mu.Unlock()
	leftRemote, rightRemote := t.TempDir(), t.TempDir()
	if err := left.ExportRemoteSnapshot(leftRemote); err != nil {
		t.Fatal(err)
	}
	if err := right.ExportRemoteSnapshot(rightRemote); err != nil {
		t.Fatal(err)
	}
	if _, err := left.MergeRemoteSnapshot(rightRemote); err != nil {
		t.Fatal(err)
	}
	if _, err := right.MergeRemoteSnapshot(leftRemote); err != nil {
		t.Fatal(err)
	}
	for name, store := range map[string]*Store{"left": left, "right": right} {
		got, err := store.GetScratchpad()
		if err != nil || got != rightState {
			t.Fatalf("%s scratchpad = %#v, %v; want %#v", name, got, err, rightState)
		}
	}
}
