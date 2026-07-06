//go:build windows

package githubsync

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

func configureBackgroundCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}
