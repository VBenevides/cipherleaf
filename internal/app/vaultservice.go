package app

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"cipherleaf/internal/githubsync"
	"cipherleaf/internal/secretstore"
	"cipherleaf/internal/secure"
	appsession "cipherleaf/internal/session"
	"cipherleaf/internal/vault"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type VaultService struct {
	mu             sync.RWMutex
	app            *application.App
	store          *vault.Store
	recent         *appsession.RecentVaultStore
	secrets        *secretstore.Store
	sync           *githubsync.Manager
	syncWorkerOnce sync.Once
	syncJobs       chan syncJob
	statisticsMu   sync.Mutex
	process        *process.Process
}

type syncJob struct{ done chan syncJobResult }
type syncJobResult struct {
	result SyncResult
	err    error
}

// RememberTTL is the default duration a vault secret stays in the OS keychain
// when the user enables "Don't ask again".
const RememberTTL = 7 * 24 * time.Hour

type CloneVaultResult struct {
	Session    vault.Session `json:"session"`
	Message    string        `json:"message"`
	Warning    string        `json:"warning"`
	LastCommit string        `json:"lastCommit"`
	Linked     bool          `json:"linked"`
}

type ApplicationStatistics struct {
	CPUPercent  float64              `json:"cpuPercent"`
	MemoryBytes uint64               `json:"memoryBytes"`
	MemoryUsage []ProcessMemoryUsage `json:"memoryUsage"`
}

type ProcessMemoryUsage struct {
	Name        string `json:"name"`
	PID         int32  `json:"pid"`
	MemoryBytes uint64 `json:"memoryBytes"`
}

// SyncResult summarizes a manual sync (pull then push) for the frontend.
type SyncResult struct {
	Linked     bool                  `json:"linked"`
	Message    string                `json:"message"`
	Warning    string                `json:"warning"`
	Branch     string                `json:"branch"`
	LastCommit string                `json:"lastCommit"`
	Pull       githubsync.PullResult `json:"pull"`
	Push       githubsync.PushResult `json:"push"`
	Merge      vault.MergeResult     `json:"merge"`
	Timings    SyncTimings           `json:"timings"`
	Git        GitDiagnostics        `json:"git"`
}

type GitDiagnostics struct {
	SSHConnectionReuse       bool   `json:"sshConnectionReuse"`
	SSHConnectionPersistSecs int    `json:"sshConnectionPersistSeconds"`
	TransportOperations      int    `json:"transportOperations"`
	GitBytes                 int64  `json:"gitBytes"`
	RepositoryFilesBytes     int64  `json:"repositoryFilesBytes"`
	Platform                 string `json:"platform"`
	Architecture             string `json:"architecture"`
	GitVersion               string `json:"gitVersion"`
	OpenSSHVersion           string `json:"openSshVersion"`
	UsedPrefetch             bool   `json:"usedPrefetch"`
	RepositoryPath           string `json:"repositoryPath"`
}

var (
	toolVersionsOnce sync.Once
	gitVersion       string
	openSSHVersion   string
)

type SyncTimings struct {
	PullMilliseconds      int64 `json:"pullMilliseconds"`
	MergeMilliseconds     int64 `json:"mergeMilliseconds"`
	PushMilliseconds      int64 `json:"pushMilliseconds"`
	TotalMilliseconds     int64 `json:"totalMilliseconds"`
	TransportMilliseconds int64 `json:"transportMilliseconds"`
	LocalMilliseconds     int64 `json:"localMilliseconds"`
}

func NewVaultService() *VaultService {
	currentProcess, _ := process.NewProcess(int32(os.Getpid()))
	return &VaultService{
		store:   vault.NewStore(),
		recent:  appsession.NewDefaultRecentVaultStore(),
		secrets: secretstore.New(),
		sync:    githubsync.NewDefaultManager(),
		process: currentProcess,
	}
}

func (s *VaultService) GetApplicationStatistics() (ApplicationStatistics, error) {
	s.statisticsMu.Lock()
	defer s.statisticsMu.Unlock()
	if s.process == nil {
		return ApplicationStatistics{}, errors.New("application statistics are unavailable")
	}
	cpuPercent, err := s.process.Percent(0)
	if err != nil {
		return ApplicationStatistics{}, err
	}
	memoryUsage, err := processMemoryUsage(s.process)
	if err != nil {
		return ApplicationStatistics{}, err
	}
	var memoryBytes uint64
	for _, item := range memoryUsage {
		memoryBytes += item.MemoryBytes
	}
	return ApplicationStatistics{CPUPercent: cpuPercent, MemoryBytes: memoryBytes, MemoryUsage: memoryUsage}, nil
}

func (s *VaultService) ListInstalledFonts() ([]string, error) {
	if runtime.GOOS != "linux" {
		return nil, nil
	}
	output, err := exec.Command("fc-list", "--format=%{family}\n").Output()
	if err != nil {
		return nil, fmt.Errorf("list installed fonts: %w", err)
	}
	return installedFontFamilies(string(output)), nil
}

func installedFontFamilies(output string) []string {
	unique := make(map[string]struct{})
	for _, family := range strings.FieldsFunc(output, func(character rune) bool { return character == '\n' || character == ',' }) {
		if family = strings.TrimSpace(family); family != "" {
			unique[family] = struct{}{}
		}
	}
	families := make([]string, 0, len(unique))
	for family := range unique {
		families = append(families, family)
	}
	sort.Strings(families)
	return families
}

func processMemoryUsage(root *process.Process) ([]ProcessMemoryUsage, error) {
	processes := []*process.Process{root}
	for index := 0; index < len(processes); index++ {
		if children, err := processes[index].Children(); err == nil {
			processes = append(processes, children...)
		}
	}
	usage := make([]ProcessMemoryUsage, 0, len(processes))
	for index, item := range processes {
		memory, err := item.MemoryInfo()
		if err != nil {
			if index == 0 {
				return nil, err
			}
			continue
		}
		name, err := item.Name()
		if err != nil || name == "" {
			name = "Application process"
		}
		usage = append(usage, ProcessMemoryUsage{Name: name, PID: item.Pid, MemoryBytes: memory.RSS})
	}
	sort.Slice(usage, func(left, right int) bool { return usage[left].MemoryBytes > usage[right].MemoryBytes })
	return usage, nil
}

func (s *VaultService) SetApp(app *application.App) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.app = app
}

func (s *VaultService) SelectVaultFolder() (string, error) {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app == nil {
		return "", nil
	}
	return app.Dialog.OpenFile().
		SetTitle("Select an encrypted vault folder").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
}

func (s *VaultService) SelectVaultDestinationFolder() (string, error) {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app == nil {
		return "", nil
	}
	return app.Dialog.OpenFile().
		SetTitle("Select where to create the local vault folder").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
}

func (s *VaultService) SelectMarkdownFolder(title string) (string, error) {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app == nil {
		return "", nil
	}
	return app.Dialog.OpenFile().
		SetTitle(title).
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
}

func (s *VaultService) SelectGitHubSSHKey() (string, error) {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app == nil {
		return "", nil
	}
	return app.Dialog.OpenFile().
		SetTitle("Select the GitHub SSH private key").
		CanChooseDirectories(false).
		CanChooseFiles(true).
		ShowHiddenFiles(true).
		PromptForSingleSelection()
}

func (s *VaultService) SelectAttachmentFile() (string, error) {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app == nil {
		return "", nil
	}
	return app.Dialog.OpenFile().SetTitle("Select a file to encrypt and attach").CanChooseDirectories(false).CanChooseFiles(true).PromptForSingleSelection()
}

func (s *VaultService) GenerateVaultSecret() (string, error) {
	return secure.RandomSecret256()
}

func (s *VaultService) CopyVaultSecret(secret string) error {
	if !secure.IsSecret256(secret) {
		return errors.New("vault secret is not a valid 256-bit secret")
	}
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app == nil || !app.Clipboard.SetText(secret) {
		return errors.New("could not copy the vault secret to the clipboard")
	}
	go func(expected string) {
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		<-timer.C
		clearClipboardIfUnchanged(expected, app.Clipboard.Text, app.Clipboard.SetText)
	}(secret)
	return nil
}

func clearClipboardIfUnchanged(
	expected string,
	read func() (string, bool),
	write func(string) bool,
) {
	current, ok := read()
	if ok && current == expected {
		write("")
	}
}

func (s *VaultService) CreateVault(parentPath, name, secret string) (vault.Session, error) {
	created, err := s.store.CreateIn(parentPath, name, secret)
	if err != nil {
		return vault.Session{}, err
	}
	if err := s.rememberVault(created.Path); err != nil {
		s.store.Lock()
		return vault.Session{}, errors.New("the vault was created, but its location could not be remembered")
	}
	return created, nil
}

func (s *VaultService) OpenVault(path, secret string) (vault.Session, error) {
	opened, err := s.store.Open(path, secret)
	if err != nil {
		return vault.Session{}, err
	}
	if err := s.rememberVault(opened.Path); err != nil {
		s.store.Lock()
		return vault.Session{}, errors.New("the vault was unlocked, but its location could not be remembered")
	}
	return opened, nil
}

func (s *VaultService) CloneGitHubVault(
	parentPath string,
	name string,
	repositorySSH string,
	privateKeyPath string,
	branch string,
	secret string,
	repositoryPrivate bool,
) (CloneVaultResult, error) {
	if current := s.store.Session(); !current.Locked {
		return CloneVaultResult{}, errors.New("lock the current vault before restoring another vault")
	}
	settings := githubsync.DefaultSettings("")
	settings.RepositorySSH = repositorySSH
	settings.PrivateKeyPath = privateKeyPath
	settings.Branch = branch
	settings.RepositoryPrivate = repositoryPrivate
	downloaded, linkedSettings, err := s.sync.DownloadVault(
		context.Background(),
		settings,
	)
	if err != nil {
		return CloneVaultResult{}, err
	}
	restored, err := s.store.RestoreRemoteSnapshot(
		downloaded.CachePath,
		parentPath,
		name,
		secret,
	)
	if err != nil {
		return CloneVaultResult{}, err
	}
	if err := s.rememberVault(restored.Path); err != nil {
		s.store.Lock()
		return CloneVaultResult{}, errors.New("the vault was restored, but its location could not be remembered")
	}
	linked := true
	warning := downloaded.Warning
	if err := s.sync.ActivateDownloadedVault(linkedSettings); err != nil {
		linked = false
		if warning != "" {
			warning += " "
		}
		warning += "The vault was restored locally, but its GitHub link settings could not be saved."
	}
	return CloneVaultResult{
		Session:    restored,
		Message:    downloaded.Message,
		Warning:    warning,
		LastCommit: downloaded.LastCommit,
		Linked:     linked,
	}, nil
}

func (s *VaultService) rememberVault(path string) error {
	theme := s.recent.LastTheme()
	return s.recent.RememberWithTheme(path, theme)
}

func (s *VaultService) GetLastVaultPath() (string, error) {
	return s.recent.LastPath()
}

func (s *VaultService) ListRecentVaultPaths() ([]string, error) {
	return s.recent.Paths()
}

type LastSession struct {
	Path  string `json:"path"`
	Theme string `json:"theme"`
}

func (s *VaultService) GetLastSession() (LastSession, error) {
	path, err := s.recent.LastPath()
	if err != nil {
		return LastSession{}, err
	}
	return LastSession{Path: path, Theme: s.recent.LastTheme()}, nil
}

func (s *VaultService) RememberTheme(theme string) error {
	theme = appsession.NormalizeTheme(theme)
	if theme == "" {
		return nil
	}
	current, err := s.recent.LastPath()
	if err != nil {
		return err
	}
	if current == "" {
		return nil
	}
	return s.recent.RememberWithTheme(current, theme)
}

func (s *VaultService) RenameVault(newName string) (vault.Session, error) {
	renamed, err := s.store.RenameVault(newName)
	if err != nil {
		return renamed, err
	}
	if err := s.rememberVault(renamed.Path); err != nil {
		return renamed, fmt.Errorf("vault was renamed, but its location could not be remembered: %w", err)
	}
	return renamed, nil
}

func (s *VaultService) LockVault() vault.Session {
	return s.store.Lock()
}

// RememberVaultSecret stores the just-validated secret without retaining it
// in the unlocked vault store.
func (s *VaultService) RememberVaultSecret(secret string) error {
	session := s.store.Session()
	if session.Locked || session.VaultID == "" {
		return errors.New("no open vault to remember")
	}
	if strings.TrimSpace(secret) == "" {
		return errors.New("vault secret is required")
	}
	if err := s.secrets.Save(session.VaultID, secret, RememberTTL); err != nil {
		return err
	}
	return nil
} // ForgetVaultSecret removes any remembered secret for the currently open
// vault from the OS keychain. It is a no-op when the vault is not linked to
// a keychain entry.
func (s *VaultService) ForgetVaultSecret() error {
	session := s.store.Session()
	if session.VaultID == "" {
		return nil
	}
	return s.secrets.Forget(session.VaultID)
}

// TryUnlockRemembered attempts to unlock the last opened vault using a
// secret remembered in the OS keychain. It returns ErrNoRememberedSecret
// (or any other error) when the user must enter the secret manually; a
// successful return yields an unlocked Session.
func (s *VaultService) TryUnlockRemembered() (vault.Session, error) {
	path, err := s.recent.LastPath()
	if err != nil {
		return vault.Session{}, err
	}
	if strings.TrimSpace(path) == "" {
		return vault.Session{}, appsession.ErrNoLastVault
	}
	return s.OpenVaultRemembered(path)
}

// OpenVaultRemembered opens path with its unexpired secret from the OS
// keychain. This also supports switching directly between remembered vaults.
func (s *VaultService) OpenVaultRemembered(path string) (vault.Session, error) {
	vaultID, err := vault.ReadVaultID(path)
	if err != nil {
		return vault.Session{}, err
	}
	secret, err := s.secrets.Load(vaultID)
	if err != nil {
		return vault.Session{}, err
	}
	session, err := s.store.Open(path, secret)
	if err != nil {
		// A wrong remembered secret should not poison the keychain entry.
		_ = s.secrets.Forget(vaultID)
		return vault.Session{}, err
	}
	if err := s.rememberVault(session.Path); err != nil {
		s.store.Lock()
		return vault.Session{}, errors.New("the vault was unlocked, but its location could not be remembered")
	}
	return session, nil
}

func (s *VaultService) CloseVault() (vault.Session, error) {
	return s.store.Lock(), nil
}

func (s *VaultService) QuitApplication() {
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if app != nil {
		app.Quit()
	}
}

func (s *VaultService) GetSession() vault.Session {
	return s.store.Session()
}

func (s *VaultService) GetVaultStatistics() (vault.VaultStatistics, error) {
	statistics, err := s.store.GetVaultStatistics()
	if err != nil {
		return statistics, err
	}
	if directory, err := s.sync.GitWorkingDirectory(s.store.Session().VaultID); err == nil {
		statistics.GitBytes, _ = repositorySizes(directory)
	}
	return statistics, nil
}

func (s *VaultService) GetTimeTrackingCatalog() (vault.TimeTrackingCatalog, error) {
	return s.store.GetTimeTrackingCatalog()
}

func (s *VaultService) CreateClient(name string) (vault.TimeClient, error) {
	return s.store.CreateClient(name)
}

func (s *VaultService) RenameClient(id, name string) (vault.TimeClient, error) {
	return s.store.RenameClient(id, name)
}

func (s *VaultService) ArchiveClient(id string) (vault.TimeClient, error) {
	return s.store.ArchiveClient(id)
}

func (s *VaultService) RestoreClient(id string) (vault.TimeClient, error) {
	return s.store.RestoreClient(id)
}

func (s *VaultService) DeleteClient(id string) error {
	return s.store.DeleteClient(id)
}

func (s *VaultService) CreateProject(name string) (vault.TimeProject, error) {
	return s.store.CreateProject(name)
}

func (s *VaultService) CreateProjectForClient(name, clientID string) (vault.TimeProject, error) {
	return s.store.CreateProject(name, clientID)
}

func (s *VaultService) RenameProject(id, name string) (vault.TimeProject, error) {
	return s.store.RenameProject(id, name)
}

func (s *VaultService) UpdateProject(id, name, clientID string) (vault.TimeProject, error) {
	return s.store.RenameProject(id, name, clientID)
}

func (s *VaultService) ArchiveProject(id string) (vault.TimeProject, error) {
	return s.store.ArchiveProject(id)
}

func (s *VaultService) RestoreProject(id string) (vault.TimeProject, error) {
	return s.store.RestoreProject(id)
}

func (s *VaultService) DeleteProject(id string) error {
	return s.store.DeleteProject(id)
}

func (s *VaultService) CreateTag(name string) (vault.TimeTag, error) {
	return s.store.CreateTag(name)
}

func (s *VaultService) RenameTag(id, name string) (vault.TimeTag, error) {
	return s.store.RenameTag(id, name)
}

func (s *VaultService) ArchiveTag(id string) (vault.TimeTag, error) {
	return s.store.ArchiveTag(id)
}

func (s *VaultService) RestoreTag(id string) (vault.TimeTag, error) {
	return s.store.RestoreTag(id)
}

func (s *VaultService) DeleteTag(id string) error {
	return s.store.DeleteTag(id)
}

func (s *VaultService) StartTimeEntry(name, projectID string, tagIDs []string) (vault.TimeEntry, error) {
	return s.store.StartTimeEntry(name, projectID, tagIDs)
}

func (s *VaultService) StartTimeEntryForClient(name, clientID, projectID string, tagIDs []string) (vault.TimeEntry, error) {
	return s.store.StartTimeEntryForClient(name, clientID, projectID, tagIDs)
}

func (s *VaultService) GetActiveTimeEntry() (*vault.TimeEntry, error) {
	return s.store.GetActiveTimeEntry()
}

func (s *VaultService) FinishActiveTimeEntry() (vault.TimeEntry, error) {
	return s.store.FinishActiveTimeEntry()
}

func (s *VaultService) UpdateTimeEntry(id, name, projectID string, tagIDs []string, startedAtUTC, endedAtUTC string) (vault.TimeEntry, error) {
	return s.store.UpdateTimeEntry(id, name, projectID, tagIDs, startedAtUTC, endedAtUTC)
}

func (s *VaultService) UpdateTimeEntryForClient(id, name, clientID, projectID string, tagIDs []string, startedAtUTC, endedAtUTC string) (vault.TimeEntry, error) {
	return s.store.UpdateTimeEntryForClient(id, name, clientID, projectID, tagIDs, startedAtUTC, endedAtUTC)
}

func (s *VaultService) DeleteTimeEntry(id string) error {
	return s.store.DeleteTimeEntry(id)
}

func (s *VaultService) ListTimeEntries(startUTC, endUTC string, filters vault.TimeEntryFilters) (vault.TimeEntryRangeResult, error) {
	return s.store.ListTimeEntries(startUTC, endUTC, filters)
}

func (s *VaultService) GetTimeDashboard(startUTC, endUTC string, filters vault.TimeEntryFilters) (vault.TimeDashboard, error) {
	return s.store.GetTimeDashboard(startUTC, endUTC, filters)
}

func (s *VaultService) ListTimeDashboardGroupEntries(name, startUTC, endUTC string, filters vault.TimeEntryFilters) ([]vault.TimeEntryRangeItem, error) {
	return s.store.ListTimeDashboardGroupEntries(name, startUTC, endUTC, filters)
}

func (s *VaultService) ListTimeTrackingConflicts() ([]vault.TimeTrackingConflict, error) {
	return s.store.ListTimeTrackingConflicts()
}

func (s *VaultService) ResolveTimeTrackingConflict(id string) error {
	return s.store.ResolveTimeTrackingConflict(id)
}

func (s *VaultService) ListNotes() ([]vault.NoteSummary, error) {
	return s.store.ListNotes()
}

func (s *VaultService) ListFolders() ([]vault.Folder, error) {
	return s.store.ListFolders()
}

func (s *VaultService) CreateFolder(name, parentID string) (vault.Folder, error) {
	return s.store.CreateFolder(name, parentID)
}

func (s *VaultService) RenameFolder(id, name string) (vault.Folder, error) {
	return s.store.RenameFolder(id, name)
}

func (s *VaultService) DeleteFolder(id string) error {
	return s.store.DeleteFolder(id)
}

func (s *VaultService) ReorderFolders(orderedIDs []string) error {
	return s.store.ReorderFolders(orderedIDs)
}

func (s *VaultService) MoveFolder(id, parentID string) (vault.Folder, error) {
	return s.store.MoveFolder(id, parentID)
}

func (s *VaultService) SetFolderHidden(id string, hidden bool) (vault.Folder, error) {
	return s.store.SetFolderHidden(id, hidden)
}

func (s *VaultService) LockFolder(id, password string) (vault.Folder, error) {
	return s.store.LockFolder(id, password)
}

func (s *VaultService) UnlockFolder(id, password string) (vault.Folder, error) {
	return s.store.UnlockFolder(id, password)
}

func (s *VaultService) CheckFolderPassword(id, password string) error {
	return s.store.CheckFolderPassword(id, password)
}

func (s *VaultService) LockFolderSession(id string) error {
	return s.store.LockFolderSession(id)
}

func (s *VaultService) SetFolderSortMode(id, mode string) (vault.Folder, error) {
	return s.store.SetFolderSortMode(id, mode)
}

func (s *VaultService) CreateNote(title string) (vault.Note, error) {
	return s.store.CreateNote(title)
}

func (s *VaultService) CreateNoteInFolder(title, folderID string) (vault.Note, error) {
	return s.store.CreateNoteInFolder(title, folderID)
}

func (s *VaultService) MoveNote(id, folderID string) (vault.Note, error) {
	return s.store.MoveNote(id, folderID)
}

func (s *VaultService) ReorderNotes(folderID string, orderedIDs []string) error {
	return s.store.ReorderNotes(folderID, orderedIDs)
}

func (s *VaultService) GetNote(id string) (vault.Note, error) {
	return s.store.GetNote(id)
}

func (s *VaultService) SaveNote(id, title, content string) (vault.SavedNote, error) {
	note, err := s.store.SaveNote(id, title, content)
	if err != nil {
		return vault.SavedNote{}, err
	}
	summary, err := s.store.GetNoteSummary(id)
	if err != nil {
		return vault.SavedNote{}, err
	}
	return vault.SavedNote{Note: note, Summary: summary}, nil
}

func (s *VaultService) SaveImageAttachment(noteID, imageDataURL string) (string, error) {
	data, err := convertImageDataURLToWebP(imageDataURL)
	if err != nil {
		return "", err
	}
	return s.store.SaveAttachment(noteID, data)
}

func (s *VaultService) GetAttachment(noteID, id string) (string, error) {
	data, err := s.store.GetAttachment(noteID, id)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func (s *VaultService) DeleteAttachment(noteID, id string) error {
	return s.store.DeleteAttachment(noteID, id)
}

func (s *VaultService) ImportFileAttachment(noteID, path string) (vault.AttachmentInfo, error) {
	return s.store.ImportFileAttachment(noteID, path)
}

func (s *VaultService) ExportFileAttachment(noteID, id, destination string) (string, error) {
	return s.store.ExportFileAttachment(noteID, id, destination)
}

func (s *VaultService) ListFileAttachments(noteID string) ([]vault.AttachmentInfo, error) {
	return s.store.ListFileAttachments(noteID)
}

func (s *VaultService) ReadClipboardImage() (string, error) {
	if runtime.GOOS != "linux" {
		return "", errors.New("native clipboard image fallback is unavailable")
	}
	var output []byte
	var mimeType string
	if _, err := exec.LookPath("wl-paste"); err == nil {
		candidates := []string{"image/png", "image/webp", "image/jpeg"}
		types, listErr := runClipboardCommand("wl-paste", "--list-types")
		if listErr == nil {
			mimeType = selectClipboardImageType(string(types))
		}
		if mimeType != "" {
			candidates = append([]string{mimeType}, candidates...)
		}
		for _, candidate := range candidates {
			value, readErr := runClipboardCommand(
				"wl-paste", "--no-newline", "--type", candidate,
			)
			if readErr == nil && len(value) > 0 {
				output = value
				mimeType = candidate
				break
			}
		}
	}
	if len(output) == 0 {
		for _, candidate := range []string{"image/png", "image/webp", "image/jpeg"} {
			if _, err := exec.LookPath("xclip"); err != nil {
				break
			}
			value, err := runClipboardCommand(
				"xclip", "-selection", "clipboard", "-t", candidate, "-o",
			)
			if err == nil && len(value) > 0 {
				output = value
				mimeType = candidate
				break
			}
		}
	}
	if len(output) == 0 {
		return "", errors.New("could not read image data from the system clipboard")
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(output), nil
}

func runClipboardCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return runLimitedClipboardCommand(ctx, name, args...)
}

func runLimitedClipboardCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	const limit = 15 * 1024 * 1024
	command := exec.CommandContext(ctx, name, args...)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	output, readErr := io.ReadAll(io.LimitReader(stdout, limit+1))
	if len(output) > limit {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, errors.New("clipboard image exceeds the 15 MiB input limit")
	}
	waitErr := command.Wait()
	if readErr != nil {
		return nil, readErr
	}
	if waitErr != nil {
		return nil, waitErr
	}
	return output, nil
}

func selectClipboardImageType(value string) string {
	available := make(map[string]bool)
	for _, item := range strings.Fields(value) {
		available[strings.ToLower(item)] = true
	}
	for _, candidate := range []string{"image/png", "image/webp", "image/jpeg"} {
		if available[candidate] {
			return candidate
		}
	}
	return ""
}

func (s *VaultService) DeleteNote(id string) error {
	return s.store.DeleteNote(id)
}

func (s *VaultService) ListTrash() ([]vault.TrashItem, error) {
	return s.store.ListTrash()
}

func (s *VaultService) RestoreTrashItem(kind, id string) error {
	return s.store.RestoreTrashItem(kind, id)
}

func (s *VaultService) PermanentlyDeleteTrashItem(kind, id string) error {
	return s.store.PermanentlyDeleteTrashItem(kind, id)
}

func (s *VaultService) ListNoteVersions(id string) ([]vault.NoteVersion, error) {
	return s.store.ListNoteVersions(id)
}

func (s *VaultService) CleanHistory() error {
	return s.store.CleanHistory()
}

func (s *VaultService) RestoreNoteVersion(id string, revision uint64) (vault.Note, error) {
	return s.store.RestoreNoteVersion(id, revision)
}

func (s *VaultService) ImportMarkdown(path string) (vault.PortabilityResult, error) {
	return s.store.ImportMarkdown(path)
}

func (s *VaultService) ExportMarkdown(path string) (vault.PortabilityResult, error) {
	return s.store.ExportMarkdown(path)
}

func (s *VaultService) ResolveNoteReference(reference string) (vault.NoteSummary, error) {
	return s.store.ResolveNoteReference(reference)
}

func (s *VaultService) ListBacklinks(noteID string) ([]vault.FindMatch, error) {
	return s.store.ListBacklinks(noteID)
}

func (s *VaultService) FindInNotes(query string, caseSensitive, wholeWord bool) ([]vault.FindMatch, error) {
	return s.store.FindInNotesWithOptions(query, 20, vault.SearchOptions{CaseSensitive: caseSensitive, WholeWord: wholeWord})
}

func (s *VaultService) ReplaceAcrossNotes(find, replace string, noteIDs []string, caseSensitive, wholeWord bool) (vault.ReplaceResult, error) {
	return s.store.ReplaceAcrossNotesWithOptions(find, replace, noteIDs, vault.SearchOptions{CaseSensitive: caseSensitive, WholeWord: wholeWord})
}

func (s *VaultService) GetVaultSettings() (vault.VaultSettings, error) {
	return s.store.GetVaultSettings()
}

func (s *VaultService) SaveVaultSettings(settings vault.VaultSettings) (vault.VaultSettings, error) {
	return s.store.SaveVaultSettings(settings)
}

func (s *VaultService) GetSyncSettings() (githubsync.SyncSettings, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return githubsync.SyncSettings{}, err
	}
	return s.sync.GetSettings(vaultID)
}

func (s *VaultService) TestGitHubConnection(
	settings githubsync.SyncSettings,
) (githubsync.ConnectionResult, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return githubsync.ConnectionResult{}, err
	}
	return s.sync.TestConnection(context.Background(), vaultID, settings)
}

func (s *VaultService) LinkGitHubVault(
	settings githubsync.SyncSettings,
) (githubsync.LinkResult, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return githubsync.LinkResult{}, err
	}
	return s.sync.LinkVault(context.Background(), vaultID, settings, s.store)
}

func (s *VaultService) PullAndLinkGitHubVault(
	settings githubsync.SyncSettings,
) (SyncResult, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return SyncResult{}, err
	}
	downloaded, linkedSettings, err := s.sync.DownloadVault(context.Background(), settings)
	if err != nil {
		return SyncResult{}, err
	}
	if downloaded.VaultID != vaultID {
		return SyncResult{}, errors.New("the remote repository belongs to another vault")
	}
	result := SyncResult{
		Linked:     true,
		Message:    downloaded.Message,
		Warning:    downloaded.Warning,
		Branch:     downloaded.Branch,
		LastCommit: downloaded.LastCommit,
		Pull: githubsync.PullResult{
			Linked:      true,
			Message:     downloaded.Message,
			Warning:     downloaded.Warning,
			Branch:      downloaded.Branch,
			LastCommit:  downloaded.LastCommit,
			StagingPath: downloaded.CachePath,
			Temporary:   false,
		},
	}
	merge, err := s.store.MergeRemoteSnapshot(downloaded.CachePath)
	if err != nil {
		return SyncResult{}, err
	}
	result.Merge = merge
	if err := s.sync.ActivateDownloadedVault(linkedSettings); err != nil {
		return SyncResult{}, err
	}
	if len(merge.Conflicts) > 0 || len(merge.TrackingConflicts) > 0 {
		result.Warning = "Remote changes were pulled. Resolve note or time-tracking conflicts before pushing."
		return result, nil
	}
	push, err := s.sync.PushVault(context.Background(), vaultID, s.store)
	if err != nil {
		result.Warning = "Remote changes were pulled, but the push could not be completed: " + err.Error()
		return result, nil
	}
	result.Push = push
	result.LastCommit = push.LastCommit
	result.Message = push.Message
	if merge.UpToDate && push.UpToDate {
		result.Message = "The vault is already in sync with GitHub."
	}
	return result, nil
}

func (s *VaultService) UnlinkGitHubSync() error {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return err
	}
	return s.sync.RemoveSettings(vaultID)
}

// OpenGitTerminal opens the system terminal at this vault's encrypted Git checkout.
func (s *VaultService) OpenGitTerminal() error {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return err
	}
	directory, err := s.sync.GitWorkingDirectory(vaultID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(directory, ".git")); err != nil {
		return errors.New("the linked Git checkout is not available on this device yet")
	}
	return openTerminal(directory)
}

// SyncNow performs a manual pull-merge-push against the linked GitHub
// repository. Local notes newer than their remote counterpart are preserved;
// remote notes newer than local replace the local copy.
func (s *VaultService) SyncNow() (SyncResult, error) {
	s.syncWorkerOnce.Do(func() {
		s.syncJobs = make(chan syncJob, 1)
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case job := <-s.syncJobs:
					time.Sleep(150 * time.Millisecond)
					waiters := []chan syncJobResult{job.done}
				drain:
					for {
						select {
						case queued := <-s.syncJobs:
							waiters = append(waiters, queued.done)
						default:
							break drain
						}
					}
					result, err := s.syncNow()
					for _, waiter := range waiters {
						waiter <- syncJobResult{result: result, err: err}
					}
				case <-ticker.C:
					if vaultID, err := s.unlockedVaultID(); err == nil {
						_ = s.sync.PrefetchVault(context.Background(), vaultID)
					}
				}
			}
		}()
	})
	job := syncJob{done: make(chan syncJobResult, 1)}
	s.syncJobs <- job
	completed := <-job.done
	return completed.result, completed.err
}

func (s *VaultService) syncNow() (result SyncResult, resultErr error) {
	startedAt := time.Now()
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return SyncResult{}, err
	}
	defer func() {
		if resultErr != nil {
			return
		}
		path, err := s.sync.GitWorkingDirectory(vaultID)
		if err == nil {
			result.Git = gitDiagnostics(path, result.Pull, result.Push)
		}
	}()
	const maxAttempts = 3
	for attempt := 0; attempt < maxAttempts; attempt++ {
		result := SyncResult{Linked: true}
		phaseStartedAt := time.Now()
		pull, pullErr := s.sync.PullVault(context.Background(), vaultID)
		if pullErr != nil {
			if githubsync.IsRetryableError(pullErr) && attempt+1 < maxAttempts {
				time.Sleep(time.Duration(attempt+1) * 150 * time.Millisecond)
				continue
			}
			return SyncResult{}, pullErr
		}
		result.Pull = pull
		result.Timings.PullMilliseconds = time.Since(phaseStartedAt).Milliseconds()
		result.Branch = pull.Branch
		result.LastCommit = pull.LastCommit
		phaseStartedAt = time.Now()
		if pull.UpToDate {
			result.Merge = vault.MergeResult{UpToDate: true}
		} else if pull.StagingPath != "" {
			merge, mergeErr := s.store.MergeRemoteSnapshot(pull.StagingPath)
			if pull.Temporary {
				_ = os.RemoveAll(pull.StagingPath)
			}
			if mergeErr != nil {
				result.Warning = "Pull succeeded, but the remote changes could not be merged: " + mergeErr.Error()
				return result, nil
			}
			result.Merge = merge
			if len(merge.Conflicts) > 0 || len(merge.TrackingConflicts) > 0 {
				result.Warning = "Pull succeeded, but note or time-tracking conflicts must be resolved before pushing."
				return result, nil
			}
		} else {
			result.Merge = vault.MergeResult{UpToDate: true}
		}
		result.Timings.MergeMilliseconds = time.Since(phaseStartedAt).Milliseconds()
		phaseStartedAt = time.Now()
		beforePushRevision, _ := s.store.SnapshotRevision()
		push, pushErr := s.sync.PushVault(context.Background(), vaultID, s.store)
		if errors.Is(pushErr, githubsync.ErrRemoteAdvanced) && attempt+1 < maxAttempts {
			continue
		}
		if githubsync.IsRetryableError(pushErr) && attempt+1 < maxAttempts {
			time.Sleep(time.Duration(attempt+1) * 150 * time.Millisecond)
			continue
		}
		if pushErr != nil {
			result.Warning = "Pull succeeded, but the push could not be completed: " + pushErr.Error()
			return result, nil
		}
		afterPushRevision, _ := s.store.SnapshotRevision()
		if beforePushRevision != "" && afterPushRevision != beforePushRevision && attempt+1 < maxAttempts {
			continue
		}
		result.Push = push
		result.Timings.PushMilliseconds = time.Since(phaseStartedAt).Milliseconds()
		result.Timings.TransportMilliseconds = pull.TransportMilliseconds + push.TransportMilliseconds
		result.Timings.LocalMilliseconds = push.LocalMilliseconds + result.Timings.MergeMilliseconds
		result.Timings.TotalMilliseconds = time.Since(startedAt).Milliseconds()
		if push.LastCommit != "" {
			result.LastCommit = push.LastCommit
		}
		result.Message = push.Message
		if result.Merge.UpToDate && push.UpToDate {
			result.Message = "The vault is already in sync with GitHub."
		}
		s.sync.MarkSynced(vaultID)
		return result, nil
	}
	return SyncResult{}, errors.New("sync could not converge after the remote branch changed repeatedly")
}

func gitDiagnostics(path string, pull githubsync.PullResult, push githubsync.PushResult) GitDiagnostics {
	toolVersionsOnce.Do(func() {
		gitVersion, openSSHVersion = githubsync.ToolVersions()
	})
	gitBytes, repositoryFilesBytes := repositorySizes(path)
	operations := 0
	if !pull.UsedPrefetch {
		operations++
	}
	if push.TransportPerformed {
		operations++
	}
	reuseConnections := runtime.GOOS != "windows"
	persistSeconds := 0
	if reuseConnections {
		persistSeconds = 30
	}
	return GitDiagnostics{
		SSHConnectionReuse:       reuseConnections,
		SSHConnectionPersistSecs: persistSeconds,
		TransportOperations:      operations,
		GitBytes:                 gitBytes,
		RepositoryFilesBytes:     repositoryFilesBytes,
		Platform:                 runtime.GOOS,
		Architecture:             runtime.GOARCH,
		GitVersion:               gitVersion,
		OpenSSHVersion:           openSSHVersion,
		UsedPrefetch:             pull.UsedPrefetch,
		RepositoryPath:           path,
	}
}

func repositorySizes(root string) (gitBytes, repositoryFilesBytes int64) {
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		if relative == ".git" || strings.HasPrefix(relative, ".git"+string(filepath.Separator)) {
			gitBytes += info.Size()
		} else {
			repositoryFilesBytes += info.Size()
		}
		return nil
	})
	return gitBytes, repositoryFilesBytes
}

// ForcePushNow overwrites the linked remote branch with the current local
// encrypted vault snapshot after the user explicitly confirms conflict loss.
func (s *VaultService) ForcePushNow() (githubsync.PushResult, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return githubsync.PushResult{}, err
	}
	return s.sync.ForcePushVault(context.Background(), vaultID, s.store)
}

func (s *VaultService) unlockedVaultID() (string, error) {
	current := s.store.Session()
	if current.Locked || current.VaultID == "" {
		return "", errors.New("unlock a vault before configuring GitHub sync")
	}
	return current.VaultID, nil
}
