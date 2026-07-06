//go:build !windows

package githubsync

import "os/exec"

func configureBackgroundCommand(_ *exec.Cmd) {}
