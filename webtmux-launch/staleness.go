package main

// The one hazard local mode adds: a build you forgot to make.
//
// Content-addressing bounds staleness rather than fixing it. A rebuild changes
// the sha, so a CHANGED binary is always redeployed and the sha reported can
// never disagree with the bytes running. What content-addressing cannot tell
// you is that you forgot to rebuild at all — the deploy then succeeds, quietly,
// with yesterday's code. Hence the "built 6m ago" stamp on the source line, and
// this warning.
//
// Advisory, never blocking: deploying a deliberately older build is a
// legitimate thing to do — it is how you bisect a regression.

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// staleSourceWarning reports Go sources newer than the binary about to be
// deployed. It looks for a checkout by walking up from the build directory; if
// there is none, there is nothing to compare against and it stays silent.
//
// It walks the working tree rather than asking git for tracked files: this runs
// on every launch, must not depend on a git binary being present, and an
// untracked .go file that is newer is just as good a signal that a rebuild is
// due.
func staleSourceWarning(s Source, platform string) string {
	dir, ok := s.(*dirSource)
	if !ok {
		return ""
	}
	built, ok := s.BuiltAt(platform)
	if !ok {
		return ""
	}
	root := findCheckout(dir.dir)
	if root == "" {
		return ""
	}
	newer := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "vendor", "node_modules", "builds":
				return fs.SkipDir
			}
			return nil
		}
		if filepath.Ext(p) != ".go" {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().After(built) {
			newer++
		}
		return nil
	})
	if newer == 0 {
		return ""
	}
	return fmt.Sprintf("warning: %s is older than %d changed .go file(s); run `make cross-compile`?",
		assetName(platform), newer)
}

// findCheckout walks up from dir looking for a .git entry (a directory in a
// normal clone, a file in a worktree).
func findCheckout(dir string) string {
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}
