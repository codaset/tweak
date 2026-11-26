package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDefaults(t *testing.T) {
	c, err := Resolve(env(map[string]string{}), "/home/joel")
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 47391 {
		t.Errorf("port %d", c.Port)
	}
	if c.StateDir != filepath.Join("/home/joel", ".local", "state", "codaset-tweak") {
		t.Errorf("state dir %s", c.StateDir)
	}
	if c.BridgeFile() != filepath.Join(c.StateDir, "bridge.json") || c.Database() != filepath.Join(c.StateDir, "tweak.db") {
		t.Errorf("files %s %s", c.BridgeFile(), c.Database())
	}
}

func TestOverrides(t *testing.T) {
	c, err := Resolve(env(map[string]string{"TWEAK_PORT": "5001", "TWEAK_STATE_DIR": "/tmp/t"}), "/home/joel")
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 5001 || c.StateDir != "/tmp/t" {
		t.Fatalf("got %+v", c)
	}
}

func TestBadPort(t *testing.T) {
	for _, p := range []string{"x", "0", "70000", "-1"} {
		if _, err := Resolve(env(map[string]string{"TWEAK_PORT": p}), "/h"); err == nil {
			t.Errorf("TWEAK_PORT=%s accepted", p)
		}
	}
}

func TestDevelopmentBuildRefusesTheLiveBridge(t *testing.T) {
	cases := []map[string]string{
		{"TWEAK_BIN": "/b/tweak"},
		{"TWEAK_BIN": "/b/tweak", "TWEAK_PORT": "5001"},
		{"TWEAK_BIN": "/b/tweak", "TWEAK_STATE_DIR": "/tmp/t"},
		// Setting the defaults explicitly is still the live bridge.
		{"TWEAK_BIN": "/b/tweak", "TWEAK_PORT": "47391", "TWEAK_STATE_DIR": "/tmp/t"},
		{"TWEAK_BIN": "/b/tweak", "TWEAK_PORT": "5001", "TWEAK_STATE_DIR": "/home/joel/.local/state/codaset-tweak/"},
	}
	for _, e := range cases {
		_, err := Resolve(env(e), "/home/joel")
		if err == nil || !strings.Contains(err.Error(), "TWEAK_BIN") {
			t.Errorf("%v: got %v", e, err)
		}
	}
	if _, err := Resolve(env(map[string]string{"TWEAK_BIN": "/b/tweak", "TWEAK_PORT": "5001", "TWEAK_STATE_DIR": "/tmp/t"}), "/home/joel"); err != nil {
		t.Errorf("own port and folder refused: %v", err)
	}
}

// The guard compares real folders: a relative TWEAK_STATE_DIR, or a symlink
// to the live folder, is still the live folder.
func TestDevelopmentBuildRefusesTheLiveFolderByAnyName(t *testing.T) {
	home := t.TempDir()
	live := DefaultStateDir(home)
	if err := os.MkdirAll(live, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(live, alias); err != nil {
		t.Fatal(err)
	}
	t.Chdir(home)
	for _, dir := range []string{".local/state/codaset-tweak", "./.local/state/../state/codaset-tweak", alias, alias + "/"} {
		_, err := Resolve(env(map[string]string{"TWEAK_BIN": "/b/tweak", "TWEAK_PORT": "5001", "TWEAK_STATE_DIR": dir}), home)
		if err == nil || !strings.Contains(err.Error(), "TWEAK_BIN") {
			t.Errorf("TWEAK_STATE_DIR=%s: got %v", dir, err)
		}
	}
}

// A relative TWEAK_STATE_DIR is made absolute, so a bridge started detached
// in another working folder uses the same state.
func TestRelativeStateDirIsMadeAbsolute(t *testing.T) {
	work := t.TempDir()
	t.Chdir(work)
	c, err := Resolve(env(map[string]string{"TWEAK_STATE_DIR": "dev-state"}), "/home/joel")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(c.StateDir) || filepath.Base(c.StateDir) != "dev-state" {
		t.Fatalf("state dir %s", c.StateDir)
	}
}

func TestAMarkerNamesOnlyAFileInCapturing(t *testing.T) {
	c := Config{StateDir: "/state"}
	for id, want := range map[string]string{
		"0f9c2a4e-1b2c-4d5e-8f90-123456789abc": "0f9c2a4e-1b2c-4d5e-8f90-123456789abc",
		"..":                                   "%2E%2E",
		"a/../../b":                            "a%2F%2E%2E%2F%2E%2E%2Fb",
		`a\b`:                                  "a%5Cb",
		"a%2F":                                 "a%252F",
	} {
		if got := c.Marker(id); got != filepath.Join("/state", "capturing", want) {
			t.Errorf("Marker(%q) = %s, want capturing/%s", id, got, want)
		}
	}
}
