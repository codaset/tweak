package config

import (
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
