package githubsync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// These host keys are published by GitHub at:
// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
const githubKnownHosts = `github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
`

type ConnectionTester interface {
	TestConnection(ctx context.Context, settings SyncSettings) (ConnectionResult, error)
}

type GitTransport interface {
	Run(ctx context.Context, name string, args []string, environment []string) ([]byte, error)
}

type ExecCommandRunner struct{}

// ToolVersions returns the installed Git and OpenSSH versions without opening
// a console window on Windows.
func ToolVersions() (string, string) {
	return toolVersion("git", "--version"), toolVersion("ssh", "-V")
}

func toolVersion(name string, arguments ...string) string {
	command := exec.Command(name, arguments...)
	configureBackgroundCommand(command)
	output, err := command.CombinedOutput()
	if err != nil && len(output) == 0 {
		return "unavailable"
	}
	return strings.Join(strings.Fields(string(output)), " ")
}

func (ExecCommandRunner) Run(
	ctx context.Context,
	name string,
	args []string,
	environment []string,
) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	configureBackgroundCommand(command)
	command.Env = mergedEnvironment(os.Environ(), environment)
	stdout := &limitedBuffer{limit: 20 * 1024 * 1024}
	stderr := &limitedBuffer{limit: 1024 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if err == nil {
		return stdout.Bytes(), nil
	}
	return append(stdout.Bytes(), stderr.Bytes()...), err
}

type GitConnectionTester struct {
	runner     GitTransport
	runtimeDir string
	timeout    time.Duration
}

func NewGitConnectionTester(runtimeDir string) *GitConnectionTester {
	return &GitConnectionTester{
		runner:     ExecCommandRunner{},
		runtimeDir: runtimeDir,
		timeout:    35 * time.Second,
	}
}

func (t *GitConnectionTester) TestConnection(
	parent context.Context,
	settings SyncSettings,
) (ConnectionResult, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return ConnectionResult{}, errors.New("Git is not installed or is not available on PATH")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return ConnectionResult{}, errors.New("OpenSSH is not installed or is not available on PATH")
	}
	knownHosts, wrapper, err := prepareSSHFiles(t.runtimeDir)
	if err != nil {
		return ConnectionResult{}, err
	}
	emptyHooks := filepath.Join(t.runtimeDir, "empty-hooks")
	if err := os.MkdirAll(emptyHooks, 0o700); err != nil {
		return ConnectionResult{}, errors.New("could not prepare safe Git hooks configuration")
	}
	contextWithTimeout, cancel := context.WithTimeout(parent, t.timeout)
	defer cancel()
	environment := secureGitEnvironment(settings, knownHosts, wrapper)

	output, err := t.runner.Run(
		contextWithTimeout,
		"git",
		[]string{"ls-remote", "--symref", settings.RepositorySSH, "HEAD"},
		environment,
	)
	if err != nil {
		return ConnectionResult{}, transportError(contextWithTimeout, output)
	}

	testRepository, err := os.MkdirTemp("", "cipherleaf-connection-*")
	if err != nil {
		return ConnectionResult{}, errors.New("could not create a temporary Git connection test")
	}
	defer os.RemoveAll(testRepository)
	localCommands := [][]string{
		{"-C", testRepository, "init", "--quiet"},
		{
			"-c", "core.hooksPath=" + emptyHooks,
			"-c", "user.name=Cipherleaf connection test",
			"-c", "user.email=connection-test@cipherleaf.local",
			"-C", testRepository,
			"commit", "--quiet", "--allow-empty", "--no-gpg-sign", "--no-verify",
			"-m", "Cipherleaf connection test",
		},
	}
	for _, arguments := range localCommands {
		_, err = t.runner.Run(contextWithTimeout, "git", arguments, localGitEnvironment())
		if err != nil {
			return ConnectionResult{}, errors.New("Git could not prepare its temporary write-permission test")
		}
	}
	testRef := fmt.Sprintf(
		"HEAD:refs/heads/cipherleaf-connection-test-%d",
		time.Now().UTC().UnixNano(),
	)
	output, err = t.runner.Run(
		contextWithTimeout,
		"git",
		[]string{
			"-c", "core.hooksPath=" + emptyHooks,
			"-C", testRepository,
			"push", "--dry-run", "--no-verify", settings.RepositorySSH, testRef,
		},
		environment,
	)
	if err != nil {
		return ConnectionResult{}, transportError(contextWithTimeout, output)
	}
	return ConnectionResult{
		Success: true,
		Message: "Connected to GitHub and verified repository write access without changing the repository.",
		Branch:  settings.Branch,
	}, nil
}

func prepareSSHFiles(runtimeDir string) (string, string, error) {
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return "", "", errors.New("could not prepare secure GitHub connection files")
	}
	if err := os.Chmod(runtimeDir, 0o700); err != nil {
		return "", "", errors.New("could not protect GitHub connection files")
	}
	knownHosts := filepath.Join(runtimeDir, "github-known-hosts")
	if err := os.WriteFile(knownHosts, []byte(githubKnownHosts), 0o600); err != nil {
		return "", "", errors.New("could not prepare GitHub host identity verification")
	}
	if err := os.Chmod(knownHosts, 0o600); err != nil {
		return "", "", errors.New("could not protect GitHub host identity verification")
	}
	if runtime.GOOS == "windows" {
		wrapper := filepath.Join(runtimeDir, "cipherleaf-ssh.cmd")
		script := "@echo off\r\nssh -i \"%CIPHERLEAF_SSH_KEY%\" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o \"UserKnownHostsFile=%CIPHERLEAF_KNOWN_HOSTS%\" %*\r\n"
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			return "", "", errors.New("could not prepare the secure SSH command")
		}
		return knownHosts, wrapper, nil
	}
	wrapper := filepath.Join(runtimeDir, "cipherleaf-ssh")
	script := "#!/bin/sh\nexec ssh -i \"$CIPHERLEAF_SSH_KEY\" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$CIPHERLEAF_KNOWN_HOSTS\" -o ControlMaster=auto -o ControlPersist=30 -o ControlPath=\"$CIPHERLEAF_SSH_CONTROL_PATH\" \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		return "", "", errors.New("could not prepare the secure SSH command")
	}
	if err := os.Chmod(wrapper, 0o700); err != nil {
		return "", "", errors.New("could not protect the secure SSH command")
	}
	return knownHosts, wrapper, nil
}

var remoteObjectPath = regexp.MustCompile(`^objects/([a-f0-9]{2})/([a-f0-9]{32})\.enc$`)
var remoteAttachmentPath = regexp.MustCompile(`^attachments/(?:[a-f0-9]{32}|shared)/([a-f0-9]{32})\.enc$`)
var remoteTrackingObjectPath = regexp.MustCompile(`^tracking/objects/([a-f0-9]{2})/([a-f0-9]{32})\.enc$`)
var remoteVaultID = regexp.MustCompile(`^[a-f0-9]{32}$`)

type GitHubSSHProvider struct {
	runner     GitTransport
	runtimeDir string
	cacheRoot  string
	timeout    time.Duration
	prefetchMu sync.Mutex
	prefetched map[string]time.Time
}

func NewGitHubSSHProvider(runtimeDir, cacheRoot string) *GitHubSSHProvider {
	return &GitHubSSHProvider{
		runner:     ExecCommandRunner{},
		runtimeDir: runtimeDir,
		cacheRoot:  cacheRoot,
		timeout:    2 * time.Minute,
		prefetched: make(map[string]time.Time),
	}
}

func (p *GitHubSSHProvider) Prefetch(ctx context.Context, settings SyncSettings) error {
	knownHosts, wrapper, err := prepareSSHFiles(p.runtimeDir)
	if err != nil {
		return err
	}
	cachePath := p.cacheRepositoryPath(settings)
	if _, err := os.Stat(filepath.Join(cachePath, ".git")); err != nil {
		return nil
	}
	contextWithTimeout, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	output, err := p.runner.Run(contextWithTimeout, "git", []string{
		"-C", cachePath, "fetch", "--quiet", "--prune", "--depth=1", "origin",
		"+refs/heads/" + settings.Branch + ":refs/remotes/origin/" + settings.Branch,
	}, secureGitEnvironment(settings, knownHosts, wrapper))
	if err != nil {
		return transportError(contextWithTimeout, output)
	}
	p.prefetchMu.Lock()
	p.prefetched[cachePath] = time.Now()
	p.prefetchMu.Unlock()
	return nil
}

// GitWorkingDirectory returns the persistent local checkout for a linked vault.
func (p *GitHubSSHProvider) GitWorkingDirectory(settings SyncSettings) string {
	return filepath.Join(p.cacheRoot, settings.VaultID)
}

func DefaultCacheRoot() string {
	root, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(root) == "" {
		root = os.TempDir()
	}
	return filepath.Join(root, "Cipherleaf", "github-sync")
}

func (p *GitHubSSHProvider) Link(
	parent context.Context,
	settings SyncSettings,
	snapshot RemoteSnapshotStore,
) (LinkResult, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return LinkResult{}, errors.New("Git is not installed or is not available on PATH")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return LinkResult{}, errors.New("OpenSSH is not installed or is not available on PATH")
	}
	knownHosts, wrapper, err := prepareSSHFiles(p.runtimeDir)
	if err != nil {
		return LinkResult{}, err
	}
	if err := os.MkdirAll(p.cacheRoot, 0o700); err != nil {
		return LinkResult{}, errors.New("could not prepare the encrypted Git cache")
	}
	if err := os.Chmod(p.cacheRoot, 0o700); err != nil {
		return LinkResult{}, errors.New("could not protect the encrypted Git cache")
	}
	emptyHooks := filepath.Join(p.runtimeDir, "empty-hooks")
	if err := os.MkdirAll(emptyHooks, 0o700); err != nil {
		return LinkResult{}, errors.New("could not prepare safe Git hooks configuration")
	}
	contextWithTimeout, cancel := context.WithTimeout(parent, p.timeout)
	defer cancel()
	environment := secureGitEnvironment(settings, knownHosts, wrapper)

	refs, err := p.runner.Run(
		contextWithTimeout,
		"git",
		[]string{"ls-remote", settings.RepositorySSH},
		environment,
	)
	if err != nil {
		return LinkResult{}, transportError(contextWithTimeout, refs)
	}
	remoteReference := findRemoteBranch(refs, settings.Branch)
	remoteEmpty := len(bytes.TrimSpace(refs)) == 0
	if !remoteEmpty && remoteReference == "" {
		return LinkResult{}, errors.New("the configured branch does not exist in this non-empty repository")
	}

	stagingRoot, err := os.MkdirTemp(p.cacheRoot, ".link-"+settings.VaultID+"-*")
	if err != nil {
		return LinkResult{}, errors.New("could not prepare a temporary encrypted Git cache")
	}
	defer os.RemoveAll(stagingRoot)
	workingTree := filepath.Join(stagingRoot, "repository")
	output, err := p.runner.Run(
		contextWithTimeout,
		"git",
		[]string{"clone", "--quiet", "--no-checkout", settings.RepositorySSH, workingTree},
		environment,
	)
	if err != nil {
		return LinkResult{}, transportError(contextWithTimeout, output)
	}

	var commit string
	if remoteEmpty {
		commit, err = p.initializeEmptyRepository(
			contextWithTimeout,
			settings,
			snapshot,
			workingTree,
			emptyHooks,
			environment,
		)
	} else {
		commit, err = p.acceptExistingRepository(
			contextWithTimeout,
			settings,
			snapshot,
			workingTree,
			remoteReference,
			emptyHooks,
			environment,
		)
	}
	if err != nil {
		return LinkResult{}, err
	}
	if err := installCache(workingTree, filepath.Join(p.cacheRoot, settings.VaultID)); err != nil {
		return LinkResult{}, err
	}
	message := "Vault linked to the existing encrypted GitHub snapshot."
	if remoteEmpty {
		message = "Vault linked and the encrypted GitHub repository was initialized."
	}
	return LinkResult{
		Linked:     true,
		Message:    message,
		Branch:     settings.Branch,
		LastCommit: commit,
	}, nil
}

func (p *GitHubSSHProvider) Download(
	parent context.Context,
	settings SyncSettings,
) (DownloadedVault, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return DownloadedVault{}, errors.New("Git is not installed or is not available on PATH")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return DownloadedVault{}, errors.New("OpenSSH is not installed or is not available on PATH")
	}
	knownHosts, wrapper, err := prepareSSHFiles(p.runtimeDir)
	if err != nil {
		return DownloadedVault{}, err
	}
	if err := os.MkdirAll(p.cacheRoot, 0o700); err != nil {
		return DownloadedVault{}, errors.New("could not prepare the encrypted Git cache")
	}
	if err := os.Chmod(p.cacheRoot, 0o700); err != nil {
		return DownloadedVault{}, errors.New("could not protect the encrypted Git cache")
	}
	contextWithTimeout, cancel := context.WithTimeout(parent, p.timeout)
	defer cancel()
	environment := secureGitEnvironment(settings, knownHosts, wrapper)
	refs, err := p.runner.Run(
		contextWithTimeout,
		"git",
		[]string{"ls-remote", settings.RepositorySSH},
		environment,
	)
	if err != nil {
		return DownloadedVault{}, transportError(contextWithTimeout, refs)
	}
	if len(bytes.TrimSpace(refs)) == 0 {
		return DownloadedVault{}, errors.New("the GitHub repository is empty and does not contain a vault")
	}
	if findRemoteBranch(refs, settings.Branch) == "" {
		return DownloadedVault{}, errors.New("the configured branch does not exist in this repository")
	}

	stagingRoot, err := os.MkdirTemp(p.cacheRoot, ".download-*")
	if err != nil {
		return DownloadedVault{}, errors.New("could not prepare a temporary encrypted Git cache")
	}
	defer os.RemoveAll(stagingRoot)
	workingTree := filepath.Join(stagingRoot, "repository")
	output, err := p.runner.Run(
		contextWithTimeout,
		"git",
		[]string{
			"clone", "--quiet", "--depth=1", "--single-branch",
			"--branch", settings.Branch, "--no-checkout",
			settings.RepositorySSH, workingTree,
		},
		environment,
	)
	if err != nil {
		return DownloadedVault{}, transportError(contextWithTimeout, output)
	}
	reference := "origin/" + settings.Branch
	if err := p.materializeExistingRepository(contextWithTimeout, workingTree, reference); err != nil {
		return DownloadedVault{}, err
	}
	if err := p.prepareExistingCache(
		contextWithTimeout,
		workingTree,
		settings.Branch,
		reference,
	); err != nil {
		return DownloadedVault{}, err
	}
	commit, err := p.resolveCommit(contextWithTimeout, workingTree)
	if err != nil {
		return DownloadedVault{}, err
	}
	vaultID, err := readRemoteVaultID(workingTree)
	if err != nil {
		return DownloadedVault{}, err
	}
	cachePath := filepath.Join(p.cacheRoot, vaultID)
	if err := installCache(workingTree, cachePath); err != nil {
		return DownloadedVault{}, err
	}
	return DownloadedVault{
		VaultID:    vaultID,
		CachePath:  cachePath,
		LastCommit: commit,
		Branch:     settings.Branch,
		Message:    "Encrypted vault downloaded and authenticated.",
	}, nil
}

func (p *GitHubSSHProvider) cacheRepositoryPath(settings SyncSettings) string {
	return filepath.Join(p.cacheRoot, settings.VaultID)
}

// Push exports the local vault snapshot into the linked Git cache repository,
// commits any changes, and pushes them to the configured branch.
func (p *GitHubSSHProvider) Push(
	parent context.Context,
	settings SyncSettings,
	snapshot RemoteSnapshotStore,
) (PushResult, error) {
	return p.push(parent, settings, snapshot, false)
}

func (p *GitHubSSHProvider) ForcePush(
	parent context.Context,
	settings SyncSettings,
	snapshot RemoteSnapshotStore,
) (PushResult, error) {
	return p.push(parent, settings, snapshot, true)
}

func (p *GitHubSSHProvider) push(
	parent context.Context,
	settings SyncSettings,
	snapshot RemoteSnapshotStore,
	force bool,
) (PushResult, error) {
	localStartedAt := time.Now()
	if _, err := exec.LookPath("git"); err != nil {
		return PushResult{}, errors.New("Git is not installed or is not available on PATH")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return PushResult{}, errors.New("OpenSSH is not installed or is not available on PATH")
	}
	cachePath := p.cacheRepositoryPath(settings)
	if _, err := os.Stat(filepath.Join(cachePath, ".git")); err != nil {
		return PushResult{}, errors.New("link this vault to GitHub before pushing")
	}
	knownHosts, wrapper, err := prepareSSHFiles(p.runtimeDir)
	if err != nil {
		return PushResult{}, err
	}
	emptyHooks := filepath.Join(p.runtimeDir, "empty-hooks")
	if err := os.MkdirAll(emptyHooks, 0o700); err != nil {
		return PushResult{}, errors.New("could not prepare safe Git hooks configuration")
	}
	contextWithTimeout, cancel := context.WithTimeout(parent, p.timeout)
	defer cancel()
	environment := secureGitEnvironment(settings, knownHosts, wrapper)

	if err := snapshot.ExportRemoteSnapshot(cachePath); err != nil {
		return PushResult{}, err
	}
	if err := validateWorkingTreeLayout(cachePath); err != nil {
		return PushResult{}, err
	}
	if err := p.stageChangedSnapshot(contextWithTimeout, cachePath); err != nil {
		return PushResult{}, errors.New("Git could not stage the encrypted vault snapshot")
	}
	staged, err := p.runner.Run(
		contextWithTimeout,
		"git",
		[]string{"-C", cachePath, "diff", "--cached", "--name-only"},
		localGitEnvironment(),
	)
	if err != nil {
		return PushResult{}, errors.New("Git could not inspect the staged snapshot")
	}
	if len(bytes.TrimSpace(staged)) == 0 {
		commit, err := p.resolveCommit(contextWithTimeout, cachePath)
		if err != nil {
			return PushResult{}, err
		}
		return PushResult{
			Linked:     true,
			Message:    "The local vault is already in sync with GitHub.",
			Branch:     settings.Branch,
			LastCommit: commit,
			UpToDate:   true,
		}, nil
	}
	commitArguments := []string{
		"-c", "core.hooksPath=" + emptyHooks,
		"-c", "user.name=Cipherleaf",
		"-c", "user.email=sync@cipherleaf.local",
		"-C", cachePath,
		"commit", "--quiet", "--no-gpg-sign", "--no-verify",
		"-m", "Update encrypted Cipherleaf vault",
	}
	if output, err := p.runner.Run(contextWithTimeout, "git", commitArguments, localGitEnvironment()); err != nil {
		_ = output
		return PushResult{}, errors.New("Git could not commit the encrypted vault snapshot")
	}
	pushArguments := []string{
		"-c", "core.hooksPath=" + emptyHooks,
		"-C", cachePath,
		"push", "--quiet", "--no-verify",
	}
	if force {
		pushArguments = append(pushArguments, "--force-with-lease")
	}
	pushArguments = append(pushArguments,
		"origin",
		"HEAD:refs/heads/"+settings.Branch,
	)
	localMilliseconds := time.Since(localStartedAt).Milliseconds()
	transportStartedAt := time.Now()
	output, err := p.runner.Run(contextWithTimeout, "git", pushArguments, environment)
	transportMilliseconds := time.Since(transportStartedAt).Milliseconds()
	if err != nil {
		if isNonFastForward(output) {
			return PushResult{}, ErrRemoteAdvanced
		}
		return PushResult{}, transportError(contextWithTimeout, output)
	}
	commit, err := p.resolveCommit(contextWithTimeout, cachePath)
	if err != nil {
		return PushResult{}, err
	}
	if err := p.recordPushedTip(
		contextWithTimeout,
		cachePath,
		settings,
	); err != nil {
		return PushResult{}, err
	}
	return PushResult{
		Linked:                true,
		Message:               map[bool]string{true: "The local encrypted vault snapshot replaced the remote branch.", false: "The encrypted vault snapshot was pushed to GitHub."}[force],
		Branch:                settings.Branch,
		LastCommit:            commit,
		UpToDate:              false,
		LocalMilliseconds:     localMilliseconds,
		TransportMilliseconds: transportMilliseconds,
		TransportPerformed:    true,
	}, nil
}

func (p *GitHubSSHProvider) stageChangedSnapshot(ctx context.Context, cachePath string) error {
	output, err := p.runner.Run(ctx, "git", []string{
		"-C", cachePath, "status", "--porcelain=v1", "-z", "--untracked-files=all",
	}, localGitEnvironment())
	if err != nil {
		return err
	}
	entries := bytes.Split(output, []byte{0})
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if len(entry) < 4 || entry[2] != ' ' {
			continue
		}
		path := string(entry[3:])
		if path != "" {
			paths = append(paths, path)
		}
	}
	for len(paths) > 0 {
		count := min(len(paths), 256)
		arguments := append([]string{"-C", cachePath, "add", "-A", "--"}, paths[:count]...)
		if _, err := p.runner.Run(ctx, "git", arguments, localGitEnvironment()); err != nil {
			return err
		}
		paths = paths[count:]
	}
	return nil
}

// Pull fetches the remote branch into the persistent encrypted cache and only
// rematerializes the snapshot when the remote commit changed.
func (p *GitHubSSHProvider) Pull(
	parent context.Context,
	settings SyncSettings,
) (PullResult, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return PullResult{}, errors.New("Git is not installed or is not available on PATH")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return PullResult{}, errors.New("OpenSSH is not installed or is not available on PATH")
	}
	knownHosts, wrapper, err := prepareSSHFiles(p.runtimeDir)
	if err != nil {
		return PullResult{}, err
	}
	if err := os.MkdirAll(p.cacheRoot, 0o700); err != nil {
		return PullResult{}, errors.New("could not prepare the encrypted Git cache")
	}
	if err := os.Chmod(p.cacheRoot, 0o700); err != nil {
		return PullResult{}, errors.New("could not protect the encrypted Git cache")
	}
	contextWithTimeout, cancel := context.WithTimeout(parent, p.timeout)
	defer cancel()
	environment := secureGitEnvironment(settings, knownHosts, wrapper)
	cachePath, err := p.ensureLinkedCache(
		contextWithTimeout,
		settings,
		environment,
	)
	if err != nil {
		return PullResult{}, err
	}
	reference := "origin/" + settings.Branch
	previousCommit, _ := p.resolveCommit(contextWithTimeout, cachePath)
	fetchArguments := []string{
		"-C", cachePath,
		"fetch", "--quiet", "--prune", "--depth=1", "origin",
		"+refs/heads/" + settings.Branch + ":refs/remotes/origin/" + settings.Branch,
	}
	p.prefetchMu.Lock()
	prefetchedAt, prefetched := p.prefetched[cachePath]
	delete(p.prefetched, cachePath)
	p.prefetchMu.Unlock()
	usedPrefetch := prefetched && time.Since(prefetchedAt) <= 30*time.Second
	transportStartedAt := time.Now()
	var output []byte
	if !usedPrefetch {
		output, err = p.runner.Run(contextWithTimeout, "git", fetchArguments, environment)
	}
	transportMilliseconds := time.Since(transportStartedAt).Milliseconds()
	if err != nil {
		return PullResult{}, transportError(contextWithTimeout, output)
	}
	remoteCommit, err := p.resolveReference(contextWithTimeout, cachePath, reference)
	if err != nil {
		return PullResult{}, err
	}
	if previousCommit == remoteCommit {
		return PullResult{
			Linked:                true,
			Message:               "The encrypted GitHub snapshot is unchanged.",
			Branch:                settings.Branch,
			LastCommit:            remoteCommit,
			StagingPath:           cachePath,
			Temporary:             false,
			UpToDate:              true,
			TransportMilliseconds: transportMilliseconds,
			UsedPrefetch:          usedPrefetch,
		}, nil
	}
	changed, err := p.changedRemotePaths(
		contextWithTimeout,
		cachePath,
		previousCommit,
		reference,
	)
	if err != nil {
		return PullResult{}, err
	}
	if err := p.materializeChangedRepository(contextWithTimeout, cachePath, reference, changed); err != nil {
		return PullResult{}, err
	}
	if err := p.prepareExistingCache(
		contextWithTimeout,
		cachePath,
		settings.Branch,
		reference,
	); err != nil {
		return PullResult{}, err
	}
	commit, err := p.resolveCommit(contextWithTimeout, cachePath)
	if err != nil {
		return PullResult{}, err
	}
	return PullResult{
		Linked:                true,
		Message:               "The encrypted vault snapshot was pulled from GitHub.",
		Branch:                settings.Branch,
		LastCommit:            commit,
		StagingPath:           cachePath,
		Temporary:             false,
		UpToDate:              false,
		TransportMilliseconds: transportMilliseconds,
		UsedPrefetch:          usedPrefetch,
	}, nil
}

// recordPushedTip records the pushed tip locally. Expensive cache
// compaction is intentionally left to Git's automatic maintenance instead of
// blocking every foreground sync.
func (p *GitHubSSHProvider) recordPushedTip(
	ctx context.Context,
	cachePath string,
	settings SyncSettings,
) error {
	output, err := p.runner.Run(ctx, "git", []string{
		"-C", cachePath,
		"update-ref", "refs/remotes/origin/" + settings.Branch, "HEAD",
	}, localGitEnvironment())
	if err != nil {
		_ = output
		return errors.New("the vault was pushed, but its local Git reference could not be updated")
	}
	return nil
}

func (p *GitHubSSHProvider) ensureLinkedCache(
	ctx context.Context,
	settings SyncSettings,
	environment []string,
) (string, error) {
	cachePath := p.cacheRepositoryPath(settings)
	if info, err := os.Stat(filepath.Join(cachePath, ".git")); err == nil && info.IsDir() {
		return cachePath, nil
	}
	stagingRoot, err := os.MkdirTemp(p.cacheRoot, ".cache-rebuild-*")
	if err != nil {
		return "", errors.New("could not prepare a replacement encrypted Git cache")
	}
	defer os.RemoveAll(stagingRoot)
	workingTree := filepath.Join(stagingRoot, "repository")
	output, err := p.runner.Run(
		ctx,
		"git",
		[]string{
			"clone", "--quiet", "--depth=1", "--single-branch",
			"--branch", settings.Branch, "--no-checkout",
			settings.RepositorySSH, workingTree,
		},
		environment,
	)
	if err != nil {
		return "", transportError(ctx, output)
	}
	if err := installCache(workingTree, cachePath); err != nil {
		return "", err
	}
	return cachePath, nil
}

func (p *GitHubSSHProvider) initializeEmptyRepository(
	ctx context.Context,
	settings SyncSettings,
	snapshot RemoteSnapshotStore,
	workingTree string,
	emptyHooks string,
	environment []string,
) (string, error) {
	if output, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "switch", "--quiet", "--orphan", settings.Branch},
		localGitEnvironment(),
	); err != nil {
		_ = output
		return "", errors.New("Git could not create the configured branch")
	}
	if err := snapshot.ExportRemoteSnapshot(workingTree); err != nil {
		return "", err
	}
	if err := validateWorkingTreeLayout(workingTree); err != nil {
		return "", err
	}
	pathspecs := []string{"-C", workingTree, "add", "-A", "--", "."}
	if output, err := p.runner.Run(
		ctx,
		"git",
		pathspecs,
		localGitEnvironment(),
	); err != nil {
		_ = output
		return "", errors.New("Git could not stage the encrypted vault snapshot")
	}
	commitArguments := []string{
		"-c", "core.hooksPath=" + emptyHooks,
		"-c", "user.name=Cipherleaf",
		"-c", "user.email=sync@cipherleaf.local",
		"-C", workingTree,
		"commit", "--quiet", "--no-gpg-sign", "--no-verify",
		"-m", "Initialize encrypted Cipherleaf vault",
	}
	if output, err := p.runner.Run(
		ctx,
		"git",
		commitArguments,
		localGitEnvironment(),
	); err != nil {
		_ = output
		return "", errors.New("Git could not commit the encrypted vault snapshot")
	}
	pushArguments := []string{
		"-c", "core.hooksPath=" + emptyHooks,
		"-C", workingTree,
		"push", "--quiet", "--no-verify", "origin",
		"HEAD:refs/heads/" + settings.Branch,
	}
	output, err := p.runner.Run(ctx, "git", pushArguments, environment)
	if err != nil {
		return "", transportError(ctx, output)
	}
	return p.resolveCommit(ctx, workingTree)
}

func (p *GitHubSSHProvider) acceptExistingRepository(
	ctx context.Context,
	settings SyncSettings,
	snapshot RemoteSnapshotStore,
	workingTree string,
	remoteReference string,
	emptyHooks string,
	environment []string,
) (string, error) {
	reference := "origin/" + settings.Branch
	if remoteReference == "" {
		return "", errors.New("the configured Git branch could not be resolved")
	}
	if err := p.materializeExistingRepository(ctx, workingTree, reference); err != nil {
		return "", err
	}
	matches, err := snapshot.ValidateRemoteSnapshot(workingTree)
	if err != nil {
		return "", err
	}
	if !matches {
		return "", errors.New("the repository contains newer or different encrypted vault data; pull reconciliation is required before linking")
	}
	if err := p.prepareExistingCache(ctx, workingTree, settings.Branch, reference); err != nil {
		return "", err
	}
	if err := snapshot.ExportRemoteSnapshot(workingTree); err != nil {
		return "", err
	}
	if err := validateWorkingTreeLayout(workingTree); err != nil {
		return "", err
	}
	if output, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "add", "-A", "--", "."},
		localGitEnvironment(),
	); err != nil {
		_ = output
		return "", errors.New("Git could not stage the encrypted vault snapshot")
	}
	staged, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "diff", "--cached", "--name-only"},
		localGitEnvironment(),
	)
	if err != nil {
		return "", errors.New("Git could not inspect the staged snapshot")
	}
	if len(bytes.TrimSpace(staged)) > 0 {
		commitArguments := []string{
			"-c", "core.hooksPath=" + emptyHooks,
			"-c", "user.name=Cipherleaf",
			"-c", "user.email=sync@cipherleaf.local",
			"-C", workingTree,
			"commit", "--quiet", "--no-gpg-sign", "--no-verify",
			"-m", "Repair encrypted Cipherleaf vault metadata",
		}
		if output, err := p.runner.Run(ctx, "git", commitArguments, localGitEnvironment()); err != nil {
			_ = output
			return "", errors.New("Git could not commit the encrypted vault snapshot")
		}
		pushArguments := []string{
			"-c", "core.hooksPath=" + emptyHooks,
			"-C", workingTree,
			"push", "--quiet", "--no-verify", "origin",
			"HEAD:refs/heads/" + settings.Branch,
		}
		output, err := p.runner.Run(ctx, "git", pushArguments, environment)
		if err != nil {
			return "", transportError(ctx, output)
		}
	}
	return p.resolveCommit(ctx, workingTree)
}

func (p *GitHubSSHProvider) materializeExistingRepository(
	ctx context.Context,
	workingTree string,
	reference string,
) error {
	output, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "ls-tree", "-rz", "--name-only", reference},
		localGitEnvironment(),
	)
	if err != nil {
		return errors.New("Git could not inspect the existing repository")
	}
	if _, err := parseRemotePaths(output); err != nil {
		return err
	}
	if output, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "checkout", "--force", reference, "--", "."},
		localGitEnvironment(),
	); err != nil {
		_ = output
		return errors.New("Git could not materialize the existing encrypted repository")
	}
	if err := validateWorkingTreeLayout(workingTree); err != nil {
		return err
	}
	if err := protectMaterializedSnapshot(workingTree); err != nil {
		return err
	}
	return nil
}

type changedRemotePath struct {
	path    string
	deleted bool
}

func (p *GitHubSSHProvider) changedRemotePaths(
	ctx context.Context,
	workingTree string,
	from string,
	to string,
) ([]changedRemotePath, error) {
	remotePaths, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "ls-tree", "-rz", "--name-only", to},
		localGitEnvironment(),
	)
	if err != nil {
		return nil, errors.New("Git could not inspect the updated repository")
	}
	if _, err := parseRemotePaths(remotePaths); err != nil {
		return nil, err
	}
	diff, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "diff", "--name-status", "-z", from, to, "--"},
		localGitEnvironment(),
	)
	if err != nil {
		return nil, errors.New("Git could not inspect encrypted repository changes")
	}
	return parseChangedRemotePaths(diff)
}

func (p *GitHubSSHProvider) materializeChangedRepository(
	ctx context.Context,
	workingTree string,
	reference string,
	changed []changedRemotePath,
) error {
	checkout := make([]string, 0, len(changed))
	for _, item := range changed {
		if item.deleted {
			if err := os.Remove(filepath.Join(workingTree, item.path)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return errors.New("could not remove an obsolete encrypted Git cache file")
			}
			continue
		}
		checkout = append(checkout, item.path)
	}
	for len(checkout) > 0 {
		count := min(len(checkout), 256)
		arguments := append([]string{"-C", workingTree, "checkout", "--force", reference, "--"}, checkout[:count]...)
		if output, err := p.runner.Run(ctx, "git", arguments, localGitEnvironment()); err != nil {
			_ = output
			return errors.New("Git could not materialize updated encrypted files")
		}
		checkout = checkout[count:]
	}
	if err := protectChangedSnapshot(workingTree, changed); err != nil {
		return err
	}
	return nil
}

func (p *GitHubSSHProvider) prepareExistingCache(
	ctx context.Context,
	workingTree string,
	branch string,
	reference string,
) error {
	for _, arguments := range [][]string{
		{"-C", workingTree, "update-ref", "refs/heads/" + branch, reference},
		{"-C", workingTree, "symbolic-ref", "HEAD", "refs/heads/" + branch},
		{"-C", workingTree, "read-tree", reference},
	} {
		if output, err := p.runner.Run(
			ctx,
			"git",
			arguments,
			localGitEnvironment(),
		); err != nil {
			_ = output
			return errors.New("Git could not prepare the existing encrypted cache")
		}
	}
	return nil
}

func (p *GitHubSSHProvider) resolveCommit(ctx context.Context, workingTree string) (string, error) {
	return p.resolveReference(ctx, workingTree, "HEAD")
}

func (p *GitHubSSHProvider) resolveReference(
	ctx context.Context,
	workingTree string,
	reference string,
) (string, error) {
	output, err := p.runner.Run(
		ctx,
		"git",
		[]string{"-C", workingTree, "rev-parse", "--verify", reference},
		localGitEnvironment(),
	)
	if err != nil {
		return "", errors.New("Git could not record the synchronized commit")
	}
	commit := strings.TrimSpace(string(output))
	if len(commit) < 40 || len(commit) > 64 {
		return "", errors.New("Git returned an invalid synchronized commit")
	}
	return commit, nil
}

func secureGitEnvironment(settings SyncSettings, knownHosts, wrapper string) []string {
	controlID := sha256.Sum256([]byte(settings.VaultID + "\x00" + settings.RepositorySSH + "\x00" + settings.PrivateKeyPath))
	return append(localGitEnvironment(),
		"GIT_SSH="+wrapper,
		"CIPHERLEAF_SSH_KEY="+settings.PrivateKeyPath,
		"CIPHERLEAF_KNOWN_HOSTS="+knownHosts,
		"CIPHERLEAF_SSH_CONTROL_PATH="+filepath.Join(filepath.Dir(wrapper), "mux-"+hex.EncodeToString(controlID[:8])),
	)
}

func localGitEnvironment() []string {
	return []string{
		"GIT_TERMINAL_PROMPT=0",
		"GIT_SSH_COMMAND",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CONFIG_COUNT=0",
	}
}

func findRemoteBranch(refs []byte, branch string) string {
	suffix := "\trefs/heads/" + branch
	for _, line := range strings.Split(string(refs), "\n") {
		if strings.HasSuffix(strings.TrimSpace(line), suffix) {
			fields := strings.Fields(line)
			if len(fields) == 2 {
				return fields[1]
			}
		}
	}
	return ""
}

func parseRemotePaths(data []byte) ([]string, error) {
	raw := bytes.Split(data, []byte{0})
	paths := make([]string, 0, len(raw))
	required := map[string]bool{
		"vault.json":        false,
		"sync/manifest.enc": false,
		"sync/folders.enc":  false,
	}
	for _, item := range raw {
		if len(item) == 0 {
			continue
		}
		if len(paths) >= 100_000 {
			return nil, errors.New("the repository contains too many files for an encrypted vault")
		}
		path := string(item)
		if _, exact := required[path]; exact {
			required[path] = true
		} else if !validRemotePath(path) {
			return nil, errors.New("the non-empty repository contains an unknown or unsafe layout")
		}
		paths = append(paths, path)
	}
	for path, present := range required {
		if !present {
			return nil, fmt.Errorf("the encrypted repository is missing %s", path)
		}
	}
	return paths, nil
}

func validRemotePath(path string) bool {
	if path == "vault.json" || path == "sync/manifest.enc" || path == "sync/folders.enc" ||
		path == "sync/tracking.enc" || path == "tracking/catalog.enc" {
		return true
	}
	match := remoteObjectPath.FindStringSubmatch(path)
	trackingMatch := remoteTrackingObjectPath.FindStringSubmatch(path)
	return (len(match) == 3 && match[1] == match[2][:2]) ||
		(len(trackingMatch) == 3 && trackingMatch[1] == trackingMatch[2][:2]) ||
		remoteAttachmentPath.MatchString(path)
}

func parseChangedRemotePaths(data []byte) ([]changedRemotePath, error) {
	fields := bytes.Split(data, []byte{0})
	result := make([]changedRemotePath, 0, len(fields)/2)
	for index := 0; index < len(fields); {
		if len(fields[index]) == 0 {
			break
		}
		status := string(fields[index])
		index++
		if index >= len(fields) {
			return nil, errors.New("Git returned malformed encrypted repository changes")
		}
		if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
			if index+1 >= len(fields) {
				return nil, errors.New("Git returned malformed encrypted repository changes")
			}
			oldPath, newPath := string(fields[index]), string(fields[index+1])
			index += 2
			if !validRemotePath(oldPath) || !validRemotePath(newPath) {
				return nil, errors.New("the encrypted repository contains an unknown or unsafe layout")
			}
			if strings.HasPrefix(status, "R") {
				result = append(result, changedRemotePath{path: oldPath, deleted: true})
			}
			result = append(result, changedRemotePath{path: newPath})
			continue
		}
		path := string(fields[index])
		index++
		if !validRemotePath(path) {
			return nil, errors.New("the encrypted repository contains an unknown or unsafe layout")
		}
		switch status {
		case "A", "M", "T":
			result = append(result, changedRemotePath{path: path})
		case "D":
			result = append(result, changedRemotePath{path: path, deleted: true})
		default:
			return nil, errors.New("Git returned an unsupported encrypted repository change")
		}
	}
	return result, nil
}

func readRemoteVaultID(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "vault.json"))
	if err != nil {
		return "", errors.New("could not read the downloaded vault identity")
	}
	if len(data) > 1024*1024 {
		return "", errors.New("downloaded vault configuration is too large")
	}
	var header struct {
		FormatVersion int    `json:"format_version"`
		VaultID       string `json:"vault_id"`
		Algorithm     string `json:"algorithm"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return "", errors.New("downloaded vault configuration is damaged")
	}
	if header.FormatVersion != FormatVersion ||
		!remoteVaultID.MatchString(header.VaultID) ||
		header.Algorithm != "XChaCha20-Poly1305" {
		return "", errors.New("downloaded repository does not contain a supported encrypted vault")
	}
	return header.VaultID, nil
}

func validateWorkingTreeLayout(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if relative == ".git" && entry.IsDir() {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("encrypted snapshot contains a non-regular file")
		}
		slashPath := filepath.ToSlash(relative)
		if slashPath == "vault.json" ||
			slashPath == "sync/manifest.enc" ||
			slashPath == "sync/folders.enc" ||
			slashPath == "sync/tracking.enc" ||
			slashPath == "tracking/catalog.enc" {
			return nil
		}
		match := remoteObjectPath.FindStringSubmatch(slashPath)
		if len(match) == 3 && match[1] == match[2][:2] {
			return nil
		}
		trackingMatch := remoteTrackingObjectPath.FindStringSubmatch(slashPath)
		if len(trackingMatch) == 3 && trackingMatch[1] == trackingMatch[2][:2] {
			return nil
		}
		if remoteAttachmentPath.MatchString(slashPath) {
			return nil
		}
		return errors.New("encrypted snapshot export produced an unsafe repository path")
	})
}

func protectMaterializedSnapshot(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == ".git" && entry.IsDir() {
			return filepath.SkipDir
		}
		mode := os.FileMode(0o600)
		if entry.IsDir() {
			mode = 0o700
		}
		if err := os.Chmod(path, mode); err != nil {
			return errors.New("could not protect the encrypted Git cache")
		}
		return nil
	})
}

func protectChangedSnapshot(root string, changed []changedRemotePath) error {
	for _, item := range changed {
		if item.deleted {
			continue
		}
		path := filepath.Join(root, item.path)
		if err := os.Chmod(path, 0o600); err != nil {
			return errors.New("could not protect the encrypted Git cache")
		}
		for directory := filepath.Dir(path); directory != root; directory = filepath.Dir(directory) {
			if err := os.Chmod(directory, 0o700); err != nil {
				return errors.New("could not protect the encrypted Git cache")
			}
		}
	}
	return nil
}

func installCache(source, destination string) error {
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return errors.New("could not prepare the encrypted Git cache destination")
	}
	backup := destination + ".previous"
	if err := os.RemoveAll(backup); err != nil {
		return errors.New("could not prepare the previous encrypted Git cache")
	}
	if _, err := os.Lstat(destination); err == nil {
		if err := os.Rename(destination, backup); err != nil {
			return errors.New("could not preserve the previous encrypted Git cache")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("could not inspect the encrypted Git cache")
	}
	if err := os.Rename(source, destination); err != nil {
		_ = os.Rename(backup, destination)
		return errors.New("could not activate the encrypted Git cache")
	}
	if err := os.RemoveAll(backup); err != nil {
		return errors.New("the encrypted Git cache was activated, but its previous copy could not be removed")
	}
	return nil
}

type limitedBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *limitedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - len(b.data)
	if remaining > 0 {
		if len(value) < remaining {
			remaining = len(value)
		}
		b.data = append(b.data, value[:remaining]...)
	}
	return len(value), nil
}

func (b *limitedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.data)
}

func transportError(ctx context.Context, output []byte) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return errors.New("the GitHub SSH connection timed out")
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("the GitHub SSH connection was cancelled")
	}
	// Only classified text leaves this boundary. Raw Git/SSH output can contain
	// repository names and local paths.
	return RedactCommandError(strings.TrimSpace(string(output)))
}

func isNonFastForward(output []byte) bool {
	lower := strings.ToLower(string(output))
	return strings.Contains(lower, "non-fast-forward") ||
		strings.Contains(lower, "fetch first") ||
		(strings.Contains(lower, "[rejected]") &&
			strings.Contains(lower, "failed to push"))
}

func mergedEnvironment(base, overrides []string) []string {
	overrideNames := make(map[string]struct{}, len(overrides))
	for _, value := range overrides {
		name, _, _ := strings.Cut(value, "=")
		overrideNames[strings.ToUpper(name)] = struct{}{}
	}
	result := make([]string, 0, len(base)+len(overrides))
	for _, value := range base {
		name, _, _ := strings.Cut(value, "=")
		if _, replaced := overrideNames[strings.ToUpper(name)]; !replaced {
			result = append(result, value)
		}
	}
	for _, value := range overrides {
		if strings.Contains(value, "=") {
			result = append(result, value)
		}
	}
	return result
}
