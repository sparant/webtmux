package main

// Platform naming and the local architecture pre-check for --webtmux-binary.

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strings"
)

// releasePlatforms is the set the Makefile's PLATFORMS list builds, which is
// therefore the set a release publishes. Kept here so an unsupported target can
// be told what *is* available rather than discovering a 404 later.
var releasePlatforms = []string{
	"linux-amd64",
	"linux-arm64",
	"linux-arm",
	"darwin-amd64",
	"darwin-arm64",
	"freebsd-amd64",
}

// archAliases maps `uname -m` output onto Go's GOARCH names. A wrong mapping
// produces a 404 on download rather than a bad binary — the safe failure
// mode — provided the error names the asset it looked for.
var archAliases = map[string]string{
	"x86_64":  "amd64",
	"amd64":   "amd64",
	"i386":    "386",
	"i686":    "386",
	"aarch64": "arm64",
	"arm64":   "arm64",
	"armv6l":  "arm",
	"armv7l":  "arm",
	"armv8l":  "arm64",
	"arm":     "arm",
}

// platformFor turns `uname -s` / `uname -m` into a release asset platform.
func platformFor(unameS, unameM string) (string, error) {
	os_ := strings.ToLower(strings.TrimSpace(unameS))
	switch os_ {
	case "linux", "darwin", "freebsd", "openbsd", "netbsd":
	default:
		return "", fmt.Errorf("unsupported target OS %q\n(releases publish: %s)", unameS, strings.Join(releasePlatforms, ", "))
	}
	arch, ok := archAliases[strings.ToLower(strings.TrimSpace(unameM))]
	if !ok {
		return "", fmt.Errorf("unrecognised target architecture %q from `uname -m`\n(releases publish: %s)", unameM, strings.Join(releasePlatforms, ", "))
	}
	p := os_ + "-" + arch
	if !supportedPlatform(p) {
		return "", fmt.Errorf("no webtmux is published for %s\n(releases publish: %s)", p, strings.Join(releasePlatforms, ", "))
	}
	return p, nil
}

func supportedPlatform(p string) bool {
	for _, s := range releasePlatforms {
		if s == p {
			return true
		}
	}
	return false
}

// binaryPlatform sniffs an executable's own OS/arch from its ELF or Mach-O
// header. --webtmux-binary cannot check that the file matches the target, and a
// mismatch would otherwise surface as a bare `Exec format error` on the remote
// after a full transfer; catching it locally names both architectures.
//
// Returns ("", nil) for a file whose format we do not recognise — a shell
// wrapper, say — so an unknown format never blocks a deliberate deploy.
func binaryPlatform(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var hdr [64]byte
	n, err := io.ReadFull(f, hdr[:])
	if err != nil && n < 20 {
		return "", nil
	}
	b := hdr[:n]

	// ELF: 7f 'E' 'L' 'F'. e_machine is a 2-byte field at offset 18, in the
	// endianness given by EI_DATA (offset 5).
	if n >= 20 && b[0] == 0x7f && b[1] == 'E' && b[2] == 'L' && b[3] == 'F' {
		var machine uint16
		if b[5] == 2 {
			machine = binary.BigEndian.Uint16(b[18:20])
		} else {
			machine = binary.LittleEndian.Uint16(b[18:20])
		}
		arch := map[uint16]string{
			0x03: "386",
			0x28: "arm",
			0x3E: "amd64",
			0xB7: "arm64",
		}[machine]
		if arch == "" {
			return "", nil
		}
		// ELF carries no "which Unix" that is reliable in practice (EI_OSABI is
		// 0/SYSV for Linux and FreeBSD Go binaries alike), so report the arch
		// with a linux OS: it is the only ELF platform a release publishes for
		// arm/arm64, and freebsd-amd64 vs linux-amd64 share an arch anyway.
		return "linux-" + arch, nil
	}

	// Mach-O 64-bit: magic feedfacf (LE) / cffaedfe (BE), cputype at offset 4.
	if n >= 8 {
		magic := binary.LittleEndian.Uint32(b[0:4])
		if magic == 0xfeedfacf || magic == 0xcffaedfe {
			cpu := binary.LittleEndian.Uint32(b[4:8])
			if magic == 0xcffaedfe {
				cpu = binary.BigEndian.Uint32(b[4:8])
			}
			switch cpu {
			case 0x01000007:
				return "darwin-amd64", nil
			case 0x0100000c:
				return "darwin-arm64", nil
			}
			return "", nil
		}
	}
	return "", nil
}

// checkBinaryArch refuses a --webtmux-binary whose architecture cannot run on
// the probed target, before any transfer happens.
func checkBinaryArch(path, targetPlatform string) error {
	got, err := binaryPlatform(path)
	if err != nil || got == "" {
		return nil // unknown format — let the remote decide
	}
	// Compare architecture, and OS family only when both are known. ELF sniffing
	// reports linux-<arch> for every ELF, so a freebsd target is compared on
	// arch alone.
	gotOS, gotArch, _ := strings.Cut(got, "-")
	wantOS, wantArch, _ := strings.Cut(targetPlatform, "-")
	if gotArch != wantArch || (gotOS == "darwin") != (wantOS == "darwin") {
		return fmt.Errorf("%s is a %s binary but %s is %s\n(build it with GOOS=%s GOARCH=%s, or use --webtmux-source)",
			path, got, "the target", targetPlatform, wantOS, wantArch)
	}
	return nil
}
