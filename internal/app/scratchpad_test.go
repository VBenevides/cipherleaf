package app

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"path/filepath"
	"testing"

	appsession "cipherleaf/internal/session"
	"cipherleaf/internal/vault"
)

func TestScratchpadLockedAccess(t *testing.T) {
	service := NewVaultService()
	if got := service.GetScratchpad(); got.Content != "" || got.Generation != 0 || got.Revision != 0 {
		t.Fatalf("locked scratchpad = %#v", got)
	}
	if _, err := service.SaveScratchpad("content", 0, 0); !errors.Is(err, vault.ErrLocked) {
		t.Fatalf("SaveScratchpad() error = %v, want vault.ErrLocked", err)
	}
	if _, err := service.GetAttachment(scratchpadNamespace, "0123456789abcdef0123456789abcdef"); !errors.Is(err, vault.ErrLocked) {
		t.Fatalf("GetAttachment() error = %v, want vault.ErrLocked", err)
	}
}

func TestScratchpadContentCaretAndRevision(t *testing.T) {
	service := newScratchpadTestService(t)
	first, err := service.SaveScratchpad("draft", -4, 0)
	if err != nil {
		t.Fatal(err)
	}
	if first.Content != "draft" || first.CaretOffset != 0 || first.Generation != 0 || first.Revision != 1 {
		t.Fatalf("first scratchpad state = %#v", first)
	}
	second, err := service.SaveScratchpad("updated", 7, first.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if second.Content != "updated" || second.CaretOffset != 7 || second.Revision != 2 {
		t.Fatalf("second scratchpad state = %#v", second)
	}
	if got := service.GetScratchpad(); got != second {
		t.Fatalf("GetScratchpad() = %#v, want %#v", got, second)
	}
}

func TestScratchpadStaleGenerationAfterLock(t *testing.T) {
	service := newScratchpadTestService(t)
	state, err := service.SaveScratchpad("before lock", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := service.store.Session().Path
	service.LockVault()
	if got := service.GetScratchpad(); got.Content != "" || got.Generation != state.Generation+1 || got.Revision != 0 {
		t.Fatalf("cleared scratchpad = %#v", got)
	}
	if _, err := service.store.Open(path, "scratchpad test secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveScratchpad("stale", 0, state.Generation); !errors.Is(err, ErrScratchpadStaleGeneration) {
		t.Fatalf("stale SaveScratchpad() error = %v", err)
	}
}

func TestScratchpadHydratesAfterReopen(t *testing.T) {
	service := NewVaultService()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	secret := "scratchpad reopen secret"
	session, err := service.CreateVault(t.TempDir(), "scratchpad", secret)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := service.SaveScratchpad("persisted", 4, service.GetScratchpad().Generation)
	if err != nil {
		t.Fatal(err)
	}
	service.LockVault()
	opened, err := service.OpenVault(session.Path, secret)
	if err != nil {
		t.Fatal(err)
	}
	got := service.GetScratchpad()
	if got.Content != saved.Content || got.CaretOffset != saved.CaretOffset || got.Revision != saved.Revision {
		t.Fatalf("reopened scratchpad = %#v, want persisted content/caret/revision from %#v", got, saved)
	}
	if got.Generation <= saved.Generation || opened.Path != session.Path {
		t.Fatalf("reopened scratchpad generation/session = %#v, %q", got, opened.Path)
	}
	if _, err := service.SaveScratchpad("stale", 0, saved.Generation); !errors.Is(err, ErrScratchpadStaleGeneration) {
		t.Fatalf("old-generation SaveScratchpad() error = %v", err)
	}
}

func TestScratchpadAppRevisionStaysMonotonicAcrossHydrationAndSave(t *testing.T) {
	service := newScratchpadTestService(t)
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	service.scratchpad.mu.Lock()
	service.scratchpad.state = ScratchpadState{Content: "local", CaretOffset: 1, Revision: 7}
	service.scratchpad.mu.Unlock()
	if _, err := service.store.SaveScratchpad("remote", 2); err != nil {
		t.Fatal(err)
	}
	if err := service.hydrateScratchpad(); err != nil {
		t.Fatal(err)
	}
	hydrated := service.GetScratchpad()
	if hydrated.Content != "remote" || hydrated.Revision != 8 {
		t.Fatalf("hydrated scratchpad = %#v, want remote revision 8", hydrated)
	}
	saved, err := service.SaveScratchpad("saved", 3, hydrated.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 9 {
		t.Fatalf("saved scratchpad revision = %d, want 9", saved.Revision)
	}
	path := service.store.Session().Path
	service.LockVault()
	if _, err := service.OpenVault(path, "scratchpad test secret"); err != nil {
		t.Fatal(err)
	}
	if reopened := service.GetScratchpad(); reopened.Content != "saved" || reopened.Revision != 2 {
		t.Fatalf("reopened scratchpad = %#v, want persisted revision 2", reopened)
	}
}

func TestScratchpadImageRoundTripAndNamespace(t *testing.T) {
	service := newScratchpadTestService(t)
	dataURL := scratchpadPNGDataURL(t)
	id, err := service.SaveImageAttachment(scratchpadNamespace, dataURL)
	if err != nil {
		t.Fatal(err)
	}
	if !isScratchpadAttachmentID(id) {
		t.Fatalf("attachment ID = %q", id)
	}
	duplicateID, err := service.SaveImageAttachment(scratchpadNamespace+":0", dataURL)
	if err != nil {
		t.Fatal(err)
	}
	if duplicateID != id {
		t.Fatalf("duplicate attachment ID = %q, want %q", duplicateID, id)
	}
	encoded, err := service.GetAttachment(scratchpadNamespace+":0", id)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(decoded) < 12 || string(decoded[:4]) != "RIFF" || string(decoded[8:12]) != "WEBP" {
		t.Fatalf("decoded attachment is not WebP: %v", err)
	}
	if _, err := service.SaveImageAttachment(scratchpadNamespace+":1", dataURL); !errors.Is(err, ErrScratchpadStaleGeneration) {
		t.Fatalf("stale namespace SaveImageAttachment() error = %v", err)
	}
	if _, err := service.GetAttachment(scratchpadNamespace+":1", id); !errors.Is(err, ErrScratchpadStaleGeneration) {
		t.Fatalf("stale namespace GetAttachment() error = %v", err)
	}
}

func TestScratchpadPendingAttachmentRetentionAndCleanup(t *testing.T) {
	service := newScratchpadTestService(t)
	id, err := service.saveScratchpadAttachment(scratchpadNamespace, scratchpadWebP(16, 'a'))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveScratchpad("draft", 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetAttachment(scratchpadNamespace, id); err != nil {
		t.Fatalf("pending attachment was cleaned up: %v", err)
	}
	if _, err := service.SaveScratchpad("attachment:"+id, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveScratchpad("", 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetAttachment(scratchpadNamespace, id); err == nil {
		t.Fatal("unreferenced attachment was not cleaned up")
	}
}

func TestScratchpadAttachmentBudget(t *testing.T) {
	service := newScratchpadTestService(t)
	for index := 0; index < 6; index++ {
		if _, err := service.saveScratchpadAttachment(scratchpadNamespace, scratchpadWebP(scratchpadMaxAttachmentBytes, byte(index))); err != nil {
			t.Fatalf("attachment %d: %v", index, err)
		}
	}
	if _, err := service.saveScratchpadAttachment(scratchpadNamespace, scratchpadWebP(4*1024*1024, 'x')); err != nil {
		t.Fatal(err)
	}
	if _, err := service.saveScratchpadAttachment(scratchpadNamespace, scratchpadWebP(16, 'y')); err == nil {
		t.Fatal("attachment budget was not enforced")
	}
	service.LockVault()
	if service.scratchpad.attachmentBytes != 0 || len(service.scratchpad.attachments) != 0 {
		t.Fatal("scratchpad attachment budget was not cleared")
	}
}

func newScratchpadTestService(t *testing.T) *VaultService {
	t.Helper()
	service := NewVaultService()
	if _, err := service.store.Create(t.TempDir(), "scratchpad test secret"); err != nil {
		t.Fatal(err)
	}
	return service
}

func scratchpadPNGDataURL(t *testing.T) string {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data.Bytes())
}

func scratchpadWebP(size int, fill byte) []byte {
	data := bytes.Repeat([]byte{fill}, size)
	copy(data, []byte("RIFF"))
	copy(data[8:], []byte("WEBP"))
	return data
}
