package vault

const (
	FormatVersion = 1
	Algorithm     = "XChaCha20-Poly1305"
)

type Session struct {
	Locked    bool   `json:"locked"`
	Path      string `json:"path"`
	VaultID   string `json:"vaultId"`
	NoteCount int    `json:"noteCount"`
}

type NoteSummary struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	FolderID       string   `json:"folderId"`
	Order          int      `json:"order"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
	ModifiedAt     int64    `json:"modifiedAt"`
	Revision       uint64   `json:"revision"`
	CiphertextHash string   `json:"ciphertextHash,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	AttachmentIDs  []string `json:"attachmentIds"`
	OutgoingLinks  []string `json:"outgoingLinks"`
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
	Folders        []Folder      `json:"folders"`
	Notes          []NoteSummary `json:"notes"`
	DeletedNotes   []Tombstone   `json:"deleted_notes,omitempty"`
	DeletedFolders []Tombstone   `json:"deleted_folders,omitempty"`
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
	FormatVersion int         `json:"format_version"`
	VaultID       string      `json:"vault_id"`
	Folders       []Folder    `json:"folders"`
	Deleted       []Tombstone `json:"deleted,omitempty"`
}

type authenticatedRemoteSnapshot struct {
	Config   vaultConfig
	Manifest manifest
	Objects  map[string]remoteSyncObject
}

// MergeResult summarizes a pull merge between the remote and local vault.
type MergeResult struct {
	PulledNotes    int             `json:"pulledNotes"`
	UpdatedNotes   int             `json:"updatedNotes"`
	DeletedNotes   int             `json:"deletedNotes"`
	PulledFolders  int             `json:"pulledFolders"`
	DeletedFolders int             `json:"deletedFolders"`
	UpToDate       bool            `json:"upToDate"`
	Conflicts      []MergeConflict `json:"conflicts,omitempty"`
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
	NoteID      string `json:"noteId"`
	Title       string `json:"title"`
	FolderID    string `json:"folderId"`
	Field       string `json:"field"`
	Snippet     string `json:"snippet"`
	Offset      int    `json:"offset"`
	MatchLength int    `json:"matchLength"`
}

// ReplaceResult summarizes a replace operation across notes.
type ReplaceResult struct {
	ReplacedNotes int `json:"replacedNotes"`
	Replacements  int `json:"replacements"`
}
