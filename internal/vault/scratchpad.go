package vault

import (
	"errors"
	"strings"
	"time"
)

const maxScratchpadBytes = 10 * 1024 * 1024

type ScratchpadState struct {
	Content     string `json:"content"`
	CaretOffset int    `json:"caretOffset"`
	Revision    uint64 `json:"revision"`
	ModifiedAt  int64  `json:"modifiedAt"`
}

func (s *Store) GetScratchpad() (ScratchpadState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return ScratchpadState{}, err
	}
	return s.manifest.Scratchpad, nil
}

func (s *Store) SaveScratchpad(content string, caretOffset int) (ScratchpadState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return ScratchpadState{}, err
	}
	if len(content) > maxScratchpadBytes {
		return ScratchpadState{}, errors.New("scratchpad exceeds the 10 MiB limit")
	}
	caretOffset = max(caretOffset, 0)
	previous := s.manifest.Scratchpad
	now := time.Now().UnixMilli()
	state := ScratchpadState{
		Content:     content,
		CaretOffset: caretOffset,
		Revision:    previous.Revision + 1,
		ModifiedAt:  max(now, previous.ModifiedAt+1),
	}
	s.manifest.Scratchpad = state
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Scratchpad = previous
		return ScratchpadState{}, err
	}
	return state, nil
}

func validateScratchpadState(state ScratchpadState) error {
	if state.Revision == 0 {
		if state != (ScratchpadState{}) {
			return errors.New("revision zero requires an empty record")
		}
		return nil
	}
	if len(state.Content) > maxScratchpadBytes {
		return errors.New("content exceeds the 10 MiB limit")
	}
	if state.CaretOffset < 0 || state.ModifiedAt < 0 {
		return errors.New("record contains a negative value")
	}
	return nil
}

func scratchpadStateIsNewer(left, right ScratchpadState) bool {
	if left.Revision == 0 {
		return false
	}
	if right.Revision == 0 {
		return true
	}
	if left.ModifiedAt != right.ModifiedAt {
		return left.ModifiedAt > right.ModifiedAt
	}
	if left.Revision != right.Revision {
		return left.Revision > right.Revision
	}
	if compared := strings.Compare(left.Content, right.Content); compared != 0 {
		return compared > 0
	}
	return left.CaretOffset > right.CaretOffset
}
