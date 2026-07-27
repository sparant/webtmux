package utils

import (
	"testing"

	"github.com/urfave/cli/v2"
)

// Flag generation is reflection over struct tags, so a mistake in it does not
// fail to compile — it silently changes a default or drops a flag. These tests
// pin the tag-reading behaviour that utils/structfields.go now provides in place
// of github.com/fatih/structs.

type primaryOptions struct {
	Address  string `flagName:"address" flagSName:"a" flagDescribe:"IP address to listen" default:"0.0.0.0"`
	Port     int    `flagName:"port" flagSName:"p" flagDescribe:"Port number" default:"8080"`
	Verbose  bool   `flagName:"verbose" flagDescribe:"Chatty" default:"true"`
	Internal bool   `default:"true"` // no flagName: settable, but not a CLI flag
	Untagged string
	Extras   map[string]interface{} // no tags at all
}

type secondaryOptions struct {
	CloseSignal int `flagName:"close-signal" flagDescribe:"Signal to send" default:"1"`
}

func TestApplyDefaultValues(t *testing.T) {
	o := &primaryOptions{}
	if err := ApplyDefaultValues(o); err != nil {
		t.Fatalf("ApplyDefaultValues: %v", err)
	}

	if o.Address != "0.0.0.0" {
		t.Errorf("Address = %q, want 0.0.0.0", o.Address)
	}
	if o.Port != 8080 {
		t.Errorf("Port = %d, want 8080", o.Port)
	}
	if !o.Verbose {
		t.Errorf("Verbose = false, want true")
	}
	// A `default` tag applies whether or not the field is also a CLI flag.
	if !o.Internal {
		t.Errorf("Internal = false, want true — a default tag without a flagName still applies")
	}
	// No default tag: left at the zero value, not touched.
	if o.Untagged != "" {
		t.Errorf("Untagged = %q, want the zero value", o.Untagged)
	}
}

func TestApplyDefaultValuesRejectsNonPointer(t *testing.T) {
	if err := ApplyDefaultValues(primaryOptions{}); err == nil {
		t.Error("want an error for a non-pointer, got nil — the fields would be set on a copy and silently lost")
	}
}

func TestApplyDefaultValuesRejectsBadBool(t *testing.T) {
	type bad struct {
		Flag bool `default:"yes"`
	}
	if err := ApplyDefaultValues(&bad{}); err == nil {
		t.Error("want an error for a non-true/false bool default, got nil")
	}
}

func TestGenerateFlags(t *testing.T) {
	flags, mappings, err := GenerateFlags(&primaryOptions{Address: "0.0.0.0", Port: 8080}, &secondaryOptions{CloseSignal: 1})
	if err != nil {
		t.Fatalf("GenerateFlags: %v", err)
	}

	// One flag per flagName tag, across both structs, and nothing else.
	byName := make(map[string]cli.Flag, len(flags))
	for _, f := range flags {
		byName[f.Names()[0]] = f
	}
	for _, want := range []string{"address", "port", "verbose", "close-signal"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("flag %q was not generated", want)
		}
	}
	for _, unwanted := range []string{"internal", "untagged", "extras"} {
		if _, ok := byName[unwanted]; ok {
			t.Errorf("flag %q was generated from an untagged field", unwanted)
		}
	}
	if len(flags) != 4 {
		t.Errorf("generated %d flags, want 4", len(flags))
	}

	addr, ok := byName["address"].(*cli.StringFlag)
	if !ok {
		t.Fatalf("address flag is %T, want *cli.StringFlag", byName["address"])
	}
	if addr.Value != "0.0.0.0" {
		t.Errorf("address default = %q, want the struct's current value", addr.Value)
	}
	if addr.Usage != "IP address to listen" {
		t.Errorf("address usage = %q, want the flagDescribe tag", addr.Usage)
	}
	if len(addr.Aliases) != 1 || addr.Aliases[0] != "a" {
		t.Errorf("address aliases = %v, want [a] from flagSName", addr.Aliases)
	}
	if len(addr.EnvVars) != 1 || addr.EnvVars[0] != "GOTTY_ADDRESS" {
		t.Errorf("address env vars = %v, want [GOTTY_ADDRESS]", addr.EnvVars)
	}

	// A hyphenated flag becomes an underscored, upper-cased env var.
	sig := byName["close-signal"].(*cli.IntFlag)
	if len(sig.EnvVars) != 1 || sig.EnvVars[0] != "GOTTY_CLOSE_SIGNAL" {
		t.Errorf("close-signal env vars = %v, want [GOTTY_CLOSE_SIGNAL]", sig.EnvVars)
	}

	// A flag with no flagSName gets no alias at all, rather than an empty one.
	verbose := byName["verbose"].(*cli.BoolFlag)
	if len(verbose.Aliases) != 0 {
		t.Errorf("verbose aliases = %v, want none", verbose.Aliases)
	}

	// The mapping is what routes a parsed flag back to its Go field.
	for flag, field := range map[string]string{
		"address":      "Address",
		"port":         "Port",
		"verbose":      "Verbose",
		"close-signal": "CloseSignal",
	} {
		if mappings[flag] != field {
			t.Errorf("mappings[%q] = %q, want %q", flag, mappings[flag], field)
		}
	}
}

func TestGenerateFlagsRejectsNonPointer(t *testing.T) {
	if _, _, err := GenerateFlags(primaryOptions{}); err == nil {
		t.Error("want an error for a non-pointer, got nil")
	}
}

// ApplyFlags must write only the flags the user actually set, and must route
// each one to whichever of several structs declares it.
func TestApplyFlagsWritesOnlySetFlagsAcrossStructs(t *testing.T) {
	primary := &primaryOptions{}
	secondary := &secondaryOptions{}
	if err := ApplyDefaultValues(primary); err != nil {
		t.Fatal(err)
	}
	if err := ApplyDefaultValues(secondary); err != nil {
		t.Fatal(err)
	}

	flags, mappings, err := GenerateFlags(primary, secondary)
	if err != nil {
		t.Fatalf("GenerateFlags: %v", err)
	}

	var applyErr error
	app := &cli.App{
		Flags: flags,
		Action: func(c *cli.Context) error {
			applyErr = ApplyFlags(flags, mappings, c, primary, secondary)
			return nil
		},
	}
	// --address and --close-signal are set; --port and --verbose are not.
	if err := app.Run([]string{"test", "--address", "127.0.0.1", "--close-signal", "9"}); err != nil {
		t.Fatalf("app.Run: %v", err)
	}
	if applyErr != nil {
		t.Fatalf("ApplyFlags: %v", applyErr)
	}

	if primary.Address != "127.0.0.1" {
		t.Errorf("Address = %q, want the value passed on the command line", primary.Address)
	}
	if secondary.CloseSignal != 9 {
		t.Errorf("CloseSignal = %d, want 9 — a flag must reach the second struct too", secondary.CloseSignal)
	}
	if primary.Port != 8080 {
		t.Errorf("Port = %d, want the default 8080 left intact for an unset flag", primary.Port)
	}
	if !primary.Verbose {
		t.Errorf("Verbose = false, want the default true left intact for an unset flag")
	}
}

func TestApplyFlagsRejectsNonPointer(t *testing.T) {
	app := &cli.App{Action: func(c *cli.Context) error {
		if err := ApplyFlags(nil, map[string]string{}, c, primaryOptions{}); err == nil {
			t.Error("want an error for a non-pointer, got nil")
		}
		return nil
	}}
	if err := app.Run([]string{"test"}); err != nil {
		t.Fatal(err)
	}
}
