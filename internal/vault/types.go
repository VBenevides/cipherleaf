package vault

const (
	FormatVersion                     = 1
	TimeTrackingManifestFormatVersion = 2
	TimeTrackingCatalogFormatVersion  = 1
	TimeTrackingCapability            = "time-tracking-v1"
	Algorithm                         = "XChaCha20-Poly1305"
)

type Session struct {
	Locked    bool   `json:"locked"`
	Path      string `json:"path"`
	VaultID   string `json:"vaultId"`
	NoteCount int    `json:"noteCount"`
}

type VaultStatistics struct {
	NotesBytes        int64 `json:"notesBytes"`
	AttachmentsBytes  int64 `json:"attachmentsBytes"`
	TimeTrackingBytes int64 `json:"timeTrackingBytes"`
	GitBytes          int64 `json:"gitBytes"`
}

type NoteSummary struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	FolderID       string         `json:"folderId"`
	Order          int            `json:"order"`
	CreatedAt      string         `json:"createdAt"`
	UpdatedAt      string         `json:"updatedAt"`
	ModifiedAt     int64          `json:"modifiedAt"`
	Revision       uint64         `json:"revision"`
	CiphertextHash string         `json:"ciphertextHash,omitempty"`
	Tags           []string       `json:"tags,omitempty"`
	AttachmentIDs  []string       `json:"attachmentIds"`
	OutgoingLinks  []string       `json:"outgoingLinks"`
	Properties     map[string]any `json:"properties,omitempty"`
}

type Note struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	FolderID   string `json:"folderId"`
	Order      int    `json:"order"`
	Content    string `json:"content"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
	ModifiedAt int64  `json:"modifiedAt"`
	Revision   uint64 `json:"revision"`
}

type SavedNote struct {
	Note    Note        `json:"note"`
	Summary NoteSummary `json:"summary"`
}

type TrashItem struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	DeletedAt string `json:"deletedAt"`
}

type NoteVersion struct {
	Revision  uint64 `json:"revision"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

type PortabilityResult struct {
	Notes       int    `json:"notes"`
	Folders     int    `json:"folders"`
	Attachments int    `json:"attachments"`
	Path        string `json:"path"`
}

type AttachmentInfo struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	MIMEType string `json:"mimeType"`
	Size     int64  `json:"size"`
}

type trashedNote struct {
	Note      Note   `json:"note"`
	DeletedAt string `json:"deleted_at"`
}

type trashedFolder struct {
	Folder    Folder `json:"folder"`
	DeletedAt string `json:"deleted_at"`
}

type Folder struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	ParentID         string `json:"parentId,omitempty"`
	Order            int    `json:"order"`
	Hidden           bool   `json:"hidden,omitempty"`
	Locked           bool   `json:"locked,omitempty"`
	LockPasswordHash string `json:"lockPasswordHash,omitempty"`
	SortMode         string `json:"sortMode,omitempty"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

type Tombstone struct {
	ID         string `json:"id"`
	Revision   uint64 `json:"revision,omitempty"`
	ModifiedAt int64  `json:"modified_at"`
}

type manifest struct {
	FormatVersion  int           `json:"format_version"`
	VaultID        string        `json:"vault_id"`
	Capabilities   []string      `json:"capabilities,omitempty"`
	Folders        []Folder      `json:"folders"`
	Notes          []NoteSummary `json:"notes"`
	DeletedNotes   []Tombstone   `json:"deleted_notes,omitempty"`
	DeletedFolders []Tombstone   `json:"deleted_folders,omitempty"`
	Settings       VaultSettings `json:"settings,omitempty"`
}

// VaultSettings contains general preferences encrypted and synced with a vault.
type VaultSettings struct {
	DailyNoteFormat         string `json:"dailyNoteFormat"`
	DailyNoteFolderID       string `json:"dailyNoteFolderId"`
	DailyTemplateNoteID     string `json:"dailyTemplateNoteId"`
	AutosaveIntervalSeconds int    `json:"autosaveIntervalSeconds"`
	AutoSyncMinutes         int    `json:"autoSyncMinutes"`
	AutoLockMinutes         int    `json:"autoLockMinutes"`
	FileHistoryLimit        int    `json:"fileHistoryLimit"`
	SectionDefault          string `json:"sectionDefault"`
	Revision                uint64 `json:"revision"`
	ModifiedAt              int64  `json:"modifiedAt"`
}

type vaultConfig struct {
	FormatVersion int              `json:"format_version"`
	VaultID       string           `json:"vault_id"`
	Algorithm     string           `json:"algorithm"`
	Key           keyConfiguration `json:"key"`
}

type keyConfiguration struct {
	KDF        kdfConfiguration `json:"kdf"`
	WrappedKey wrappedKey       `json:"wrapped_key"`
}

type kdfConfiguration struct {
	Name        string `json:"name"`
	Salt        string `json:"salt"`
	Time        uint32 `json:"time"`
	MemoryKiB   uint32 `json:"memory_kib"`
	Parallelism uint8  `json:"parallelism"`
}

type wrappedKey struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type envelope struct {
	FormatVersion int    `json:"format_version"`
	Algorithm     string `json:"algorithm"`
	ObjectType    string `json:"object_type"`
	ObjectID      string `json:"object_id"`
	Compression   string `json:"compression,omitempty"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
}

type remoteSyncManifest struct {
	FormatVersion int                `json:"format_version"`
	VaultID       string             `json:"vault_id"`
	Objects       []remoteSyncObject `json:"objects"`
}

type remoteSyncObject struct {
	ID             string       `json:"id"`
	CiphertextHash string       `json:"ciphertext_hash"`
	Revision       uint64       `json:"revision"`
	ModifiedAt     int64        `json:"modified_at"`
	Deleted        bool         `json:"deleted"`
	Summary        *NoteSummary `json:"summary,omitempty"`
}

type remoteFolderManifest struct {
	FormatVersion int           `json:"format_version"`
	VaultID       string        `json:"vault_id"`
	Folders       []Folder      `json:"folders"`
	Deleted       []Tombstone   `json:"deleted,omitempty"`
	Settings      VaultSettings `json:"settings,omitempty"`
}

type remoteTrackingInventory struct {
	FormatVersion int                    `json:"format_version"`
	VaultID       string                 `json:"vault_id"`
	Catalog       remoteTrackingObject   `json:"catalog"`
	Buckets       []remoteTrackingObject `json:"buckets"`
}

type remoteTrackingObject struct {
	ID             string `json:"id"`
	CiphertextHash string `json:"ciphertext_hash"`
	Revision       uint64 `json:"revision"`
	ModifiedAt     int64  `json:"modified_at"`
}

type authenticatedRemoteSnapshot struct {
	Config   vaultConfig
	Manifest manifest
	Objects  map[string]remoteSyncObject
	Tracking *authenticatedTrackingSnapshot
}

type authenticatedTrackingSnapshot struct {
	Inventory remoteTrackingInventory
	Catalog   timeTrackingCatalog
	Buckets   map[string]timeTrackingBucket
}

// MergeResult summarizes a pull merge between the remote and local vault.
type MergeResult struct {
	PulledNotes       int                    `json:"pulledNotes"`
	UpdatedNotes      int                    `json:"updatedNotes"`
	DeletedNotes      int                    `json:"deletedNotes"`
	PulledFolders     int                    `json:"pulledFolders"`
	DeletedFolders    int                    `json:"deletedFolders"`
	UpdatedSettings   bool                   `json:"updatedSettings"`
	UpToDate          bool                   `json:"upToDate"`
	Conflicts         []MergeConflict        `json:"conflicts,omitempty"`
	TrackingConflicts []TimeTrackingConflict `json:"trackingConflicts,omitempty"`
}

type MergeConflict struct {
	LocalNoteID   string `json:"localNoteId"`
	RemoteNoteID  string `json:"remoteNoteId"`
	Title         string `json:"title"`
	Message       string `json:"message"`
	LocalContent  string `json:"localContent"`
	RemoteContent string `json:"remoteContent"`
}

// FindMatch describes a single occurrence of a query inside a note.
type FindMatch struct {
	NoteID           string `json:"noteId"`
	Title            string `json:"title"`
	FolderID         string `json:"folderId"`
	Field            string `json:"field"`
	Snippet          string `json:"snippet"`
	Offset           int    `json:"offset"`
	MatchLength      int    `json:"matchLength"`
	UTF16Offset      int    `json:"utf16Offset"`
	UTF16MatchLength int    `json:"utf16MatchLength"`
}

// ReplaceResult summarizes a replace operation across notes.
type ReplaceResult struct {
	ReplacedNotes int `json:"replacedNotes"`
	Replacements  int `json:"replacements"`
}
