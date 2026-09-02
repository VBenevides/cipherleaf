package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	noteHistoryObjectType = "note-history"
	trashNoteObjectType   = "trash-note"
	trashFolderObjectType = "trash-folder"
)

func (s *Store) trashPathLocked(kind, id string) string {
	return filepath.Join(s.root, trashDirectory, kind+"s", id+".enc")
}

func (s *Store) historyPathLocked(id string, revision uint64) string {
	return filepath.Join(s.root, historyDirectory, id, fmt.Sprintf("%020d.enc", revision))
}

func (s *Store) writeRecoveryRecordLocked(path, objectType, objectID string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if objectType == noteHistoryObjectType {
		envelope, err := s.buildEnvelopeLocked(objectType, objectID, data, "")
		if err != nil {
			return err
		}
		data, err = json.Marshal(envelope)
		if err != nil {
			return err
		}
		return writeBytesAtomic(path, data)
	}
	return s.writeEnvelopeLocked(path, objectType, objectID, data)
}

func (s *Store) readRecoveryRecordLocked(path, objectType, objectID string, value any) error {
	data, err := s.readEnvelopeLocked(path, objectType, objectID)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func (s *Store) writeNoteHistoryLocked(note Note) error {
	path := s.historyPathLocked(note.ID, note.Revision)
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	directory := filepath.Dir(path)
	entries, err := os.ReadDir(directory)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".enc.bak") {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
	entries = slices.DeleteFunc(entries, func(entry os.DirEntry) bool {
		_, ok := historyRevision(entry.Name())
		return entry.IsDir() || !ok
	})
	for _, entry := range entries {
		revision, _ := historyRevision(entry.Name())
		var previous Note
		objectID := fmt.Sprintf("%s:%d", note.ID, revision)
		if err := s.readRecoveryRecordLocked(filepath.Join(directory, entry.Name()), noteHistoryObjectType, objectID, &previous); err != nil {
			return err
		}
		if noteContentsEqual(previous.Content, note.Content) {
			return nil
		}
	}
	objectID := fmt.Sprintf("%s:%d", note.ID, note.Revision)
	if err := s.writeRecoveryRecordLocked(path, noteHistoryObjectType, objectID, note); err != nil {
		return fmt.Errorf("save note history: %w", err)
	}
	limit := normalizeVaultSettings(s.manifest.Settings).FileHistoryLimit
	return pruneHistoryDirectory(directory, limit)
}

func (s *Store) writeTrashedNoteLocked(note Note) error {
	item := trashedNote{Note: note, DeletedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	return s.writeRecoveryRecordLocked(s.trashPathLocked("note", note.ID), trashNoteObjectType, note.ID, item)
}

func (s *Store) writeTrashedFolderLocked(folder Folder) error {
	item := trashedFolder{Folder: folder, DeletedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	return s.writeRecoveryRecordLocked(s.trashPathLocked("folder", folder.ID), trashFolderObjectType, folder.ID, item)
}

func (s *Store) listTrashedNotesLocked() ([]trashedNote, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, trashDirectory, "notes"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]trashedNote, 0, len(entries))
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".enc")
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".enc") || !validID(id) {
			continue
		}
		var item trashedNote
		if err := s.readRecoveryRecordLocked(s.trashPathLocked("note", id), trashNoteObjectType, id, &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Store) listTrashedFoldersLocked() ([]trashedFolder, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, trashDirectory, "folders"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]trashedFolder, 0, len(entries))
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".enc")
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".enc") || !validID(id) {
			continue
		}
		var item trashedFolder
		if err := s.readRecoveryRecordLocked(s.trashPathLocked("folder", id), trashFolderObjectType, id, &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Store) ListTrash() ([]TrashItem, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	items := make([]TrashItem, 0)
	notes, err := s.listTrashedNotesLocked()
	if err != nil {
		return nil, err
	}
	for _, item := range notes {
		if s.folderExistsLocked(item.Note.FolderID) && s.requireFolderAccessibleLocked(item.Note.FolderID) != nil {
			continue
		}
		items = append(items, TrashItem{ID: item.Note.ID, Kind: "note", Title: item.Note.Title, DeletedAt: item.DeletedAt})
	}
	folders, err := s.listTrashedFoldersLocked()
	if err != nil {
		return nil, err
	}
	for _, item := range folders {
		items = append(items, TrashItem{ID: item.Folder.ID, Kind: "folder", Title: item.Folder.Name, DeletedAt: item.DeletedAt})
	}
	slices.SortFunc(items, func(left, right TrashItem) int { return strings.Compare(right.DeletedAt, left.DeletedAt) })
	return items, nil
}

func (s *Store) RestoreTrashItem(kind, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	path := s.trashPathLocked(kind, id)
	originalManifest := cloneManifest(s.manifest)
	switch kind {
	case "note":
		var item trashedNote
		if err := s.readRecoveryRecordLocked(path, trashNoteObjectType, id, &item); err != nil {
			return err
		}
		if s.folderExistsLocked(item.Note.FolderID) {
			if err := s.requireFolderAccessibleLocked(item.Note.FolderID); err != nil {
				return err
			}
		}
		if _, found := s.findNoteLocked(id); found {
			return errors.New("note already exists")
		}
		if !s.folderExistsLocked(item.Note.FolderID) {
			item.Note.FolderID = ""
		}
		tombstone, _ := findTombstone(s.manifest.DeletedNotes, id)
		item.Note.Revision = max(item.Note.Revision+2, tombstone.Revision+1)
		item.Note.ModifiedAt = nextModifiedAt(max(item.Note.ModifiedAt, tombstone.ModifiedAt))
		item.Note.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		hash, err := s.writeNoteLocked(item.Note)
		if err != nil {
			return err
		}
		summary := summaryFromNote(item.Note)
		summary.CiphertextHash = hash
		s.manifest.Notes = append(s.manifest.Notes, summary)
		s.manifest.DeletedNotes = removeTombstone(s.manifest.DeletedNotes, id)
		s.noteIndexes = nil
		if err := s.saveManifestLocked(); err != nil {
			s.manifest = originalManifest
			s.noteIndexes = nil
			removeFileAndBackup(s.notePathLocked(id))
			return err
		}
		s.updateSearchIndexLocked(id, derivedMarkdownContent(item.Note.Content))
	case "folder":
		var item trashedFolder
		if err := s.readRecoveryRecordLocked(path, trashFolderObjectType, id, &item); err != nil {
			return err
		}
		if _, found := s.findFolderLocked(id); found {
			return errors.New("folder already exists")
		}
		if item.Folder.ParentID != "" {
			if _, found := s.findFolderLocked(item.Folder.ParentID); !found {
				item.Folder.ParentID = ""
			}
		}
		item.Folder.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		s.manifest.Folders = append(s.manifest.Folders, item.Folder)
		s.manifest.DeletedFolders = removeTombstone(s.manifest.DeletedFolders, id)
		s.folderIndexes = nil
		if err := s.saveManifestLocked(); err != nil {
			s.manifest = originalManifest
			s.folderIndexes = nil
			return err
		}
	default:
		return errors.New("invalid trash item kind")
	}
	_ = os.Remove(path)
	_ = os.Remove(path + ".bak")
	return nil
}

func (s *Store) PermanentlyDeleteTrashItem(kind, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if kind != "note" && kind != "folder" {
		return errors.New("invalid trash item kind")
	}
	path := s.trashPathLocked(kind, id)
	if err := os.Remove(path); err != nil {
		return err
	}
	_ = os.Remove(path + ".bak")
	if kind == "note" {
		_ = os.RemoveAll(filepath.Join(s.root, historyDirectory, id))
		return s.pruneSharedAttachmentsLocked()
	}
	return nil
}

func historyRevision(name string) (uint64, bool) {
	if !strings.HasSuffix(name, ".enc") {
		return 0, false
	}
	revision, err := strconv.ParseUint(strings.TrimSuffix(name, ".enc"), 10, 64)
	return revision, err == nil
}

func pruneHistoryDirectory(directory string, limit int) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	versions := entries[:0]
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".bak") {
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
				return err
			}
		} else if _, ok := historyRevision(entry.Name()); ok && !entry.IsDir() {
			versions = append(versions, entry)
		}
	}
	slices.SortFunc(versions, func(left, right os.DirEntry) int { return strings.Compare(left.Name(), right.Name()) })
	for _, entry := range versions[:max(0, len(versions)-limit)] {
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) CleanHistory() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	root := filepath.Join(s.root, historyDirectory)
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	limit := normalizeVaultSettings(s.manifest.Settings).FileHistoryLimit
	if err := pruneHistoryDirectory(root, limit); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			if err := pruneHistoryDirectory(filepath.Join(root, entry.Name()), limit); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) ListNoteVersions(id string) ([]NoteVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	index, found := s.findNoteLocked(id)
	if !found {
		return nil, errors.New("note not found")
	}
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(s.root, historyDirectory, id))
	if errors.Is(err, os.ErrNotExist) {
		return []NoteVersion{}, nil
	}
	if err != nil {
		return nil, err
	}
	slices.SortFunc(entries, func(left, right os.DirEntry) int { return strings.Compare(right.Name(), left.Name()) })
	versions := make([]NoteVersion, 0, len(entries))
	seenContent := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		revision, ok := historyRevision(entry.Name())
		if entry.IsDir() || !ok {
			continue
		}
		var note Note
		objectID := fmt.Sprintf("%s:%d", id, revision)
		if err := s.readRecoveryRecordLocked(filepath.Join(s.root, historyDirectory, id, entry.Name()), noteHistoryObjectType, objectID, &note); err != nil {
			return nil, err
		}
		content := derivedMarkdownContent(note.Content)
		if _, duplicate := seenContent[content]; duplicate {
			continue
		}
		seenContent[content] = struct{}{}
		versions = append(versions, NoteVersion{Revision: revision, Title: note.Title, UpdatedAt: note.UpdatedAt})
	}
	return versions, nil
}

func (s *Store) RestoreNoteVersion(id string, revision uint64) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Note{}, err
	}
	index, found := s.findNoteLocked(id)
	if !found {
		return Note{}, errors.New("note not found")
	}
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return Note{}, err
	}
	current, err := s.readNoteLocked(id)
	if err != nil {
		return Note{}, err
	}
	var historical Note
	objectID := fmt.Sprintf("%s:%d", id, revision)
	if err := s.readRecoveryRecordLocked(s.historyPathLocked(id, revision), noteHistoryObjectType, objectID, &historical); err != nil {
		return Note{}, err
	}
	if !s.folderExistsLocked(historical.FolderID) {
		historical.FolderID = ""
	}
	if historical.Title == current.Title && noteContentsEqual(historical.Content, current.Content) && historical.FolderID == current.FolderID {
		return noteForClient(current), nil
	}
	if err := s.writeNoteHistoryLocked(current); err != nil {
		return Note{}, err
	}
	historical.ID = id
	historical.Revision = current.Revision + 1
	historical.ModifiedAt = nextModifiedAt(current.ModifiedAt)
	historical.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	originalManifest := cloneManifest(s.manifest)
	hash, err := s.writeNoteLocked(historical)
	if err != nil {
		return Note{}, err
	}
	s.manifest.Notes[index] = summaryFromNote(historical)
	s.manifest.Notes[index].CiphertextHash = hash
	if err := s.saveManifestLocked(); err != nil {
		return Note{}, s.rollbackNoteWritesLocked(originalManifest, map[string]Note{id: current}, err)
	}
	s.updateSearchIndexLocked(id, derivedMarkdownContent(historical.Content))
	return noteForClient(historical), nil
}

func noteContentsEqual(left, right string) bool {
	return left == right || derivedMarkdownContent(left) == derivedMarkdownContent(right)
}
