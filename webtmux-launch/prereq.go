package main

// Prerequisites the launcher cannot supply itself — an ssh client here, tmux
// on the target — and how to get them on each OS. Checked before the first
// step that needs them, so the user is told what to install instead of seeing
// `exec: "ssh": executable file not found` or a probe that cannot find tmux.

import (
	"fmt"
	"os/exec"
	"runtime"
)

// requireSSH fails with install instructions when there is no ssh client on
// PATH. The launcher shells out to the system ssh on purpose (see ssh.go), so
// without one it has nothing to connect with.
func requireSSH() error {
	if _, err := exec.LookPath("ssh"); err == nil {
		return nil
	}
	return fmt.Errorf("no ssh client found on PATH\n%s", sshInstallHint(runtime.GOOS))
}

// sshInstallHint: macOS and Windows 10 1809+/11 ship an OpenSSH client, so
// missing ssh there is unusual and the hint says how to turn it back on.
func sshInstallHint(goos string) string {
	switch goos {
	case "windows":
		return "Windows 10 (1809+) and 11 include OpenSSH Client as an optional feature:\n" +
			"  Settings → System → Optional features → Add a feature → \"OpenSSH Client\"\n" +
			"or, in an administrator PowerShell:\n" +
			"  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0\n" +
			"then open a NEW terminal so PATH picks up C:\\Windows\\System32\\OpenSSH."
	case "darwin":
		return "macOS ships /usr/bin/ssh; if it is gone, check PATH, or: brew install openssh"
	default:
		return "install your distro's OpenSSH client, e.g. sudo apt install openssh-client " +
			"(dnf/zypper: openssh-clients, pacman: openssh, apk: openssh-client)"
	}
}

// tmuxInstallHint says how to install tmux on the target, from its `uname -s`
// and /etc/os-release ID.
func tmuxInstallHint(targetOS, distro string) string {
	switch {
	case targetOS == "Darwin":
		// macOS has no tmux and no package manager of its own; Homebrew is the
		// common answer, MacPorts the other.
		return "brew install tmux   (no Homebrew? see https://brew.sh — or with MacPorts: sudo port install tmux)"
	case targetOS == "FreeBSD":
		return "sudo pkg install tmux"
	}
	switch distro {
	case "debian", "ubuntu", "raspbian", "linuxmint", "pop":
		return "sudo apt install tmux"
	case "fedora", "rhel", "centos", "rocky", "almalinux":
		return "sudo dnf install tmux"
	case "arch", "manjaro":
		return "sudo pacman -S tmux"
	case "alpine":
		return "sudo apk add tmux"
	case "opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles":
		return "sudo zypper install tmux"
	case "":
		return "your package manager's tmux package"
	default:
		return "your package manager's tmux package (" + distro + ")"
	}
}

// nativeWindowsError explains why "this machine" cannot be native Windows and
// what to do instead. Used when no WSL is installed to fall back to.
func nativeWindowsError() error {
	return fmt.Errorf("webtmux cannot run on native Windows: it needs tmux and a Unix terminal, which Windows lacks.\n" +
		"Two ways forward:\n" +
		"  1. run it in WSL on this PC — in an administrator PowerShell:  wsl --install\n" +
		"     reboot, open the new Ubuntu once to create your user, then inside it:  sudo apt install tmux\n" +
		"     then:  webtmux-launch wsl\n" +
		"  2. point the launcher at a Linux or Mac machine you can ssh to:  webtmux-launch you@linuxbox")
}
