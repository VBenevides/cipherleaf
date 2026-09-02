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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"cipherleaf/internal/atomicfile"
	"cipherleaf/internal/secure"
)

const (
	configFilename                = "vault.json"
	manifestFilename              = "manifest.enc"
	syncDirectory                 = "sync"
	syncManifestFile              = "manifest.enc"
	syncFoldersFile               = "folders.enc"
	syncTrackingFile              = "tracking.enc"
	syncManifestObjectType        = "sync-manifest"
	syncFoldersObjectType         = "sync-folders"
	noteContentObjectType         = "note-content"
	canonicalObjectDocumentFormat = "cipherleaf.object-document"
	encryptedBackupSuffix         = ".enc.bak"
	maxNoteBytes                  = 10 * 1024 * 1024
	maxAttachmentBytes            = 10 * 1024 * 1024
	maxFileAttachmentBytes        = 64 * 1024 * 1024
	maxTimeTrackingBytes          = 32 * 1024 * 1024
	maxEnvelopeBytes              = 96 * 1024 * 1024
	maxTitleRunes                 = 200
	maxFolderRunes                = 120
	folderPasswordSaltBytes       = 16
	folderPasswordVerifierPrefix  = "argon2id-v1:"
)

var (
	defaultKDF             = secure.KDFParams{Time: 3, Memory: 64 * 1024, Threads: 2}
	ErrLocked              = errors.New("vault is locked")
	ErrFolderLocked        = errors.New("folder is locked")
	ErrVaultAlreadyExists  = errors.New("a vault already exists in this folder")
	ErrVaultFolderExists   = errors.New("a folder with that vault name already exists")
	ErrVaultNotFound       = errors.New("no encrypted vault exists in this folder")
	ErrEncryptedFileAbsent = errors.New("an encrypted note file is missing")
	attachmentReference    = regexp.MustCompile(`attachment:([a-f0-9]{32})`)
	inlineCodePattern      = regexp.MustCompile("`+[^`\n]*`+")
	wikilinkPattern        = regexp.MustCompile(`\[\[([^\]\n]+)\]\]`)
	tagPattern             = regexp.MustCompile(`(^|[\s(])#([A-Za-z0-9][A-Za-z0-9_-]{0,63})`)
	canonicalCodeFence     = regexp.MustCompile("^([ \\t]*)```([^\\s`]*)[ \\t]*$")
	canonicalCodeFenceEnd  = regexp.MustCompile("^[ \\t]*```[ \\t]*$")
	canonicalOutline       = regexp.MustCompile(`^([ \t]*)(>+)([ \t]?)(.*)$`)
	canonicalBare          = regexp.MustCompile(`^([ \t]*)<([ \t]?)(.*)$`)
	canonicalImage         = regexp.MustCompile(`^!\[[^\]]*]\([^)]+\)\s*$`)
	canonicalAttachment    = regexp.MustCompile(`^(!?)\[[^\]]*]\(attachment:([a-f0-9]{32})(?:#[^)]*)?\)\s*$`)
	canonicalBullet        = regexp.MustCompile(`^([-*])(?:\s+(.*)|\s*)$`)
	canonicalOrdered       = regexp.MustCompile(`^(\d+[.)])(?:\s+(.*)|\s*)$`)
	canonicalCheckbox      = regexp.MustCompile(`^\[([ xX]?)\]\s*(.*)$`)
	canonicalTask          = regexp.MustCompile(`^(?:[-+*]\s+)?\[([ xX]?)\]\s*(.*)$`)
	canonicalHeading       = regexp.MustCompile(`^#{1,6}\s+`)
	canonicalCheckboxEnd   = regexp.MustCompile(`\[[ xX]?\](\s*)$`)
)

const (
	sharedAttachmentFolder = "shared"
	trashDirectory         = "trash"
	historyDirectory       = "history"
)

type Store struct {
	mu                       sync.RWMutex
	root                     string
	vaultID                  string
	key                      []byte
	manifest                 manifest
	searchIndex              map[string]string
	authorizedFolders        map[string]struct{}
	exportBaselines          map[string]manifest
	exportDirty              map[string]struct{}
	exportIncremental        bool
	noteIndexes              map[string]int
	folderIndexes            map[string]int
	sharedAttachmentRefs     map[string]int
	pendingSharedAttachments map[string]map[string]struct{}
	savedManifestHash        [sha256.Size]byte
	hasSavedManifestHash     bool
	timeTrackingCatalog      *timeTrackingCatalog
	timeTrackingBucketCache  map[string]timeTrackingBucket
	timeTrackingBucketOrder  []string
	timeTrackingBucketRead   func(string)
	timeTrackingWriteHook    func(string, string) error
	timeTrackingNow          func() time.Time
	manifestWriteHook        func() error
}

func NewStore() *Store {
	return &Store{}
}

// SnapshotRevision identifies the current provider-neutral vault contents.
// It is cheap to compare and changes whenever persisted sync metadata changes.
func (s *Store) SnapshotRevision() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return "", err
	}
	data, err := snapshotRevisionData(s.manifest, s.timeTrackingCatalog)
	if err != nil {
		return "", fmt.Errorf("encode snapshot revision: %w", err)
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

func snapshotRevisionData(value manifest, tracking *timeTrackingCatalog) ([]byte, error) {
	return json.Marshal(struct {
		Manifest manifest             `json:"manifest"`
		Tracking *timeTrackingCatalog `json:"tracking,omitempty"`
	}{Manifest: value, Tracking: tracking})
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
	s.manifest = manifest{
		FormatVersion: FormatVersion,
		VaultID:       vaultID,
		Folders:       []Folder{},
		Notes:         []NoteSummary{},
		Settings:      defaultVaultSettings(),
	}
	s.searchIndex = make(map[string]string)
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
	if err := s.loadManifestLocked(); err != nil {
		s.clearLocked()
		return Session{}, fmt.Errorf("open encrypted manifest: %w", err)
	}
	if hasTimeTrackingCapability(s.manifest) {
		if err := s.loadTimeTrackingCatalogLocked(); err != nil {
			s.clearLocked()
			return Session{}, fmt.Errorf("open encrypted tracking catalog: %w", err)
		}
	}
	_ = s.rebuildSearchIndexLocked()
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

func defaultVaultSettings() VaultSettings {
	return VaultSettings{
		DailyNoteFormat: "YYYY-MM-DD", AutosaveIntervalSeconds: 60, AutoSyncMinutes: 15,
		AutoLockMinutes: 15, FileHistoryLimit: 10, SectionDefault: "collapsed",
	}
}

func normalizeVaultSettings(settings VaultSettings) VaultSettings {
	defaults := defaultVaultSettings()
	if strings.TrimSpace(settings.DailyNoteFormat) == "" {
		settings.DailyNoteFormat = defaults.DailyNoteFormat
	}
	if settings.AutosaveIntervalSeconds < 60 {
		settings.AutosaveIntervalSeconds = defaults.AutosaveIntervalSeconds
	}
	if settings.AutoSyncMinutes < 1 {
		settings.AutoSyncMinutes = defaults.AutoSyncMinutes
	}
	if settings.AutoLockMinutes < 1 {
		settings.AutoLockMinutes = defaults.AutoLockMinutes
	}
	if settings.FileHistoryLimit < 1 {
		settings.FileHistoryLimit = defaults.FileHistoryLimit
	} else if settings.FileHistoryLimit > 50 {
		settings.FileHistoryLimit = 50
	}
	if settings.SectionDefault != "expanded" && settings.SectionDefault != "collapsed" {
		settings.SectionDefault = defaults.SectionDefault
	}
	return settings
}

func (s *Store) GetVaultSettings() (VaultSettings, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return VaultSettings{}, err
	}
	return normalizeVaultSettings(s.manifest.Settings), nil
}

func (s *Store) SaveVaultSettings(settings VaultSettings) (VaultSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return VaultSettings{}, err
	}
	settings = normalizeVaultSettings(settings)
	settings.Revision = max(settings.Revision, s.manifest.Settings.Revision) + 1
	settings.ModifiedAt = time.Now().UnixMilli()
	previous := s.manifest.Settings
	s.manifest.Settings = settings
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Settings = previous
		return VaultSettings{}, err
	}
	return settings, nil
}

func (s *Store) ListNotes() ([]NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	result := make([]NoteSummary, 0, len(s.manifest.Notes))
	for _, note := range s.manifest.Notes {
		if s.requireNoteAccessibleLocked(note) == nil {
			result = append(result, note)
		}
	}
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
	if err := s.requireFolderAccessibleLocked(folderID); err != nil {
		return Note{}, err
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
	s.updateSearchIndexLocked(id, "")
	return noteForClient(note), nil
}

func (s *Store) ListFolders() ([]Folder, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	result := slices.Clone(s.manifest.Folders)
	for index := range result {
		result[index] = folderForClient(result[index])
	}
	sortFolders(result)
	return result, nil
}

func (s *Store) CreateFolder(name string, parentIDs ...string) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Folder{}, err
	}
	parentID := ""
	if len(parentIDs) > 0 {
		parentID = parentIDs[0]
	}
	if len(parentIDs) > 1 {
		return Folder{}, errors.New("only one parent folder is allowed")
	}
	if !s.folderExistsLocked(parentID) {
		return Folder{}, errors.New("parent folder not found")
	}
	if err := s.requireFolderAccessibleLocked(parentID); err != nil {
		return Folder{}, err
	}
	name, err := normalizeFolderName(name)
	if err != nil {
		return Folder{}, err
	}
	if s.folderNameExistsLocked(name, parentID, "") {
		return Folder{}, errors.New("a folder with this name already exists")
	}
	id, err := randomID(16)
	if err != nil {
		return Folder{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	folder := Folder{ID: id, Name: name, ParentID: parentID, Order: s.nextFolderOrderLocked(parentID), SortMode: "manual", CreatedAt: now, UpdatedAt: now}
	s.manifest.Folders = append(s.manifest.Folders, folder)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders = s.manifest.Folders[:len(s.manifest.Folders)-1]
		return Folder{}, err
	}
	return folderForClient(folder), nil
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
	if s.folderNameExistsLocked(name, s.manifest.Folders[index].ParentID, id) {
		return Folder{}, errors.New("a folder with this name already exists")
	}
	original := s.manifest.Folders[index]
	s.manifest.Folders[index].Name = name
	s.manifest.Folders[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders[index] = original
		return Folder{}, err
	}
	return folderForClient(s.manifest.Folders[index]), nil
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

// MoveFolder places a folder under a new parent. A folder cannot be nested
// within itself or one of its descendants.
func (s *Store) MoveFolder(id, parentID string) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return Folder{}, err
	}
	index, found := s.findFolderLocked(id)
	if !found {
		return Folder{}, errors.New("folder not found")
	}
	if id == parentID {
		return Folder{}, errors.New("a folder cannot contain itself")
	}
	if !s.folderExistsLocked(parentID) {
		return Folder{}, errors.New("parent folder not found")
	}
	if s.folderIsDescendantLocked(parentID, id) {
		return Folder{}, errors.New("a folder cannot contain one of its ancestors")
	}
	if err := s.requireFolderAccessibleLocked(id); err != nil {
		return Folder{}, err
	}
	if err := s.requireFolderAccessibleLocked(parentID); err != nil {
		return Folder{}, err
	}
	if s.manifest.Folders[index].ParentID == parentID {
		return folderForClient(s.manifest.Folders[index]), nil
	}
	if s.folderNameExistsLocked(s.manifest.Folders[index].Name, parentID, id) {
		return Folder{}, errors.New("a folder with this name already exists")
	}
	original := s.manifest.Folders[index]
	s.manifest.Folders[index].ParentID = parentID
	s.manifest.Folders[index].Order = s.nextFolderOrderLocked(parentID)
	s.manifest.Folders[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders[index] = original
		return Folder{}, err
	}
	return folderForClient(s.manifest.Folders[index]), nil
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
	s.manifest.Folders[index].Locked = true
	s.manifest.Folders[index].LockPasswordHash = verifier
	s.manifest.Folders[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest.Folders[index] = original
		return Folder{}, err
	}
	for authorizedID := range s.authorizedFolders {
		if authorizedID == id || s.folderIsDescendantLocked(authorizedID, id) {
			delete(s.authorizedFolders, authorizedID)
		}
	}
	return folderForClient(s.manifest.Folders[index]), nil
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
	delete(s.authorizedFolders, id)
	return folderForClient(s.manifest.Folders[index]), nil
}

func (s *Store) CheckFolderPassword(id, password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	if s.authorizedFolders == nil {
		s.authorizedFolders = make(map[string]struct{})
	}
	s.authorizedFolders[id] = struct{}{}
	return nil
}

func (s *Store) LockFolderSession(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	folder, found := s.folderByIDLocked(id)
	if !found {
		return errors.New("folder not found")
	}
	if !folder.Locked {
		return errors.New("folder is not locked")
	}
	for authorizedID := range s.authorizedFolders {
		if authorizedID == id || s.folderIsDescendantLocked(authorizedID, id) {
			delete(s.authorizedFolders, authorizedID)
		}
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
	return folderForClient(s.manifest.Folders[index]), nil
}

func folderForClient(folder Folder) Folder {
	folder.LockPasswordHash = ""
	return folder
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
	for _, folder := range s.manifest.Folders {
		if folder.ParentID == id {
			return errors.New("folder is not empty; move or delete its subfolders first")
		}
	}
	original := s.manifest.Folders
	originalDeleted := slices.Clone(s.manifest.DeletedFolders)
	if err := s.writeTrashedFolderLocked(original[index]); err != nil {
		return err
	}
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
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return Note{}, err
	}
	if err := s.requireFolderAccessibleLocked(folderID); err != nil {
		return Note{}, err
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
	if err := s.requireFolderAccessibleLocked(folderID); err != nil {
		return err
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

func (s *Store) GetNote(id string) (Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return Note{}, err
	}
	if _, found := s.findNoteLocked(id); !found {
		return Note{}, errors.New("note not found")
	}
	index, _ := s.findNoteLocked(id)
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return Note{}, err
	}
	note, err := s.readNoteLocked(id)
	if err != nil {
		return Note{}, err
	}
	return noteForClient(note), nil
}

func (s *Store) GetNoteSummary(id string) (NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return NoteSummary{}, err
	}
	index, found := s.findNoteLocked(id)
	if !found {
		return NoteSummary{}, errors.New("note not found")
	}
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return NoteSummary{}, err
	}
	return *cloneNoteSummary(s.manifest.Notes[index]), nil
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
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return Note{}, err
	}
	title, err := normalizeTitle(title)
	if err != nil {
		return Note{}, err
	}
	storedContent := canonicalizeNoteContent(content)
	if len(storedContent) > maxNoteBytes {
		return Note{}, errors.New("note exceeds the 10 MiB limit")
	}
	derivedContent := derivedMarkdownContent(storedContent)
	current, err := s.readNoteLocked(id)
	if err != nil {
		return Note{}, err
	}
	originalSummary := s.manifest.Notes[index]
	originalManifest := cloneManifest(s.manifest)
	contentMatches := current.Content == storedContent || derivedMarkdownContent(current.Content) == content
	if current.Title == title && contentMatches {
		if err := s.pruneNoteAttachmentsByIDLocked(id, extractAttachmentIDs(derivedContent)); err != nil {
			return Note{}, err
		}
		if err := s.prunePendingSharedAttachmentsLocked(id); err != nil {
			return Note{}, err
		}
		return noteForClientContent(current, derivedContent), nil
	}
	original := current
	if err := s.writeNoteHistoryLocked(current); err != nil {
		return Note{}, err
	}
	s.ensureSharedAttachmentRefsLocked()
	current.Title = title
	current.Content = storedContent
	now := time.Now().UTC()
	current.UpdatedAt = now.Format(time.RFC3339Nano)
	current.ModifiedAt = nextModifiedAt(current.ModifiedAt)
	current.Revision++
	hash := originalSummary.CiphertextHash
	originals := make(map[string]Note)
	if current.Content != original.Content {
		hash, err = s.writeNoteLocked(current)
		if err != nil {
			return Note{}, err
		}
		originals[id] = original
	}
	s.manifest.Notes[index] = summaryFromNoteContent(current, derivedContent)
	s.manifest.Notes[index].CiphertextHash = hash
	if err := s.saveManifestLocked(); err != nil {
		return Note{}, s.rollbackNoteWritesLocked(originalManifest, originals, err)
	}
	s.updateSharedAttachmentRefsLocked(originalSummary.AttachmentIDs, s.manifest.Notes[index].AttachmentIDs)
	s.updateSearchIndexLocked(id, derivedContent)
	if err := s.pruneNoteAttachmentsByIDLocked(id, s.manifest.Notes[index].AttachmentIDs); err != nil {
		return Note{}, err
	}
	if err := s.prunePendingSharedAttachmentsLocked(id); err != nil {
		return Note{}, err
	}
	return noteForClientContent(current, derivedContent), nil
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
	noteIndex, _ := s.findNoteLocked(noteID)
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[noteIndex]); err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > maxAttachmentBytes {
		return "", errors.New("image must be between 1 byte and 10 MiB")
	}
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return "", errors.New("image is not valid WebP data")
	}
	ids, err := s.sharedAttachmentIDsLocked()
	if err != nil {
		return "", err
	}
	// ponytail: O(n) encrypted scan; add a keyed hash index if paste latency becomes measurable.
	for existingID := range ids {
		existing, err := s.readEnvelopeLocked(
			s.sharedAttachmentPathLocked(existingID),
			"attachment",
			sharedAttachmentAAD(existingID),
		)
		if err == nil && bytes.Equal(existing, data) {
			s.trackPendingAttachmentLocked(noteID, existingID)
			return existingID, nil
		}
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
	s.trackPendingAttachmentLocked(noteID, id)
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
	noteIndex, _ := s.findNoteLocked(noteID)
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[noteIndex]); err != nil {
		return nil, err
	}
	if !validID(id) {
		return nil, errors.New("invalid attachment ID")
	}
	attachmentIDs, err := s.attachmentIDsForSummaryLocked(s.manifest.Notes[noteIndex])
	if err != nil {
		return nil, err
	}
	if !slices.Contains(attachmentIDs, id) && !s.pendingAttachmentBelongsToNoteLocked(noteID, id) {
		return nil, errors.New("attachment does not belong to this note")
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
			!strings.HasSuffix(entry.Name(), encryptedBackupSuffix) {
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

func (s *Store) ensureSharedAttachmentRefsLocked() {
	if s.sharedAttachmentRefs != nil {
		return
	}
	s.sharedAttachmentRefs = make(map[string]int)
	for _, summary := range s.manifest.Notes {
		for _, id := range summary.AttachmentIDs {
			s.sharedAttachmentRefs[id]++
		}
	}
}

func (s *Store) updateSharedAttachmentRefsLocked(before, after []string) {
	beforeSet := make(map[string]struct{}, len(before))
	afterSet := make(map[string]struct{}, len(after))
	for _, id := range before {
		beforeSet[id] = struct{}{}
	}
	for _, id := range after {
		afterSet[id] = struct{}{}
	}
	for id := range beforeSet {
		if _, kept := afterSet[id]; !kept && s.sharedAttachmentRefs[id] > 0 {
			s.sharedAttachmentRefs[id]--
		}
	}
	for id := range afterSet {
		if _, existed := beforeSet[id]; !existed {
			s.sharedAttachmentRefs[id]++
		}
	}
}

func (s *Store) trackPendingAttachmentLocked(noteID, id string) {
	if s.pendingSharedAttachments == nil {
		s.pendingSharedAttachments = make(map[string]map[string]struct{})
	}
	if s.pendingSharedAttachments[id] == nil {
		s.pendingSharedAttachments[id] = make(map[string]struct{})
	}
	s.pendingSharedAttachments[id][noteID] = struct{}{}
}

func (s *Store) pendingAttachmentBelongsToNoteLocked(noteID, id string) bool {
	_, found := s.pendingSharedAttachments[id][noteID]
	return found
}

func (s *Store) prunePendingSharedAttachmentsLocked(noteID string) error {
	if len(s.pendingSharedAttachments) == 0 {
		return nil
	}
	s.ensureSharedAttachmentRefsLocked()
	for id, owners := range s.pendingSharedAttachments {
		delete(owners, noteID)
		if len(owners) > 0 {
			continue
		}
		if s.sharedAttachmentRefs[id] == 0 {
			path := s.sharedAttachmentPathLocked(id)
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			_ = os.Remove(path + ".bak")
		}
		delete(s.pendingSharedAttachments, id)
	}
	return nil
}

func (s *Store) pruneSharedAttachmentsByIDLocked(candidates map[string]struct{}) error {
	if len(candidates) == 0 {
		return nil
	}
	referenced, err := s.referencedSharedAttachmentsLocked(candidates)
	if err != nil {
		return err
	}
	if len(referenced) == len(candidates) {
		return nil
	}
	return s.removeUnreferencedSharedAttachmentsLocked(candidates, referenced)
}

func (s *Store) referencedSharedAttachmentsLocked(candidates map[string]struct{}) (map[string]struct{}, error) {
	referenced := make(map[string]struct{}, len(candidates))
	for _, summary := range s.manifest.Notes {
		ids, err := s.attachmentIDsForSummaryLocked(summary)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			if _, ok := candidates[id]; ok {
				referenced[id] = struct{}{}
			}
		}
		if len(referenced) == len(candidates) {
			break
		}
	}
	return referenced, nil
}

func (s *Store) removeUnreferencedSharedAttachmentsLocked(
	candidates, referenced map[string]struct{},
) error {
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
			!strings.HasSuffix(entry.Name(), encryptedBackupSuffix) {
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
			!strings.HasSuffix(entry.Name(), encryptedBackupSuffix) {
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
	if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
		return err
	}
	original := s.manifest.Notes
	originalDeleted := slices.Clone(s.manifest.DeletedNotes)
	item := original[index]
	note, err := s.readNoteLocked(id)
	if err != nil {
		return err
	}
	if err := s.writeNoteHistoryLocked(note); err != nil {
		return err
	}
	if err := s.writeTrashedNoteLocked(note); err != nil {
		return err
	}
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
	delete(s.searchIndex, id)
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
		result := make([]NoteSummary, 0, len(s.manifest.Notes))
		for _, note := range s.manifest.Notes {
			if s.requireNoteAccessibleLocked(note) == nil {
				result = append(result, note)
			}
		}
		sortSummaries(result)
		return result, nil
	}
	result := make([]NoteSummary, 0)
	for _, item := range s.manifest.Notes {
		if s.requireNoteAccessibleLocked(item) != nil {
			continue
		}
		if strings.Contains(strings.ToLower(item.Title), query) {
			result = append(result, item)
			continue
		}
		content, indexed := s.searchIndex[item.ID]
		if !indexed {
			note, err := s.readNoteLocked(item.ID)
			if err != nil {
				return nil, err
			}
			content = derivedMarkdownContent(note.Content)
		}
		if strings.Contains(strings.ToLower(content), query) {
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
	if summary, fallback, resolved, err := s.resolveExplicitNoteReferenceLocked(reference); err != nil {
		return NoteSummary{}, err
	} else if resolved {
		return summary, nil
	} else {
		reference = fallback
	}
	if summary, found := s.findNoteByReferenceTitleLocked(strings.ToLower(reference)); found {
		return summary, nil
	}
	return NoteSummary{}, errors.New("note reference not found")
}

func (s *Store) resolveExplicitNoteReferenceLocked(reference string) (NoteSummary, string, bool, error) {
	if label, id, ok := parseNoteReference(reference); ok {
		if index, found := s.findNoteLocked(id); found {
			if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
				return NoteSummary{}, "", false, err
			}
			return s.manifest.Notes[index], "", true, nil
		}
		reference = label
	}
	if strings.HasPrefix(reference, "note:") {
		id := strings.TrimPrefix(reference, "note:")
		if index, found := s.findNoteLocked(id); found {
			if err := s.requireNoteAccessibleLocked(s.manifest.Notes[index]); err != nil {
				return NoteSummary{}, "", false, err
			}
			return s.manifest.Notes[index], "", true, nil
		}
		return NoteSummary{}, "", false, errors.New("note reference not found")
	}
	return NoteSummary{}, reference, false, nil
}

func (s *Store) findNoteByReferenceTitleLocked(normalized string) (NoteSummary, bool) {
	for _, item := range s.manifest.Notes {
		if s.requireNoteAccessibleLocked(item) != nil {
			continue
		}
		if strings.ToLower(item.Title) == normalized {
			return item, true
		}
		if item.FolderID != "" {
			if folder, found := s.folderByIDLocked(item.FolderID); found &&
				strings.ToLower(folder.Name+"/"+item.Title) == normalized {
				return item, true
			}
		}
	}
	return NoteSummary{}, false
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
	if err := s.requireNoteAccessibleLocked(target); err != nil {
		return nil, err
	}
	aliases := s.backlinkAliasesLocked(target)
	var matches []FindMatch
	for _, summary := range s.manifest.Notes {
		if summary.ID == noteID {
			continue
		}
		if s.requireNoteAccessibleLocked(summary) != nil {
			continue
		}
		found, err := s.backlinksForSummaryLocked(summary, target.ID, aliases)
		if err != nil {
			return nil, err
		}
		matches = append(matches, found...)
	}
	return matches, nil
}

func (s *Store) backlinkAliasesLocked(target NoteSummary) map[string]struct{} {
	aliases := map[string]struct{}{
		strings.ToLower(target.Title): {},
		"note:" + target.ID:           {},
	}
	if target.FolderID != "" {
		if folder, found := s.folderByIDLocked(target.FolderID); found {
			aliases[strings.ToLower(folder.Name+"/"+target.Title)] = struct{}{}
		}
	}
	return aliases
}

func (s *Store) backlinksForSummaryLocked(
	summary NoteSummary,
	targetID string,
	aliases map[string]struct{},
) ([]FindMatch, error) {
	if summary.OutgoingLinks != nil {
		for _, link := range summary.OutgoingLinks {
			if outgoingLinkMatches(link, targetID, aliases) {
				return []FindMatch{backlinkMetadataMatch(summary, link)}, nil
			}
		}
		return nil, nil
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
			if id == targetID {
				return []FindMatch{backlinkMatch(summary, content, match[0], match[1], raw)}, nil
			}
			key = strings.ToLower(label)
		}
		if _, ok := aliases[key]; ok {
			return []FindMatch{backlinkMatch(summary, content, match[0], match[1], raw)}, nil
		}
	}
	return nil, nil
}

func (s *Store) ListUnlinkedMentions(noteID string) ([]FindMatch, error) {
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
	needle := strings.ToLower(strings.TrimSpace(target.Title))
	if needle == "" {
		return []FindMatch{}, nil
	}
	result := make([]FindMatch, 0)
	for _, summary := range s.manifest.Notes {
		if summary.ID == noteID || s.requireNoteAccessibleLocked(summary) != nil {
			continue
		}
		mentions, err := s.unlinkedMentionsForSummaryLocked(summary, needle)
		if err != nil {
			return nil, err
		}
		result = append(result, mentions...)
	}
	return result, nil
}

func (s *Store) unlinkedMentionsForSummaryLocked(summary NoteSummary, needle string) ([]FindMatch, error) {
	content := s.searchIndex[summary.ID]
	if content == "" {
		note, err := s.readNoteLocked(summary.ID)
		if err != nil {
			return nil, err
		}
		content = derivedMarkdownContent(note.Content)
	}
	lower := strings.ToLower(content)
	linkedRanges := wikilinkPattern.FindAllStringIndex(content, -1)
	result := make([]FindMatch, 0)
	for offset := 0; offset < len(lower); {
		at := strings.Index(lower[offset:], needle)
		if at < 0 {
			break
		}
		at += offset
		linked := false
		for _, span := range linkedRanges {
			if at >= span[0] && at < span[1] {
				linked = true
				break
			}
		}
		if !linked {
			result = append(result, withUTF16Range(FindMatch{NoteID: summary.ID, Title: summary.Title, FolderID: summary.FolderID, Field: "content", Snippet: makeSnippet(content, at, len(needle)), Offset: at, MatchLength: len(needle)}, content))
		}
		offset = at + len(needle)
	}
	return result, nil
}

type SearchOptions struct {
	CaseSensitive bool
	WholeWord     bool
}

// FindInNotes decrypts every note, locates matches of query, and returns up
// to maxPerNote snippets per note. Matches report the
// exact offset and length inside the note's plain-text content so the
// editor can scroll to them.
func (s *Store) FindInNotes(query string, maxPerNote int) ([]FindMatch, error) {
	return s.FindInNotesWithOptions(query, maxPerNote, SearchOptions{})
}

func (s *Store) FindInNotesWithOptions(query string, maxPerNote int, options SearchOptions) ([]FindMatch, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	rawQuery := strings.TrimSpace(query)
	if _, advanced, err := parseAdvancedQuery(rawQuery); err != nil {
		return nil, err
	} else if advanced {
		return s.findAdvancedLocked(rawQuery, maxPerNote, options)
	}
	if rawQuery == "" {
		return []FindMatch{}, nil
	}
	if maxPerNote <= 0 {
		maxPerNote = 20
	}
	pattern, err := compileLiteralPattern(rawQuery, options)
	if err != nil {
		return nil, err
	}
	items := slices.Clone(s.manifest.Notes)
	sortSummaries(items)
	results := make([]FindMatch, 0)
	for _, item := range items {
		if s.requireNoteAccessibleLocked(item) != nil {
			continue
		}
		titleMatches := literalMatches(item.Title, pattern, options.WholeWord, maxPerNote)
		for _, match := range titleMatches {
			results = append(results, withUTF16Range(FindMatch{
				NoteID:      item.ID,
				Title:       item.Title,
				FolderID:    item.FolderID,
				Field:       "title",
				Snippet:     makeSnippet(item.Title, match[0], match[1]-match[0]),
				Offset:      match[0],
				MatchLength: match[1] - match[0],
			}, item.Title))
		}
		content, indexed := s.searchIndex[item.ID]
		if !indexed {
			note, err := s.readNoteLocked(item.ID)
			if err != nil {
				return nil, err
			}
			content = derivedMarkdownContent(note.Content)
		}
		contentMatches := literalMatches(content, pattern, options.WholeWord, maxPerNote)
		for _, match := range contentMatches {
			results = append(results, withUTF16Range(FindMatch{
				NoteID:      item.ID,
				Title:       item.Title,
				FolderID:    item.FolderID,
				Field:       "content",
				Snippet:     makeSnippet(content, match[0], match[1]-match[0]),
				Offset:      match[0],
				MatchLength: match[1] - match[0],
			}, content))
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

// ReplaceAcrossNotes performs a literal replacement of find with replace.
// When noteIDs is empty every note is processed;
// otherwise only the listed notes are updated. The encrypted envelope and
// ModifiedAt are refreshed for every modified note so sync reconciles the
// new content.
func (s *Store) ReplaceAcrossNotes(find, replace string, noteIDs []string) (ReplaceResult, error) {
	return s.ReplaceAcrossNotesWithOptions(find, replace, noteIDs, SearchOptions{})
}

func (s *Store) ReplaceAcrossNotesWithOptions(find, replace string, noteIDs []string, options SearchOptions) (ReplaceResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return ReplaceResult{}, err
	}
	pattern, err := compileReplacementPattern(find, options)
	if err != nil {
		return ReplaceResult{}, err
	}
	allowed := make(map[string]struct{}, len(noteIDs))
	for _, id := range noteIDs {
		allowed[id] = struct{}{}
	}
	restricted := len(noteIDs) > 0
	result := ReplaceResult{}
	indexedContent := make(map[string]string)
	originalManifest := cloneManifest(s.manifest)
	originals := make(map[string]Note)
	rollback := func(err error) (ReplaceResult, error) {
		return ReplaceResult{}, s.rollbackNoteWritesLocked(originalManifest, originals, err)
	}
	for index, item := range s.manifest.Notes {
		if restricted {
			if _, ok := allowed[item.ID]; !ok {
				continue
			}
		}
		if err := s.requireNoteAccessibleLocked(item); err != nil {
			if restricted {
				return rollback(err)
			}
			continue
		}
		replacements, changed, err := s.replaceNoteLocked(
			index, item, pattern, replace, options, originals, indexedContent,
		)
		if err != nil {
			return rollback(err)
		}
		if changed {
			result.Replacements += replacements
			result.ReplacedNotes++
		}
	}
	if result.ReplacedNotes > 0 {
		if err := s.saveManifestLocked(); err != nil {
			return rollback(err)
		}
		for id, content := range indexedContent {
			s.updateSearchIndexLocked(id, content)
		}
	}
	return result, nil
}

func compileReplacementPattern(find string, options SearchOptions) (*regexp.Regexp, error) {
	if find == "" {
		return nil, errors.New("search text is required")
	}
	if strings.Contains(find, "\n") {
		return nil, errors.New("search text cannot contain line breaks")
	}
	if _, advanced, err := parseAdvancedQuery(strings.TrimSpace(find)); err != nil {
		return nil, err
	} else if advanced {
		return nil, errors.New("advanced search queries cannot be replaced")
	}
	return compileLiteralPattern(find, options)
}

func (s *Store) replaceNoteLocked(
	index int,
	item NoteSummary,
	pattern *regexp.Regexp,
	replace string,
	options SearchOptions,
	originals map[string]Note,
	indexedContent map[string]string,
) (int, bool, error) {
	note, err := s.readNoteLocked(item.ID)
	if err != nil {
		return 0, false, err
	}
	titleMatches := literalMatches(note.Title, pattern, options.WholeWord, -1)
	newTitle := note.Title
	if len(titleMatches) > 0 {
		newTitle = replaceLiteralMatches(note.Title, titleMatches, replace)
	}
	content := derivedMarkdownContent(note.Content)
	contentMatches := literalMatches(content, pattern, options.WholeWord, -1)
	if newTitle == note.Title && len(contentMatches) == 0 {
		return 0, false, nil
	}
	newContent := note.Content
	if len(contentMatches) > 0 {
		newContent = canonicalizeNoteContent(replaceLiteralMatches(content, contentMatches, replace))
	}
	updated := Note{
		ID:         note.ID,
		Title:      newTitle,
		FolderID:   note.FolderID,
		Order:      note.Order,
		Content:    newContent,
		CreatedAt:  note.CreatedAt,
		UpdatedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		ModifiedAt: nextModifiedAt(note.ModifiedAt),
		Revision:   note.Revision + 1,
	}
	hash, err := s.writeNoteLocked(updated)
	if err != nil {
		return 0, false, err
	}
	originals[note.ID] = note
	s.manifest.Notes[index] = summaryFromNote(updated)
	s.manifest.Notes[index].CiphertextHash = hash
	if len(contentMatches) > 0 {
		indexedContent[updated.ID] = derivedMarkdownContent(updated.Content)
	}
	return len(titleMatches) + len(contentMatches), true, nil
}

func compileLiteralPattern(query string, options SearchOptions) (*regexp.Regexp, error) {
	expression := regexp.QuoteMeta(query)
	if !options.CaseSensitive {
		expression = `(?i:` + expression + `)`
	}
	return regexp.Compile(expression)
}

func literalMatches(value string, pattern *regexp.Regexp, wholeWord bool, limit int) [][]int {
	matches := pattern.FindAllStringIndex(value, -1)
	result := make([][]int, 0, len(matches))
	for _, match := range matches {
		if wholeWord && !isWholeWordMatch(value, match[0], match[1]) {
			continue
		}
		result = append(result, match)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result
}

func isWholeWordMatch(value string, start, end int) bool {
	if start > 0 {
		before, _ := utf8.DecodeLastRuneInString(value[:start])
		if unicode.IsLetter(before) || unicode.IsNumber(before) || before == '_' {
			return false
		}
	}
	if end < len(value) {
		after, _ := utf8.DecodeRuneInString(value[end:])
		if unicode.IsLetter(after) || unicode.IsNumber(after) || after == '_' {
			return false
		}
	}
	return true
}

func replaceLiteralMatches(value string, matches [][]int, replacement string) string {
	var builder strings.Builder
	start := 0
	for _, match := range matches {
		builder.WriteString(value[start:match[0]])
		builder.WriteString(replacement)
		start = match[1]
	}
	builder.WriteString(value[start:])
	return builder.String()
}

// ExportRemoteSnapshot writes the provider-neutral encrypted repository
// layout. It deliberately excludes the local manifest and all backup files.
func (s *Store) ExportRemoteSnapshot(destination string) error {
	s.mu.Lock()
	if err := s.requireUnlocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	if err := s.pruneStaleAttachmentsLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	if s.timeTrackingCatalog != nil && len(s.timeTrackingCatalog.Conflicts) > 0 {
		s.mu.Unlock()
		return errors.New("resolve time-tracking conflicts before exporting or pushing the vault")
	}
	s.mu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		s.mu.RLock()
		if err := s.requireUnlocked(); err != nil {
			s.mu.RUnlock()
			return err
		}
		manifestData, err := snapshotRevisionData(s.manifest, s.timeTrackingCatalog)
		if err != nil {
			s.mu.RUnlock()
			return err
		}
		captured := cloneManifest(s.manifest)
		revision := sha256.Sum256(manifestData)
		destinationKey := filepath.Clean(destination)
		baseline, incremental := s.exportBaselines[destinationKey]
		dirty := changedSnapshotNoteIDs(baseline, captured)
		snapshot := &Store{
			root: s.root, vaultID: s.vaultID, key: slices.Clone(s.key), manifest: captured,
			exportDirty: dirty, exportIncremental: incremental,
		}
		if s.timeTrackingCatalog != nil {
			tracking := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
			snapshot.timeTrackingCatalog = &tracking
		}
		s.mu.RUnlock()
		if err := snapshot.exportRemoteSnapshot(destination); err != nil {
			return err
		}
		current, err := s.SnapshotRevision()
		if err != nil {
			return err
		}
		if current == hex.EncodeToString(revision[:]) {
			s.mu.Lock()
			if s.exportBaselines == nil {
				s.exportBaselines = make(map[string]manifest)
			}
			s.exportBaselines[destinationKey] = captured
			s.mu.Unlock()
			return nil
		}
	}
	return errors.New("vault changed repeatedly while preparing its sync snapshot")
}

func changedSnapshotNoteIDs(before, after manifest) map[string]struct{} {
	dirty := make(map[string]struct{})
	previous := make(map[string]NoteSummary, len(before.Notes))
	for _, note := range before.Notes {
		previous[note.ID] = note
	}
	for _, note := range after.Notes {
		old, found := previous[note.ID]
		if !found || old.Revision != note.Revision || old.CiphertextHash != note.CiphertextHash ||
			!slices.Equal(old.AttachmentIDs, note.AttachmentIDs) {
			dirty[note.ID] = struct{}{}
		}
		delete(previous, note.ID)
	}
	for id := range previous {
		dirty[id] = struct{}{}
	}
	return dirty
}

func cloneManifest(source manifest) manifest {
	result := source
	result.Capabilities = slices.Clone(source.Capabilities)
	result.Folders = slices.Clone(source.Folders)
	result.DeletedNotes = slices.Clone(source.DeletedNotes)
	result.DeletedFolders = slices.Clone(source.DeletedFolders)
	result.Notes = make([]NoteSummary, len(source.Notes))
	for index, note := range source.Notes {
		result.Notes[index] = *cloneNoteSummary(note)
	}
	return result
}

func (s *Store) rollbackNoteWritesLocked(original manifest, notes map[string]Note, cause error) error {
	s.manifest = cloneManifest(original)
	s.noteIndexes = nil
	var rollbackErr error
	for id, note := range notes {
		hash, err := s.writeNoteLocked(note)
		if err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		if index, found := s.findNoteLocked(id); found {
			s.manifest.Notes[index].CiphertextHash = hash
		}
	}
	if len(notes) > 0 {
		s.hasSavedManifestHash = false
		rollbackErr = errors.Join(rollbackErr, s.saveManifestLocked())
	}
	return errors.Join(cause, rollbackErr)
}

func (s *Store) prepareRemoteSnapshotDestinationLocked(destination string) error {
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
	return nil
}

func (s *Store) exportRemoteNotesLocked(
	destination string,
	items []NoteSummary,
	existingObjects map[string]remoteSyncObject,
) (remoteSyncManifest, error) {
	inventory := remoteSyncManifest{
		FormatVersion: FormatVersion,
		VaultID:       s.vaultID,
		Objects:       make([]remoteSyncObject, 0, len(items)+len(s.manifest.DeletedNotes)),
	}
	expectedObjects := make(map[string]struct{}, len(items))
	for _, item := range items {
		object, path, err := s.exportRemoteNoteLocked(destination, item, existingObjects[item.ID])
		if err != nil {
			return remoteSyncManifest{}, err
		}
		expectedObjects[path] = struct{}{}
		inventory.Objects = append(inventory.Objects, object)
	}
	for _, deleted := range s.manifest.DeletedNotes {
		inventory.Objects = append(inventory.Objects, remoteSyncObject{
			ID: deleted.ID, Revision: deleted.Revision, ModifiedAt: deleted.ModifiedAt, Deleted: true,
		})
	}
	slices.SortFunc(inventory.Objects, func(left, right remoteSyncObject) int {
		return strings.Compare(left.ID, right.ID)
	})
	if err := removeUnexpectedSnapshotObjects(filepath.Join(destination, "objects"), expectedObjects); err != nil {
		return remoteSyncManifest{}, err
	}
	return inventory, nil
}

func (s *Store) exportRemoteNoteLocked(
	destination string,
	item NoteSummary,
	existing remoteSyncObject,
) (remoteSyncObject, string, error) {
	source := s.notePathLocked(item.ID)
	target := filepath.Join(destination, "objects", item.ID[:2], item.ID+".enc")
	_, dirty := s.exportDirty[item.ID]
	if existing.ID != "" && item.CiphertextHash != "" &&
		existing.CiphertextHash == item.CiphertextHash &&
		existing.Revision == item.Revision &&
		existing.ModifiedAt == item.ModifiedAt &&
		existing.Summary != nil && !existing.Deleted &&
		((s.exportIncremental && !dirty) || (!s.exportIncremental && sameRegularFileSize(source, target))) {
		existing.Summary = cloneNoteSummary(item)
		return existing, filepath.Clean(target), nil
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return remoteSyncObject{}, "", fmt.Errorf("read encrypted note %s for remote snapshot: %w", item.ID, err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return remoteSyncObject{}, "", fmt.Errorf("create remote note object folder: %w", err)
	}
	if err := writeBytesIfChangedFast(target, data); err != nil {
		return remoteSyncObject{}, "", fmt.Errorf("stage encrypted remote note %s: %w", item.ID, err)
	}
	hash := sha256.Sum256(data)
	hashText := hex.EncodeToString(hash[:])
	if item.CiphertextHash != hashText {
		if index, found := s.findNoteLocked(item.ID); found {
			s.manifest.Notes[index].CiphertextHash = hashText
		}
	}
	return remoteSyncObject{
		ID: item.ID, CiphertextHash: hashText, Revision: item.Revision,
		ModifiedAt: item.ModifiedAt, Summary: cloneNoteSummary(item),
	}, filepath.Clean(target), nil
}

func (s *Store) exportRemoteSnapshot(destination string) error {
	if err := s.prepareRemoteSnapshotDestinationLocked(destination); err != nil {
		return err
	}

	items := slices.Clone(s.manifest.Notes)
	sortSummaries(items)
	existingObjects := s.readExistingRemoteInventoryLocked(destination)
	inventory, err := s.exportRemoteNotesLocked(destination, items, existingObjects)
	if err != nil {
		return err
	}
	if err := s.exportAttachmentsLocked(destination); err != nil {
		return err
	}
	if err := s.exportTimeTrackingLocked(destination); err != nil {
		return err
	}
	return s.writeRemoteSnapshotMetadataLocked(destination, inventory)
}

func (s *Store) writeRemoteSnapshotMetadataLocked(
	destination string,
	inventory remoteSyncManifest,
) error {
	inventoryPlaintext, err := json.Marshal(inventory)
	if err != nil {
		return fmt.Errorf("encode remote sync inventory: %w", err)
	}
	inventoryPath := filepath.Join(destination, syncDirectory, syncManifestFile)
	if err := s.writeRemoteEnvelopeIfChangedLocked(
		inventoryPath,
		syncManifestObjectType,
		syncManifestObjectType,
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
		Settings:      s.manifest.Settings,
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
		syncFoldersObjectType,
		syncFoldersObjectType,
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
	if err := s.requireUnlocked(); err != nil {
		s.mu.RUnlock()
		return false, err
	}
	local := &Store{
		root: s.root, vaultID: s.vaultID, key: slices.Clone(s.key), manifest: cloneManifest(s.manifest),
	}
	if s.timeTrackingCatalog != nil {
		tracking := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
		local.timeTrackingCatalog = &tracking
	}
	revisionData, err := snapshotRevisionData(local.manifest, local.timeTrackingCatalog)
	s.mu.RUnlock()
	if err != nil {
		return false, err
	}
	revision := sha256.Sum256(revisionData)

	remote, err := local.readRemoteSnapshotLocked(source, true, false)
	if err != nil {
		return false, err
	}
	matches, err := local.remoteSnapshotMatchesLocked(remote)
	if err != nil {
		return false, err
	}
	current, err := s.SnapshotRevision()
	if err != nil {
		return false, err
	}
	if current != hex.EncodeToString(revision[:]) {
		return false, nil
	}
	return matches, nil
}

func (s *Store) remoteSnapshotMatchesLocked(remote authenticatedRemoteSnapshot) (bool, error) {
	localFolders := slices.Clone(s.manifest.Folders)
	sortFolders(localFolders)
	localDeletedFolders := slices.Clone(s.manifest.DeletedFolders)
	sortTombstones(localDeletedFolders)
	localDeletedNotes := slices.Clone(s.manifest.DeletedNotes)
	sortTombstones(localDeletedNotes)
	matches := slices.Equal(remote.Manifest.Folders, localFolders) &&
		slices.Equal(remote.Manifest.DeletedFolders, localDeletedFolders) &&
		slices.Equal(remote.Manifest.DeletedNotes, localDeletedNotes) &&
		remote.Manifest.Settings == s.manifest.Settings &&
		len(remote.Objects) == len(s.manifest.Notes)+len(localDeletedNotes)
	trackingMatches, err := s.timeTrackingSnapshotMatchesLocked(remote.Tracking)
	if err != nil {
		return false, err
	}
	if !matches || !trackingMatches {
		return false, nil
	}
	for _, note := range s.manifest.Notes {
		remoteObject, exists := remote.Objects[note.ID]
		if !exists || remoteObject.Revision != note.Revision {
			return false, nil
		}
		data, err := os.ReadFile(s.notePathLocked(note.ID))
		if err != nil {
			return false, fmt.Errorf("read local encrypted note %s: %w", note.ID, err)
		}
		hash := sha256.Sum256(data)
		if hex.EncodeToString(hash[:]) != remoteObject.CiphertextHash {
			return false, nil
		}
	}
	for _, deleted := range localDeletedNotes {
		remoteObject, exists := remote.Objects[deleted.ID]
		if !exists || !remoteObject.Deleted ||
			remoteObject.Revision != deleted.Revision ||
			remoteObject.ModifiedAt != deleted.ModifiedAt {
			return false, nil
		}
	}
	return true, nil
}

func (s *Store) readExistingRemoteInventoryLocked(
	root string,
) map[string]remoteSyncObject {
	plaintext, err := s.readEnvelopeFileLocked(
		filepath.Join(root, syncDirectory, syncManifestFile),
		syncManifestObjectType,
		syncManifestObjectType,
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
	if strings.TrimSpace(source) == "" {
		return MergeResult{}, errors.New("remote snapshot source is required")
	}
	for attempt := 0; attempt < 3; attempt++ {
		s.mu.RLock()
		if err := s.requireUnlocked(); err != nil {
			s.mu.RUnlock()
			return MergeResult{}, err
		}
		manifestData, err := snapshotRevisionData(s.manifest, s.timeTrackingCatalog)
		validator := &Store{root: s.root, vaultID: s.vaultID, key: slices.Clone(s.key)}
		s.mu.RUnlock()
		if err != nil {
			return MergeResult{}, err
		}
		remote, err := validator.readRemoteSnapshotLocked(source, false, false)
		if err != nil {
			return MergeResult{}, err
		}
		s.mu.Lock()
		currentData, err := snapshotRevisionData(s.manifest, s.timeTrackingCatalog)
		if err != nil {
			s.mu.Unlock()
			return MergeResult{}, err
		}
		if !bytes.Equal(manifestData, currentData) {
			s.mu.Unlock()
			continue
		}
		result, err := s.mergeRemoteSnapshotLocked(source, remote)
		s.mu.Unlock()
		return result, err
	}
	return MergeResult{}, errors.New("vault changed repeatedly while planning its remote merge")
}

func (s *Store) mergeRemoteNotesLocked(
	source string,
	remote authenticatedRemoteSnapshot,
	result *MergeResult,
) ([]NoteSummary, []Tombstone, error) {
	mergedNotes := make([]NoteSummary, 0, len(s.manifest.Notes)+len(remote.Manifest.Notes))
	mergedNotes = append(mergedNotes, s.manifest.Notes...)
	mergedDeletedNotes := slices.Clone(s.manifest.DeletedNotes)
	mergedNotes, mergedDeletedNotes = s.mergeRemoteDeletedNotesLocked(
		mergedNotes, mergedDeletedNotes, remote.Manifest.DeletedNotes, result,
	)

	noteIndexes := make(map[string]int, len(mergedNotes))
	for index, note := range mergedNotes {
		noteIndexes[note.ID] = index
	}
	for _, remoteNote := range remote.Manifest.Notes {
		var err error
		mergedNotes, mergedDeletedNotes, err = s.mergeRemoteNoteLocked(
			source, remoteNote, mergedNotes, mergedDeletedNotes, noteIndexes, result,
		)
		if err != nil {
			return nil, nil, err
		}
	}
	sortSummaries(mergedNotes)
	return mergedNotes, mergedDeletedNotes, nil
}

func (s *Store) mergeRemoteDeletedNotesLocked(
	mergedNotes []NoteSummary,
	mergedDeletedNotes []Tombstone,
	deletedNotes []Tombstone,
	result *MergeResult,
) ([]NoteSummary, []Tombstone) {
	localNotes := make(map[string]NoteSummary, len(mergedNotes))
	for _, note := range mergedNotes {
		localNotes[note.ID] = note
	}
	deletedNoteIDs := make(map[string]struct{})
	for _, deleted := range deletedNotes {
		local, found := localNotes[deleted.ID]
		var localModified int64
		var localRevision uint64
		if found {
			localModified = local.ModifiedAt
			localRevision = local.Revision
			if versionIsNewer(deleted.Revision, deleted.ModifiedAt, local.Revision, local.ModifiedAt) {
				deletedNoteIDs[deleted.ID] = struct{}{}
				removeFileAndBackup(s.notePathLocked(deleted.ID))
				_ = os.RemoveAll(filepath.Join(s.root, "attachments", deleted.ID))
				result.DeletedNotes++
				result.UpToDate = false
			}
		}
		if !found || versionIsNewer(deleted.Revision, deleted.ModifiedAt, localRevision, localModified) {
			mergedDeletedNotes = upsertTombstone(mergedDeletedNotes, deleted)
		}
	}
	if len(deletedNoteIDs) == 0 {
		return mergedNotes, mergedDeletedNotes
	}
	kept := mergedNotes[:0]
	for _, note := range mergedNotes {
		if _, deleted := deletedNoteIDs[note.ID]; !deleted {
			kept = append(kept, note)
		}
	}
	return kept, mergedDeletedNotes
}

func (s *Store) mergeRemoteNoteLocked(
	source string,
	remoteNote NoteSummary,
	mergedNotes []NoteSummary,
	mergedDeletedNotes []Tombstone,
	noteIndexes map[string]int,
	result *MergeResult,
) ([]NoteSummary, []Tombstone, error) {
	if deleted, found := findTombstone(mergedDeletedNotes, remoteNote.ID); found &&
		!versionIsNewer(remoteNote.Revision, remoteNote.ModifiedAt, deleted.Revision, deleted.ModifiedAt) {
		return mergedNotes, mergedDeletedNotes, nil
	}
	mergedDeletedNotes = removeTombstone(mergedDeletedNotes, remoteNote.ID)
	localIndex, found := noteIndexes[remoteNote.ID]
	if !found {
		localIndex = -1
	}
	if localIndex < 0 {
		if err := copyRemoteNoteObject(source, s.root, remoteNote.ID); err != nil {
			return nil, nil, err
		}
		if err := replaceRemoteAttachments(source, s.root, remoteNote.ID); err != nil {
			return nil, nil, err
		}
		mergedNotes = append(mergedNotes, remoteNote)
		noteIndexes[remoteNote.ID] = len(mergedNotes) - 1
		result.PulledNotes++
		result.UpToDate = false
		return mergedNotes, mergedDeletedNotes, nil
	}
	return s.mergeExistingRemoteNoteLocked(
		source, remoteNote, mergedNotes, mergedDeletedNotes, localIndex, result,
	)
}

func (s *Store) mergeExistingRemoteNoteLocked(
	source string,
	remoteNote NoteSummary,
	mergedNotes []NoteSummary,
	mergedDeletedNotes []Tombstone,
	localIndex int,
	result *MergeResult,
) ([]NoteSummary, []Tombstone, error) {
	local := mergedNotes[localIndex]
	if remoteNote.Revision == local.Revision && remoteNote.CiphertextHash != "" &&
		local.CiphertextHash != "" && remoteNote.CiphertextHash != local.CiphertextHash {
		localNote, err := s.readNoteFromSummaryAtLocked(s.root, local)
		if err != nil {
			return nil, nil, err
		}
		remoteNoteData, err := s.readNoteFromSummaryAtLocked(source, remoteNote)
		if err != nil {
			return nil, nil, err
		}
		result.Conflicts = append(result.Conflicts, MergeConflict{
			LocalNoteID: local.ID, RemoteNoteID: remoteNote.ID, Title: local.Title,
			Message:      "Local and remote edits conflicted. Resolve the final version before syncing.",
			LocalContent: derivedMarkdownContent(localNote.Content), RemoteContent: derivedMarkdownContent(remoteNoteData.Content),
		})
		result.UpToDate = false
		return mergedNotes, mergedDeletedNotes, nil
	}
	if versionIsNewer(remoteNote.Revision, remoteNote.ModifiedAt, local.Revision, local.ModifiedAt) {
		if err := copyRemoteNoteObject(source, s.root, remoteNote.ID); err != nil {
			return nil, nil, err
		}
		if err := replaceRemoteAttachments(source, s.root, remoteNote.ID); err != nil {
			return nil, nil, err
		}
		mergedNotes[localIndex] = remoteNote
		result.UpdatedNotes++
		result.UpToDate = false
		return mergedNotes, mergedDeletedNotes, nil
	}
	if !versionIsNewer(local.Revision, local.ModifiedAt, remoteNote.Revision, remoteNote.ModifiedAt) {
		if err := replaceRemoteAttachments(source, s.root, remoteNote.ID); err != nil {
			return nil, nil, err
		}
	}
	return mergedNotes, mergedDeletedNotes, nil
}

func (s *Store) mergeRemoteFoldersLocked(
	remote authenticatedRemoteSnapshot,
	mergedNotes []NoteSummary,
	result *MergeResult,
) ([]Folder, []Tombstone, error) {
	mergedFolders := slices.Clone(s.manifest.Folders)
	mergedDeletedFolders := slices.Clone(s.manifest.DeletedFolders)
	mergedFolders, mergedDeletedFolders = mergeRemoteFolderUpdates(
		remote.Manifest.Folders, mergedFolders, mergedDeletedFolders, result,
	)
	mergedFolders, mergedDeletedFolders = mergeRemoteFolderDeletions(
		remote.Manifest.DeletedFolders, mergedFolders, mergedDeletedFolders, mergedNotes, result,
	)
	sortFolders(mergedFolders)
	if err := validateFolderHierarchy(mergedFolders); err != nil {
		return nil, nil, fmt.Errorf("merged folder hierarchy %w", err)
	}
	return mergedFolders, mergedDeletedFolders, nil
}

func mergeRemoteFolderUpdates(
	remoteFolders []Folder,
	mergedFolders []Folder,
	mergedDeletedFolders []Tombstone,
	result *MergeResult,
) ([]Folder, []Tombstone) {
	folderIndexes := make(map[string]int, len(mergedFolders))
	for index, folder := range mergedFolders {
		folderIndexes[folder.ID] = index
	}
	for _, remoteFolder := range remoteFolders {
		if deleted, found := findTombstone(mergedDeletedFolders, remoteFolder.ID); found {
			updated, _ := time.Parse(time.RFC3339Nano, remoteFolder.UpdatedAt)
			if deleted.ModifiedAt >= updated.Unix() {
				continue
			}
			mergedDeletedFolders = removeTombstone(mergedDeletedFolders, remoteFolder.ID)
		}
		index, found := folderIndexes[remoteFolder.ID]
		if found {
			local := mergedFolders[index]
			if remoteFolder.UpdatedAt > local.UpdatedAt {
				mergedFolders[index] = remoteFolder
				result.PulledFolders++
				result.UpToDate = false
			}
		}
		if !found {
			mergedFolders = append(mergedFolders, remoteFolder)
			folderIndexes[remoteFolder.ID] = len(mergedFolders) - 1
			result.PulledFolders++
			result.UpToDate = false
		}
	}
	return mergedFolders, mergedDeletedFolders
}

func mergeRemoteFolderDeletions(
	deletedFolders []Tombstone,
	mergedFolders []Folder,
	mergedDeletedFolders []Tombstone,
	mergedNotes []NoteSummary,
	result *MergeResult,
) ([]Folder, []Tombstone) {
	folderByID := make(map[string]Folder, len(mergedFolders))
	childCounts := make(map[string]int)
	noteFolderRefs := make(map[string]struct{})
	for _, folder := range mergedFolders {
		folderByID[folder.ID] = folder
		if folder.ParentID != "" {
			childCounts[folder.ParentID]++
		}
	}
	for _, note := range mergedNotes {
		if note.FolderID != "" {
			noteFolderRefs[note.FolderID] = struct{}{}
		}
	}
	deletedFolderIDs := make(map[string]struct{})
	for _, deleted := range deletedFolders {
		local, found := folderByID[deleted.ID]
		acceptTombstone := true
		if found {
			updated, _ := time.Parse(time.RFC3339Nano, local.UpdatedAt)
			_, referenced := noteFolderRefs[deleted.ID]
			if deleted.ModifiedAt <= updated.Unix() || referenced || childCounts[deleted.ID] > 0 {
				acceptTombstone = false
			} else {
				deletedFolderIDs[deleted.ID] = struct{}{}
				if local.ParentID != "" && childCounts[local.ParentID] > 0 {
					childCounts[local.ParentID]--
				}
				result.DeletedFolders++
				result.UpToDate = false
			}
		}
		if acceptTombstone {
			before, existed := findTombstone(mergedDeletedFolders, deleted.ID)
			mergedDeletedFolders = upsertTombstone(mergedDeletedFolders, deleted)
			if !found && (!existed || deleted.ModifiedAt > before.ModifiedAt) {
				result.UpToDate = false
			}
		}
	}
	if len(deletedFolderIDs) > 0 {
		kept := mergedFolders[:0]
		for _, folder := range mergedFolders {
			if _, deleted := deletedFolderIDs[folder.ID]; !deleted {
				kept = append(kept, folder)
			}
		}
		mergedFolders = kept
	}
	return mergedFolders, mergedDeletedFolders
}

func (s *Store) mergeRemoteSnapshotLocked(source string, remote authenticatedRemoteSnapshot) (MergeResult, error) {
	result := MergeResult{UpToDate: true}
	if err := reconcileRemoteAttachmentDirectory(
		filepath.Join(source, "attachments", sharedAttachmentFolder),
		filepath.Join(s.root, "attachments", sharedAttachmentFolder),
	); err != nil {
		return MergeResult{}, fmt.Errorf("reconcile shared attachments: %w", err)
	}
	mergedNotes, mergedDeletedNotes, err := s.mergeRemoteNotesLocked(source, remote, &result)
	if err != nil {
		return MergeResult{}, err
	}

	mergedFolders, mergedDeletedFolders, err := s.mergeRemoteFoldersLocked(remote, mergedNotes, &result)
	if err != nil {
		return MergeResult{}, err
	}
	mergedSettings := s.manifest.Settings
	if settingsVersionIsNewer(remote.Manifest.Settings, mergedSettings) {
		mergedSettings = remote.Manifest.Settings
		result.UpdatedSettings = true
		result.UpToDate = false
	}
	trackingConflicts, trackingChanged, err := s.mergeTimeTrackingSnapshotLocked(remote.Tracking)
	if err != nil {
		return MergeResult{}, err
	}
	result.TrackingConflicts = trackingConflicts
	if trackingChanged || len(trackingConflicts) > 0 {
		result.UpToDate = false
	}

	if result.UpToDate {
		return result, nil
	}
	s.manifest.Folders = mergedFolders
	s.manifest.Notes = mergedNotes
	s.manifest.DeletedNotes = mergedDeletedNotes
	s.manifest.DeletedFolders = mergedDeletedFolders
	s.manifest.Settings = mergedSettings
	if err := s.saveManifestLocked(); err != nil {
		return MergeResult{}, fmt.Errorf("save merged manifest: %w", err)
	}
	s.searchIndex = nil
	_ = s.rebuildSearchIndexLocked()
	return result, nil
}

func settingsVersionIsNewer(left, right VaultSettings) bool {
	if left.Revision != right.Revision {
		return left.Revision > right.Revision
	}
	return left.ModifiedAt > right.ModifiedAt
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
	target := filepath.Join(localRoot, "attachments", noteID)
	sourceDir := filepath.Join(source, "attachments", noteID)
	return reconcileRemoteAttachmentDirectory(sourceDir, target)
}

func reconcileRemoteAttachmentDirectory(source, target string) error {
	if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
		return os.RemoveAll(target)
	} else if err != nil {
		return err
	}
	expected := make(map[string]struct{})
	if err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return err
		}
		if err := copyFileIfChangedFast(path, destination); err != nil {
			return err
		}
		expected[filepath.Clean(destination)] = struct{}{}
		return nil
	}); err != nil {
		return err
	}
	return removeUnexpectedSnapshotObjects(target, expected)
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
		return s.exportAttachmentEntryLocked(sourceRoot, targetRoot, path, entry, walkErr, expected)
	})
	if err != nil {
		return err
	}
	return removeUnexpectedSnapshotObjects(targetRoot, expected)
}

func (s *Store) exportAttachmentEntryLocked(
	sourceRoot, targetRoot, path string,
	entry os.DirEntry,
	walkErr error,
	expected map[string]struct{},
) error {
	if walkErr != nil || entry.IsDir() {
		return walkErr
	}
	relative, err := filepath.Rel(sourceRoot, path)
	if err != nil {
		return err
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) == 2 && strings.HasSuffix(parts[1], encryptedBackupSuffix) {
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
		return s.validateRemoteAttachmentEntryLocked(root, path, entry, walkErr, remoteNotes)
	})
}

func (s *Store) validateRemoteAttachmentEntryLocked(
	root, path string,
	entry os.DirEntry,
	walkErr error,
	remoteNotes map[string]remoteSyncObject,
) error {
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
		payload, fileErr := s.readEnvelopeFileLocked(path, "file-attachment", objectID)
		if fileErr != nil {
			return fmt.Errorf("authenticate remote attachment: %w", err)
		}
		if _, _, fileErr = decodeFileAttachment(payload); fileErr != nil {
			return fileErr
		}
		return nil
	}
	if len(data) == 0 || len(data) > maxAttachmentBytes ||
		len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return errors.New("remote attachment contains invalid WebP data")
	}
	return nil
}

type remoteSnapshotMetadata struct {
	Config         vaultConfig
	Inventory      remoteSyncManifest
	Folders        []Folder
	DeletedFolders []Tombstone
	Settings       VaultSettings
}

func (s *Store) readRemoteSnapshotMetadataLocked(source string) (remoteSnapshotMetadata, error) {
	var metadata remoteSnapshotMetadata
	if err := readJSONFile(filepath.Join(source, configFilename), 1024*1024, &metadata.Config); err != nil {
		return remoteSnapshotMetadata{}, fmt.Errorf("read remote vault configuration: %w", err)
	}
	if err := validateConfig(metadata.Config); err != nil {
		return remoteSnapshotMetadata{}, fmt.Errorf("validate remote vault configuration: %w", err)
	}
	if metadata.Config.VaultID != s.vaultID {
		return remoteSnapshotMetadata{}, errors.New("remote repository belongs to another vault")
	}
	inventoryPlaintext, err := s.readEnvelopeFileLocked(
		filepath.Join(source, syncDirectory, syncManifestFile),
		syncManifestObjectType,
		syncManifestObjectType,
	)
	if err != nil {
		return remoteSnapshotMetadata{}, fmt.Errorf("authenticate remote sync inventory: %w", err)
	}
	if err := json.Unmarshal(inventoryPlaintext, &metadata.Inventory); err != nil {
		return remoteSnapshotMetadata{}, errors.New("remote sync inventory is damaged")
	}
	if metadata.Inventory.FormatVersion != FormatVersion || metadata.Inventory.VaultID != s.vaultID {
		return remoteSnapshotMetadata{}, errors.New("remote sync inventory belongs to another vault or format")
	}
	folderPlaintext, err := s.readEnvelopeFileLocked(
		filepath.Join(source, syncDirectory, syncFoldersFile),
		syncFoldersObjectType,
		syncFoldersObjectType,
	)
	if err != nil {
		return remoteSnapshotMetadata{}, fmt.Errorf("authenticate remote folder metadata: %w", err)
	}
	var folderManifest remoteFolderManifest
	if err := json.Unmarshal(folderPlaintext, &folderManifest); err != nil {
		return remoteSnapshotMetadata{}, errors.New("remote folder metadata is damaged")
	}
	if folderManifest.FormatVersion != FormatVersion || folderManifest.VaultID != s.vaultID {
		return remoteSnapshotMetadata{}, errors.New("remote folder metadata belongs to another vault or format")
	}
	metadata.Settings = normalizeVaultSettings(folderManifest.Settings)
	if metadata.Settings.ModifiedAt < 0 ||
		(folderManifest.Settings.ModifiedAt != 0 && metadata.Settings != folderManifest.Settings) {
		return remoteSnapshotMetadata{}, errors.New("remote settings contain invalid data")
	}
	metadata.Folders = slices.Clone(folderManifest.Folders)
	sortFolders(metadata.Folders)
	metadata.DeletedFolders, err = validateRemoteFolderMetadata(metadata.Folders, folderManifest.Deleted)
	if err != nil {
		return remoteSnapshotMetadata{}, err
	}
	return metadata, nil
}

func validateRemoteFolderMetadata(folders []Folder, deleted []Tombstone) ([]Tombstone, error) {
	seen := make(map[string]struct{}, len(folders)+len(deleted))
	for _, folder := range folders {
		if !validID(folder.ID) {
			return nil, errors.New("remote folder metadata contains an invalid folder ID")
		}
		normalizedName, err := normalizeFolderName(folder.Name)
		if err != nil || normalizedName != folder.Name {
			return nil, errors.New("remote folder metadata contains an invalid folder name")
		}
		if _, err := time.Parse(time.RFC3339Nano, folder.CreatedAt); err != nil {
			return nil, errors.New("remote folder metadata contains an invalid creation time")
		}
		if _, err := time.Parse(time.RFC3339Nano, folder.UpdatedAt); err != nil {
			return nil, errors.New("remote folder metadata contains an invalid update time")
		}
		if _, duplicate := seen[folder.ID]; duplicate {
			return nil, errors.New("remote folder metadata contains a duplicate folder")
		}
		seen[folder.ID] = struct{}{}
	}
	if err := validateFolderHierarchy(folders); err != nil {
		return nil, fmt.Errorf("remote folder metadata %w", err)
	}
	result := slices.Clone(deleted)
	sortTombstones(result)
	for _, item := range result {
		if !validID(item.ID) || item.ModifiedAt < 0 {
			return nil, errors.New("remote folder metadata contains an invalid tombstone")
		}
		if _, live := seen[item.ID]; live {
			return nil, errors.New("remote folder is both live and deleted")
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return nil, errors.New("remote folder metadata contains a duplicate tombstone")
		}
		seen[item.ID] = struct{}{}
	}
	return result, nil
}

func (s *Store) readRemoteSnapshotObjectsLocked(
	source string,
	inventory remoteSyncManifest,
	remoteFolders []Folder,
	verifyAllObjects bool,
	validateDerivedMetadata bool,
) (map[string]remoteSyncObject, []NoteSummary, int, error) {
	seen := make(map[string]struct{}, len(inventory.Objects))
	remoteNotes := make(map[string]remoteSyncObject, len(inventory.Objects))
	noteSummaries := make([]NoteSummary, 0, len(inventory.Objects))
	liveObjectCount := 0
	for _, item := range inventory.Objects {
		if err := validateRemoteInventoryObject(item); err != nil {
			return nil, nil, 0, err
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return nil, nil, 0, errors.New("remote sync inventory contains a duplicate object")
		}
		seen[item.ID] = struct{}{}
		object, summary, live, err := s.readRemoteSnapshotObjectLocked(
			source, item, remoteFolders, verifyAllObjects, validateDerivedMetadata,
		)
		if err != nil {
			return nil, nil, 0, err
		}
		remoteNotes[item.ID] = object
		if live {
			liveObjectCount++
			noteSummaries = append(noteSummaries, *summary)
		}
	}
	return remoteNotes, noteSummaries, liveObjectCount, nil
}

func validateRemoteInventoryObject(item remoteSyncObject) error {
	if !validID(item.ID) || item.Revision == 0 || item.ModifiedAt < 0 {
		return errors.New("remote sync inventory contains an invalid object")
	}
	return nil
}

func (s *Store) readRemoteSnapshotObjectLocked(
	source string,
	item remoteSyncObject,
	remoteFolders []Folder,
	verifyAllObjects bool,
	validateDerivedMetadata bool,
) (remoteSyncObject, *NoteSummary, bool, error) {
	if err := validateRemoteInventoryObject(item); err != nil {
		return remoteSyncObject{}, nil, false, err
	}
	if item.Deleted {
		if item.CiphertextHash != "" {
			return remoteSyncObject{}, nil, false, errors.New("remote deleted object unexpectedly contains a hash")
		}
		return item, nil, false, nil
	}
	if len(item.CiphertextHash) != sha256.Size*2 {
		return remoteSyncObject{}, nil, false, errors.New("remote sync inventory contains an invalid object hash")
	}
	if _, err := hex.DecodeString(item.CiphertextHash); err != nil {
		return remoteSyncObject{}, nil, false, errors.New("remote sync inventory contains an invalid object hash")
	}
	if !verifyAllObjects {
		if localIndex, found := s.findNoteLocked(item.ID); found {
			local := s.manifest.Notes[localIndex]
			if local.CiphertextHash == item.CiphertextHash && local.Revision == item.Revision && local.ModifiedAt == item.ModifiedAt {
				return item, &local, true, nil
			}
		}
	}
	path := filepath.Join(source, "objects", item.ID[:2], item.ID+".enc")
	data, err := os.ReadFile(path)
	if err != nil {
		return remoteSyncObject{}, nil, false, fmt.Errorf("read remote encrypted note %s: %w", item.ID, err)
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != item.CiphertextHash {
		return remoteSyncObject{}, nil, false, fmt.Errorf("remote encrypted note %s does not match its inventory hash", item.ID)
	}
	var summary NoteSummary
	var note Note
	if item.Summary != nil {
		summary = *cloneNoteSummary(*item.Summary)
		if summary.ID != item.ID {
			return remoteSyncObject{}, nil, false, fmt.Errorf("remote encrypted note %s metadata is inconsistent", item.ID)
		}
		note, err = s.readNoteFromSummaryAtLocked(source, summary)
	} else {
		note, err = s.readLegacyNoteAtLocked(source, item.ID)
		summary = summaryFromNote(note)
	}
	if err != nil {
		return remoteSyncObject{}, nil, false, fmt.Errorf("authenticate remote encrypted note %s: %w", item.ID, err)
	}
	if err := validateRemoteNote(note, item, remoteFolders, validateDerivedMetadata); err != nil {
		return remoteSyncObject{}, nil, false, err
	}
	if !validateDerivedMetadata {
		derived := summaryFromNote(note)
		summary.Tags = derived.Tags
		summary.AttachmentIDs = derived.AttachmentIDs
		summary.OutgoingLinks = derived.OutgoingLinks
	}
	summary.CiphertextHash = item.CiphertextHash
	return item, &summary, true, nil
}

func validateRemoteObjectsDirectoryLocked(
	objectsRoot string,
	remoteNotes map[string]remoteSyncObject,
	liveObjectCount int,
) error {
	if _, err := os.Stat(objectsRoot); errors.Is(err, os.ErrNotExist) && liveObjectCount == 0 {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect remote objects folder: %w", err)
	}
	return filepath.WalkDir(objectsRoot, func(path string, entry os.DirEntry, walkErr error) error {
		return validateRemoteObjectEntry(objectsRoot, path, entry, walkErr, remoteNotes)
	})
}

func validateRemoteObjectEntry(
	objectsRoot, path string,
	entry os.DirEntry,
	walkErr error,
	remoteNotes map[string]remoteSyncObject,
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
}

func (s *Store) readRemoteSnapshotLocked(
	source string,
	verifyAllObjects bool,
	validateDerivedMetadata bool,
) (authenticatedRemoteSnapshot, error) {
	metadata, err := s.readRemoteSnapshotMetadataLocked(source)
	if err != nil {
		return authenticatedRemoteSnapshot{}, err
	}
	remoteConfig := metadata.Config
	inventory := metadata.Inventory
	remoteFolders := metadata.Folders
	remoteDeletedFolders := metadata.DeletedFolders
	remoteSettings := metadata.Settings

	remoteNotes, noteSummaries, liveObjectCount, err := s.readRemoteSnapshotObjectsLocked(
		source, inventory, remoteFolders, verifyAllObjects, validateDerivedMetadata,
	)
	if err != nil {
		return authenticatedRemoteSnapshot{}, err
	}
	objectsRoot := filepath.Join(source, "objects")
	if err := validateRemoteObjectsDirectoryLocked(objectsRoot, remoteNotes, liveObjectCount); err != nil {
		return authenticatedRemoteSnapshot{}, err
	}
	if err := s.validateRemoteAttachmentsLocked(source, remoteNotes); err != nil {
		return authenticatedRemoteSnapshot{}, err
	}
	remoteTracking, err := s.readRemoteTimeTrackingLocked(source)
	if err != nil {
		return authenticatedRemoteSnapshot{}, err
	}
	sortSummaries(noteSummaries)
	remoteFormat := FormatVersion
	var remoteCapabilities []string
	if remoteTracking != nil {
		remoteFormat = TimeTrackingManifestFormatVersion
		remoteCapabilities = []string{TimeTrackingCapability}
	}
	return authenticatedRemoteSnapshot{
		Config: remoteConfig,
		Manifest: manifest{
			FormatVersion:  remoteFormat,
			VaultID:        s.vaultID,
			Capabilities:   remoteCapabilities,
			Folders:        remoteFolders,
			Notes:          noteSummaries,
			DeletedFolders: remoteDeletedFolders,
			DeletedNotes:   tombstonesFromRemoteObjects(remoteNotes),
			Settings:       remoteSettings,
		},
		Objects:  remoteNotes,
		Tracking: remoteTracking,
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
			filepath.Join(directory, item.ID+encryptedBackupSuffix),
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
	if remote.Tracking != nil {
		if err := restoreTrackingCiphertext(source, stagingRoot, remote.Tracking); err != nil {
			return Session{}, err
		}
		tracking := cloneTimeTrackingCatalog(remote.Tracking.Catalog)
		validator.timeTrackingCatalog = &tracking
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
	s.manifest = remote.Manifest
	if remote.Tracking != nil {
		tracking := cloneTimeTrackingCatalog(remote.Tracking.Catalog)
		s.timeTrackingCatalog = &tracking
	}
	s.searchIndex = nil
	_ = s.rebuildSearchIndexLocked()
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
	s.key = nil
	s.root = ""
	s.vaultID = ""
	s.manifest = manifest{}
	s.searchIndex = nil
	s.authorizedFolders = nil
	s.noteIndexes = nil
	s.folderIndexes = nil
	s.sharedAttachmentRefs = nil
	s.pendingSharedAttachments = nil
	s.exportBaselines = nil
	s.hasSavedManifestHash = false
	s.timeTrackingCatalog = nil
	s.timeTrackingBucketCache = nil
	s.timeTrackingBucketOrder = nil
	s.timeTrackingBucketRead = nil
	s.timeTrackingWriteHook = nil
	s.timeTrackingNow = nil
	s.manifestWriteHook = nil
}

func (s *Store) updateSearchIndexLocked(id, content string) {
	if s.searchIndex != nil {
		s.searchIndex[id] = content
	}
}

func (s *Store) rebuildSearchIndexLocked() error {
	index := make(map[string]string, len(s.manifest.Notes))
	for _, item := range s.manifest.Notes {
		note, err := s.readNoteLocked(item.ID)
		if err != nil {
			return err
		}
		content := derivedMarkdownContent(note.Content)
		index[item.ID] = content
	}
	s.searchIndex = index
	return nil
}

func (s *Store) findNoteLocked(id string) (int, bool) {
	if len(s.noteIndexes) != len(s.manifest.Notes) {
		s.rebuildNoteIndexesLocked()
	}
	if index, found := s.noteIndexes[id]; found && index < len(s.manifest.Notes) && s.manifest.Notes[index].ID == id {
		return index, true
	}
	s.rebuildNoteIndexesLocked()
	index, found := s.noteIndexes[id]
	if !found {
		return -1, false
	}
	return index, found
}

func (s *Store) rebuildNoteIndexesLocked() {
	s.noteIndexes = make(map[string]int, len(s.manifest.Notes))
	for index, note := range s.manifest.Notes {
		s.noteIndexes[note.ID] = index
	}
}

func (s *Store) requireNoteAccessibleLocked(note NoteSummary) error {
	return s.requireFolderAccessibleLocked(note.FolderID)
}

func (s *Store) requireFolderAccessibleLocked(id string) error {
	seen := make(map[string]struct{})
	for id != "" {
		if _, duplicate := seen[id]; duplicate {
			return errors.New("folder hierarchy contains a cycle")
		}
		seen[id] = struct{}{}
		folder, found := s.folderByIDLocked(id)
		if !found {
			return errors.New("folder not found")
		}
		if folder.Locked {
			if _, authorized := s.authorizedFolders[id]; !authorized {
				return ErrFolderLocked
			}
		}
		id = folder.ParentID
	}
	return nil
}

func (s *Store) findFolderLocked(id string) (int, bool) {
	if len(s.folderIndexes) != len(s.manifest.Folders) {
		s.rebuildFolderIndexesLocked()
	}
	if index, found := s.folderIndexes[id]; found && index < len(s.manifest.Folders) && s.manifest.Folders[index].ID == id {
		return index, true
	}
	s.rebuildFolderIndexesLocked()
	index, found := s.folderIndexes[id]
	if !found {
		return -1, false
	}
	return index, found
}

func (s *Store) rebuildFolderIndexesLocked() {
	s.folderIndexes = make(map[string]int, len(s.manifest.Folders))
	for index, folder := range s.manifest.Folders {
		s.folderIndexes[folder.ID] = index
	}
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

func (s *Store) folderNameExistsLocked(name, parentID, excludingID string) bool {
	for _, folder := range s.manifest.Folders {
		if folder.ID != excludingID && folder.ParentID == parentID && strings.EqualFold(folder.Name, name) {
			return true
		}
	}
	return false
}

func (s *Store) folderIsDescendantLocked(id, ancestorID string) bool {
	seen := make(map[string]struct{})
	for id != "" {
		if id == ancestorID {
			return true
		}
		if _, duplicate := seen[id]; duplicate {
			return true
		}
		seen[id] = struct{}{}
		folder, found := s.folderByIDLocked(id)
		if !found {
			return false
		}
		id = folder.ParentID
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
		path, noteContentObjectType, note.ID, payload, compression,
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
		plaintext, err = s.readEnvelopeLocked(path, noteContentObjectType, id)
	} else {
		plaintext, err = s.readEnvelopeFileLocked(path, noteContentObjectType, id)
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
	if hasTimeTrackingCapability(s.manifest) && s.timeTrackingCatalog == nil {
		catalog := newTimeTrackingCatalog(s.vaultID)
		if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
			return fmt.Errorf("initialize tracking catalog: %w", err)
		}
		s.timeTrackingCatalog = &catalog
	}
	plaintext, err := json.Marshal(s.manifest)
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	hash := sha256.Sum256(plaintext)
	if s.hasSavedManifestHash && hash == s.savedManifestHash {
		return nil
	}
	if s.manifestWriteHook != nil {
		if err := s.manifestWriteHook(); err != nil {
			return err
		}
	}
	if err := s.writeEnvelopeLocked(filepath.Join(s.root, manifestFilename), "manifest", "manifest", plaintext); err != nil {
		return err
	}
	s.savedManifestHash = hash
	s.hasSavedManifestHash = true
	return nil
}

func (s *Store) loadManifestLocked() error {
	result, err := s.readManifestAtLocked(s.root)
	if err != nil {
		return err
	}
	s.manifest = result
	plaintext, err := json.Marshal(result)
	if err == nil {
		s.savedManifestHash = sha256.Sum256(plaintext)
		s.hasSavedManifestHash = true
	}
	return nil
}

func (s *Store) readManifestAtLocked(root string) (manifest, error) {
	plaintext, err := s.readManifestPlaintextLocked(root)
	if err != nil {
		return manifest{}, err
	}
	var result manifest
	if err := json.Unmarshal(plaintext, &result); err != nil {
		return manifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	if result.VaultID != s.vaultID {
		return manifest{}, errors.New("manifest belongs to another vault or format version")
	}
	if err := validateManifestCapabilities(result.FormatVersion, result.Capabilities); err != nil {
		return manifest{}, err
	}
	result.Settings = normalizeVaultSettings(result.Settings)
	if err := validateManifestFolders(&result); err != nil {
		return manifest{}, err
	}
	if err := validateManifestNotes(result); err != nil {
		return manifest{}, err
	}
	if err := validateManifestTombstones(result); err != nil {
		return manifest{}, err
	}
	sortTombstones(result.DeletedNotes)
	sortTombstones(result.DeletedFolders)
	return result, nil
}

func (s *Store) readManifestPlaintextLocked(root string) ([]byte, error) {
	path := filepath.Join(root, manifestFilename)
	if root == s.root {
		return s.readEnvelopeLocked(path, "manifest", "manifest")
	}
	return s.readEnvelopeFileLocked(path, "manifest", "manifest")
}

func validateManifestFolders(result *manifest) error {
	for index, folder := range result.Folders {
		if !validID(folder.ID) {
			return errors.New("manifest contains an invalid folder ID")
		}
		if _, err := normalizeFolderName(folder.Name); err != nil {
			return errors.New("manifest contains an invalid folder name")
		}
		result.Folders[index].SortMode = normalizeSortMode(folder.SortMode)
		if folder.Locked && folder.LockPasswordHash == "" {
			return errors.New("manifest contains a locked folder without a verifier")
		}
	}
	if err := validateFolderHierarchy(result.Folders); err != nil {
		return fmt.Errorf("manifest %w", err)
	}
	return nil
}

func validateManifestNotes(result manifest) error {
	for _, item := range result.Notes {
		if !validID(item.ID) {
			return errors.New("manifest contains an invalid note ID")
		}
		if item.FolderID != "" && !folderIDExists(result.Folders, item.FolderID) {
			return errors.New("manifest references a folder that does not exist")
		}
	}
	return nil
}

func validateManifestTombstones(result manifest) error {
	liveNotes := make(map[string]struct{}, len(result.Notes))
	for _, item := range result.Notes {
		liveNotes[item.ID] = struct{}{}
	}
	seenDeletedNotes := make(map[string]struct{}, len(result.DeletedNotes))
	for _, item := range result.DeletedNotes {
		if !validID(item.ID) || item.Revision == 0 || item.ModifiedAt < 0 {
			return errors.New("manifest contains an invalid note tombstone")
		}
		if _, live := liveNotes[item.ID]; live {
			return errors.New("manifest note is both live and deleted")
		}
		if _, duplicate := seenDeletedNotes[item.ID]; duplicate {
			return errors.New("manifest contains a duplicate note tombstone")
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
			return errors.New("manifest contains an invalid folder tombstone")
		}
		if _, live := liveFolders[item.ID]; live {
			return errors.New("manifest folder is both live and deleted")
		}
		if _, duplicate := seenDeletedFolders[item.ID]; duplicate {
			return errors.New("manifest contains a duplicate folder tombstone")
		}
		seenDeletedFolders[item.ID] = struct{}{}
	}
	return nil
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
		(value.Compression != "gzip" ||
			(objectType != "note" && objectType != noteContentObjectType && objectType != trackingBucketObjectType)) {
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
		if objectType == trackingBucketObjectType {
			return decompressPayload(plaintext, maxTimeTrackingBytes, "tracking bucket")
		}
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
	return atomicfile.Write(path, data, syncFile)
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
			(entry.Name() != syncManifestFile && entry.Name() != syncFoldersFile && entry.Name() != syncTrackingFile) {
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
	return summaryFromNoteContent(note, derivedMarkdownContent(note.Content))
}

func summaryFromNoteContent(note Note, derivedContent string) NoteSummary {
	return NoteSummary{
		ID: note.ID, Title: note.Title, FolderID: note.FolderID, Order: note.Order, CreatedAt: note.CreatedAt,
		UpdatedAt: note.UpdatedAt, ModifiedAt: note.ModifiedAt, Revision: note.Revision, Tags: extractTags(derivedContent),
		AttachmentIDs: extractAttachmentIDs(derivedContent), OutgoingLinks: extractOutgoingLinks(derivedContent),
		Properties: extractProperties(derivedContent),
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
	return noteForClientContent(note, derivedMarkdownContent(note.Content))
}

func noteForClientContent(note Note, derivedContent string) Note {
	note.Content = derivedContent
	return note
}

func cloneNoteSummary(summary NoteSummary) *NoteSummary {
	clone := summary
	clone.Tags = slices.Clone(summary.Tags)
	clone.AttachmentIDs = slices.Clone(summary.AttachmentIDs)
	clone.OutgoingLinks = slices.Clone(summary.OutgoingLinks)
	clone.Properties = cloneProperties(summary.Properties)
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
	Language        string   `json:"language,omitempty"`
	Closed          *bool    `json:"closed,omitempty"`
	AttachmentID    string   `json:"attachmentId,omitempty"`
	AttachmentKind  string   `json:"attachmentKind,omitempty"`
}

type parsedCanonicalLine struct {
	tag            string
	tags           []string
	indent         int
	contentIndent  int
	text           string
	checked        *bool
	sourcePrefix   string
	language       string
	attachmentID   string
	attachmentKind string
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
		document.Format == canonicalObjectDocumentFormat &&
		document.Version == 1
}

func canonicalObjectDocumentFromMarkdown(content string) canonicalObjectDocument {
	parser := canonicalMarkdownParser{lines: strings.Split(content, "\n"), parsedByID: map[string]parsedCanonicalLine{}}
	objects := parser.parse()
	return canonicalObjectDocument{Format: canonicalObjectDocumentFormat, Version: 1, Objects: objects}
}

type canonicalMarkdownParser struct {
	lines        []string
	objects      []*canonicalObjectNode
	stack        []*canonicalObjectNode
	sectionStack []*canonicalObjectNode
	parsedByID   map[string]parsedCanonicalLine
	activeCode   *canonicalObjectNode
	activeLines  []string
}

func (p *canonicalMarkdownParser) parse() []canonicalObjectNode {
	for index, raw := range p.lines {
		if p.consumeCodeLine(raw) || p.consumeBlankLine(index, raw) {
			continue
		}
		parsed := classifyCanonicalMarkdownLine(raw)
		if p.consumeContinuation(raw, parsed) {
			continue
		}
		p.appendObject(index+1, parsed)
	}
	objects := make([]canonicalObjectNode, 0, len(p.objects))
	for _, object := range p.objects {
		objects = append(objects, *object)
	}
	return objects
}

func (p *canonicalMarkdownParser) consumeCodeLine(raw string) bool {
	if p.activeCode == nil {
		return false
	}
	if canonicalCodeFenceEnd.MatchString(raw) {
		closed := true
		p.activeCode.Closed = &closed
		p.activeCode = nil
		p.activeLines = nil
	} else {
		p.activeLines = append(p.activeLines, raw)
		p.activeCode.Text = strings.Join(p.activeLines, "\n")
	}
	return true
}

func (p *canonicalMarkdownParser) consumeBlankLine(index int, raw string) bool {
	if raw == "" || strings.TrimSpace(raw) != "" {
		return false
	}
	usedAsContinuation := false
	if len(p.stack) > 0 {
		previous := p.stack[len(p.stack)-1]
		previousParsed := p.parsedByID[previous.ID]
		next := ""
		if index+1 < len(p.lines) {
			next = p.lines[index+1]
		}
		if strings.TrimSpace(next) != "" && startsWithWhitespace(next) &&
			!lineStartsExplicitCanonicalObject(next) && lineVisualIndent(next) >= previousParsed.contentIndent {
			previous.Text += "\n"
			usedAsContinuation = true
		}
	}
	return raw != "" || usedAsContinuation
}

func (p *canonicalMarkdownParser) consumeContinuation(raw string, parsed parsedCanonicalLine) bool {
	if len(p.stack) == 0 {
		return false
	}
	previous := p.stack[len(p.stack)-1]
	previousParsed := p.parsedByID[previous.ID]
	if previous.Text == "" || !startsWithWhitespace(raw) || lineStartsExplicitCanonicalObject(raw) ||
		parsed.indent < previousParsed.contentIndent {
		return false
	}
	previous.Text += "\n" + canonicalContinuationText(raw, previousParsed.contentIndent)
	return true
}

func (p *canonicalMarkdownParser) appendObject(lineNumber int, parsed parsedCanonicalLine) {
	for len(p.stack) > 0 && p.stack[len(p.stack)-1].Indent >= parsed.indent {
		p.stack = p.stack[:len(p.stack)-1]
	}
	for len(p.sectionStack) > 0 && p.sectionStack[len(p.sectionStack)-1].Indent >= parsed.indent {
		p.sectionStack = p.sectionStack[:len(p.sectionStack)-1]
	}
	parent := (*canonicalObjectNode)(nil)
	if len(p.stack) > 0 {
		parent = p.stack[len(p.stack)-1]
	}
	parentSection := (*canonicalObjectNode)(nil)
	if len(p.sectionStack) > 0 {
		parentSection = p.sectionStack[len(p.sectionStack)-1]
	}
	parentPath := ""
	if parent != nil {
		parentPath = parent.ID + "/"
	}
	id := stableCanonicalObjectID(fmt.Sprintf("%s%s:%d:%s:%d", parentPath, parsed.tag, parsed.indent, parsed.text, lineNumber))
	object := canonicalObjectNode{
		ID: id, Tag: parsed.tag, Tags: slices.Clone(parsed.tags), Text: parsed.text, Checked: parsed.checked,
		Indent: parsed.indent, ContentIndent: parsed.contentIndent, ChildrenIDs: []string{}, SourcePrefix: parsed.sourcePrefix,
		Language: parsed.language, AttachmentID: parsed.attachmentID, AttachmentKind: parsed.attachmentKind,
	}
	if object.Tag == "code" {
		closed := false
		object.Closed = &closed
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
	p.objects = append(p.objects, objectPointer)
	p.stack = append(p.stack, objectPointer)
	p.parsedByID[id] = parsed
	if object.Tag == "section" {
		p.sectionStack = append(p.sectionStack, objectPointer)
	}
	if object.Tag == "code" {
		p.activeCode = objectPointer
		p.activeLines = nil
	}
}

func stableCanonicalObjectID(input string) string {
	hash := sha256.Sum256([]byte(input))
	hexValue := hex.EncodeToString(hash[:])
	return fmt.Sprintf("%s-%s-4%s-%s-%s", hexValue[:8], hexValue[8:12], hexValue[13:16], hexValue[16:20], hexValue[20:32])
}

func classifyCanonicalMarkdownLine(raw string) parsedCanonicalLine {
	if fence := canonicalCodeFence.FindStringSubmatch(raw); fence != nil {
		return canonicalCodeLine(fence)
	}
	context := canonicalLineContextFor(raw)
	if parsed, ok := context.attachmentLine(); ok {
		return parsed
	}
	if parsed, ok := context.listLine(); ok {
		return parsed
	}
	return context.textLine()
}

func canonicalCodeLine(fence []string) parsedCanonicalLine {
	indent := visualIndent(fence[1])
	return parsedCanonicalLine{
		tag: "code", tags: []string{"code"}, indent: indent, contentIndent: indent,
		sourcePrefix: fence[1] + "```" + fence[2], language: fence[2],
	}
}

type canonicalLineContext struct {
	raw           string
	source        string
	tags          []string
	indent        int
	contentIndent int
	outline       bool
	sourcePrefix  func(string) string
}

func canonicalLineContextFor(raw string) canonicalLineContext {
	outline := canonicalOutline.FindStringSubmatch(raw)
	bare := canonicalBare.FindStringSubmatch(raw)
	if outline != nil {
		bare = nil
	}
	context := canonicalLineContext{raw: raw, source: strings.TrimLeft(raw, " \t"), tags: []string{}, indent: lineVisualIndent(raw)}
	context.contentIndent = context.indent
	if outline != nil {
		context.source = outline[4]
		context.tags = append(context.tags, "section")
		context.outline = true
		context.indent = visualIndent(outline[1]) + (len(outline[2])-1)*2
		context.contentIndent = visualIndent(outline[1]) + len(outline[2]) + visualIndent(outline[3])
	} else if bare != nil {
		context.source = bare[3]
	}
	context.sourcePrefix = func(text string) string {
		if text == "" {
			return raw
		}
		index := strings.Index(raw, text)
		if index >= 0 {
			return raw[:index]
		}
		if context.contentIndent > len(raw) {
			return raw
		}
		return raw[:context.contentIndent]
	}
	return context
}

func (context canonicalLineContext) attachmentLine() (parsedCanonicalLine, bool) {
	attachment := canonicalAttachment.FindStringSubmatch(context.source)
	if canonicalImage.MatchString(strings.TrimSpace(context.source)) && (attachment == nil || attachment[1] == "!") {
		text := strings.TrimSpace(context.source)
		tags := append(context.tags, "image")
		attachmentID, attachmentKind := "", ""
		if attachment != nil {
			tags = append(tags, "attachment")
			attachmentID, attachmentKind = attachment[2], "image"
		}
		return parsedCanonicalLine{
			tag: "image", tags: tags, indent: context.indent, contentIndent: context.contentIndent,
			text: text, sourcePrefix: context.sourcePrefix(text), attachmentID: attachmentID, attachmentKind: attachmentKind,
		}, true
	}
	if attachment == nil {
		return parsedCanonicalLine{}, false
	}
	text := strings.TrimSpace(context.source)
	return parsedCanonicalLine{
		tag: "text", tags: append(context.tags, "attachment", "text"), indent: context.indent,
		contentIndent: context.contentIndent, text: text, sourcePrefix: context.sourcePrefix(text),
		attachmentID: attachment[2], attachmentKind: "file",
	}, true
}

func (context canonicalLineContext) listLine() (parsedCanonicalLine, bool) {
	match := canonicalBullet.FindStringSubmatch(context.source)
	if match == nil {
		match = canonicalOrdered.FindStringSubmatch(context.source)
	}
	if match == nil {
		return parsedCanonicalLine{}, false
	}
	text, checked := canonicalListText(match[2])
	return parsedCanonicalLine{
		tag: "bulletpoint", tags: append(context.tags, "bulletpoint"), indent: context.indent,
		contentIndent: context.contentIndent + len(context.source) - len(text), text: text,
		checked: checked, sourcePrefix: context.sourcePrefix(text),
	}, true
}

func canonicalListText(value string) (string, *bool) {
	text := strings.TrimSpace(value)
	checkbox := canonicalCheckbox.FindStringSubmatch(value)
	if checkbox == nil {
		return text, nil
	}
	text = strings.TrimSpace(checkbox[2])
	checked := strings.EqualFold(checkbox[1], "x")
	return text, &checked
}

func (context canonicalLineContext) textLine() parsedCanonicalLine {
	tags := append(context.tags, "text")
	if strings.HasPrefix(context.source, "#") && canonicalHeading.MatchString(context.source) {
		tag := "text"
		if context.outline {
			tag = "section"
		}
		text := strings.TrimSpace(context.source)
		return parsedCanonicalLine{
			tag: tag, tags: tags, indent: context.indent, contentIndent: context.contentIndent,
			text: text, sourcePrefix: context.sourcePrefix(text),
		}
	}
	checkbox := canonicalCheckbox.FindStringSubmatch(context.source)
	text := strings.TrimSpace(context.source)
	checkboxContentIndent := -1
	var checked *bool
	if checkbox != nil {
		text = strings.TrimSpace(checkbox[2])
		checkboxContentIndent = context.contentIndent + len(context.source) - len(checkbox[2])
		value := strings.EqualFold(checkbox[1], "x")
		checked = &value
	}
	contentIndent := context.contentIndent
	if !context.outline && checkbox == nil {
		contentIndent = context.indent + 2
	}
	if checkboxContentIndent >= 0 {
		contentIndent = checkboxContentIndent
	}
	tag := "text"
	if context.outline {
		tag = "section"
	}
	return parsedCanonicalLine{
		tag: tag, tags: tags, indent: context.indent, contentIndent: contentIndent,
		text: text, checked: checked, sourcePrefix: context.sourcePrefix(text),
	}
}

func startsWithWhitespace(text string) bool {
	return strings.HasPrefix(text, " ") || strings.HasPrefix(text, "\t")
}

func lineStartsExplicitCanonicalObject(raw string) bool {
	outline := canonicalOutline.FindStringSubmatch(raw)
	bare := canonicalBare.FindStringSubmatch(raw)
	if outline != nil {
		bare = nil
	}
	source := strings.TrimLeft(raw, " \t")
	if outline != nil {
		source = outline[4]
	} else if bare != nil {
		source = bare[3]
	}
	return outline != nil ||
		bare != nil ||
		canonicalImage.MatchString(strings.TrimSpace(source)) ||
		canonicalAttachment.MatchString(source) ||
		canonicalTask.MatchString(source) ||
		canonicalBullet.MatchString(source) ||
		canonicalOrdered.MatchString(source) ||
		canonicalHeading.MatchString(source) ||
		canonicalCodeFence.MatchString(source)
}

func canonicalContinuationText(raw string, contentIndent int) string {
	offset, column := 0, 0
	for offset < len(raw) && column < contentIndent {
		switch raw[offset] {
		case ' ':
			column++
		case '\t':
			column += 2
		default:
			return strings.TrimRight(raw[offset:], " \t")
		}
		offset++
	}
	return strings.TrimRight(raw[offset:], " \t")
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
		document.Format != canonicalObjectDocumentFormat ||
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
	if object.Tag == "code" {
		return markdownCodeLine(object)
	}

	textLines := strings.Split(object.Text, "\n")
	firstText := ""
	if len(textLines) > 0 {
		firstText = textLines[0]
	}
	prefixHasCheckbox := canonicalCheckboxEnd.MatchString(object.SourcePrefix)
	if object.Checked != nil && !prefixHasCheckbox {
		firstText = canonicalCheckedText(firstText, *object.Checked)
	}
	prefix := canonicalObjectMarkdownPrefix(object, prefixHasCheckbox)
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

func markdownCodeLine(object canonicalObjectNode) string {
	indent := strings.Repeat(" ", max(0, object.Indent))
	lines := []string{indent + "```" + object.Language}
	if object.Text != "" {
		lines = append(lines, strings.Split(object.Text, "\n")...)
	}
	if object.Closed == nil || *object.Closed {
		lines = append(lines, indent+"```")
	}
	return strings.Join(lines, "\n")
}

func canonicalCheckedText(text string, checked bool) string {
	marker := "[ ] "
	if checked {
		marker = "[x] "
	}
	return strings.TrimRight(marker+text, " ")
}

func canonicalObjectMarkdownPrefix(object canonicalObjectNode, prefixHasCheckbox bool) string {
	hasSection := object.Tag == "section" || slices.Contains(object.Tags, "section")
	indent := strings.Repeat(" ", max(0, object.Indent))
	sourcePrefix := strings.TrimLeft(object.SourcePrefix, " \t")
	if prefixHasCheckbox && object.Checked != nil {
		marker := "[ ]"
		if *object.Checked {
			marker = "[x]"
		}
		sourcePrefix = canonicalCheckboxEnd.ReplaceAllString(sourcePrefix, marker+"$1")
	}
	switch {
	case hasSection:
		return indent + "> " + strings.TrimLeft(strings.TrimLeft(sourcePrefix, ">"), " \t")
	case strings.HasPrefix(sourcePrefix, "<"):
		return indent + sourcePrefix
	case sourcePrefix != "":
		return indent + sourcePrefix
	case object.Tag == "bulletpoint":
		return indent + "- "
	default:
		return indent
	}
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

func (s *Store) nextFolderOrderLocked(parentID string) int {
	next := 0
	for _, folder := range s.manifest.Folders {
		if folder.ParentID == parentID && folder.Order >= next {
			next = folder.Order + 1
		}
	}
	return next
}

func folderHasChild(folders []Folder, parentID string) bool {
	for _, folder := range folders {
		if folder.ParentID == parentID {
			return true
		}
	}
	return false
}

func validateFolderHierarchy(folders []Folder) error {
	byID, err := indexFolderHierarchy(folders)
	if err != nil {
		return err
	}
	for _, folder := range folders {
		if err := validateFolderParent(folder, byID); err != nil {
			return err
		}
	}
	return nil
}

func indexFolderHierarchy(folders []Folder) (map[string]Folder, error) {
	byID := make(map[string]Folder, len(folders))
	names := make(map[string]struct{}, len(folders))
	for _, folder := range folders {
		if _, duplicate := byID[folder.ID]; duplicate {
			return nil, errors.New("contains a duplicate folder")
		}
		byID[folder.ID] = folder
		nameKey := folder.ParentID + "\x00" + strings.ToLower(folder.Name)
		if _, duplicate := names[nameKey]; duplicate {
			return nil, errors.New("contains duplicate folder names")
		}
		names[nameKey] = struct{}{}
	}
	return byID, nil
}

func validateFolderParent(folder Folder, byID map[string]Folder) error {
	if folder.ParentID == "" {
		return nil
	}
	if folder.ParentID == folder.ID {
		return errors.New("contains a folder that parents itself")
	}
	if _, found := byID[folder.ParentID]; !found {
		return errors.New("contains a folder with a missing parent")
	}
	seen := map[string]struct{}{folder.ID: {}}
	for parentID := folder.ParentID; parentID != ""; {
		if _, duplicate := seen[parentID]; duplicate {
			return errors.New("contains a folder hierarchy cycle")
		}
		seen[parentID] = struct{}{}
		parentID = byID[parentID].ParentID
	}
	return nil
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
	if utf8.RuneCountInString(password) < 8 {
		return "", errors.New("folder password must contain at least 8 characters")
	}
	return deriveFolderPasswordVerifier(password)
}

func deriveFolderPasswordVerifier(password string) (string, error) {
	salt := make([]byte, folderPasswordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate folder password salt: %w", err)
	}
	hash, err := secure.DeriveKey(password, salt, defaultKDF)
	if err != nil {
		return "", err
	}
	defer secure.Zero(hash)
	return fmt.Sprintf("%s%s:%d:%d:%d:%s", folderPasswordVerifierPrefix,
		base64.RawURLEncoding.EncodeToString(salt), defaultKDF.Time, defaultKDF.Memory,
		defaultKDF.Threads, hex.EncodeToString(hash)), nil
}

func verifyFolderPassword(verifier, password string) bool {
	if strings.HasPrefix(verifier, folderPasswordVerifierPrefix) {
		payload := strings.TrimPrefix(verifier, folderPasswordVerifierPrefix)
		parts := strings.Split(payload, ":")
		if len(parts) != 5 {
			return false
		}
		salt, err := base64.RawURLEncoding.DecodeString(parts[0])
		if err != nil || len(salt) != folderPasswordSaltBytes {
			return false
		}
		timeCost, timeErr := strconv.ParseUint(parts[1], 10, 32)
		memory, memoryErr := strconv.ParseUint(parts[2], 10, 32)
		threads, threadsErr := strconv.ParseUint(parts[3], 10, 8)
		kdf := kdfConfiguration{Time: uint32(timeCost), MemoryKiB: uint32(memory), Parallelism: uint8(threads)}
		if timeErr != nil || memoryErr != nil || threadsErr != nil || !supportedKDFProfile(kdf) {
			return false
		}
		expected, err := hex.DecodeString(parts[4])
		if err != nil || len(expected) != sha256.Size {
			return false
		}
		actual, err := secure.DeriveKey(password, salt, secure.KDFParams{Time: kdf.Time, Memory: kdf.MemoryKiB, Threads: kdf.Parallelism})
		if err != nil {
			return false
		}
		defer secure.Zero(actual)
		return subtle.ConstantTimeCompare(actual, expected) == 1
	}
	return false
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
	content = inlineCodePattern.ReplaceAllString(content, "")
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
	return withUTF16Range(FindMatch{
		NoteID:      summary.ID,
		Title:       summary.Title,
		Field:       "content",
		Snippet:     makeSnippet(content, from, to-from),
		Offset:      from,
		MatchLength: len(raw) + 4,
	}, content)
}

func backlinkMetadataMatch(summary NoteSummary, raw string) FindMatch {
	content := "[[" + raw + "]]"
	return withUTF16Range(FindMatch{
		NoteID:      summary.ID,
		Title:       summary.Title,
		Field:       "content",
		Snippet:     content,
		Offset:      0,
		MatchLength: len(content),
	}, content)
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
