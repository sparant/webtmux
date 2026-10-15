package main

// Per-target port and secret persistence.
//
// Ports and the secret path are generated ONCE per target and reused, so the
// URL never changes — not just across reconnects within one run, but across
// launcher restarts. Quit the launcher, relaunch tomorrow, and an already-open
// browser tab revives through its own --reconnect loop because the URL it is
// retrying is still the right one.

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
)

type targetConfig struct {
	LocalPort int `json:"local_port"`
	// RemotePort is the port the launcher's OWN webtmux listens on, on the
	// target. Never the port of a webtmux it adopted: that one is used for the
	// run and not saved (see adopt). It once was saved, and the next launch
	// then started its own webtmux on the adopted instance's port — e.g. 8090,
	// where a containerised webtmux publishes — blocking that instance's
	// restart for as long as the launcher ran.
	RemotePort int `json:"remote_port"`
	// RemotePortChosen marks a RemotePort the user asked for with
	// --remote-port while launching, which is kept whatever its value.
	// Unmarked values outside the launcher's own range are treated as the
	// leftover of that old bug and replaced (see ensure).
	RemotePortChosen bool   `json:"remote_port_chosen,omitempty"`
	Secret           string `json:"secret"`
	// Password is only used by --auth. It is deliberately NOT the secret path:
	// reusing that would mean anyone who learned the URL already had the
	// password, so basic auth would add nothing on the shared box it exists for.
	Password string `json:"password,omitempty"`

	path string // where this was loaded from; not serialised
}

func configDir() string { return filepath.Join(homeDir(), ".config", "webtmux-launch") }

// configPath sanitises the ssh target into a filename. A target is passed
// verbatim to ssh (so aliases and user@host:port forms work), which means it
// can contain characters a path cannot.
func configPath(target string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '-', r == '.', r == '_':
			return r
		default:
			return '_'
		}
	}, target)
	return filepath.Join(configDir(), safe+".json")
}

func loadTargetConfig(target string) *targetConfig {
	return loadTargetConfigFrom(configPath(target))
}

func loadTargetConfigFrom(p string) *targetConfig {
	c := &targetConfig{path: p}
	b, err := os.ReadFile(p)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(b, c)
	c.path = p
	return c
}

func (c *targetConfig) save() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// 0600: the secret path in here is shell-equivalent for anyone who can
	// reach the tunnel.
	return os.WriteFile(c.path, append(b, '\n'), 0o600)
}

// ensure fills in whatever is missing and validates what was stored. A stored
// local port that has since been taken falls back to a fresh allocation.
//
// --remote-port is deliberately NOT applied here: in adopt mode it selects
// which running instance to connect to, and saving it would make that
// instance's port the launcher's own. launch applies it (useRemotePort).
//
// It returns a note when it replaced a saved remote port, for the caller to
// show when it starts its own webtmux.
func (c *targetConfig) ensure(localOverride int) (note string, err error) {
	if localOverride > 0 {
		c.LocalPort = localOverride
	}
	if c.LocalPort == 0 || !localPortFree(c.LocalPort) {
		p, err := freeLocalPort()
		if err != nil {
			return "", err
		}
		c.LocalPort = p
	}
	if c.RemotePort != 0 && !c.RemotePortChosen && !inRandomRange(c.RemotePort) {
		note = fmt.Sprintf("remote port %d in %s was not one this launcher picked or you asked for "+
			"(most likely saved from a webtmux it connected to); replacing it", c.RemotePort, c.path)
		c.RemotePort = 0
	}
	if c.RemotePort == 0 {
		p, err := randomHighPort()
		if err != nil {
			return "", err
		}
		c.RemotePort = p
		if note != "" {
			note += fmt.Sprintf(" with %d", p)
		}
	}
	if c.Secret == "" {
		s, err := randomSecret(32)
		if err != nil {
			return "", err
		}
		c.Secret = s
	}
	if c.Password == "" {
		pw, err := randomSecret(20)
		if err != nil {
			return "", err
		}
		c.Password = pw
	}
	return note, nil
}

// useRemotePort applies an explicit --remote-port when the launcher starts its
// own webtmux, and marks it as chosen so ensure never replaces it.
func (c *targetConfig) useRemotePort(p int) {
	if p > 0 {
		c.RemotePort, c.RemotePortChosen = p, true
	}
}

// freeLocalPort asks the kernel for one: bind 127.0.0.1:0, read the port, close.
func freeLocalPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("cannot allocate a local port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func localPortFree(p int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// randomHighPort picks a remote port blind — webtmux has no --port 0, and we
// cannot bind on the far side to find out. A collision is handled where it
// surfaces: the supervisor sees the child die with "address already in use" and
// reallocates.
// The launcher's own remote ports come from [randomPortLow, randomPortLow+
// randomPortSpan): high enough to stay clear of ports software conventionally
// claims (8080, 8090, …), below the usual ephemeral range.
const (
	randomPortLow  = 30000
	randomPortSpan = 20000
)

func randomHighPort() (int, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(randomPortSpan))
	if err != nil {
		return 0, err
	}
	return randomPortLow + int(n.Int64()), nil
}

func inRandomRange(p int) bool { return p >= randomPortLow && p < randomPortLow+randomPortSpan }

const secretAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func randomSecret(n int) (string, error) {
	b := make([]byte, n)
	max := big.NewInt(int64(len(secretAlphabet)))
	for i := range b {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = secretAlphabet[v.Int64()]
	}
	return string(b), nil
}

// urlPath is what webtmux's --url-path wants and what the browser opens: a leading
// and trailing slash around the secret.
func (c *targetConfig) urlPath() string { return "/" + c.Secret + "/" }

func (c *targetConfig) url() string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", c.LocalPort, c.urlPath())
}
