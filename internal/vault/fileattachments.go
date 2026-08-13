package vault

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

func encodeFileAttachment(info AttachmentInfo, data []byte) ([]byte, error) {
	metadata, err := json.Marshal(info)
	if err != nil {
		return nil, err
	}
	payload := make([]byte, 4+len(metadata)+len(data))
	binary.BigEndian.PutUint32(payload, uint32(len(metadata)))
	copy(payload[4:], metadata)
	copy(payload[4+len(metadata):], data)
	return payload, nil
}

func decodeFileAttachment(payload []byte) (AttachmentInfo, []byte, error) {
	if len(payload) < 5 {
		return AttachmentInfo{}, nil, errors.New("encrypted file attachment is damaged")
	}
	metadataSize := int(binary.BigEndian.Uint32(payload[:4]))
	if metadataSize <= 0 || metadataSize > len(payload)-4 {
		return AttachmentInfo{}, nil, errors.New("encrypted file attachment metadata is damaged")
	}
	var info AttachmentInfo
	if err := json.Unmarshal(payload[4:4+metadataSize], &info); err != nil {
		return AttachmentInfo{}, nil, errors.New("encrypted file attachment metadata is damaged")
	}
	data := payload[4+metadataSize:]
	if !validID(info.ID) || strings.TrimSpace(info.Filename) == "" || info.Size != int64(len(data)) || len(data) > maxFileAttachmentBytes {
		return AttachmentInfo{}, nil, errors.New("encrypted file attachment is invalid")
	}
	return info, data, nil
}

func (s *Store) ImportFileAttachment(noteID, source string) (AttachmentInfo, error) {
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() {
		return AttachmentInfo{}, errors.New("attachment source is not a regular file")
	}
	if info.Size() <= 0 || info.Size() > maxFileAttachmentBytes {
		return AttachmentInfo{}, errors.New("attachment must be between 1 byte and 64 MiB")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return AttachmentInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return AttachmentInfo{}, err
	}
	if _, found := s.findNoteLocked(noteID); !found {
		return AttachmentInfo{}, errors.New("note not found")
	}
	noteIndex, _ := s.findNoteLocked(noteID)
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[noteIndex]); err != nil {
		return AttachmentInfo{}, err
	}
	id, err := randomID(16)
	if err != nil {
		return AttachmentInfo{}, err
	}
	attachment := AttachmentInfo{ID: id, Filename: filepath.Base(source), MIMEType: mime.TypeByExtension(filepath.Ext(source)), Size: int64(len(data))}
	if attachment.MIMEType == "" {
		attachment.MIMEType = "application/octet-stream"
	}
	payload, err := encodeFileAttachment(attachment, data)
	if err != nil {
		return AttachmentInfo{}, err
	}
	path := s.sharedAttachmentPathLocked(id)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return AttachmentInfo{}, err
	}
	if err := s.writeEnvelopeLocked(path, "file-attachment", sharedAttachmentAAD(id), payload); err != nil {
		return AttachmentInfo{}, err
	}
	s.trackPendingAttachmentLocked(noteID, id)
	return attachment, nil
}

func (s *Store) FileAttachment(noteID, id string) (AttachmentInfo, []byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return AttachmentInfo{}, nil, err
	}
	index, found := s.findNoteLocked(noteID)
	if !found {
		return AttachmentInfo{}, nil, errors.New("note not found")
	}
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return AttachmentInfo{}, nil, err
	}
	allowed := false
	for _, attachmentID := range s.manifest.Notes[index].AttachmentIDs {
		if attachmentID == id {
			allowed = true
			break
		}
	}
	if !allowed {
		return AttachmentInfo{}, nil, errors.New("attachment does not belong to this note")
	}
	payload, err := s.readEnvelopeLocked(s.sharedAttachmentPathLocked(id), "file-attachment", sharedAttachmentAAD(id))
	if err != nil {
		return AttachmentInfo{}, nil, fmt.Errorf("decrypt file attachment: %w", err)
	}
	return decodeFileAttachment(payload)
}

func (s *Store) ListFileAttachments(noteID string) ([]AttachmentInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	index, found := s.findNoteLocked(noteID)
	if !found {
		return nil, errors.New("note not found")
	}
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return nil, err
	}
	result := make([]AttachmentInfo, 0)
	for _, id := range s.manifest.Notes[index].AttachmentIDs {
		payload, err := s.readEnvelopeLocked(s.sharedAttachmentPathLocked(id), "file-attachment", sharedAttachmentAAD(id))
		if err != nil {
			continue
		}
		info, _, err := decodeFileAttachment(payload)
		if err != nil {
			return nil, err
		}
		result = append(result, info)
	}
	return result, nil
}

func (s *Store) ExportFileAttachment(noteID, id, destination string) (string, error) {
	info, data, err := s.FileAttachment(noteID, id)
	if err != nil {
		return "", err
	}
	directory, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	if stat, err := os.Stat(directory); err != nil || !stat.IsDir() {
		return "", errors.New("attachment destination is not a directory")
	}
	name := portableName(info.Filename, "attachment")
	extension := filepath.Ext(name)
	base := strings.TrimSuffix(name, extension)
	for suffix := 1; ; suffix++ {
		candidate := name
		if suffix > 1 {
			candidate = fmt.Sprintf("%s (%d)%s", base, suffix, extension)
		}
		path := filepath.Join(directory, candidate)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, err := file.Write(data); err != nil {
			file.Close()
			_ = os.Remove(path)
			return "", err
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(path)
			return "", err
		}
		return path, nil
	}
}
