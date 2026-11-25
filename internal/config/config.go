// Package config resolves where the bridge listens and where state lives,
// from TWEAK_PORT, TWEAK_STATE_DIR and TWEAK_BIN.
package config

import (
	"fmt"
	"path/filepath"
	"strconv"
)

// DefaultPort is the live bridge's port.
const DefaultPort = 47391

// Config is the resolved port and state folder.
type Config struct {
	Port     int
	StateDir string
}

// Resolve reads the environment through getenv. home is the user's home
// folder. When TWEAK_BIN is set (a development build), the live bridge's port
// and state folder are refused, even when set explicitly.
func Resolve(getenv func(string) string, home string) (Config, error) {
	c := Config{Port: DefaultPort, StateDir: DefaultStateDir(home)}
	if p := getenv("TWEAK_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return c, fmt.Errorf("TWEAK_PORT=%s isn't a port: use a number from 1 to 65535", p)
		}
		c.Port = n
	}
	if d := getenv("TWEAK_STATE_DIR"); d != "" {
		c.StateDir = filepath.Clean(d)
	}
	if getenv("TWEAK_BIN") != "" {
		if c.Port == DefaultPort {
			return c, fmt.Errorf("TWEAK_BIN is set, so this is a development build: set TWEAK_PORT to a port other than %d", DefaultPort)
		}
		if c.StateDir == DefaultStateDir(home) {
			return c, fmt.Errorf("TWEAK_BIN is set, so this is a development build: set TWEAK_STATE_DIR to a folder other than %s", c.StateDir)
		}
	}
	return c, nil
}

// DefaultStateDir is the live state folder.
func DefaultStateDir(home string) string {
	return filepath.Join(home, ".local", "state", "codaset-tweak")
}

// BridgeFile is bridge.json: the running bridge's port, PID and version.
func (c Config) BridgeFile() string { return filepath.Join(c.StateDir, "bridge.json") }

// Database is the SQLite file.
func (c Config) Database() string { return filepath.Join(c.StateDir, "tweak.db") }

// Log is where a bridge started by the CLI writes its output.
func (c Config) Log() string { return filepath.Join(c.StateDir, "bridge.log") }
