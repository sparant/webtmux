package server

import (
	"testing"

	"webtmux/utils"
)

// The base path is --url-path. The upstream --path / -m spellings are gone, not
// aliased: a flag named "path" read as a filesystem directory.
func TestURLPathFlagReplacesPath(t *testing.T) {
	flags, mappings, err := utils.GenerateFlags(&Options{})
	if err != nil {
		t.Fatal(err)
	}
	if mappings["url-path"] != "Path" {
		t.Errorf("--url-path must set Options.Path, mappings = %v", mappings["url-path"])
	}
	for _, f := range flags {
		for _, name := range f.Names() {
			if name == "path" || name == "m" {
				t.Errorf("flag %v still answers to %q", f.Names(), name)
			}
		}
	}
}
