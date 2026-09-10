package app

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"cipherleaf/internal/vault"
)

const (
	scratchpadNamespace          = "scratchpad"
	scratchpadMaxContentBytes    = 10 * 1024 * 1024
	scratchpadMaxAttachmentBytes = 10 * 1024 * 1024
	scratchpadAttachmentBudget   = 64 * 1024 * 1024
)

var ErrScratchpadStaleGeneration = errors.New("scratchpad generation is stale")

type ScratchpadState struct {
	Content     string `json:"content"`
	CaretOffset int    `json:"caretOffset"`
	Generation  uint64 `json:"generation"`
	Revision    uint64 `json:"revision"`
}

type scratchpadStore struct {
	mu              sync.RWMutex
	state           ScratchpadState
	attachments     map[string][]byte
	pending         map[string]struct{}
	attachmentBytes int
}

func (s *VaultService) GetScratchpad() ScratchpadState {
	s.scratchpad.mu.RLock()
	defer s.scratchpad.mu.RUnlock()
	if s.store.Session().Locked {
		return ScratchpadState{Generation: s.scratchpad.state.Generation}
	}
	return s.scratchpad.state
}

func (s *VaultService) clearScratchpad() {
	s.scratchpad.mu.Lock()
	state := s.scratchpad.clearLocked()
	s.scratchpad.mu.Unlock()
	s.emitScratchpadEvent("cipherleaf:scratchpad-cleared", state)
}

func (s *VaultService) hydrateScratchpad() error {
	s.scratchpad.mu.Lock()
	persisted, err := s.store.GetScratchpad()
	if err != nil {
		s.scratchpad.mu.Unlock()
		return err
	}

	state := s.scratchpad.state
	currentRevision := state.Revision
	changed := state.Content != persisted.Content ||
		state.CaretOffset != persisted.CaretOffset ||
		state.Revision != persisted.Revision
	state.Content = persisted.Content
	state.CaretOffset = persisted.CaretOffset
	state.Revision = persisted.Revision
	if changed && persisted.Revision <= currentRevision {
		state.Revision = currentRevision + 1
	}
	s.scratchpad.state = state
	s.scratchpad.mu.Unlock()
	if changed {
		s.emitScratchpadEvent("cipherleaf:scratchpad-changed", state)
	}
	return nil
}

func (s *VaultService) SaveScratchpad(content string, caretOffset int, generation uint64) (ScratchpadState, error) {
	s.scratchpad.mu.Lock()
	if s.store.Session().Locked {
		s.scratchpad.mu.Unlock()
		return ScratchpadState{}, vault.ErrLocked
	}
	if len(content) > scratchpadMaxContentBytes {
		s.scratchpad.mu.Unlock()
		return ScratchpadState{}, errors.New("scratchpad exceeds the 10 MiB limit")
	}
	if generation != s.scratchpad.state.Generation {
		s.scratchpad.mu.Unlock()
		return ScratchpadState{}, ErrScratchpadStaleGeneration
	}
	if caretOffset < 0 {
		caretOffset = 0
	}
	persisted, err := s.store.SaveScratchpad(content, caretOffset)
	if err != nil {
		s.scratchpad.mu.Unlock()
		return ScratchpadState{}, err
	}
	currentRevision := s.scratchpad.state.Revision
	s.scratchpad.state.Content = persisted.Content
	s.scratchpad.state.CaretOffset = persisted.CaretOffset
	s.scratchpad.state.Revision = persisted.Revision
	if persisted.Revision <= currentRevision {
		s.scratchpad.state.Revision = currentRevision + 1
	}
	for id := range scratchpadAttachmentIDs(persisted.Content) {
		delete(s.scratchpad.pending, id)
	}
	s.scratchpad.cleanupAttachmentsLocked(persisted.Content)
	state := s.scratchpad.state
	s.scratchpad.mu.Unlock()
	s.emitScratchpadEvent("cipherleaf:scratchpad-changed", state)
	return state, nil
}

func (s *scratchpadStore) clearLocked() ScratchpadState {
	s.state.Content = ""
	s.state.CaretOffset = 0
	s.state.Revision = 0
	s.state.Generation++
	s.attachments = nil
	s.pending = nil
	s.attachmentBytes = 0
	return s.state
}

func (s *scratchpadStore) cleanupAttachmentsLocked(content string) {
	referenced := scratchpadAttachmentIDs(content)
	for id, data := range s.attachments {
		if _, keep := referenced[id]; keep {
			continue
		}
		if _, pending := s.pending[id]; pending {
			continue
		}
		delete(s.attachments, id)
		s.attachmentBytes -= len(data)
	}
}

func (s *VaultService) saveScratchpadAttachment(namespace string, data []byte) (string, error) {
	generation, explicitGeneration, err := scratchpadGeneration(namespace)
	if err != nil {
		return "", err
	}
	if err := validateScratchpadAttachment(data); err != nil {
		return "", err
	}
	s.scratchpad.mu.Lock()
	defer s.scratchpad.mu.Unlock()
	if s.store.Session().Locked {
		return "", vault.ErrLocked
	}
	if explicitGeneration && generation != s.scratchpad.state.Generation {
		return "", ErrScratchpadStaleGeneration
	}
	if s.scratchpad.attachments == nil {
		s.scratchpad.attachments = make(map[string][]byte)
		s.scratchpad.pending = make(map[string]struct{})
	}
	for id, existing := range s.scratchpad.attachments {
		if bytes.Equal(existing, data) {
			s.scratchpad.pending[id] = struct{}{}
			return id, nil
		}
	}
	if s.scratchpad.attachmentBytes+len(data) > scratchpadAttachmentBudget {
		return "", errors.New("scratchpad attachments exceed the 64 MiB limit")
	}
	var id string
	for {
		id, err = scratchpadAttachmentID()
		if err != nil {
			return "", err
		}
		if _, exists := s.scratchpad.attachments[id]; !exists {
			break
		}
	}
	s.scratchpad.attachments[id] = append([]byte(nil), data...)
	s.scratchpad.pending[id] = struct{}{}
	s.scratchpad.attachmentBytes += len(data)
	return id, nil
}

func (s *VaultService) getScratchpadAttachment(namespace, id string) ([]byte, error) {
	generation, explicitGeneration, err := scratchpadGeneration(namespace)
	if err != nil {
		return nil, err
	}
	s.scratchpad.mu.RLock()
	defer s.scratchpad.mu.RUnlock()
	if s.store.Session().Locked {
		return nil, vault.ErrLocked
	}
	if explicitGeneration && generation != s.scratchpad.state.Generation {
		return nil, ErrScratchpadStaleGeneration
	}
	if !isScratchpadAttachmentID(id) {
		return nil, errors.New("invalid attachment ID")
	}
	data, ok := s.scratchpad.attachments[id]
	if !ok {
		return nil, errors.New("attachment not found")
	}
	return append([]byte(nil), data...), nil
}

func (s *VaultService) emitScratchpadEvent(name string, state ScratchpadState) {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app != nil && app.Event != nil {
		app.Event.Emit(name, state)
	}
}

func scratchpadGeneration(namespace string) (uint64, bool, error) {
	if namespace == scratchpadNamespace {
		return 0, false, nil
	}
	prefix := scratchpadNamespace + ":"
	if !strings.HasPrefix(namespace, prefix) {
		return 0, false, errors.New("invalid scratchpad namespace")
	}
	generation, err := strconv.ParseUint(strings.TrimPrefix(namespace, prefix), 10, 64)
	if err != nil {
		return 0, false, errors.New("invalid scratchpad generation")
	}
	return generation, true, nil
}

func validateScratchpadAttachment(data []byte) error {
	if len(data) == 0 || len(data) > scratchpadMaxAttachmentBytes {
		return errors.New("image must be between 1 byte and 10 MiB")
	}
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return errors.New("image is not valid WebP data")
	}
	return nil
}

func scratchpadAttachmentID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", fmt.Errorf("create scratchpad attachment ID: %w", err)
	}
	return hex.EncodeToString(data[:]), nil
}

func scratchpadAttachmentIDs(content string) map[string]struct{} {
	ids := make(map[string]struct{})
	for offset := 0; ; {
		index := strings.Index(content[offset:], "attachment:")
		if index < 0 {
			return ids
		}
		index += offset + len("attachment:")
		if len(content)-index < 32 {
			return ids
		}
		id := content[index : index+32]
		if isScratchpadAttachmentID(id) {
			ids[id] = struct{}{}
		}
		offset = index + 32
	}
}

func isScratchpadAttachmentID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, character := range id {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
