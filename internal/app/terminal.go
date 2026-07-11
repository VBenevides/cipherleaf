package app

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
)

func openTerminal(directory string) error {
	if runtime.GOOS == "darwin" {
		return startTerminal(exec.Command("open", "-a", "Terminal", directory))
	}
	if runtime.GOOS == "windows" {
		command := exec.Command("cmd.exe", "/K")
		command.Dir = directory
		return startTerminal(command)
	}
	for _, name := range []string{
		"x-terminal-emulator", "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "xterm",
	} {
		if _, err := exec.LookPath(name); err == nil {
			command := exec.Command(name)
			command.Dir = directory
			return startTerminal(command)
		}
	}
	return errors.New("no supported terminal application was found")
}

func startTerminal(command *exec.Cmd) error {
	if err := command.Start(); err != nil {
		return fmt.Errorf("open terminal: %w", err)
	}
	go func() { _ = command.Wait() }()
	return nil
}
