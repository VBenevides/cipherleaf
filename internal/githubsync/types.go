package githubsync

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

const (
	FormatVersion     = 1
	ProviderGitHubSSH = "github-ssh"
	DefaultBranch     = "main"
)

var (
	ErrSettingsNotFound = errors.New("GitHub sync settings have not been saved")
	ErrRemoteAdvanced   = errors.New("the remote branch advanced during sync")
)

// SyncSettings is the device-local configuration exposed to the application
// frontend. The SSH key bytes are never read into or returned by this type.
type SyncSettings struct {
	FormatVersion     int    `json:"formatVersion"`
	VaultID           string `json:"vaultId"`
	Provider          string `json:"provider"`
	RepositorySSH     string `json:"repositorySsh"`
	PrivateKeyPath    string `json:"privateKeyPath"`
	Branch            string `json:"branch"`
	RepositoryPrivate bool   `json:"repositoryPrivate"`
	Linked            bool   `json:"linked"`
	LastSyncedAt      int64  `json:"lastSyncedAt"`
	LastSnapshotRev   string `json:"lastSnapshotRev"`
	LastCommit        string `json:"lastCommit"`
}

type ConnectionResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Warning string `json:"warning"`
	Branch  string `json:"branch"`
}

type LinkResult struct {
	Linked     bool   `json:"linked"`
	Message    string `json:"message"`
	Warning    string `json:"warning"`
	Branch     string `json:"branch"`
	LastCommit string `json:"lastCommit"`
}

type DownloadedVault struct {
	VaultID    string
	CachePath  string
	LastCommit string
	Branch     string
	Message    string
	Warning    string
}

// PushResult reports the outcome of pushing the local vault snapshot to the
// remote repository.
type PushResult struct {
	Linked                bool   `json:"linked"`
	Message               string `json:"message"`
	Warning               string `json:"warning"`
	Branch                string `json:"branch"`
	LastCommit            string `json:"lastCommit"`
	UpToDate              bool   `json:"upToDate"`
	LocalMilliseconds     int64  `json:"localMilliseconds"`
	TransportMilliseconds int64  `json:"transportMilliseconds"`
	TransportPerformed    bool   `json:"transportPerformed"`
}

// PullResult reports the outcome of fetching the remote snapshot. StagingPath
// points at the materialized encrypted layout; Temporary indicates ownership.
type PullResult struct {
	Linked                bool   `json:"linked"`
	Message               string `json:"message"`
	Warning               string `json:"warning"`
	Branch                string `json:"branch"`
	LastCommit            string `json:"lastCommit"`
	StagingPath           string `json:"stagingPath"`
	Temporary             bool   `json:"temporary"`
	UpToDate              bool   `json:"upToDate"`
	TransportMilliseconds int64  `json:"transportMilliseconds"`
	UsedPrefetch          bool   `json:"usedPrefetch"`
}

type Repository struct {
	Owner     string
	Name      string
	Canonical string
}

func DefaultSettings(vaultID string) SyncSettings {
	return SyncSettings{
		FormatVersion: FormatVersion,
		VaultID:       vaultID,
		Provider:      ProviderGitHubSSH,
		Branch:        DefaultBranch,
	}
}

// ValidateSettings normalizes and validates settings before they are saved or
// used by a Git process.
func ValidateSettings(settings SyncSettings, vaultID string) (SyncSettings, string, error) {
	if strings.TrimSpace(vaultID) == "" {
		return SyncSettings{}, "", errors.New("an unlocked vault is required")
	}
	if settings.VaultID != "" && settings.VaultID != vaultID {
		return SyncSettings{}, "", errors.New("sync settings belong to another vault")
	}
	settings, warning, err := validateCommonSettings(settings)
	if err != nil {
		return SyncSettings{}, "", err
	}
	settings.VaultID = vaultID
	return settings, warning, nil
}

func ValidateDownloadSettings(settings SyncSettings) (SyncSettings, string, error) {
	settings, warning, err := validateCommonSettings(settings)
	if err != nil {
		return SyncSettings{}, "", err
	}
	settings.VaultID = ""
	settings.Linked = false
	return settings, warning, nil
}

func validateCommonSettings(settings SyncSettings) (SyncSettings, string, error) {
	repository, err := ParseGitHubSSHRepository(settings.RepositorySSH)
	if err != nil {
		return SyncSettings{}, "", err
	}
	keyPath, warning, err := validatePrivateKeyPath(settings.PrivateKeyPath)
	if err != nil {
		return SyncSettings{}, "", err
	}
	branch := strings.TrimSpace(settings.Branch)
	if branch == "" {
		branch = DefaultBranch
	}
	if !validBranch(branch) {
		return SyncSettings{}, "", errors.New("Git branch name is invalid")
	}
	if !settings.RepositoryPrivate {
		return SyncSettings{}, "", errors.New("confirm that the GitHub repository is private")
	}
	settings.FormatVersion = FormatVersion
	settings.Provider = ProviderGitHubSSH
	settings.RepositorySSH = repository.Canonical
	settings.PrivateKeyPath = keyPath
	settings.Branch = branch
	return settings, warning, nil
}

func ParseGitHubSSHRepository(value string) (Repository, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return Repository{}, errors.New("GitHub repository SSH URL is required")
	}

	var path string
	switch {
	case strings.HasPrefix(value, "git@github.com:"):
		path = strings.TrimPrefix(value, "git@github.com:")
	case strings.HasPrefix(value, "ssh://"):
		parsed, err := url.Parse(value)
		if err != nil || parsed.Scheme != "ssh" || parsed.User == nil ||
			parsed.User.Username() != "git" || parsed.User.String() != "git" ||
			!strings.EqualFold(parsed.Hostname(), "github.com") ||
			(parsed.Port() != "" && parsed.Port() != "22") ||
			parsed.RawQuery != "" || parsed.Fragment != "" {
			return Repository{}, invalidRepositoryError()
		}
		path = strings.TrimPrefix(parsed.EscapedPath(), "/")
		if unescaped, err := url.PathUnescape(path); err == nil {
			path = unescaped
		}
	default:
		return Repository{}, invalidRepositoryError()
	}

	path = strings.TrimSuffix(path, ".git")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || !validRepositoryPart(parts[0]) || !validRepositoryPart(parts[1]) {
		return Repository{}, invalidRepositoryError()
	}
	return Repository{
		Owner:     parts[0],
		Name:      parts[1],
		Canonical: fmt.Sprintf("git@github.com:%s/%s.git", parts[0], parts[1]),
	}, nil
}

func invalidRepositoryError() error {
	return errors.New("use a GitHub SSH URL such as git@github.com:OWNER/REPOSITORY.git")
}

func validRepositoryPart(value string) bool {
	if value == "" || value == "." || value == ".." || strings.Contains(value, "..") {
		return false
	}
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsDigit(character) ||
			character == '-' || character == '_' || character == '.' {
			continue
		}
		return false
	}
	return true
}

func validatePrivateKeyPath(value string) (string, string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", "", errors.New("GitHub SSH private key location is required")
	}
	if strings.EqualFold(filepath.Ext(value), ".pub") {
		return "", "", errors.New("select the SSH private key, not its .pub public key")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", "", errors.New("could not resolve the SSH private key location")
	}
	absolute = filepath.Clean(absolute)
	info, err := os.Stat(absolute)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", errors.New("the selected SSH private key does not exist")
	}
	if err != nil {
		return "", "", errors.New("the selected SSH private key cannot be inspected")
	}
	if !info.Mode().IsRegular() {
		return "", "", errors.New("the selected SSH private key is not a regular file")
	}
	warning := ""
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		warning = "SSH key permissions are broader than owner-only; use chmod 600 on the key."
	}
	return absolute, warning, nil
}

func validBranch(value string) bool {
	if value == "" || value == "@" || strings.HasPrefix(value, "-") ||
		strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") ||
		strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") ||
		strings.HasSuffix(value, ".lock") || strings.Contains(value, "..") ||
		strings.Contains(value, "@{") || strings.ContainsAny(value, " ~^:?*[\\") {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return !strings.Contains(value, "//")
}

// RedactCommandError converts transport output into an actionable message
// without returning repository URLs, key paths, command environments, or
// arbitrary remote output to the UI.
func RedactCommandError(output string) error {
	lower := strings.ToLower(output)
	switch {
	case strings.Contains(lower, "permission denied (publickey)"):
		return errors.New("GitHub rejected the selected SSH key; add its public key to the repository with write access")
	case strings.Contains(lower, "repository not found"):
		return errors.New("GitHub repository was not found or the selected SSH key cannot access it")
	case strings.Contains(lower, "host key verification failed"):
		return errors.New("GitHub host identity verification failed")
	case strings.Contains(lower, "could not resolve hostname"),
		strings.Contains(lower, "connection timed out"),
		strings.Contains(lower, "network is unreachable"),
		strings.Contains(lower, "connection refused"):
		return errors.New("GitHub could not be reached over SSH")
	case strings.Contains(lower, "non-fast-forward"):
		return errors.New("GitHub accepted the key, but the branch changed during the connection test")
	default:
		return errors.New("the GitHub SSH connection could not be completed")
	}
}
