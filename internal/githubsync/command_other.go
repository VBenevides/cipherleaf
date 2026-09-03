//go:build !windows

package githubsync

import "os/exec"

func configureBackgroundCommand(_ *exec.Cmd) {
	// Unix does not need a platform-specific process configuration.
}
