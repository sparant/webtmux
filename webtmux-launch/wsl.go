package main

// WSL mode: the launcher runs natively on Windows and webtmux runs inside a WSL
// distro on the same PC.
//
// Native Windows cannot host webtmux at all — there is no tmux and no Unix PTY
// — so on Windows "this machine" means the WSL distro, not Windows itself. WSL
// mode is local mode with one change: a command reaches the distro's shell as
// `wsl.exe -e /bin/sh -c …` instead of `/bin/sh -c …`. Everything else is
// unchanged:
//
//   - no tunnel: WSL forwards a port bound to 127.0.0.1 inside the distro to
//     the Windows 127.0.0.1 (WSL 2's localhostForwarding, on by default; WSL 1
//     shares the network stack outright), so the browser on Windows reaches
//     webtmux on its one port, exactly as in local mode;
//   - the lifetime tie: the liveness pipe is wsl.exe's stdin, which wsl.exe
//     relays into the distro, so the launcher exiting closes it there too;
//   - the probe, deploy and attach script are the Linux ones, because the
//     target IS Linux — so the binary it deploys is webtmux-linux-<arch>.
//
// Running the Linux launcher inside WSL instead works too: that is plain local
// mode, and openBrowser hands the URL to Windows (see wslBrowserCommands).

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// parseWSLTarget recognises `wsl` (the default distro) and `wsl:<distro>`.
// Only on Windows: anywhere else "wsl" is an ordinary host name or ssh alias.
func parseWSLTarget(goos, target string) (distro string, ok bool) {
	if goos != "windows" {
		return "", false
	}
	if strings.EqualFold(target, "wsl") {
		return "", true
	}
	if len(target) > 4 && strings.EqualFold(target[:4], "wsl:") {
		return target[4:], true
	}
	return "", false
}

// newWSLRunner is the runner for a WSL distro on this PC. local stays true:
// it is what every caller checks for "no tunnel, one port".
func newWSLRunner(distro string, verbose bool) *sshRunner {
	return &sshRunner{target: wslLabel(distro), verbose: verbose, stderr: os.Stderr, local: true, wsl: true, distro: distro}
}

func wslLabel(distro string) string {
	if distro == "" {
		return "wsl"
	}
	return "wsl:" + distro
}

// wslArgs is the wsl.exe argv for one shell command. `--cd ~` starts it in the
// distro user's home, the same starting point ssh gives; -e runs /bin/sh
// directly rather than through the user's login shell, so rc-file chatter
// cannot reach the probe's parser.
func wslArgs(distro, remote string) []string {
	var args []string
	if distro != "" {
		args = append(args, "-d", distro)
	}
	return append(args, "--cd", "~", "-e", "/bin/sh", "-c", remote)
}

// wslExe finds wsl.exe. It is in System32 on every Windows that has WSL, but a
// 32-bit process sees System32 redirected, so PATH is asked first.
func wslExe() (string, error) {
	if p, err := exec.LookPath("wsl.exe"); err == nil {
		return p, nil
	}
	p := os.Getenv("SystemRoot") + `\System32\wsl.exe`
	if _, err := os.Stat(p); err != nil {
		return "", err
	}
	return p, nil
}

// insideWSL reports whether THIS process is a Linux one running under WSL,
// where there is no Linux browser but Windows' own is one exec away.
func insideWSL() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	_, err := os.Stat("/proc/sys/fs/binfmt_misc/WSLInterop")
	return err == nil
}

// wslBrowserCommands opens url in the Windows browser from inside WSL: wslview
// (wslu) when installed, else Windows' own `cmd.exe /c start`, which every WSL
// can run through interop. The empty title argument is start's quirk: its first
// quoted argument is a window title, not the thing to open.
func wslBrowserCommands(url string) [][]string {
	return [][]string{
		{"wslview", url},
		{"cmd.exe", "/c", "start", "", url},
	}
}
