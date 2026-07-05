package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"cipherleaf/internal/githubsync"
	"cipherleaf/internal/secretstore"
	"cipherleaf/internal/secure"
	appsession "cipherleaf/internal/session"
	"cipherleaf/internal/vault"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type VaultService struct {
	mu      sync.RWMutex
	app     *application.App
	store   *vault.Store
	recent  *appsession.RecentVaultStore
	secrets *secretstore.Store
	sync    *githubsync.Manager
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
}

func NewVaultService() *VaultService {
	return &VaultService{
		store:   vault.NewStore(),
		recent:  appsession.NewDefaultRecentVaultStore(),
		secrets: secretstore.New(),
		sync:    githubsync.NewDefaultManager(),
	}
}

func (s *VaultService) setApp(app *application.App) {
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

// RememberVaultSecret stores the open vault's secret in the OS keychain so
// the user does not have to paste it again for the configured TTL. It must
// be called only after a successful Open so the secret is known to be valid.
func (s *VaultService) RememberVaultSecret() error {
	session := s.store.Session()
	if session.Locked || session.VaultID == "" {
		return errors.New("no open vault to remember")
	}
	secret, ok := s.store.UnlockedSecret()
	if !ok {
		return errors.New("the unlocked secret is no longer available")
	}
	defer secure.Zero(secret)
	if err := s.secrets.Save(session.VaultID, string(secret), RememberTTL); err != nil {
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
	vaultID, err := vault.ReadVaultID(path)
	if err != nil {
		return vault.Session{}, err
	}
	secret, err := s.secrets.Load(vaultID)
	if err != nil {
		return vault.Session{}, err
	}
	session, err := s.store.Open(path, secret)
	secure.ZeroString(secret)
	if err != nil {
		// A wrong remembered secret should not poison the keychain entry.
		_ = s.secrets.Forget(vaultID)
		return vault.Session{}, err
	}
	return session, nil
}

func (s *VaultService) CloseVault() (vault.Session, error) {
	if err := s.recent.Forget(); err != nil {
		return s.store.Session(), errors.New("the recent-session entry could not be cleared, so the vault remains open")
	}
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

func (s *VaultService) ListNotes() ([]vault.NoteSummary, error) {
	return s.store.ListNotes()
}

func (s *VaultService) ListFolders() ([]vault.Folder, error) {
	return s.store.ListFolders()
}

func (s *VaultService) CreateFolder(name string) (vault.Folder, error) {
	return s.store.CreateFolder(name)
}

func (s *VaultService) RenameFolder(id, name string) (vault.Folder, error) {
	return s.store.RenameFolder(id, name)
}

func (s *VaultService) DeleteFolder(id string) error {
	return s.store.DeleteFolder(id)
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

func (s *VaultService) GetNote(id string) (vault.Note, error) {
	return s.store.GetNote(id)
}

func (s *VaultService) SaveNote(id, title, content string) (vault.Note, error) {
	return s.store.SaveNote(id, title, content)
}

func (s *VaultService) SaveAttachment(noteID, webpBase64 string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(webpBase64)
	if err != nil {
		return "", errors.New("image data is not valid base64")
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

func (s *VaultService) ReadClipboardImage() (string, error) {
	if runtime.GOOS != "linux" {
		return "", errors.New("native clipboard image fallback is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var output []byte
	var mimeType string
	if _, err := exec.LookPath("wl-paste"); err == nil {
		types, listErr := exec.CommandContext(ctx, "wl-paste", "--list-types").Output()
		if listErr == nil {
			mimeType = selectClipboardImageType(string(types))
		}
		if mimeType != "" {
			value, readErr := runLimitedClipboardCommand(
				ctx, "wl-paste", "--no-newline", "--type", mimeType,
			)
			if readErr == nil {
				output = value
			}
		}
	}
	if len(output) == 0 {
		for _, candidate := range []string{"image/png", "image/webp", "image/jpeg"} {
			if _, err := exec.LookPath("xclip"); err != nil {
				break
			}
			value, err := runLimitedClipboardCommand(
				ctx, "xclip", "-selection", "clipboard", "-t", candidate, "-o",
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

func (s *VaultService) SearchNotes(query string) ([]vault.NoteSummary, error) {
	return s.store.Search(query)
}

func (s *VaultService) FindInNotes(query string) ([]vault.FindMatch, error) {
	return s.store.FindInNotes(query, 20)
}

func (s *VaultService) ReplaceAcrossNotes(find, replace string, noteIDs []string) (vault.ReplaceResult, error) {
	return s.store.ReplaceAcrossNotes(find, replace, noteIDs)
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

func (s *VaultService) UnlinkGitHubSync() error {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return err
	}
	return s.sync.RemoveSettings(vaultID)
}

// SyncNow performs a manual pull-merge-push against the linked GitHub
// repository. Local notes newer than their remote counterpart are preserved;
// remote notes newer than local replace the local copy.
func (s *VaultService) SyncNow() (SyncResult, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return SyncResult{}, err
	}
	const maxAttempts = 3
	for attempt := 0; attempt < maxAttempts; attempt++ {
		result := SyncResult{Linked: true}
		pull, pullErr := s.sync.PullVault(context.Background(), vaultID)
		if pullErr != nil {
			return SyncResult{}, pullErr
		}
		result.Pull = pull
		result.Branch = pull.Branch
		result.LastCommit = pull.LastCommit
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
		}
		push, pushErr := s.sync.PushVault(context.Background(), vaultID, s.store)
		if errors.Is(pushErr, githubsync.ErrRemoteAdvanced) && attempt+1 < maxAttempts {
			continue
		}
		if pushErr != nil {
			result.Warning = "Pull succeeded, but the push could not be completed: " + pushErr.Error()
			return result, nil
		}
		result.Push = push
		result.LastCommit = push.LastCommit
		result.Message = push.Message
		if result.Merge.UpToDate && push.UpToDate {
			result.Message = "The vault is already in sync with GitHub."
		}
		return result, nil
	}
	return SyncResult{}, errors.New("sync could not converge after the remote branch changed repeatedly")
}

// PullNow pulls and merges the remote vault snapshot without pushing back.
func (s *VaultService) PullNow() (vault.MergeResult, error) {
	vaultID, err := s.unlockedVaultID()
	if err != nil {
		return vault.MergeResult{}, err
	}
	pull, err := s.sync.PullVault(context.Background(), vaultID)
	if err != nil {
		return vault.MergeResult{}, err
	}
	if pull.Temporary {
		defer os.RemoveAll(pull.StagingPath)
	}
	if pull.UpToDate {
		s.sync.MarkSynced(vaultID)
		return vault.MergeResult{UpToDate: true}, nil
	}
	merged, err := s.store.MergeRemoteSnapshot(pull.StagingPath)
	if err != nil {
		return vault.MergeResult{}, err
	}
	s.sync.MarkSynced(vaultID)
	return merged, nil
}

func (s *VaultService) unlockedVaultID() (string, error) {
	current := s.store.Session()
	if current.Locked || current.VaultID == "" {
		return "", errors.New("unlock a vault before configuring GitHub sync")
	}
	return current.VaultID, nil
}
