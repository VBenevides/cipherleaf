package vault

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"cipherleaf/internal/secure"
)

const (
	configFilename               = "vault.json"
	manifestFilename             = "manifest.enc"
	syncDirectory                = "sync"
	syncManifestFile             = "manifest.enc"
	syncFoldersFile              = "folders.enc"
	maxNoteBytes                 = 10 * 1024 * 1024
	maxAttachmentBytes           = 10 * 1024 * 1024
	maxEnvelopeBytes             = 16 * 1024 * 1024
	maxTitleRunes                = 200
	maxFolderRunes               = 120
	folderPasswordSaltBytes      = 16
	folderPasswordVerifierPrefix = "sha256-salt-v1:"
)

var (
	defaultKDF             = secure.KDFParams{Time: 3, Memory: 64 * 1024, Threads: 2}
	ErrLocked              = errors.New("vault is locked")
	ErrVaultAlreadyExists  = errors.New("a vault already exists in this folder")
	ErrVaultFolderExists   = errors.New("a folder with that vault name already exists")
	ErrVaultNotFound       = errors.New("no encrypted vault exists in this folder")
	ErrEncryptedFileAbsent = errors.New("an encrypted note file is missing")
	attachmentReference    = regexp.MustCompile(`attachment:([a-f0-9]{32})`)
	wikilinkPattern        = regexp.MustCompile(`\[\[([^\]\n]+)\]\]`)
	tagPattern             = regexp.MustCompile(`(^|[\s(])#([A-Za-z0-9][A-Za-z0-9_-]{0,63})`)
)

const sharedAttachmentFolder = "shared"

type Store struct {
	mu       sync.RWMutex
	root     string
	vaultID  string
	key      []byte
	secret   []byte
	manifest manifest
}

func NewStore() *Store {
	return &Store{}
}

// ReadVaultID returns the vault identifier stored in the configuration file
// at the given root. The vault does not need to be unlocked because
// vault.json is not encrypted.
func ReadVaultID(root string) (string, error) {
	configPath := filepath.Join(root, configFilename)
	var config vaultConfig
	if err := readJSON(configPath, 1<<20, &config); err != nil {
		return "", fmt.Errorf("read vault configuration: %w", err)
	}
	if strings.TrimSpace(config.VaultID) == "" {
		return "", errors.New("vault configuration is missing a vault id")
	}
	return config.VaultID, nil
}

func (s *Store) CreateIn(parent, name, passphrase string) (Session, error) {
	parent, err := prepareRoot(parent)
	if err != nil {
		return Session{}, err
	}
	if fileExists(filepath.Join(parent, configFilename)) {
		return Session{}, ErrVaultAlreadyExists
	}
	name, err = normalizeVaultName(name)
	if err != nil {
		return Session{}, err
	}
	root := filepath.Join(parent, name)
	if info, statErr := os.Stat(root); statErr == nil {
		if !info.IsDir() {
			return Session{}, ErrVaultFolderExists
		}
		if fileExists(filepath.Join(root, configFilename)) {
			return Session{}, ErrVaultAlreadyExists
		}
		return Session{}, ErrVaultFolderExists
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Session{}, fmt.Errorf("inspect new vault folder: %w", statErr)
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		return Session{}, fmt.Errorf("create named vault folder: %w", err)
	}
	created, err := s.Create(root, passphrase)
	if err != nil {
		cleanupNewVaultFolder(root)
		return Session{}, err
	}
	return created, nil
}

func (s *Store) Create(root, passphrase string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if utf8.RuneCountInString(passphrase) < 12 {
		return Session{}, errors.New("vault secret must contain at least 12 characters")
	}
	root, err := prepareRoot(root)
	if err != nil {
		return Session{}, err
	}
	if _, err := os.Stat(filepath.Join(root, configFilename)); err == nil {
		return Session{}, ErrVaultAlreadyExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return Session{}, fmt.Errorf("inspect vault folder: %w", err)
	}

	vaultID, err := randomID(16)
	if err != nil {
		return Session{}, err
	}
	masterKey, err := secure.RandomBytes(secure.KeySize)
	if err != nil {
		return Session{}, err
	}
	masterKeyOwnedByStore := false
	defer func() {
		if !masterKeyOwnedByStore {
			secure.Zero(masterKey)
		}
	}()

	config, err := buildConfig(vaultID, masterKey, passphrase, defaultKDF)
	if err != nil {
		return Session{}, err
	}
	if err := os.MkdirAll(filepath.Join(root, "objects"), 0o700); err != nil {
		return Session{}, fmt.Errorf("create objects folder: %w", err)
	}
	if err := writeJSONAtomic(filepath.Join(root, configFilename), config); err != nil {
		return Session{}, fmt.Errorf("write vault configuration: %w", err)
	}

	s.clearLocked()
	s.root = root
	s.vaultID = vaultID
	s.key = masterKey
	masterKeyOwnedByStore = true
	s.secret = []byte(passphrase)
	s.manifest = manifest{
		FormatVersion: FormatVersion,
		VaultID:       vaultID,
		Folders:       []Folder{},
		Notes:         []NoteSummary{},
	}
	if err := s.saveManifestLocked(); err != nil {
		s.clearLocked()
		removeFileAndBackup(filepath.Join(root, manifestFilename))
		removeFileAndBackup(filepath.Join(root, configFilename))
		_ = os.Remove(filepath.Join(root, "objects"))
		return Session{}, fmt.Errorf("write encrypted manifest: %w", err)
	}
	return s.sessionLocked(), nil
}

func (s *Store) Open(root, passphrase string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	root, err := prepareRoot(root)
	if err != nil {
		return Session{}, err
	}
	var config vaultConfig
	if err := readJSON(filepath.Join(root, configFilename), 1024*1024, &config); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Session{}, ErrVaultNotFound
		}
		return Session{}, fmt.Errorf("read vault configuration: %w", err)
	}
	if err := validateConfig(config); err != nil {
		return Session{}, err
	}

	key, err := unwrapMasterKey(config, passphrase)
	if err != nil {
		return Session{}, errors.New("unable to unlock vault: the vault secret is incorrect or key data is damaged")
	}

	s.clearLocked()
	s.root = root
	s.vaultID = config.VaultID
	s.key = key
	s.secret = []byte(passphrase)
	if err := s.loadManifestLocked(); err != nil {
		s.clearLocked()
		return Session{}, fmt.Errorf("open encrypted manifest: %w", err)
	}
	return s.sessionLocked(), nil
}

func (s *Store) Lock() Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clearLocked()
	return Session{Locked: true}
}

func (s *Store) Session() Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.key) == 0 {
		return Session{Locked: true}
	}
	return s.sessionLocked()
}

func (s *Store) ListNotes() ([]NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	result := slices.Clone(s.manifest.Notes)
	sortSummaries(result)
	return result, nil
}

func (s *Store) CreateNote(title string) (Note, error) {
	return s.CreateNoteInFolder(title, "")
}

func (s *Store) CreateNoteInFolder(title, folderID string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Note{}, err
	}
	if !s.folderExistsLocked(folderID) {
		return Note{}, errors.New("folder not found")
	}
	title, err := normalizeTitle(title)
	if err != nil {
		return Note{}, err
	}
	id, err := randomID(16)
	if err != nil {
		return Note{}, err
	}
	now := time.Now().UTC()
	nowRFC := now.Format(time.RFC3339Nano)
	note := Note{
		ID: id, Title: title, FolderID: folderID, Order: s.nextNoteOrderLocked(folderID), Content: canonicalizeNoteContent(""),
		CreatedAt: nowRFC, UpdatedAt: nowRFC, ModifiedAt: now.Unix(), Revision: 1,
	}
	hash, err := s.writeNoteLocked(note)
	if err != nil {
		return Note{}, err
	}
	summary := summaryFromNote(note)
	summary.CiphertextHash = hash
	s.manifest.Notes = append(s.manifest.Notes, summary)
	if err := s.saveManifestLocked(); err != nil {
		removeFileAndBackup(s.notePathLocked(id))
		s.manifest.Notes = s.manifest.Notes[:len(s.manifest.Notes)-1]
		return Note{}, err
	}
	return noteForClient(note), nil
}

func (s *Store) ListFolders() ([]Folder, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	result := slices.Clone(s.manifest.Folders)
	sortFolders(result)
	return result, nil
}

func (s *Store) CreateFolder(name string) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Folder{}, err
	}
	name, err := normalizeFolderName(name)
	if err != nil {
		return Folder{}, err
	}
	if s.folderNameExistsLocked(name, "") {
		return Folder{}, errors.New("a folder with this name already exists")
	}
	id, err := randomID(16)
	if err != nil {
		return Folder{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	folder := Folder{ID: id, Name: name, Order: s.nextFolderOrderLocked(), SortMode: "manual", CreatedAt: now, UpdatedAt: now}
	s.manifest.Folders = append(s.manifest.Folders, folder)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders = s.manifest.Folders[:len(s.manifest.Folders)-1]
		return Folder{}, err
	}
	return folder, nil
}

func (s *Store) RenameFolder(id, name string) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Folder{}, err
	}
	index, found := s.findFolderLocked(id)
	if !found {
		return Folder{}, errors.New("folder not found")
	}
	name, err := normalizeFolderName(name)
	if err != nil {
		return Folder{}, err
	}
	if s.folderNameExistsLocked(name, id) {
		return Folder{}, errors.New("a folder with this name already exists")
	}
	original := s.manifest.Folders[index]
	s.manifest.Folders[index].Name = name
	s.manifest.Folders[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders[index] = original
		return Folder{}, err
	}
	return s.manifest.Folders[index], nil
}

func (s *Store) ReorderFolders(orderedIDs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if len(orderedIDs) != len(s.manifest.Folders) {
		return errors.New("folder order does not include every folder")
	}
	seen := make(map[string]struct{}, len(orderedIDs))
	for _, id := range orderedIDs {
		if _, found := s.findFolderLocked(id); !found {
			return errors.New("folder order contains an unknown folder")
		}
		if _, duplicate := seen[id]; duplicate {
			return errors.New("folder order contains a duplicate folder")
		}
		seen[id] = struct{}{}
	}
	original := slices.Clone(s.manifest.Folders)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for order, id := range orderedIDs {
		index, _ := s.findFolderLocked(id)
		s.manifest.Folders[index].Order = order
		s.manifest.Folders[index].UpdatedAt = now
	}
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders = original
		return err
	}
	return nil
}

func (s *Store) SetFolderHidden(id string, hidden bool) (Folder, error) {
	return s.updateFolderLocked(id, func(folder *Folder) {
		folder.Hidden = hidden
	})
}

func (s *Store) LockFolder(id, password string) (Folder, error) {
	verifier, err := newFolderPasswordVerifier(password)
	if err != nil {
		return Folder{}, err
	}
	return s.updateFolderLocked(id, func(folder *Folder) {
		folder.Locked = true
		folder.LockPasswordHash = verifier
	})
}

func (s *Store) UnlockFolder(id, password string) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Folder{}, err
	}
	index, found := s.findFolderLocked(id)
	if !found {
		return Folder{}, errors.New("folder not found")
	}
	if !verifyFolderPassword(s.manifest.Folders[index].LockPasswordHash, password) {
		return Folder{}, errors.New("folder password is incorrect")
	}
	original := s.manifest.Folders[index]
	s.manifest.Folders[index].Locked = false
	s.manifest.Folders[index].LockPasswordHash = ""
	s.manifest.Folders[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders[index] = original
		return Folder{}, err
	}
	return s.manifest.Folders[index], nil
}

func (s *Store) CheckFolderPassword(id, password string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	index, found := s.findFolderLocked(id)
	if !found {
		return errors.New("folder not found")
	}
	if !verifyFolderPassword(s.manifest.Folders[index].LockPasswordHash, password) {
		return errors.New("folder password is incorrect")
	}
	return nil
}

func (s *Store) SetFolderSortMode(id, mode string) (Folder, error) {
	mode = normalizeSortMode(mode)
	return s.updateFolderLocked(id, func(folder *Folder) {
		folder.SortMode = mode
	})
}

func (s *Store) updateFolderLocked(id string, update func(*Folder)) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Folder{}, err
	}
	index, found := s.findFolderLocked(id)
	if !found {
		return Folder{}, errors.New("folder not found")
	}
	original := s.manifest.Folders[index]
	update(&s.manifest.Folders[index])
	s.manifest.Folders[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders[index] = original
		return Folder{}, err
	}
	return s.manifest.Folders[index], nil
}

func (s *Store) DeleteFolder(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	index, found := s.findFolderLocked(id)
	if !found {
		return errors.New("folder not found")
	}
	for _, note := range s.manifest.Notes {
		if note.FolderID == id {
			return errors.New("folder is not empty; move or delete its notes first")
		}
	}
	original := s.manifest.Folders
	originalDeleted := slices.Clone(s.manifest.DeletedFolders)
	deletedAt := time.Now().UTC().Unix()
	if updated, err := time.Parse(time.RFC3339Nano, original[index].UpdatedAt); err == nil &&
		deletedAt <= updated.Unix() {
		deletedAt = updated.Unix() + 1
	}
	s.manifest.Folders = append(slices.Clone(original[:index]), original[index+1:]...)
	s.manifest.DeletedFolders = upsertTombstone(
		s.manifest.DeletedFolders,
		Tombstone{ID: id, ModifiedAt: deletedAt},
	)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders = original
		s.manifest.DeletedFolders = originalDeleted
		return err
	}
	return nil
}

func (s *Store) MoveNote(id, folderID string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Note{}, err
	}
	index, found := s.findNoteLocked(id)
	if !found {
		return Note{}, errors.New("note not found")
	}
	if !s.folderExistsLocked(folderID) {
		return Note{}, errors.New("folder not found")
	}
	current, err := s.readNoteLocked(id)
	if err != nil {
		return Note{}, err
	}
	if current.FolderID == folderID {
		return current, nil
	}
	original := current
	originalSummary := s.manifest.Notes[index]
	current.FolderID = folderID
	current.Order = s.nextNoteOrderLocked(folderID)
	now := time.Now().UTC()
	current.UpdatedAt = now.Format(time.RFC3339Nano)
	current.ModifiedAt = nextModifiedAt(original.ModifiedAt)
	current.Revision++
	s.manifest.Notes[index] = summaryFromNote(current)
	s.manifest.Notes[index].CiphertextHash = originalSummary.CiphertextHash
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Notes[index] = originalSummary
		return Note{}, err
	}
	return noteForClient(current), nil
}

func (s *Store) ReorderNotes(folderID string, orderedIDs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if !s.folderExistsLocked(folderID) {
		return errors.New("folder not found")
	}
	folderCount := 0
	seen := make(map[string]struct{}, len(orderedIDs))
	for _, summary := range s.manifest.Notes {
		if summary.FolderID == folderID {
			folderCount++
		}
	}
	if len(orderedIDs) != folderCount {
		return errors.New("note order does not include every note in the folder")
	}
	for _, id := range orderedIDs {
		index, found := s.findNoteLocked(id)
		if !found || s.manifest.Notes[index].FolderID != folderID {
			return errors.New("note order contains a note from another folder")
		}
		if _, duplicate := seen[id]; duplicate {
			return errors.New("note order contains a duplicate note")
		}
		seen[id] = struct{}{}
	}

	originalManifest := slices.Clone(s.manifest.Notes)
	for order, id := range orderedIDs {
		index, _ := s.findNoteLocked(id)
		if s.manifest.Notes[index].Order == order {
			continue
		}
		note, err := s.readNoteLocked(id)
		if err != nil {
			return err
		}
		originalSummary := s.manifest.Notes[index]
		note.Order = order
		now := time.Now().UTC()
		note.UpdatedAt = now.Format(time.RFC3339Nano)
		note.ModifiedAt = nextModifiedAt(note.ModifiedAt)
		note.Revision++
		s.manifest.Notes[index] = summaryFromNote(note)
		s.manifest.Notes[index].CiphertextHash = originalSummary.CiphertextHash
	}
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Notes = originalManifest
		return err
	}
	return nil
}

func (s *Store) restoreReorderedNotesLocked(manifest []NoteSummary, notes map[string]Note) {
	s.manifest.Notes = manifest
	for _, note := range notes {
		_, _ = s.writeNoteLocked(note)
	}
}

func (s *Store) GetNote(id string) (Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return Note{}, err
	}
	if _, found := s.findNoteLocked(id); !found {
		return Note{}, errors.New("note not found")
	}
	note, err := s.readNoteLocked(id)
	if err != nil {
		return Note{}, err
	}
	return noteForClient(note), nil
}

func (s *Store) SaveNote(id, title, content string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Note{}, err
	}
	index, found := s.findNoteLocked(id)
	if !found {
		return Note{}, errors.New("note not found")
	}
	title, err := normalizeTitle(title)
	if err != nil {
		return Note{}, err
	}
	storedContent := canonicalizeNoteContent(content)
	if len(storedContent) > maxNoteBytes {
		return Note{}, errors.New("note exceeds the 10 MiB limit")
	}
	current, err := s.readNoteLocked(id)
	if err != nil {
		return Note{}, err
	}
	originalSummary := s.manifest.Notes[index]
	contentMatches := current.Content == storedContent || derivedMarkdownContent(current.Content) == content
	if current.Title == title && contentMatches {
		if err := s.pruneNoteAttachmentsLocked(id, storedContent); err != nil {
			return Note{}, err
		}
		if err := s.pruneSharedAttachmentsForSaveLocked(); err != nil {
			return Note{}, err
		}
		return noteForClient(current), nil
	}
	original := current
	current.Title = title
	current.Content = storedContent
	now := time.Now().UTC()
	current.UpdatedAt = now.Format(time.RFC3339Nano)
	current.ModifiedAt = nextModifiedAt(current.ModifiedAt)
	current.Revision++
	hash := originalSummary.CiphertextHash
	if current.Content != original.Content {
		hash, err = s.writeNoteLocked(current)
		if err != nil {
			return Note{}, err
		}
	}
	s.manifest.Notes[index] = summaryFromNote(current)
	s.manifest.Notes[index].CiphertextHash = hash
	if err := s.saveManifestLocked(); err != nil {
		return Note{}, err
	}
	if err := s.pruneNoteAttachmentsLocked(id, storedContent); err != nil {
		return Note{}, err
	}
	if err := s.pruneSharedAttachmentsForSaveLocked(); err != nil {
		return Note{}, err
	}
	return noteForClient(current), nil
}

// SaveAttachment encrypts a WebP image in the vault and returns its opaque ID.
func (s *Store) SaveAttachment(noteID string, data []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return "", err
	}
	if _, found := s.findNoteLocked(noteID); !found {
		return "", errors.New("note not found")
	}
	if len(data) == 0 || len(data) > maxAttachmentBytes {
		return "", errors.New("image must be between 1 byte and 10 MiB")
	}
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return "", errors.New("image is not valid WebP data")
	}
	id, err := randomID(16)
	if err != nil {
		return "", fmt.Errorf("create attachment ID: %w", err)
	}
	path := s.sharedAttachmentPathLocked(id)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create attachment folder: %w", err)
	}
	if err := s.writeEnvelopeLocked(path, "attachment", sharedAttachmentAAD(id), data); err != nil {
		return "", fmt.Errorf("encrypt attachment: %w", err)
	}
	return id, nil
}

// GetAttachment decrypts an image belonging to a note.
func (s *Store) GetAttachment(noteID, id string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	if _, found := s.findNoteLocked(noteID); !found {
		return nil, errors.New("note not found")
	}
	if !validID(id) {
		return nil, errors.New("invalid attachment ID")
	}
	sharedPath := s.sharedAttachmentPathLocked(id)
	data, err := s.readEnvelopeLocked(sharedPath, "attachment", sharedAttachmentAAD(id))
	if _, statErr := os.Stat(sharedPath); errors.Is(statErr, os.ErrNotExist) {
		data, err = s.readEnvelopeLocked(
			s.attachmentPathLocked(noteID, id),
			"attachment",
			noteID+":"+id,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("decrypt attachment: %w", err)
	}
	if len(data) > maxAttachmentBytes ||
		len(data) < 12 ||
		string(data[:4]) != "RIFF" ||
		string(data[8:12]) != "WEBP" {
		return nil, errors.New("encrypted attachment is damaged")
	}
	return data, nil
}

// DeleteAttachment removes an image belonging to a note.
func (s *Store) DeleteAttachment(noteID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if _, found := s.findNoteLocked(noteID); !found {
		return errors.New("note not found")
	}
	if !validID(id) {
		return errors.New("invalid attachment ID")
	}
	sharedPath := s.sharedAttachmentPathLocked(id)
	if err := os.Remove(sharedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove encrypted shared attachment: %w", err)
	}
	if err := os.Remove(sharedPath + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove encrypted shared attachment backup: %w", err)
	}
	path := s.attachmentPathLocked(noteID, id)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove encrypted attachment: %w", err)
	}
	if err := os.Remove(path + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove encrypted attachment backup: %w", err)
	}
	return nil
}

// PruneStaleAttachments removes encrypted images not referenced by their note.
func (s *Store) PruneStaleAttachments() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	return s.pruneStaleAttachmentsLocked()
}

func (s *Store) pruneStaleAttachmentsLocked() error {
	attachmentRoot := filepath.Join(s.root, "attachments")
	entries, err := os.ReadDir(attachmentRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect attachment folders: %w", err)
	}
	notes := make(map[string]struct{}, len(s.manifest.Notes))
	for _, summary := range s.manifest.Notes {
		notes[summary.ID] = struct{}{}
		if summary.AttachmentIDs != nil {
			if err := s.pruneNoteAttachmentsByIDLocked(summary.ID, summary.AttachmentIDs); err != nil {
				return err
			}
		} else {
			note, err := s.readNoteLocked(summary.ID)
			if err != nil {
				return err
			}
			if err := s.pruneNoteAttachmentsLocked(summary.ID, note.Content); err != nil {
				return err
			}
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() || (entry.Name() != sharedAttachmentFolder && !validID(entry.Name())) {
			return errors.New("attachments folder contains an invalid path")
		}
		if entry.Name() == sharedAttachmentFolder {
			if err := s.pruneSharedAttachmentsLocked(); err != nil {
				return err
			}
			continue
		}
		if _, found := notes[entry.Name()]; !found {
			if err := os.RemoveAll(filepath.Join(attachmentRoot, entry.Name())); err != nil {
				return fmt.Errorf("remove orphaned attachment folder: %w", err)
			}
		}
	}
	return nil
}

func (s *Store) pruneSharedAttachmentsLocked() error {
	referenced := make(map[string]struct{})
	for _, summary := range s.manifest.Notes {
		ids, err := s.attachmentIDsForSummaryLocked(summary)
		if err != nil {
			return err
		}
		for _, id := range ids {
			referenced[id] = struct{}{}
		}
	}
	directory := filepath.Join(s.root, "attachments", sharedAttachmentFolder)
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect shared attachments: %w", err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".enc") &&
			!strings.HasSuffix(entry.Name(), ".enc.bak") {
			return errors.New("shared attachments folder contains an invalid path")
		}
		name := strings.TrimSuffix(strings.TrimSuffix(entry.Name(), ".bak"), ".enc")
		if entry.IsDir() || !validID(name) {
			return errors.New("shared attachments folder contains an invalid path")
		}
		if _, found := referenced[name]; found {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
			return fmt.Errorf("remove stale shared attachment: %w", err)
		}
	}
	return nil
}

func (s *Store) pruneSharedAttachmentsForSaveLocked() error {
	candidates, err := s.sharedAttachmentIDsLocked()
	if err != nil {
		return err
	}
	return s.pruneSharedAttachmentsByIDLocked(candidates)
}

func (s *Store) pruneSharedAttachmentsByIDLocked(candidates map[string]struct{}) error {
	if len(candidates) == 0 {
		return nil
	}
	referenced := make(map[string]struct{}, len(candidates))
	for _, summary := range s.manifest.Notes {
		ids, err := s.attachmentIDsForSummaryLocked(summary)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if _, ok := candidates[id]; ok {
				referenced[id] = struct{}{}
			}
		}
		if len(referenced) == len(candidates) {
			return nil
		}
	}
	for id := range candidates {
		if _, found := referenced[id]; found {
			continue
		}
		path := s.sharedAttachmentPathLocked(id)
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale shared attachment: %w", err)
		}
		if err := os.Remove(path + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale shared attachment backup: %w", err)
		}
	}
	return nil
}

func (s *Store) attachmentIDsForSummaryLocked(summary NoteSummary) ([]string, error) {
	if summary.AttachmentIDs != nil {
		return summary.AttachmentIDs, nil
	}
	note, err := s.readNoteLocked(summary.ID)
	if err != nil {
		return nil, err
	}
	return extractAttachmentIDs(derivedMarkdownContent(note.Content)), nil
}

func (s *Store) sharedAttachmentIDsLocked() (map[string]struct{}, error) {
	directory := filepath.Join(s.root, "attachments", sharedAttachmentFolder)
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect shared attachments: %w", err)
	}
	ids := make(map[string]struct{})
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".enc") &&
			!strings.HasSuffix(entry.Name(), ".enc.bak") {
			return nil, errors.New("shared attachments folder contains an invalid path")
		}
		name := strings.TrimSuffix(strings.TrimSuffix(entry.Name(), ".bak"), ".enc")
		if entry.IsDir() || !validID(name) {
			return nil, errors.New("shared attachments folder contains an invalid path")
		}
		ids[name] = struct{}{}
	}
	return ids, nil
}

func (s *Store) pruneNoteAttachmentsLocked(noteID, content string) error {
	return s.pruneNoteAttachmentsByIDLocked(noteID, extractAttachmentIDs(derivedMarkdownContent(content)))
}

func (s *Store) pruneNoteAttachmentsByIDLocked(noteID string, ids []string) error {
	referenced := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		referenced[id] = struct{}{}
	}
	directory := filepath.Join(s.root, "attachments", noteID)
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect note attachments: %w", err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".enc") &&
			!strings.HasSuffix(entry.Name(), ".enc.bak") {
			return errors.New("note attachments folder contains an invalid path")
		}
		name := strings.TrimSuffix(strings.TrimSuffix(entry.Name(), ".bak"), ".enc")
		if entry.IsDir() || !validID(name) {
			return errors.New("note attachments folder contains an invalid path")
		}
		if _, found := referenced[name]; found {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
			return fmt.Errorf("remove stale attachment: %w", err)
		}
	}
	return nil
}

func (s *Store) DeleteNote(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	index, found := s.findNoteLocked(id)
	if !found {
		return errors.New("note not found")
	}
	original := s.manifest.Notes
	originalDeleted := slices.Clone(s.manifest.DeletedNotes)
	item := original[index]
	s.manifest.Notes = append(slices.Clone(original[:index]), original[index+1:]...)
	s.manifest.DeletedNotes = upsertTombstone(
		s.manifest.DeletedNotes,
		Tombstone{
			ID:         id,
			Revision:   item.Revision + 1,
			ModifiedAt: nextModifiedAt(item.ModifiedAt),
		},
	)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Notes = original
		s.manifest.DeletedNotes = originalDeleted
		return err
	}
	path := s.notePathLocked(id)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove encrypted note: %w", err)
	}
	if err := os.Remove(path + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove encrypted note backup: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(s.root, "attachments", id)); err != nil {
		return fmt.Errorf("remove encrypted note attachments: %w", err)
	}
	if err := s.pruneSharedAttachmentsLocked(); err != nil {
		return err
	}
	return nil
}

func (s *Store) Search(query string) ([]NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		result := slices.Clone(s.manifest.Notes)
		sortSummaries(result)
		return result, nil
	}
	result := make([]NoteSummary, 0)
	for _, item := range s.manifest.Notes {
		if strings.Contains(strings.ToLower(item.Title), query) {
			result = append(result, item)
			continue
		}
		note, err := s.readNoteLocked(item.ID)
		if err != nil {
			return nil, err
		}
		if strings.Contains(strings.ToLower(derivedMarkdownContent(note.Content)), query) {
			result = append(result, item)
		}
	}
	sortSummaries(result)
	return result, nil
}

func (s *Store) ResolveNoteReference(reference string) (NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return NoteSummary{}, err
	}
	reference = strings.TrimSpace(reference)
	if label, id, ok := parseNoteReference(reference); ok {
		if index, found := s.findNoteLocked(id); found {
			return s.manifest.Notes[index], nil
		}
		reference = label
	}
	if strings.HasPrefix(reference, "note:") {
		id := strings.TrimPrefix(reference, "note:")
		if index, found := s.findNoteLocked(id); found {
			return s.manifest.Notes[index], nil
		}
		return NoteSummary{}, errors.New("note reference not found")
	}
	normalized := strings.ToLower(reference)
	for _, item := range s.manifest.Notes {
		if strings.ToLower(item.Title) == normalized {
			return item, nil
		}
		if item.FolderID != "" {
			if folder, found := s.folderByIDLocked(item.FolderID); found &&
				strings.ToLower(folder.Name+"/"+item.Title) == normalized {
				return item, nil
			}
		}
	}
	return NoteSummary{}, errors.New("note reference not found")
}

func (s *Store) ListBacklinks(noteID string) ([]FindMatch, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	targetIndex, found := s.findNoteLocked(noteID)
	if !found {
		return nil, errors.New("note not found")
	}
	target := s.manifest.Notes[targetIndex]
	aliases := map[string]struct{}{
		strings.ToLower(target.Title): {},
		"note:" + target.ID:           {},
	}
	if target.FolderID != "" {
		if folder, found := s.folderByIDLocked(target.FolderID); found {
			aliases[strings.ToLower(folder.Name+"/"+target.Title)] = struct{}{}
		}
	}
	var matches []FindMatch
	for _, summary := range s.manifest.Notes {
		if summary.ID == noteID {
			continue
		}
		if summary.OutgoingLinks != nil {
			for _, link := range summary.OutgoingLinks {
				if outgoingLinkMatches(link, target.ID, aliases) {
					matches = append(matches, backlinkMetadataMatch(summary, link))
					break
				}
			}
			continue
		}
		note, err := s.readNoteLocked(summary.ID)
		if err != nil {
			return nil, err
		}
		content := derivedMarkdownContent(note.Content)
		for _, match := range wikilinkPattern.FindAllStringSubmatchIndex(content, -1) {
			raw := content[match[2]:match[3]]
			label, id, hasID := parseNoteReference(raw)
			key := strings.ToLower(strings.TrimSpace(raw))
			if hasID {
				if id == target.ID {
					matches = append(matches, backlinkMatch(summary, content, match[0], match[1], raw))
					break
				}
				key = strings.ToLower(label)
			}
			if _, ok := aliases[key]; ok {
				matches = append(matches, backlinkMatch(summary, content, match[0], match[1], raw))
				break
			}
		}
	}
	return matches, nil
}

// FindInNotes decrypts every note, locates all case-insensitive matches of
// query, and returns up to maxPerNote snippets per note. Matches report the
// exact offset and length inside the note's plain-text content so the
// editor can scroll to them.
func (s *Store) FindInNotes(query string, maxPerNote int) ([]FindMatch, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return []FindMatch{}, nil
	}
	if maxPerNote <= 0 {
		maxPerNote = 20
	}
	items := slices.Clone(s.manifest.Notes)
	sortSummaries(items)
	results := make([]FindMatch, 0)
	for _, item := range items {
		haystack := strings.ToLower(item.Title)
		idx := 0
		for count := 0; count < maxPerNote; count++ {
			at := strings.Index(haystack[idx:], query)
			if at < 0 {
				break
			}
			results = append(results, FindMatch{
				NoteID:      item.ID,
				Title:       item.Title,
				FolderID:    item.FolderID,
				Field:       "title",
				Snippet:     makeSnippet(item.Title, idx+at, len(query)),
				Offset:      idx + at,
				MatchLength: len(query),
			})
			idx += at + len(query)
			if idx >= len(haystack) {
				break
			}
		}
		note, err := s.readNoteLocked(item.ID)
		if err != nil {
			return nil, err
		}
		content := derivedMarkdownContent(note.Content)
		lowerContent := strings.ToLower(content)
		cidx := 0
		for count := 0; count < maxPerNote; count++ {
			at := strings.Index(lowerContent[cidx:], query)
			if at < 0 {
				break
			}
			abs := cidx + at
			results = append(results, FindMatch{
				NoteID:      item.ID,
				Title:       note.Title,
				FolderID:    item.FolderID,
				Field:       "content",
				Snippet:     makeSnippet(content, abs, len(query)),
				Offset:      abs,
				MatchLength: len(query),
			})
			cidx = abs + len(query)
			if cidx >= len(lowerContent) {
				break
			}
		}
	}
	return results, nil
}

func makeSnippet(haystack string, offset, length int) string {
	const radius = 40
	start := offset - radius
	if start < 0 {
		start = 0
	}
	end := offset + length + radius
	if end > len(haystack) {
		end = len(haystack)
	}
	prefix := ""
	if start > 0 {
		prefix = "…"
	}
	suffix := ""
	if end < len(haystack) {
		suffix = "…"
	}
	return prefix + haystack[start:end] + suffix
}

// ReplaceAcrossNotes performs a case-insensitive substring replacement of
// find with replace. When noteIDs is empty every note is processed;
// otherwise only the listed notes are updated. The encrypted envelope and
// ModifiedAt are refreshed for every modified note so sync reconciles the
// new content.
func (s *Store) ReplaceAcrossNotes(find, replace string, noteIDs []string) (ReplaceResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return ReplaceResult{}, err
	}
	if find == "" {
		return ReplaceResult{}, errors.New("search text is required")
	}
	if strings.Contains(find, "\n") {
		return ReplaceResult{}, errors.New("search text cannot contain line breaks")
	}
	allowed := make(map[string]struct{}, len(noteIDs))
	for _, id := range noteIDs {
		allowed[id] = struct{}{}
	}
	restricted := len(noteIDs) > 0

	result := ReplaceResult{}
	for index, item := range s.manifest.Notes {
		if restricted {
			if _, ok := allowed[item.ID]; !ok {
				continue
			}
		}
		note, err := s.readNoteLocked(item.ID)
		if err != nil {
			return ReplaceResult{}, err
		}
		titleChanged := false
		newTitle := note.Title
		if strings.Contains(strings.ToLower(note.Title), strings.ToLower(find)) {
			newTitle = replaceInsensitive(note.Title, find, replace)
			titleChanged = newTitle != note.Title
		}
		content := derivedMarkdownContent(note.Content)
		newContent := note.Content
		count := strings.Count(strings.ToLower(content), strings.ToLower(find))
		if count > 0 {
			newContent = canonicalizeNoteContent(replaceInsensitive(content, find, replace))
		}
		if !titleChanged && count == 0 {
			continue
		}
		titleCount := 0
		if titleChanged {
			titleCount = strings.Count(strings.ToLower(note.Title), strings.ToLower(find))
		}
		now := time.Now().UTC()
		updated := Note{
			ID:         note.ID,
			Title:      newTitle,
			FolderID:   note.FolderID,
			Order:      note.Order,
			Content:    newContent,
			CreatedAt:  note.CreatedAt,
			UpdatedAt:  now.Format(time.RFC3339Nano),
			ModifiedAt: nextModifiedAt(note.ModifiedAt),
			Revision:   note.Revision + 1,
		}
		hash, err := s.writeNoteLocked(updated)
		if err != nil {
			return ReplaceResult{}, err
		}
		s.manifest.Notes[index] = summaryFromNote(updated)
		s.manifest.Notes[index].CiphertextHash = hash
		result.Replacements += count + titleCount
		result.ReplacedNotes++
	}
	if result.ReplacedNotes > 0 {
		if err := s.saveManifestLocked(); err != nil {
			return ReplaceResult{}, err
		}
	}
	return result, nil
}

func replaceInsensitive(haystack, find, replace string) string {
	lower := strings.ToLower(haystack)
	lowerFind := strings.ToLower(find)
	var builder strings.Builder
	builder.Grow(len(haystack))
	idx := 0
	for {
		at := strings.Index(lower[idx:], lowerFind)
		if at < 0 {
			builder.WriteString(haystack[idx:])
			break
		}
		abs := idx + at
		builder.WriteString(haystack[idx:abs])
		builder.WriteString(replace)
		idx = abs + len(lowerFind)
	}
	return builder.String()
}

// ExportRemoteSnapshot writes the provider-neutral encrypted repository
// layout. It deliberately excludes the local manifest and all backup files.
func (s *Store) ExportRemoteSnapshot(destination string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if err := s.pruneStaleAttachmentsLocked(); err != nil {
		return err
	}
	if strings.TrimSpace(destination) == "" {
		return errors.New("remote snapshot destination is required")
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return fmt.Errorf("create remote snapshot destination: %w", err)
	}
	if err := rejectLiveVaultDestination(s.root, destination); err != nil {
		return err
	}
	if err := copyFileIfChangedFast(
		filepath.Join(s.root, configFilename),
		filepath.Join(destination, configFilename),
	); err != nil {
		return fmt.Errorf("stage remote vault configuration: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(destination, syncDirectory), 0o700); err != nil {
		return fmt.Errorf("create remote sync metadata folder: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(destination, "objects"), 0o700); err != nil {
		return fmt.Errorf("create remote objects folder: %w", err)
	}

	items := slices.Clone(s.manifest.Notes)
	sortSummaries(items)
	existingObjects := s.readExistingRemoteInventoryLocked(destination)
	inventory := remoteSyncManifest{
		FormatVersion: FormatVersion,
		VaultID:       s.vaultID,
		Objects:       make([]remoteSyncObject, 0, len(items)+len(s.manifest.DeletedNotes)),
	}
	expectedObjects := make(map[string]struct{}, len(items))
	manifestChanged := false
	for _, item := range items {
		source := s.notePathLocked(item.ID)
		target := filepath.Join(destination, "objects", item.ID[:2], item.ID+".enc")
		if existing, found := existingObjects[item.ID]; found &&
			item.CiphertextHash != "" &&
			existing.CiphertextHash == item.CiphertextHash &&
			existing.Revision == item.Revision &&
			existing.ModifiedAt == item.ModifiedAt &&
			existing.Summary != nil &&
			!existing.Deleted &&
			sameRegularFileSize(source, target) {
			expectedObjects[filepath.Clean(target)] = struct{}{}
			existing.Summary = cloneNoteSummary(item)
			inventory.Objects = append(inventory.Objects, existing)
			continue
		}
		data, err := os.ReadFile(source)
		if err != nil {
			return fmt.Errorf("read encrypted note %s for remote snapshot: %w", item.ID, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return fmt.Errorf("create remote note object folder: %w", err)
		}
		if err := writeBytesIfChangedFast(target, data); err != nil {
			return fmt.Errorf("stage encrypted remote note %s: %w", item.ID, err)
		}
		expectedObjects[filepath.Clean(target)] = struct{}{}
		hash := sha256.Sum256(data)
		hashText := hex.EncodeToString(hash[:])
		if item.CiphertextHash != hashText {
			if index, found := s.findNoteLocked(item.ID); found {
				s.manifest.Notes[index].CiphertextHash = hashText
				manifestChanged = true
			}
		}
		inventory.Objects = append(inventory.Objects, remoteSyncObject{
			ID:             item.ID,
			CiphertextHash: hashText,
			Revision:       item.Revision,
			ModifiedAt:     item.ModifiedAt,
			Summary:        cloneNoteSummary(item),
		})
	}
	if manifestChanged {
		if err := s.saveManifestLocked(); err != nil {
			return fmt.Errorf("save local ciphertext hashes: %w", err)
		}
	}
	for _, deleted := range s.manifest.DeletedNotes {
		inventory.Objects = append(inventory.Objects, remoteSyncObject{
			ID:         deleted.ID,
			Revision:   deleted.Revision,
			ModifiedAt: deleted.ModifiedAt,
			Deleted:    true,
		})
	}
	slices.SortFunc(inventory.Objects, func(left, right remoteSyncObject) int {
		return strings.Compare(left.ID, right.ID)
	})
	if err := removeUnexpectedSnapshotObjects(
		filepath.Join(destination, "objects"),
		expectedObjects,
	); err != nil {
		return err
	}
	if err := s.exportAttachmentsLocked(destination); err != nil {
		return err
	}
	inventoryPlaintext, err := json.Marshal(inventory)
	if err != nil {
		return fmt.Errorf("encode remote sync inventory: %w", err)
	}
	inventoryPath := filepath.Join(destination, syncDirectory, syncManifestFile)
	if err := s.writeRemoteEnvelopeIfChangedLocked(
		inventoryPath,
		"sync-manifest",
		"sync-manifest",
		inventoryPlaintext,
	); err != nil {
		return fmt.Errorf("encrypt remote sync inventory: %w", err)
	}
	if err := os.Remove(inventoryPath + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove remote sync inventory backup: %w", err)
	}

	folderManifest := remoteFolderManifest{
		FormatVersion: FormatVersion,
		VaultID:       s.vaultID,
		Folders:       slices.Clone(s.manifest.Folders),
		Deleted:       slices.Clone(s.manifest.DeletedFolders),
	}
	sortFolders(folderManifest.Folders)
	sortTombstones(folderManifest.Deleted)
	folderPlaintext, err := json.Marshal(folderManifest)
	if err != nil {
		return fmt.Errorf("encode remote folders: %w", err)
	}
	foldersPath := filepath.Join(destination, syncDirectory, syncFoldersFile)
	if err := s.writeRemoteEnvelopeIfChangedLocked(
		foldersPath,
		"sync-folders",
		"sync-folders",
		folderPlaintext,
	); err != nil {
		return fmt.Errorf("encrypt remote folders: %w", err)
	}
	if err := os.Remove(foldersPath + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove remote folder metadata backup: %w", err)
	}
	if err := removeUnexpectedSyncFiles(filepath.Join(destination, syncDirectory)); err != nil {
		return err
	}
	return nil
}

// ValidateRemoteSnapshot authenticates every encrypted remote object and
// reports whether it represents the exact current local encrypted snapshot.
func (s *Store) ValidateRemoteSnapshot(source string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return false, err
	}
	remote, err := s.readRemoteSnapshotLocked(source, true, false)
	if err != nil {
		return false, err
	}
	localFolders := slices.Clone(s.manifest.Folders)
	sortFolders(localFolders)
	localDeletedFolders := slices.Clone(s.manifest.DeletedFolders)
	sortTombstones(localDeletedFolders)
	localDeletedNotes := slices.Clone(s.manifest.DeletedNotes)
	sortTombstones(localDeletedNotes)
	matches := slices.Equal(remote.Manifest.Folders, localFolders) &&
		slices.Equal(remote.Manifest.DeletedFolders, localDeletedFolders) &&
		slices.Equal(remote.Manifest.DeletedNotes, localDeletedNotes) &&
		len(remote.Objects) == len(s.manifest.Notes)+len(localDeletedNotes)
	if matches {
		for _, local := range s.manifest.Notes {
			remoteObject, exists := remote.Objects[local.ID]
			if !exists || remoteObject.Revision != local.Revision {
				matches = false
				break
			}
			data, err := os.ReadFile(s.notePathLocked(local.ID))
			if err != nil {
				return false, fmt.Errorf("read local encrypted note %s: %w", local.ID, err)
			}
			hash := sha256.Sum256(data)
			if hex.EncodeToString(hash[:]) != remoteObject.CiphertextHash {
				matches = false
				break
			}
		}
		for _, deleted := range localDeletedNotes {
			remoteObject, exists := remote.Objects[deleted.ID]
			if !exists || !remoteObject.Deleted ||
				remoteObject.Revision != deleted.Revision ||
				remoteObject.ModifiedAt != deleted.ModifiedAt {
				matches = false
				break
			}
		}
	}
	return matches, nil
}

func (s *Store) readExistingRemoteInventoryLocked(
	root string,
) map[string]remoteSyncObject {
	plaintext, err := s.readEnvelopeFileLocked(
		filepath.Join(root, syncDirectory, syncManifestFile),
		"sync-manifest",
		"sync-manifest",
	)
	if err != nil {
		return nil
	}
	var inventory remoteSyncManifest
	if json.Unmarshal(plaintext, &inventory) != nil ||
		inventory.FormatVersion != FormatVersion ||
		inventory.VaultID != s.vaultID {
		return nil
	}
	result := make(map[string]remoteSyncObject, len(inventory.Objects))
	for _, item := range inventory.Objects {
		if validID(item.ID) {
			result[item.ID] = item
		}
	}
	return result
}

// MergeRemoteSnapshot pulls newer encrypted notes and folders from an
// authenticated remote snapshot into the local vault. Revisions take
// precedence over timestamps so clock skew cannot overwrite newer content.
func (s *Store) MergeRemoteSnapshot(source string) (MergeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return MergeResult{}, err
	}
	if strings.TrimSpace(source) == "" {
		return MergeResult{}, errors.New("remote snapshot source is required")
	}
	remote, err := s.readRemoteSnapshotLocked(source, false, false)
	if err != nil {
		return MergeResult{}, err
	}
	result := MergeResult{UpToDate: true}
	mergedNotes := make([]NoteSummary, 0, len(s.manifest.Notes)+len(remote.Manifest.Notes))
	mergedNotes = append(mergedNotes, s.manifest.Notes...)
	mergedDeletedNotes := slices.Clone(s.manifest.DeletedNotes)

	for _, deleted := range remote.Manifest.DeletedNotes {
		found := false
		var localModified int64
		var localRevision uint64
		for index, local := range mergedNotes {
			if local.ID == deleted.ID {
				found = true
				localModified = local.ModifiedAt
				localRevision = local.Revision
				if versionIsNewer(
					deleted.Revision,
					deleted.ModifiedAt,
					local.Revision,
					local.ModifiedAt,
				) {
					mergedNotes = append(mergedNotes[:index], mergedNotes[index+1:]...)
					removeFileAndBackup(s.notePathLocked(deleted.ID))
					_ = os.RemoveAll(filepath.Join(s.root, "attachments", deleted.ID))
					result.DeletedNotes++
					result.UpToDate = false
				}
				break
			}
		}
		if !found || versionIsNewer(
			deleted.Revision,
			deleted.ModifiedAt,
			localRevision,
			localModified,
		) {
			mergedDeletedNotes = upsertTombstone(mergedDeletedNotes, deleted)
		}
	}

	for _, remoteNote := range remote.Manifest.Notes {
		if deleted, found := findTombstone(mergedDeletedNotes, remoteNote.ID); found &&
			!versionIsNewer(
				remoteNote.Revision,
				remoteNote.ModifiedAt,
				deleted.Revision,
				deleted.ModifiedAt,
			) {
			continue
		}
		mergedDeletedNotes = removeTombstone(mergedDeletedNotes, remoteNote.ID)
		localIndex := -1
		for index, local := range mergedNotes {
			if local.ID == remoteNote.ID {
				localIndex = index
				break
			}
		}
		if localIndex < 0 {
			if err := copyRemoteNoteObject(source, s.root, remoteNote.ID); err != nil {
				return MergeResult{}, err
			}
			if err := replaceRemoteAttachments(source, s.root, remoteNote.ID); err != nil {
				return MergeResult{}, err
			}
			mergedNotes = append(mergedNotes, remoteNote)
			result.PulledNotes++
			result.UpToDate = false
			continue
		}
		local := mergedNotes[localIndex]
		if remoteNote.Revision == local.Revision &&
			remoteNote.CiphertextHash != "" &&
			local.CiphertextHash != "" &&
			remoteNote.CiphertextHash != local.CiphertextHash {
			localNote, err := s.readNoteFromSummaryAtLocked(s.root, local)
			if err != nil {
				return MergeResult{}, err
			}
			remote, err := s.readNoteFromSummaryAtLocked(source, remoteNote)
			if err != nil {
				return MergeResult{}, err
			}
			result.Conflicts = append(result.Conflicts, MergeConflict{
				LocalNoteID:   local.ID,
				RemoteNoteID:  remoteNote.ID,
				Title:         local.Title,
				Message:       "Local and remote edits conflicted. Resolve the final version before syncing.",
				LocalContent:  derivedMarkdownContent(localNote.Content),
				RemoteContent: derivedMarkdownContent(remote.Content),
			})
			result.UpToDate = false
		} else if versionIsNewer(
			remoteNote.Revision,
			remoteNote.ModifiedAt,
			local.Revision,
			local.ModifiedAt,
		) {
			if err := copyRemoteNoteObject(source, s.root, remoteNote.ID); err != nil {
				return MergeResult{}, err
			}
			if err := replaceRemoteAttachments(source, s.root, remoteNote.ID); err != nil {
				return MergeResult{}, err
			}
			mergedNotes[localIndex] = remoteNote
			result.UpdatedNotes++
			result.UpToDate = false
		} else if !versionIsNewer(
			local.Revision,
			local.ModifiedAt,
			remoteNote.Revision,
			remoteNote.ModifiedAt,
		) {
			// Equal note versions must also converge their attachment files.
			// This repairs interrupted or older syncs that copied the note
			// reference without copying its encrypted attachment.
			if err := replaceRemoteAttachments(source, s.root, remoteNote.ID); err != nil {
				return MergeResult{}, err
			}
		}
	}
	sortSummaries(mergedNotes)

	mergedFolders := slices.Clone(s.manifest.Folders)
	mergedDeletedFolders := slices.Clone(s.manifest.DeletedFolders)
	for _, remoteFolder := range remote.Manifest.Folders {
		if deleted, found := findTombstone(mergedDeletedFolders, remoteFolder.ID); found {
			updated, _ := time.Parse(time.RFC3339Nano, remoteFolder.UpdatedAt)
			if deleted.ModifiedAt >= updated.Unix() {
				continue
			}
			mergedDeletedFolders = removeTombstone(mergedDeletedFolders, remoteFolder.ID)
		}
		found := false
		for index, local := range mergedFolders {
			if local.ID != remoteFolder.ID {
				continue
			}
			found = true
			if remoteFolder.UpdatedAt > local.UpdatedAt {
				mergedFolders[index] = remoteFolder
				result.PulledFolders++
				result.UpToDate = false
			}
			break
		}
		if !found {
			mergedFolders = append(mergedFolders, remoteFolder)
			result.PulledFolders++
			result.UpToDate = false
		}
	}
	for _, deleted := range remote.Manifest.DeletedFolders {
		found := false
		acceptTombstone := true
		for index, local := range mergedFolders {
			if local.ID != deleted.ID {
				continue
			}
			found = true
			updated, _ := time.Parse(time.RFC3339Nano, local.UpdatedAt)
			if deleted.ModifiedAt <= updated.Unix() || noteReferencesFolder(mergedNotes, deleted.ID) {
				acceptTombstone = false
				break
			}
			mergedFolders = append(mergedFolders[:index], mergedFolders[index+1:]...)
			result.DeletedFolders++
			result.UpToDate = false
			break
		}
		if acceptTombstone {
			before, existed := findTombstone(mergedDeletedFolders, deleted.ID)
			mergedDeletedFolders = upsertTombstone(mergedDeletedFolders, deleted)
			if !found && (!existed || deleted.ModifiedAt > before.ModifiedAt) {
				result.UpToDate = false
			}
		}
	}
	sortFolders(mergedFolders)

	if result.UpToDate {
		return result, nil
	}
	s.manifest.Folders = mergedFolders
	s.manifest.Notes = mergedNotes
	s.manifest.DeletedNotes = mergedDeletedNotes
	s.manifest.DeletedFolders = mergedDeletedFolders
	if err := s.saveManifestLocked(); err != nil {
		return MergeResult{}, fmt.Errorf("save merged manifest: %w", err)
	}
	return result, nil
}

func copyRemoteNoteObject(source, localRoot, id string) error {
	sourcePath := filepath.Join(source, "objects", id[:2], id+".enc")
	targetPath := filepath.Join(localRoot, "objects", id[:2], id+".enc")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
		return fmt.Errorf("create local note object folder: %w", err)
	}
	if err := copyFileAtomic(sourcePath, targetPath); err != nil {
		return fmt.Errorf("stage pulled encrypted note %s: %w", id, err)
	}
	return nil
}

func replaceRemoteAttachments(source, localRoot, noteID string) error {
	sharedSource := filepath.Join(source, "attachments", sharedAttachmentFolder)
	if _, err := os.Stat(sharedSource); err == nil {
		if err := copyAttachmentDirectory(sharedSource, filepath.Join(localRoot, "attachments", sharedAttachmentFolder)); err != nil {
			return fmt.Errorf("copy shared attachments: %w", err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect remote shared attachments: %w", err)
	}
	target := filepath.Join(localRoot, "attachments", noteID)
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("replace local attachments: %w", err)
	}
	sourceDir := filepath.Join(source, "attachments", noteID)
	if _, err := os.Stat(sourceDir); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect remote attachments: %w", err)
	}
	return copyAttachmentDirectory(sourceDir, target)
}

func copyAttachmentDirectory(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o700)
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("attachment folder contains a non-regular file")
		}
		return copyFileAtomic(path, destination)
	})
}

func (s *Store) exportAttachmentsLocked(destination string) error {
	sourceRoot := filepath.Join(s.root, "attachments")
	targetRoot := filepath.Join(destination, "attachments")
	expected := make(map[string]struct{})
	if _, err := os.Stat(sourceRoot); errors.Is(err, os.ErrNotExist) {
		return os.RemoveAll(targetRoot)
	} else if err != nil {
		return fmt.Errorf("inspect local attachments: %w", err)
	}
	if err := os.MkdirAll(targetRoot, 0o700); err != nil {
		return fmt.Errorf("create remote attachments folder: %w", err)
	}
	err := filepath.WalkDir(sourceRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		relative, err := filepath.Rel(sourceRoot, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(relative), "/")
		if len(parts) == 2 && strings.HasSuffix(parts[1], ".enc.bak") {
			return nil
		}
		if len(parts) != 2 || (parts[0] != sharedAttachmentFolder && !validID(parts[0])) ||
			!strings.HasSuffix(parts[1], ".enc") ||
			!validID(strings.TrimSuffix(parts[1], ".enc")) {
			return errors.New("local attachments folder contains an invalid path")
		}
		if parts[0] != sharedAttachmentFolder {
			if _, found := s.findNoteLocked(parts[0]); !found {
				return errors.New("local attachment belongs to a missing note")
			}
		}
		target := filepath.Join(targetRoot, relative)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := copyFileIfChangedFast(path, target); err != nil {
			return fmt.Errorf("stage encrypted attachment: %w", err)
		}
		expected[filepath.Clean(target)] = struct{}{}
		return nil
	})
	if err != nil {
		return err
	}
	return removeUnexpectedSnapshotObjects(targetRoot, expected)
}

func (s *Store) validateRemoteAttachmentsLocked(
	source string,
	remoteNotes map[string]remoteSyncObject,
) error {
	root := filepath.Join(source, "attachments")
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect remote attachments: %w", err)
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(relative), "/")
		if len(parts) != 2 || (parts[0] != sharedAttachmentFolder && !validID(parts[0])) ||
			!strings.HasSuffix(parts[1], ".enc") {
			return errors.New("remote attachments folder contains an invalid path")
		}
		id := strings.TrimSuffix(parts[1], ".enc")
		objectID := sharedAttachmentAAD(id)
		if parts[0] != sharedAttachmentFolder {
			note, found := remoteNotes[parts[0]]
			if !found || note.Deleted || !validID(id) {
				return errors.New("remote attachment belongs to a missing note")
			}
			objectID = parts[0] + ":" + id
		} else if !validID(id) {
			return errors.New("remote attachments folder contains an invalid path")
		}
		data, err := s.readEnvelopeFileLocked(path, "attachment", objectID)
		if err != nil {
			return fmt.Errorf("authenticate remote attachment: %w", err)
		}
		if len(data) == 0 || len(data) > maxAttachmentBytes ||
			len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
			return errors.New("remote attachment contains invalid WebP data")
		}
		return nil
	})
}

func (s *Store) readRemoteSnapshotLocked(
	source string,
	verifyAllObjects bool,
	validateDerivedMetadata bool,
) (authenticatedRemoteSnapshot, error) {
	var remoteConfig vaultConfig
	if err := readJSONFile(
		filepath.Join(source, configFilename),
		1024*1024,
		&remoteConfig,
	); err != nil {
		return authenticatedRemoteSnapshot{}, fmt.Errorf("read remote vault configuration: %w", err)
	}
	if err := validateConfig(remoteConfig); err != nil {
		return authenticatedRemoteSnapshot{}, fmt.Errorf("validate remote vault configuration: %w", err)
	}
	if remoteConfig.VaultID != s.vaultID {
		return authenticatedRemoteSnapshot{}, errors.New("remote repository belongs to another vault")
	}

	inventoryPlaintext, err := s.readEnvelopeFileLocked(
		filepath.Join(source, syncDirectory, syncManifestFile),
		"sync-manifest",
		"sync-manifest",
	)
	if err != nil {
		return authenticatedRemoteSnapshot{}, fmt.Errorf("authenticate remote sync inventory: %w", err)
	}
	var inventory remoteSyncManifest
	if err := json.Unmarshal(inventoryPlaintext, &inventory); err != nil {
		return authenticatedRemoteSnapshot{}, errors.New("remote sync inventory is damaged")
	}
	if inventory.FormatVersion != FormatVersion || inventory.VaultID != s.vaultID {
		return authenticatedRemoteSnapshot{}, errors.New("remote sync inventory belongs to another vault or format")
	}

	folderPlaintext, err := s.readEnvelopeFileLocked(
		filepath.Join(source, syncDirectory, syncFoldersFile),
		"sync-folders",
		"sync-folders",
	)
	if err != nil {
		return authenticatedRemoteSnapshot{}, fmt.Errorf("authenticate remote folder metadata: %w", err)
	}
	var folderManifest remoteFolderManifest
	if err := json.Unmarshal(folderPlaintext, &folderManifest); err != nil {
		return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata is damaged")
	}
	if folderManifest.FormatVersion != FormatVersion || folderManifest.VaultID != s.vaultID {
		return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata belongs to another vault or format")
	}
	remoteFolders := slices.Clone(folderManifest.Folders)
	sortFolders(remoteFolders)
	seenFolders := make(map[string]struct{}, len(remoteFolders))
	seenFolderNames := make(map[string]struct{}, len(remoteFolders))
	for _, folder := range remoteFolders {
		if !validID(folder.ID) {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains an invalid folder ID")
		}
		normalizedName, err := normalizeFolderName(folder.Name)
		if err != nil || normalizedName != folder.Name {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains an invalid folder name")
		}
		if _, err := time.Parse(time.RFC3339Nano, folder.CreatedAt); err != nil {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains an invalid creation time")
		}
		if _, err := time.Parse(time.RFC3339Nano, folder.UpdatedAt); err != nil {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains an invalid update time")
		}
		if _, duplicate := seenFolders[folder.ID]; duplicate {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains a duplicate folder")
		}
		nameKey := strings.ToLower(folder.Name)
		if _, duplicate := seenFolderNames[nameKey]; duplicate {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains duplicate folder names")
		}
		seenFolders[folder.ID] = struct{}{}
		seenFolderNames[nameKey] = struct{}{}
	}
	remoteDeletedFolders := slices.Clone(folderManifest.Deleted)
	sortTombstones(remoteDeletedFolders)
	for _, deleted := range remoteDeletedFolders {
		if !validID(deleted.ID) || deleted.ModifiedAt < 0 {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains an invalid tombstone")
		}
		if _, live := seenFolders[deleted.ID]; live {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder is both live and deleted")
		}
		if _, duplicate := seenFolders[deleted.ID]; duplicate {
			return authenticatedRemoteSnapshot{}, errors.New("remote folder metadata contains a duplicate tombstone")
		}
		seenFolders[deleted.ID] = struct{}{}
	}

	seen := make(map[string]struct{}, len(inventory.Objects))
	remoteNotes := make(map[string]remoteSyncObject, len(inventory.Objects))
	noteSummaries := make([]NoteSummary, 0, len(inventory.Objects))
	liveObjectCount := 0
	for _, item := range inventory.Objects {
		if !validID(item.ID) || item.Revision == 0 || item.ModifiedAt < 0 {
			return authenticatedRemoteSnapshot{}, errors.New("remote sync inventory contains an invalid object")
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return authenticatedRemoteSnapshot{}, errors.New("remote sync inventory contains a duplicate object")
		}
		seen[item.ID] = struct{}{}
		if item.Deleted {
			if item.CiphertextHash != "" {
				return authenticatedRemoteSnapshot{}, errors.New("remote deleted object unexpectedly contains a hash")
			}
			remoteNotes[item.ID] = item
			continue
		}
		liveObjectCount++
		if len(item.CiphertextHash) != sha256.Size*2 {
			return authenticatedRemoteSnapshot{}, errors.New("remote sync inventory contains an invalid object hash")
		}
		if _, err := hex.DecodeString(item.CiphertextHash); err != nil {
			return authenticatedRemoteSnapshot{}, errors.New("remote sync inventory contains an invalid object hash")
		}
		if !verifyAllObjects {
			localIndex, found := s.findNoteLocked(item.ID)
			if found {
				local := s.manifest.Notes[localIndex]
				if local.CiphertextHash == item.CiphertextHash &&
					local.Revision == item.Revision &&
					local.ModifiedAt == item.ModifiedAt {
					remoteNotes[item.ID] = item
					noteSummaries = append(noteSummaries, local)
					continue
				}
			}
		}
		path := filepath.Join(source, "objects", item.ID[:2], item.ID+".enc")
		data, err := os.ReadFile(path)
		if err != nil {
			return authenticatedRemoteSnapshot{}, fmt.Errorf("read remote encrypted note %s: %w", item.ID, err)
		}
		hash := sha256.Sum256(data)
		if hex.EncodeToString(hash[:]) != item.CiphertextHash {
			return authenticatedRemoteSnapshot{}, fmt.Errorf("remote encrypted note %s does not match its inventory hash", item.ID)
		}
		var summary NoteSummary
		var note Note
		if item.Summary != nil {
			summary = *cloneNoteSummary(*item.Summary)
			if summary.ID != item.ID {
				return authenticatedRemoteSnapshot{}, fmt.Errorf("remote encrypted note %s metadata is inconsistent", item.ID)
			}
			note, err = s.readNoteFromSummaryAtLocked(source, summary)
		} else {
			note, err = s.readLegacyNoteAtLocked(source, item.ID)
			summary = summaryFromNote(note)
		}
		if err != nil {
			return authenticatedRemoteSnapshot{}, fmt.Errorf("authenticate remote encrypted note %s: %w", item.ID, err)
		}
		if err := validateRemoteNote(note, item, remoteFolders, validateDerivedMetadata); err != nil {
			return authenticatedRemoteSnapshot{}, err
		}
		if !validateDerivedMetadata {
			derived := summaryFromNote(note)
			summary.Tags = derived.Tags
			summary.AttachmentIDs = derived.AttachmentIDs
			summary.OutgoingLinks = derived.OutgoingLinks
		}
		remoteNotes[item.ID] = item
		summary.CiphertextHash = item.CiphertextHash
		noteSummaries = append(noteSummaries, summary)
	}
	objectsRoot := filepath.Join(source, "objects")
	if _, err := os.Stat(objectsRoot); errors.Is(err, os.ErrNotExist) && liveObjectCount == 0 {
		// Git does not track the empty objects directory for a vault with no notes.
	} else if err != nil {
		return authenticatedRemoteSnapshot{}, fmt.Errorf("inspect remote objects folder: %w", err)
	} else {
		if err := filepath.WalkDir(objectsRoot, func(
			path string,
			entry os.DirEntry,
			walkErr error,
		) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			relative, err := filepath.Rel(objectsRoot, path)
			if err != nil {
				return err
			}
			parts := strings.Split(filepath.ToSlash(relative), "/")
			if len(parts) != 2 || !strings.HasSuffix(parts[1], ".enc") {
				return errors.New("remote objects folder contains an unknown file")
			}
			id := strings.TrimSuffix(parts[1], ".enc")
			if !validID(id) || parts[0] != id[:2] {
				return errors.New("remote objects folder contains an invalid path")
			}
			item, expected := remoteNotes[id]
			if !expected || item.Deleted {
				return errors.New("remote objects folder contains an object absent from its inventory")
			}
			return nil
		}); err != nil {
			return authenticatedRemoteSnapshot{}, err
		}
	}
	if err := s.validateRemoteAttachmentsLocked(source, remoteNotes); err != nil {
		return authenticatedRemoteSnapshot{}, err
	}
	sortSummaries(noteSummaries)
	return authenticatedRemoteSnapshot{
		Config: remoteConfig,
		Manifest: manifest{
			FormatVersion:  FormatVersion,
			VaultID:        s.vaultID,
			Folders:        remoteFolders,
			Notes:          noteSummaries,
			DeletedFolders: remoteDeletedFolders,
			DeletedNotes:   tombstonesFromRemoteObjects(remoteNotes),
		},
		Objects: remoteNotes,
	}, nil
}

// RestoreRemoteSnapshot reconstructs a complete local vault from the
// provider-neutral encrypted repository layout. Remote data is authenticated
// before any final vault folder becomes visible.
func (s *Store) RestoreRemoteSnapshot(
	source, parent, name, passphrase string,
) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.key) != 0 {
		return Session{}, errors.New("lock the current vault before restoring another vault")
	}
	parent, err := prepareRoot(parent)
	if err != nil {
		return Session{}, err
	}
	name, err = normalizeVaultName(name)
	if err != nil {
		return Session{}, err
	}
	finalRoot := filepath.Join(parent, name)
	if err := ensureNewVaultPathAvailable(finalRoot); err != nil {
		return Session{}, err
	}

	var config vaultConfig
	if err := readJSONFile(
		filepath.Join(source, configFilename),
		1024*1024,
		&config,
	); err != nil {
		return Session{}, fmt.Errorf("read downloaded vault configuration: %w", err)
	}
	if err := validateConfig(config); err != nil {
		return Session{}, fmt.Errorf("validate downloaded vault configuration: %w", err)
	}
	key, err := unwrapMasterKey(config, passphrase)
	if err != nil {
		return Session{}, errors.New("unable to restore vault: the vault secret is incorrect or downloaded key data is damaged")
	}
	keyOwnedByStore := false
	defer func() {
		if !keyOwnedByStore {
			secure.Zero(key)
		}
	}()
	validator := &Store{vaultID: config.VaultID, key: key}
	remote, err := validator.readRemoteSnapshotLocked(source, true, true)
	if err != nil {
		return Session{}, fmt.Errorf("validate downloaded encrypted vault: %w", err)
	}

	stagingRoot, err := os.MkdirTemp(parent, ".cipherleaf-restore-*")
	if err != nil {
		return Session{}, fmt.Errorf("create restored vault staging folder: %w", err)
	}
	defer os.RemoveAll(stagingRoot)
	if err := os.Chmod(stagingRoot, 0o700); err != nil {
		return Session{}, fmt.Errorf("protect restored vault staging folder: %w", err)
	}
	configData, err := os.ReadFile(filepath.Join(source, configFilename))
	if err != nil {
		return Session{}, fmt.Errorf("read downloaded vault configuration bytes: %w", err)
	}
	for _, target := range []string{
		filepath.Join(stagingRoot, configFilename),
		filepath.Join(stagingRoot, configFilename+".bak"),
	} {
		if err := writeBytesAtomic(target, configData); err != nil {
			return Session{}, fmt.Errorf("stage restored vault configuration: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Join(stagingRoot, "objects"), 0o700); err != nil {
		return Session{}, fmt.Errorf("create restored vault objects folder: %w", err)
	}
	for _, item := range remote.Manifest.Notes {
		sourcePath := filepath.Join(source, "objects", item.ID[:2], item.ID+".enc")
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			return Session{}, fmt.Errorf("read downloaded encrypted note %s: %w", item.ID, err)
		}
		directory := filepath.Join(stagingRoot, "objects", item.ID[:2])
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return Session{}, fmt.Errorf("create restored note object folder: %w", err)
		}
		for _, target := range []string{
			filepath.Join(directory, item.ID+".enc"),
			filepath.Join(directory, item.ID+".enc.bak"),
		} {
			if err := writeBytesAtomic(target, data); err != nil {
				return Session{}, fmt.Errorf("stage restored encrypted note %s: %w", item.ID, err)
			}
		}
	}
	if sourceAttachments := filepath.Join(source, "attachments"); directoryExists(sourceAttachments) {
		if err := copyAttachmentDirectory(sourceAttachments, filepath.Join(stagingRoot, "attachments")); err != nil {
			return Session{}, fmt.Errorf("restore encrypted attachments: %w", err)
		}
	}
	validator.root = stagingRoot
	validator.manifest = remote.Manifest
	if err := validator.saveManifestLocked(); err != nil {
		return Session{}, fmt.Errorf("create restored local manifest: %w", err)
	}
	if err := ensureNewVaultPathAvailable(finalRoot); err != nil {
		return Session{}, err
	}
	if err := os.Rename(stagingRoot, finalRoot); err != nil {
		return Session{}, fmt.Errorf("activate restored vault folder: %w", err)
	}

	s.root = finalRoot
	s.vaultID = remote.Config.VaultID
	s.key = key
	s.secret = []byte(passphrase)
	s.manifest = remote.Manifest
	keyOwnedByStore = true
	validator.key = nil
	return s.sessionLocked(), nil
}

func (s *Store) sessionLocked() Session {
	return Session{
		Locked: false, Path: s.root, VaultID: s.vaultID, NoteCount: len(s.manifest.Notes),
	}
}

func (s *Store) requireUnlocked() error {
	if len(s.key) != secure.KeySize || s.root == "" {
		return ErrLocked
	}
	return nil
}

func (s *Store) clearLocked() {
	secure.Zero(s.key)
	secure.Zero(s.secret)
	s.key = nil
	s.secret = nil
	s.root = ""
	s.vaultID = ""
	s.manifest = manifest{}
}

// UnlockedSecret returns a copy of the secret currently holding the vault
// open together with a boolean indicating whether the store is unlocked. The
// caller is responsible for zeroing the returned slice when finished.
func (s *Store) UnlockedSecret() ([]byte, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.key) == 0 || len(s.secret) == 0 {
		return nil, false
	}
	clone := make([]byte, len(s.secret))
	copy(clone, s.secret)
	return clone, true
}

func (s *Store) findNoteLocked(id string) (int, bool) {
	for index, item := range s.manifest.Notes {
		if item.ID == id {
			return index, true
		}
	}
	return -1, false
}

func (s *Store) findFolderLocked(id string) (int, bool) {
	for index, item := range s.manifest.Folders {
		if item.ID == id {
			return index, true
		}
	}
	return -1, false
}

func (s *Store) folderByIDLocked(id string) (Folder, bool) {
	index, found := s.findFolderLocked(id)
	if !found {
		return Folder{}, false
	}
	return s.manifest.Folders[index], true
}

func (s *Store) folderExistsLocked(id string) bool {
	if id == "" {
		return true
	}
	_, found := s.findFolderLocked(id)
	return found
}

func (s *Store) folderNameExistsLocked(name, excludingID string) bool {
	for _, folder := range s.manifest.Folders {
		if folder.ID != excludingID && strings.EqualFold(folder.Name, name) {
			return true
		}
	}
	return false
}

func (s *Store) notePathLocked(id string) string {
	return filepath.Join(s.root, "objects", id[:2], id+".enc")
}

func (s *Store) attachmentPathLocked(noteID, id string) string {
	return filepath.Join(s.root, "attachments", noteID, id+".enc")
}

func (s *Store) sharedAttachmentPathLocked(id string) string {
	return filepath.Join(s.root, "attachments", sharedAttachmentFolder, id+".enc")
}

func sharedAttachmentAAD(id string) string {
	return sharedAttachmentFolder + ":" + id
}

func (s *Store) writeNoteLocked(note Note) (string, error) {
	plaintext := []byte(note.Content)
	path := s.notePathLocked(note.ID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create note object folder: %w", err)
	}
	payload, compression, err := compressNotePayload(plaintext)
	if err != nil {
		return "", err
	}
	if err := s.writeEnvelopePayloadLocked(
		path, "note-content", note.ID, payload, compression,
	); err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("hash encrypted note: %w", err)
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

func (s *Store) readNoteLocked(id string) (Note, error) {
	index, found := s.findNoteLocked(id)
	if !found {
		return Note{}, errors.New("note not found")
	}
	return s.readNoteFromSummaryAtLocked(s.root, s.manifest.Notes[index])
}

func (s *Store) readNoteFromSummaryAtLocked(root string, summary NoteSummary) (Note, error) {
	if !validID(summary.ID) {
		return Note{}, errors.New("invalid note ID")
	}
	content, legacy, err := s.readNoteContentAtLocked(root, summary.ID)
	if err != nil {
		return Note{}, err
	}
	if legacy != nil && summary.Title == "" {
		return *legacy, nil
	}
	return noteFromSummary(summary, content), nil
}

func (s *Store) readLegacyNoteAtLocked(root, id string) (Note, error) {
	content, legacy, err := s.readNoteContentAtLocked(root, id)
	if err != nil {
		return Note{}, err
	}
	if legacy == nil {
		return Note{}, errors.New("encrypted note metadata is stored outside the note object")
	}
	legacy.Content = content
	return *legacy, nil
}

func (s *Store) readNoteContentAtLocked(root, id string) (string, *Note, error) {
	if !validID(id) {
		return "", nil, errors.New("invalid note ID")
	}
	path := filepath.Join(root, "objects", id[:2], id+".enc")
	var plaintext []byte
	var err error
	legacyEnvelope := false
	if root == s.root {
		plaintext, err = s.readEnvelopeLocked(path, "note-content", id)
	} else {
		plaintext, err = s.readEnvelopeFileLocked(path, "note-content", id)
	}
	if err != nil {
		legacyEnvelope = true
		if root == s.root {
			plaintext, err = s.readEnvelopeLocked(path, "note", id)
		} else {
			plaintext, err = s.readEnvelopeFileLocked(path, "note", id)
		}
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil, ErrEncryptedFileAbsent
		}
		return "", nil, fmt.Errorf("decrypt note %s: %w", id, err)
	}
	var note Note
	if legacyEnvelope {
		if err := json.Unmarshal(plaintext, &note); err == nil && note.ID == id && note.Title != "" {
			return note.Content, &note, nil
		}
		return "", nil, fmt.Errorf("decode note %s: legacy metadata is invalid", id)
	}
	if !utf8.Valid(plaintext) {
		return "", nil, fmt.Errorf("decode note %s: content is not valid UTF-8", id)
	}
	return string(plaintext), nil, nil
}

func (s *Store) saveManifestLocked() error {
	plaintext, err := json.Marshal(s.manifest)
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	return s.writeEnvelopeLocked(filepath.Join(s.root, manifestFilename), "manifest", "manifest", plaintext)
}

func (s *Store) loadManifestLocked() error {
	result, err := s.readManifestAtLocked(s.root)
	if err != nil {
		return err
	}
	s.manifest = result
	return nil
}

func (s *Store) readManifestAtLocked(root string) (manifest, error) {
	path := filepath.Join(root, manifestFilename)
	var plaintext []byte
	var err error
	if root == s.root {
		plaintext, err = s.readEnvelopeLocked(path, "manifest", "manifest")
	} else {
		plaintext, err = s.readEnvelopeFileLocked(path, "manifest", "manifest")
	}
	if err != nil {
		return manifest{}, err
	}
	var result manifest
	if err := json.Unmarshal(plaintext, &result); err != nil {
		return manifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	if result.FormatVersion != FormatVersion || result.VaultID != s.vaultID {
		return manifest{}, errors.New("manifest belongs to another vault or format version")
	}
	for index, folder := range result.Folders {
		if !validID(folder.ID) {
			return manifest{}, errors.New("manifest contains an invalid folder ID")
		}
		if _, err := normalizeFolderName(folder.Name); err != nil {
			return manifest{}, errors.New("manifest contains an invalid folder name")
		}
		result.Folders[index].SortMode = normalizeSortMode(folder.SortMode)
		if folder.Locked && folder.LockPasswordHash == "" {
			return manifest{}, errors.New("manifest contains a locked folder without a verifier")
		}
	}
	for _, item := range result.Notes {
		if !validID(item.ID) {
			return manifest{}, errors.New("manifest contains an invalid note ID")
		}
		if item.FolderID != "" && !folderIDExists(result.Folders, item.FolderID) {
			return manifest{}, errors.New("manifest references a folder that does not exist")
		}
	}
	liveNotes := make(map[string]struct{}, len(result.Notes))
	for _, item := range result.Notes {
		liveNotes[item.ID] = struct{}{}
	}
	seenDeletedNotes := make(map[string]struct{}, len(result.DeletedNotes))
	for _, item := range result.DeletedNotes {
		if !validID(item.ID) || item.Revision == 0 || item.ModifiedAt < 0 {
			return manifest{}, errors.New("manifest contains an invalid note tombstone")
		}
		if _, live := liveNotes[item.ID]; live {
			return manifest{}, errors.New("manifest note is both live and deleted")
		}
		if _, duplicate := seenDeletedNotes[item.ID]; duplicate {
			return manifest{}, errors.New("manifest contains a duplicate note tombstone")
		}
		seenDeletedNotes[item.ID] = struct{}{}
	}
	liveFolders := make(map[string]struct{}, len(result.Folders))
	for _, item := range result.Folders {
		liveFolders[item.ID] = struct{}{}
	}
	seenDeletedFolders := make(map[string]struct{}, len(result.DeletedFolders))
	for _, item := range result.DeletedFolders {
		if !validID(item.ID) || item.ModifiedAt < 0 {
			return manifest{}, errors.New("manifest contains an invalid folder tombstone")
		}
		if _, live := liveFolders[item.ID]; live {
			return manifest{}, errors.New("manifest folder is both live and deleted")
		}
		if _, duplicate := seenDeletedFolders[item.ID]; duplicate {
			return manifest{}, errors.New("manifest contains a duplicate folder tombstone")
		}
		seenDeletedFolders[item.ID] = struct{}{}
	}
	sortTombstones(result.DeletedNotes)
	sortTombstones(result.DeletedFolders)
	return result, nil
}

func (s *Store) writeEnvelopeLocked(path, objectType, objectID string, plaintext []byte) error {
	return s.writeEnvelopePayloadLocked(path, objectType, objectID, plaintext, "")
}

func (s *Store) writeEnvelopePayloadLocked(
	path, objectType, objectID string,
	plaintext []byte,
	compression string,
) error {
	value, err := s.buildEnvelopeLocked(objectType, objectID, plaintext, compression)
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, value)
}

func (s *Store) buildEnvelopeLocked(
	objectType, objectID string,
	plaintext []byte,
	compression string,
) (envelope, error) {
	aad := envelopeAssociatedData(s.vaultID, objectType, objectID, compression)
	nonce, ciphertext, err := secure.Seal(s.key, plaintext, aad)
	if err != nil {
		return envelope{}, fmt.Errorf("encrypt %s: %w", objectType, err)
	}
	return envelope{
		FormatVersion: FormatVersion,
		Algorithm:     Algorithm,
		ObjectType:    objectType,
		ObjectID:      objectID,
		Compression:   compression,
		Nonce:         base64.RawURLEncoding.EncodeToString(nonce),
		Ciphertext:    base64.RawURLEncoding.EncodeToString(ciphertext),
	}, nil
}

func (s *Store) writeRemoteEnvelopeIfChangedLocked(
	path, objectType, objectID string,
	plaintext []byte,
) error {
	existing, err := s.readEnvelopeFileLocked(path, objectType, objectID)
	if err == nil && bytes.Equal(existing, plaintext) {
		return nil
	}
	value, err := s.buildEnvelopeLocked(objectType, objectID, plaintext, "")
	if err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode remote encrypted metadata: %w", err)
	}
	return writeBytesAtomicFast(path, data)
}

func (s *Store) readEnvelopeLocked(path, objectType, objectID string) ([]byte, error) {
	plaintext, err := s.readEnvelopeFileLocked(path, objectType, objectID)
	if err == nil {
		return plaintext, nil
	}
	backupPlaintext, backupErr := s.readEnvelopeFileLocked(path+".bak", objectType, objectID)
	if backupErr == nil {
		return backupPlaintext, nil
	}
	return nil, fmt.Errorf("%w (encrypted backup is also unavailable: %v)", err, backupErr)
}

func (s *Store) readEnvelopeFileLocked(path, objectType, objectID string) ([]byte, error) {
	var value envelope
	if err := readJSONFile(path, maxEnvelopeBytes, &value); err != nil {
		return nil, err
	}
	if value.FormatVersion != FormatVersion || value.Algorithm != Algorithm ||
		value.ObjectType != objectType || value.ObjectID != objectID {
		return nil, errors.New("encrypted object header is invalid")
	}
	if value.Compression != "" &&
		(value.Compression != "gzip" || (objectType != "note" && objectType != "note-content")) {
		return nil, errors.New("encrypted object compression is invalid")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(value.Nonce)
	if err != nil {
		return nil, errors.New("encrypted object nonce is invalid")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(value.Ciphertext)
	if err != nil {
		return nil, errors.New("encrypted object payload is invalid")
	}
	plaintext, err := secure.Open(
		s.key,
		nonce,
		ciphertext,
		envelopeAssociatedData(s.vaultID, objectType, objectID, value.Compression),
	)
	if err != nil {
		return nil, err
	}
	if value.Compression == "gzip" {
		return decompressNotePayload(plaintext)
	}
	return plaintext, nil
}

func buildConfig(vaultID string, masterKey []byte, passphrase string, params secure.KDFParams) (vaultConfig, error) {
	salt, err := secure.RandomBytes(16)
	if err != nil {
		return vaultConfig{}, err
	}
	wrappingKey, err := secure.DeriveKey(passphrase, salt, params)
	if err != nil {
		return vaultConfig{}, err
	}
	defer secure.Zero(wrappingKey)
	nonce, ciphertext, err := secure.Seal(
		wrappingKey, masterKey, []byte("emv:1:vault-key:"+vaultID),
	)
	if err != nil {
		return vaultConfig{}, err
	}
	return vaultConfig{
		FormatVersion: FormatVersion,
		VaultID:       vaultID,
		Algorithm:     Algorithm,
		Key: keyConfiguration{
			KDF: kdfConfiguration{
				Name:        "Argon2id",
				Salt:        base64.RawURLEncoding.EncodeToString(salt),
				Time:        params.Time,
				MemoryKiB:   params.Memory,
				Parallelism: params.Threads,
			},
			WrappedKey: wrappedKey{
				Nonce:      base64.RawURLEncoding.EncodeToString(nonce),
				Ciphertext: base64.RawURLEncoding.EncodeToString(ciphertext),
			},
		},
	}, nil
}

func unwrapMasterKey(config vaultConfig, passphrase string) ([]byte, error) {
	salt, err := base64.RawURLEncoding.DecodeString(config.Key.KDF.Salt)
	if err != nil {
		return nil, err
	}
	params := secure.KDFParams{
		Time:    config.Key.KDF.Time,
		Memory:  config.Key.KDF.MemoryKiB,
		Threads: config.Key.KDF.Parallelism,
	}
	wrappingKey, err := secure.DeriveKey(passphrase, salt, params)
	if err != nil {
		return nil, err
	}
	defer secure.Zero(wrappingKey)
	nonce, err := base64.RawURLEncoding.DecodeString(config.Key.WrappedKey.Nonce)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(config.Key.WrappedKey.Ciphertext)
	if err != nil {
		return nil, err
	}
	key, err := secure.Open(
		wrappingKey, nonce, ciphertext, []byte("emv:1:vault-key:"+config.VaultID),
	)
	if err != nil {
		return nil, err
	}
	if len(key) != secure.KeySize {
		secure.Zero(key)
		return nil, errors.New("wrapped vault key has invalid length")
	}
	return key, nil
}

func validateConfig(config vaultConfig) error {
	if config.FormatVersion != FormatVersion {
		return fmt.Errorf("unsupported vault format version %d", config.FormatVersion)
	}
	if !validID(config.VaultID) || config.Algorithm != Algorithm {
		return errors.New("vault configuration is invalid")
	}
	kdf := config.Key.KDF
	if kdf.Name != "Argon2id" || !supportedKDFProfile(kdf) {
		return errors.New("vault KDF configuration is invalid or unsafe")
	}
	return nil
}

func supportedKDFProfile(kdf kdfConfiguration) bool {
	return (kdf.Time == 3 && kdf.MemoryKiB == 64*1024 && kdf.Parallelism == 2) ||
		(kdf.Time == 1 && kdf.MemoryKiB == 8*1024 && kdf.Parallelism == 2)
}

func prepareRoot(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("vault folder is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve vault folder: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect vault folder: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("vault path must be a folder")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("resolve vault folder links: %w", err)
	}
	return filepath.Clean(resolved), nil
}

func writeJSONAtomic(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode JSON: %w", err)
	}

	// Keep a known-good encrypted copy throughout the replacement. Once the
	// primary write succeeds, refresh the backup so both files represent the
	// last fully committed value.
	backupPath := path + ".bak"
	if _, err := os.Stat(backupPath); errors.Is(err, os.ErrNotExist) {
		if previous, readErr := os.ReadFile(path); readErr == nil {
			if err := writeBytesAtomic(backupPath, previous); err != nil {
				return fmt.Errorf("preserve encrypted backup: %w", err)
			}
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return fmt.Errorf("read encrypted file before replacement: %w", readErr)
		}
	} else if err != nil {
		return fmt.Errorf("inspect encrypted backup: %w", err)
	}
	if err := writeBytesAtomic(path, data); err != nil {
		return err
	}
	if err := writeBytesAtomic(backupPath, data); err != nil {
		return fmt.Errorf("refresh encrypted backup: %w", err)
	}
	return nil
}

func writeBytesAtomic(path string, data []byte) error {
	return writeBytesAtomicWithSync(path, data, true)
}

func writeBytesAtomicFast(path string, data []byte) error {
	return writeBytesAtomicWithSync(path, data, false)
}

func writeBytesAtomicWithSync(path string, data []byte, syncFile bool) error {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".emv-write-*")
	if err != nil {
		return fmt.Errorf("create encrypted temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("set encrypted file permissions: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write encrypted temporary file: %w", err)
	}
	if syncFile {
		if err := temp.Sync(); err != nil {
			temp.Close()
			return fmt.Errorf("flush encrypted temporary file: %w", err)
		}
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close encrypted temporary file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace encrypted file: %w", err)
	}
	return nil
}

func copyFileAtomic(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return writeBytesAtomic(target, data)
}

func copyFileIfChangedFast(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return writeBytesIfChangedFast(target, data)
}

func writeBytesIfChangedFast(path string, data []byte) error {
	existing, err := os.ReadFile(path)
	if err == nil && bytes.Equal(existing, data) {
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeBytesAtomicFast(path, data)
}

func removeUnexpectedSnapshotObjects(
	objectsRoot string,
	expected map[string]struct{},
) error {
	if err := filepath.WalkDir(objectsRoot, func(
		path string,
		entry os.DirEntry,
		walkErr error,
	) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if _, keep := expected[filepath.Clean(path)]; keep {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove stale remote object: %w", err)
		}
		return nil
	}); err != nil {
		return err
	}
	return removeEmptyDirectories(objectsRoot)
}

func removeUnexpectedSyncFiles(syncRoot string) error {
	entries, err := os.ReadDir(syncRoot)
	if err != nil {
		return fmt.Errorf("inspect remote sync metadata folder: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() ||
			(entry.Name() != syncManifestFile && entry.Name() != syncFoldersFile) {
			if err := os.RemoveAll(filepath.Join(syncRoot, entry.Name())); err != nil {
				return fmt.Errorf("remove stale remote sync metadata: %w", err)
			}
		}
	}
	return nil
}

func removeEmptyDirectories(root string) error {
	directories := make([]string, 0)
	if err := filepath.WalkDir(root, func(
		path string,
		entry os.DirEntry,
		walkErr error,
	) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() && path != root {
			directories = append(directories, path)
		}
		return nil
	}); err != nil {
		return err
	}
	slices.SortFunc(directories, func(left, right string) int {
		return len(right) - len(left)
	})
	for _, directory := range directories {
		if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
			if entries, readErr := os.ReadDir(directory); readErr == nil && len(entries) > 0 {
				continue
			}
			return fmt.Errorf("remove empty remote object folder: %w", err)
		}
	}
	return nil
}

func rejectLiveVaultDestination(root, destination string) error {
	resolved, err := filepath.EvalSymlinks(destination)
	if err != nil {
		return fmt.Errorf("resolve snapshot destination: %w", err)
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil {
		// Paths on different Windows volumes cannot overlap.
		return nil
	}
	if relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return errors.New("snapshot destination must be outside the live vault")
	}
	return nil
}

func readJSON(path string, maxBytes int64, target any) error {
	err := readJSONFile(path, maxBytes, target)
	if err == nil {
		return nil
	}
	if backupErr := readJSONFile(path+".bak", maxBytes, target); backupErr == nil {
		return nil
	} else {
		return fmt.Errorf("%w (backup is also unavailable: %v)", err, backupErr)
	}
}

func readJSONFile(path string, maxBytes int64, target any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	limited := io.LimitReader(file, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return errors.New("file exceeds the supported size")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

func associatedData(vaultID, objectType, objectID string) []byte {
	return []byte(fmt.Sprintf("emv:%d:%s:%s:%s", FormatVersion, vaultID, objectType, objectID))
}

func envelopeAssociatedData(
	vaultID, objectType, objectID, compression string,
) []byte {
	base := associatedData(vaultID, objectType, objectID)
	if compression == "" {
		return base
	}
	return append(base, []byte(":compression:"+compression)...)
}

func compressNotePayload(plaintext []byte) ([]byte, string, error) {
	if len(plaintext) < 4*1024 {
		return plaintext, "", nil
	}
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return nil, "", fmt.Errorf("create note compressor: %w", err)
	}
	if _, err := writer.Write(plaintext); err != nil {
		writer.Close()
		return nil, "", fmt.Errorf("compress note: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, "", fmt.Errorf("finish note compression: %w", err)
	}
	if compressed.Len() >= len(plaintext) {
		return plaintext, "", nil
	}
	return compressed.Bytes(), "gzip", nil
}

func decompressNotePayload(compressed []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, errors.New("compressed encrypted note is damaged")
	}
	defer reader.Close()
	const maxDecompressedNote = maxNoteBytes + 1024*1024
	plaintext, err := io.ReadAll(io.LimitReader(reader, maxDecompressedNote+1))
	if err != nil {
		return nil, errors.New("decompress encrypted note")
	}
	if len(plaintext) > maxDecompressedNote {
		return nil, errors.New("compressed encrypted note exceeds the supported size")
	}
	return plaintext, nil
}

func randomID(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate opaque ID: %w", err)
	}
	return hex.EncodeToString(value), nil
}

func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func normalizeTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Untitled"
	}
	if utf8.RuneCountInString(title) > maxTitleRunes {
		return "", fmt.Errorf("title exceeds %d characters", maxTitleRunes)
	}
	return title, nil
}

func normalizeFolderName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("folder name is required")
	}
	if utf8.RuneCountInString(name) > maxFolderRunes {
		return "", fmt.Errorf("folder name exceeds %d characters", maxFolderRunes)
	}
	if strings.ContainsAny(name, `/\`) {
		return "", errors.New("folder name cannot contain slashes")
	}
	return name, nil
}

// RenameVault renames the current vault's folder from its current name to
// newName inside the same parent directory. The vault must be unlocked so
// the in-memory key is zeroed; the caller reopens with the returned session.
func (s *Store) RenameVault(newName string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Session{}, err
	}
	cleaned, err := normalizeVaultName(newName)
	if err != nil {
		return Session{}, err
	}
	parent := filepath.Dir(s.root)
	target := filepath.Join(parent, cleaned)
	if filepath.Clean(target) == filepath.Clean(s.root) {
		return s.sessionLocked(), nil
	}
	if _, statErr := os.Stat(target); statErr == nil {
		return Session{}, errors.New("a folder with the new name already exists")
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Session{}, fmt.Errorf("inspect rename target: %w", statErr)
	}
	if err := os.Rename(s.root, target); err != nil {
		return Session{}, fmt.Errorf("rename vault folder: %w", err)
	}
	s.root = target
	secure.Zero(s.key)
	s.key = nil
	secure.Zero(s.secret)
	s.secret = nil
	s.manifest = manifest{}
	return Session{Locked: true, Path: target, VaultID: s.vaultID}, nil
}

func normalizeVaultName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("vault name is required")
	}
	if name == "." || name == ".." || filepath.Base(name) != name ||
		strings.ContainsAny(name, `/\`) {
		return "", errors.New("vault name cannot contain path separators")
	}
	if utf8.RuneCountInString(name) > maxFolderRunes {
		return "", fmt.Errorf("vault name exceeds %d characters", maxFolderRunes)
	}
	return name, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func sameRegularFileSize(left, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil &&
		leftInfo.Mode().IsRegular() && rightInfo.Mode().IsRegular() &&
		leftInfo.Size() == rightInfo.Size()
}

func cleanupNewVaultFolder(root string) {
	removeFileAndBackup(filepath.Join(root, manifestFilename))
	removeFileAndBackup(filepath.Join(root, configFilename))
	_ = os.Remove(filepath.Join(root, "objects"))
	_ = os.Remove(root)
}

func ensureNewVaultPathAvailable(root string) error {
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect restored vault destination: %w", err)
	}
	if info.IsDir() && fileExists(filepath.Join(root, configFilename)) {
		return ErrVaultAlreadyExists
	}
	return ErrVaultFolderExists
}

func removeFileAndBackup(path string) {
	_ = os.Remove(path + ".bak")
	_ = os.Remove(path)
}

func folderIDExists(folders []Folder, id string) bool {
	for _, folder := range folders {
		if folder.ID == id {
			return true
		}
	}
	return false
}

func noteReferencesFolder(notes []NoteSummary, folderID string) bool {
	for _, note := range notes {
		if note.FolderID == folderID {
			return true
		}
	}
	return false
}

func summaryFromNote(note Note) NoteSummary {
	derivedContent := derivedMarkdownContent(note.Content)
	return NoteSummary{
		ID: note.ID, Title: note.Title, FolderID: note.FolderID, Order: note.Order, CreatedAt: note.CreatedAt,
		UpdatedAt: note.UpdatedAt, ModifiedAt: note.ModifiedAt, Revision: note.Revision, Tags: extractTags(derivedContent),
		AttachmentIDs: extractAttachmentIDs(derivedContent), OutgoingLinks: extractOutgoingLinks(derivedContent),
	}
}

func noteFromSummary(summary NoteSummary, content string) Note {
	return Note{
		ID:         summary.ID,
		Title:      summary.Title,
		FolderID:   summary.FolderID,
		Order:      summary.Order,
		Content:    content,
		CreatedAt:  summary.CreatedAt,
		UpdatedAt:  summary.UpdatedAt,
		ModifiedAt: summary.ModifiedAt,
		Revision:   summary.Revision,
	}
}

func noteForClient(note Note) Note {
	note.Content = derivedMarkdownContent(note.Content)
	return note
}

func cloneNoteSummary(summary NoteSummary) *NoteSummary {
	clone := summary
	clone.Tags = slices.Clone(summary.Tags)
	clone.AttachmentIDs = slices.Clone(summary.AttachmentIDs)
	clone.OutgoingLinks = slices.Clone(summary.OutgoingLinks)
	return &clone
}

func validateRemoteNote(
	note Note,
	item remoteSyncObject,
	folders []Folder,
	validateDerivedMetadata bool,
) error {
	normalizedTitle, titleErr := normalizeTitle(note.Title)
	if titleErr != nil || normalizedTitle != note.Title ||
		!utf8.ValidString(note.Content) || len([]byte(note.Content)) > maxNoteBytes ||
		note.Revision == 0 || note.ModifiedAt < 0 {
		return fmt.Errorf("remote encrypted note %s contains invalid data", item.ID)
	}
	if _, err := time.Parse(time.RFC3339Nano, note.CreatedAt); err != nil {
		return fmt.Errorf("remote encrypted note %s has an invalid creation time", item.ID)
	}
	if _, err := time.Parse(time.RFC3339Nano, note.UpdatedAt); err != nil {
		return fmt.Errorf("remote encrypted note %s has an invalid update time", item.ID)
	}
	if note.Revision != item.Revision ||
		note.ModifiedAt != item.ModifiedAt ||
		(note.FolderID != "" && !folderIDExists(folders, note.FolderID)) {
		return fmt.Errorf("remote encrypted note %s metadata is inconsistent", item.ID)
	}
	if validateDerivedMetadata && item.Summary != nil &&
		(!slices.Equal(extractTags(derivedMarkdownContent(note.Content)), item.Summary.Tags) ||
			!slices.Equal(extractAttachmentIDs(derivedMarkdownContent(note.Content)), item.Summary.AttachmentIDs) ||
			!slices.Equal(extractOutgoingLinks(derivedMarkdownContent(note.Content)), item.Summary.OutgoingLinks)) {
		return fmt.Errorf("remote encrypted note %s derived metadata is inconsistent", item.ID)
	}
	return nil
}

type canonicalObjectDocument struct {
	Format  string                `json:"format"`
	Version int                   `json:"version"`
	Objects []canonicalObjectNode `json:"objects"`
}

type canonicalObjectNode struct {
	ID              string   `json:"id"`
	Tag             string   `json:"tag"`
	Tags            []string `json:"tags"`
	Text            string   `json:"text"`
	Checked         *bool    `json:"checked,omitempty"`
	Indent          int      `json:"indent"`
	ContentIndent   int      `json:"contentIndent"`
	ParentID        *string  `json:"parentId"`
	ParentSectionID *string  `json:"parentSectionId"`
	ChildrenIDs     []string `json:"childrenIds"`
	SourcePrefix    string   `json:"sourcePrefix,omitempty"`
}

type parsedCanonicalLine struct {
	tag           string
	tags          []string
	indent        int
	contentIndent int
	text          string
	checked       *bool
	startsObject  bool
	sourcePrefix  string
}

func canonicalizeNoteContent(content string) string {
	if isCanonicalObjectDocument(content) {
		return content
	}
	data, err := json.MarshalIndent(canonicalObjectDocumentFromMarkdown(content), "", "  ")
	if err != nil {
		return content
	}
	return string(data)
}

func isCanonicalObjectDocument(content string) bool {
	var document canonicalObjectDocument
	return json.Unmarshal([]byte(content), &document) == nil &&
		document.Format == "cipherleaf.object-document" &&
		document.Version == 1
}

func canonicalObjectDocumentFromMarkdown(content string) canonicalObjectDocument {
	lines := strings.Split(content, "\n")
	var objectPointers []*canonicalObjectNode
	var stack []*canonicalObjectNode
	var sectionStack []*canonicalObjectNode
	parsedByID := map[string]parsedCanonicalLine{}

	for index, raw := range lines {
		lineNumber := index + 1
		if raw != "" && strings.TrimSpace(raw) == "" {
			usedAsContinuation := false
			if len(stack) > 0 {
				previous := stack[len(stack)-1]
				previousParsed := parsedByID[previous.ID]
				next := ""
				if index+1 < len(lines) {
					next = lines[index+1]
				}
				if strings.TrimSpace(next) != "" && startsWithWhitespace(next) && !lineStartsExplicitCanonicalObject(next) && lineVisualIndent(next) >= previousParsed.contentIndent {
					previous.Text += "\n"
					usedAsContinuation = true
				}
			}
			if raw != "" || usedAsContinuation {
				continue
			}
		}
		parsed := classifyCanonicalMarkdownLine(raw)
		previous := (*canonicalObjectNode)(nil)
		if len(stack) > 0 {
			previous = stack[len(stack)-1]
		}
		if previous != nil {
			previousParsed := parsedByID[previous.ID]
			if previous.Text != "" && startsWithWhitespace(raw) && !lineStartsExplicitCanonicalObject(raw) && parsed.indent >= previousParsed.contentIndent {
				previous.Text += "\n" + strings.TrimSpace(raw)
				continue
			}
		}
		for len(stack) > 0 && stack[len(stack)-1].Indent >= parsed.indent {
			stack = stack[:len(stack)-1]
		}
		for len(sectionStack) > 0 && sectionStack[len(sectionStack)-1].Indent >= parsed.indent {
			sectionStack = sectionStack[:len(sectionStack)-1]
		}
		parent := (*canonicalObjectNode)(nil)
		if len(stack) > 0 {
			parent = stack[len(stack)-1]
		}
		parentSection := (*canonicalObjectNode)(nil)
		if len(sectionStack) > 0 {
			parentSection = sectionStack[len(sectionStack)-1]
		}
		parentPath := ""
		if parent != nil {
			parentPath = parent.ID + "/"
		}
		id := stableCanonicalObjectID(fmt.Sprintf("%s%s:%d:%s:%d", parentPath, parsed.tag, parsed.indent, parsed.text, lineNumber))
		object := canonicalObjectNode{
			ID: id, Tag: parsed.tag, Tags: slices.Clone(parsed.tags), Text: parsed.text, Checked: parsed.checked,
			Indent: parsed.indent, ContentIndent: parsed.contentIndent, ChildrenIDs: []string{}, SourcePrefix: parsed.sourcePrefix,
		}
		if parent != nil {
			parentID := parent.ID
			object.ParentID = &parentID
			parent.ChildrenIDs = append(parent.ChildrenIDs, id)
		}
		if parentSection != nil {
			parentSectionID := parentSection.ID
			object.ParentSectionID = &parentSectionID
		}
		objectPointer := &object
		objectPointers = append(objectPointers, objectPointer)
		stack = append(stack, objectPointer)
		parsedByID[id] = parsed
		if object.Tag == "section" {
			sectionStack = append(sectionStack, objectPointer)
		}
	}
	objects := make([]canonicalObjectNode, 0, len(objectPointers))
	for _, object := range objectPointers {
		objects = append(objects, *object)
	}
	return canonicalObjectDocument{Format: "cipherleaf.object-document", Version: 1, Objects: objects}
}

func stableCanonicalObjectID(input string) string {
	hash := sha256.Sum256([]byte(input))
	hexValue := hex.EncodeToString(hash[:])
	return fmt.Sprintf("%s-%s-4%s-%s-%s", hexValue[:8], hexValue[8:12], hexValue[13:16], hexValue[16:20], hexValue[20:32])
}

func classifyCanonicalMarkdownLine(raw string) parsedCanonicalLine {
	outline := regexp.MustCompile(`^([ \t]*)(>+)([ \t]?)(.*)$`).FindStringSubmatch(raw)
	source := strings.TrimLeft(raw, " \t")
	tags := []string{}
	indent := lineVisualIndent(raw)
	contentIndent := indent
	if outline != nil {
		source = outline[4]
		tags = append(tags, "section")
		indent = visualIndent(outline[1]) + (len(outline[2])-1)*2
		contentIndent = visualIndent(outline[1]) + len(outline[2]) + visualIndent(outline[3])
	}
	sourcePrefix := func(text string) string {
		if text == "" {
			return raw
		}
		index := strings.Index(raw, text)
		if index >= 0 {
			return raw[:index]
		}
		if contentIndent > len(raw) {
			return raw
		}
		return raw[:contentIndent]
	}
	if regexp.MustCompile(`^!\[[^\]]*]\([^)]+\)\s*$`).MatchString(strings.TrimSpace(source)) || attachmentReference.MatchString(source) {
		text := strings.TrimSpace(source)
		return parsedCanonicalLine{tag: "image", tags: append(tags, "image"), indent: indent, contentIndent: contentIndent, text: text, startsObject: true, sourcePrefix: sourcePrefix(text)}
	}
	if match := regexp.MustCompile(`^([-*])(?:\s+(.*)|\s*)$`).FindStringSubmatch(source); match != nil {
		text := strings.TrimSpace(match[2])
		var checked *bool
		if checkbox := regexp.MustCompile(`^\[([ xX])\]\s*(.*)$`).FindStringSubmatch(match[2]); checkbox != nil {
			text = strings.TrimSpace(checkbox[2])
			value := strings.EqualFold(checkbox[1], "x")
			checked = &value
		}
		return parsedCanonicalLine{tag: "bulletpoint", tags: append(tags, "bulletpoint"), indent: indent, contentIndent: contentIndent + len(source) - len(text), text: text, checked: checked, startsObject: true, sourcePrefix: sourcePrefix(text)}
	}
	if match := regexp.MustCompile(`^(\d+[.)])(?:\s+(.*)|\s*)$`).FindStringSubmatch(source); match != nil {
		text := strings.TrimSpace(match[2])
		var checked *bool
		if checkbox := regexp.MustCompile(`^\[([ xX])\]\s*(.*)$`).FindStringSubmatch(match[2]); checkbox != nil {
			text = strings.TrimSpace(checkbox[2])
			value := strings.EqualFold(checkbox[1], "x")
			checked = &value
		}
		return parsedCanonicalLine{tag: "bulletpoint", tags: append(tags, "bulletpoint"), indent: indent, contentIndent: contentIndent + len(source) - len(text), text: text, checked: checked, startsObject: true, sourcePrefix: sourcePrefix(text)}
	}
	tags = append(tags, "text")
	if strings.HasPrefix(source, "#") && regexp.MustCompile(`^#{1,6}\s+`).MatchString(source) {
		tag := "text"
		if outline != nil {
			tag = "section"
		}
		text := strings.TrimSpace(source)
		return parsedCanonicalLine{tag: tag, tags: tags, indent: indent, contentIndent: contentIndent, text: text, startsObject: true, sourcePrefix: sourcePrefix(text)}
	}
	checkbox := regexp.MustCompile(`^\[([ xX])\]\s*(.*)$`).FindStringSubmatch(source)
	text := strings.TrimSpace(source)
	checkboxContentIndent := -1
	var checked *bool
	if checkbox != nil {
		text = strings.TrimSpace(checkbox[2])
		checkboxContentIndent = contentIndent + len(source) - len(checkbox[2])
		value := strings.EqualFold(checkbox[1], "x")
		checked = &value
	}
	if outline == nil && checkbox == nil {
		contentIndent = indent + 2
	}
	if checkboxContentIndent >= 0 {
		contentIndent = checkboxContentIndent
	}
	return parsedCanonicalLine{tag: map[bool]string{true: "section", false: "text"}[outline != nil], tags: tags, indent: indent, contentIndent: contentIndent, text: text, checked: checked, startsObject: true, sourcePrefix: sourcePrefix(text)}
}

func startsWithWhitespace(text string) bool {
	return strings.HasPrefix(text, " ") || strings.HasPrefix(text, "\t")
}

func lineStartsExplicitCanonicalObject(raw string) bool {
	outline := regexp.MustCompile(`^([ \t]*)(>+)([ \t]?)(.*)$`).FindStringSubmatch(raw)
	source := strings.TrimLeft(raw, " \t")
	if outline != nil {
		source = outline[4]
	}
	return outline != nil ||
		regexp.MustCompile(`^!\[[^\]]*]\([^)]+\)\s*$`).MatchString(strings.TrimSpace(source)) ||
		attachmentReference.MatchString(source) ||
		regexp.MustCompile(`^(?:[-+*]\s+)?\[([ xX])\]\s*(.*)$`).MatchString(source) ||
		regexp.MustCompile(`^[-*](?:\s+.*|\s*)$`).MatchString(source) ||
		regexp.MustCompile(`^\d+[.)](?:\s+.*|\s*)$`).MatchString(source) ||
		regexp.MustCompile(`^#{1,6}\s+`).MatchString(source)
}

func visualIndent(text string) int {
	return len(strings.ReplaceAll(text, "\t", "  "))
}

func lineVisualIndent(text string) int {
	return visualIndent(text[:len(text)-len(strings.TrimLeft(text, " \t"))])
}

func derivedMarkdownContent(content string) string {
	var document canonicalObjectDocument
	if err := json.Unmarshal([]byte(content), &document); err != nil ||
		document.Format != "cipherleaf.object-document" ||
		document.Version != 1 {
		return content
	}
	byID := make(map[string]canonicalObjectNode, len(document.Objects))
	for _, object := range document.Objects {
		byID[object.ID] = object
	}
	var roots []canonicalObjectNode
	for _, object := range document.Objects {
		if object.ParentID == nil {
			roots = append(roots, object)
		}
	}
	var lines []string
	var appendObject func(canonicalObjectNode)
	appendObject = func(object canonicalObjectNode) {
		lines = append(lines, markdownLineForCanonicalObject(object))
		for _, childID := range object.ChildrenIDs {
			if child, found := byID[childID]; found {
				appendObject(child)
			}
		}
	}
	for _, root := range roots {
		appendObject(root)
	}
	return strings.Join(lines, "\n")
}

func markdownLineForCanonicalObject(object canonicalObjectNode) string {
	textLines := strings.Split(object.Text, "\n")
	firstText := ""
	if len(textLines) > 0 {
		firstText = textLines[0]
	}
	prefixHasCheckbox := regexp.MustCompile(`\[[ xX]\]\s*$`).MatchString(object.SourcePrefix)
	if object.Checked != nil && !prefixHasCheckbox {
		if *object.Checked {
			firstText = strings.TrimRight("[x] "+firstText, " ")
		} else {
			firstText = strings.TrimRight("[ ] "+firstText, " ")
		}
	}
	hasSection := slices.Contains(object.Tags, "section")
	marker := ""
	switch object.Tag {
	case "bulletpoint":
		marker = "- "
	}
	prefix := object.SourcePrefix
	if prefix == "" {
		prefix = strings.Repeat(" ", max(0, object.Indent)) + marker
	}
	if hasSection && object.SourcePrefix == "" {
		prefix = strings.Repeat(">", max(1, object.Indent/2+1)) + " " + marker
	}
	lines := []string{prefix + firstText}
	continuationPrefix := strings.Repeat(" ", max(0, object.ContentIndent))
	for _, line := range textLines[1:] {
		if line == "" {
			lines = append(lines, "")
		} else {
			lines = append(lines, continuationPrefix+line)
		}
	}
	return strings.Join(lines, "\n")
}

func sortSummaries(items []NoteSummary) {
	slices.SortStableFunc(items, func(left, right NoteSummary) int {
		if left.Order != right.Order {
			return left.Order - right.Order
		}
		return strings.Compare(strings.ToLower(left.Title), strings.ToLower(right.Title))
	})
}

func (s *Store) nextNoteOrderLocked(folderID string) int {
	next := 0
	for _, note := range s.manifest.Notes {
		if note.FolderID == folderID && note.Order >= next {
			next = note.Order + 1
		}
	}
	return next
}

func sortFolders(items []Folder) {
	slices.SortStableFunc(items, func(left, right Folder) int {
		if left.Order != right.Order {
			return left.Order - right.Order
		}
		return strings.Compare(strings.ToLower(left.Name), strings.ToLower(right.Name))
	})
}

func (s *Store) nextFolderOrderLocked() int {
	next := 0
	for _, folder := range s.manifest.Folders {
		if folder.Order >= next {
			next = folder.Order + 1
		}
	}
	return next
}

func normalizeSortMode(mode string) string {
	switch mode {
	case "title", "updated", "created":
		return mode
	default:
		return "manual"
	}
}

func newFolderPasswordVerifier(password string) (string, error) {
	salt := make([]byte, folderPasswordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate folder password salt: %w", err)
	}
	hash := saltedFolderPasswordHash(password, salt)
	return folderPasswordVerifierPrefix +
		base64.RawURLEncoding.EncodeToString(salt) + ":" +
		hex.EncodeToString(hash), nil
}

func verifyFolderPassword(verifier, password string) bool {
	if strings.HasPrefix(verifier, folderPasswordVerifierPrefix) {
		payload := strings.TrimPrefix(verifier, folderPasswordVerifierPrefix)
		parts := strings.Split(payload, ":")
		if len(parts) != 2 {
			return false
		}
		salt, err := base64.RawURLEncoding.DecodeString(parts[0])
		if err != nil || len(salt) != folderPasswordSaltBytes {
			return false
		}
		expected, err := hex.DecodeString(parts[1])
		if err != nil || len(expected) != sha256.Size {
			return false
		}
		actual := saltedFolderPasswordHash(password, salt)
		return subtle.ConstantTimeCompare(actual, expected) == 1
	}

	// Backward compatibility for folders locked before salted verifiers existed.
	expected, err := hex.DecodeString(verifier)
	if err != nil || len(expected) != sha256.Size {
		return false
	}
	legacyHash := sha256.Sum256([]byte(password))
	return subtle.ConstantTimeCompare(legacyHash[:], expected) == 1
}

func saltedFolderPasswordHash(password string, salt []byte) []byte {
	hasher := sha256.New()
	_, _ = hasher.Write(salt)
	_, _ = hasher.Write([]byte(password))
	return hasher.Sum(nil)
}

func extractTags(content string) []string {
	seen := make(map[string]struct{})
	var tags []string
	for _, match := range tagPattern.FindAllStringSubmatch(content, -1) {
		tag := strings.ToLower(match[2])
		if _, exists := seen[tag]; exists {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	slices.Sort(tags)
	return tags
}

func extractAttachmentIDs(content string) []string {
	seen := make(map[string]struct{})
	for _, match := range attachmentReference.FindAllStringSubmatch(content, -1) {
		seen[match[1]] = struct{}{}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func extractOutgoingLinks(content string) []string {
	seen := make(map[string]struct{})
	for _, match := range wikilinkPattern.FindAllStringSubmatch(content, -1) {
		link := normalizeOutgoingLink(match[1])
		if link != "" {
			seen[link] = struct{}{}
		}
	}
	links := make([]string, 0, len(seen))
	for link := range seen {
		links = append(links, link)
	}
	slices.Sort(links)
	return links
}

func normalizeOutgoingLink(link string) string {
	return strings.ToLower(strings.TrimSpace(link))
}

func parseNoteReference(reference string) (label string, id string, ok bool) {
	parts := strings.Split(reference, "|")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "note:") {
			id = strings.TrimPrefix(part, "note:")
			if validID(id) {
				label = strings.TrimSpace(parts[0])
				return label, id, true
			}
		}
	}
	return "", "", false
}

func backlinkMatch(summary NoteSummary, content string, from, to int, raw string) FindMatch {
	return FindMatch{
		NoteID:      summary.ID,
		Title:       summary.Title,
		Field:       "content",
		Snippet:     makeSnippet(content, from, to-from),
		Offset:      from,
		MatchLength: len(raw) + 4,
	}
}

func backlinkMetadataMatch(summary NoteSummary, raw string) FindMatch {
	return FindMatch{
		NoteID:      summary.ID,
		Title:       summary.Title,
		Field:       "content",
		Snippet:     "[[" + raw + "]]",
		Offset:      0,
		MatchLength: len(raw) + 4,
	}
}

func outgoingLinkMatches(link, targetID string, aliases map[string]struct{}) bool {
	label, id, hasID := parseNoteReference(link)
	if hasID {
		if id == targetID {
			return true
		}
		link = normalizeOutgoingLink(label)
	}
	_, ok := aliases[link]
	return ok
}

func nextModifiedAt(previous int64) int64 {
	now := time.Now().UTC().Unix()
	if now <= previous {
		return previous + 1
	}
	return now
}

func versionIsNewer(revision uint64, modifiedAt int64, otherRevision uint64, otherModifiedAt int64) bool {
	if revision != 0 && otherRevision != 0 && revision != otherRevision {
		return revision > otherRevision
	}
	return modifiedAt > otherModifiedAt
}

func upsertTombstone(items []Tombstone, value Tombstone) []Tombstone {
	for index := range items {
		if items[index].ID == value.ID {
			if versionIsNewer(
				value.Revision,
				value.ModifiedAt,
				items[index].Revision,
				items[index].ModifiedAt,
			) {
				items[index] = value
			}
			sortTombstones(items)
			return items
		}
	}
	items = append(items, value)
	sortTombstones(items)
	return items
}

func removeTombstone(items []Tombstone, id string) []Tombstone {
	for index := range items {
		if items[index].ID == id {
			return append(slices.Clone(items[:index]), items[index+1:]...)
		}
	}
	return items
}

func findTombstone(items []Tombstone, id string) (Tombstone, bool) {
	for _, item := range items {
		if item.ID == id {
			return item, true
		}
	}
	return Tombstone{}, false
}

func sortTombstones(items []Tombstone) {
	slices.SortFunc(items, func(left, right Tombstone) int {
		return strings.Compare(left.ID, right.ID)
	})
}

func tombstonesFromRemoteObjects(items map[string]remoteSyncObject) []Tombstone {
	result := make([]Tombstone, 0)
	for _, item := range items {
		if item.Deleted {
			result = append(result, Tombstone{
				ID: item.ID, Revision: item.Revision, ModifiedAt: item.ModifiedAt,
			})
		}
	}
	sortTombstones(result)
	return result
}
