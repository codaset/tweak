// Package config resolves where the bridge listens and where state lives,
// from TWEAK_PORT, TWEAK_STATE_DIR and TWEAK_BIN.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
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
		// Absolute, so a bridge started detached in another folder finds it.
		abs, err := filepath.Abs(d)
		if err != nil {
			return c, fmt.Errorf("TWEAK_STATE_DIR=%s: %v", d, err)
		}
		c.StateDir = abs
	}
	if getenv("TWEAK_BIN") != "" {
		if c.Port == DefaultPort {
			return c, fmt.Errorf("TWEAK_BIN is set, so this is a development build: set TWEAK_PORT to a port other than %d", DefaultPort)
		}
		if sameFolder(c.StateDir, DefaultStateDir(home)) {
			return c, fmt.Errorf("TWEAK_BIN is set, so this is a development build: set TWEAK_STATE_DIR to a folder other than %s", c.StateDir)
		}
	}
	return c, nil
}

// sameFolder reports whether a and b name the same folder once symlinks are
// followed, so no alias for the live state folder gets past the guard.
func sameFolder(a, b string) bool {
	return Canonical(a) == Canonical(b)
}

// Canonical resolves symlinks in the longest part of path that exists, and
// keeps the rest as written (the folder, or a file about to be created, may
// not exist yet).
func Canonical(path string) string {
	path = filepath.Clean(path)
	var rest []string
	for {
		real, err := filepath.EvalSymlinks(path)
		if err == nil {
			return filepath.Join(append([]string{real}, rest...)...)
		}
		parent := filepath.Dir(path)
		if !errors.Is(err, fs.ErrNotExist) || parent == path {
			return filepath.Join(append([]string{path}, rest...)...)
		}
		rest = append([]string{filepath.Base(path)}, rest...)
		path = parent
	}
}

// DefaultStateDir is the live state folder.
func DefaultStateDir(home string) string {
	return filepath.Join(home, ".local", "state", "codaset-tweak")
}

// BridgeFile is bridge.json: the running bridge's port, PID and version.
func (c Config) BridgeFile() string { return filepath.Join(c.StateDir, "bridge.json") }

// Database is the SQLite file.
func (c Config) Database() string { return filepath.Join(c.StateDir, "tweak.db") }

// ExtensionDir is the folder the bridge writes the extension to, for Chrome
// to load unpacked.
func (c Config) ExtensionDir() string { return filepath.Join(c.StateDir, "extension") }

// Marker is the file that says a session is capturing: while it exists,
// tweak hook pre-edit tells the bridge about each file before it's edited.
// The session ID is encoded so it can only ever name a file in capturing/.
func (c Config) Marker(session string) string {
	return filepath.Join(c.MarkerDir(), markerName(session))
}

// MarkerDir is the folder of capture markers.
func (c Config) MarkerDir() string { return filepath.Join(c.StateDir, "capturing") }

// Released is the file tweak hook session-end leaves when no bridge is
// running: the next bridge to start ends the session it names.
func (c Config) Released(session string) string {
	return filepath.Join(c.ReleasedDir(), markerName(session))
}

// ReleasedDir is the folder of released markers.
func (c Config) ReleasedDir() string { return filepath.Join(c.StateDir, "released") }

// markerName keeps letters, digits, - and _ (a UUID is unchanged) and
// writes every other byte as %XX, so no two IDs share a name and none can
// be . or .. or hold a separator.
func markerName(session string) string {
	var b strings.Builder
	for i := 0; i < len(session); i++ {
		switch ch := session[i]; {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9', ch == '-', ch == '_':
			b.WriteByte(ch)
		default:
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// Handover is the file a command leaves while it hands over to a newer
// bridge, so tweak hook pre-edit waits for the new one.
func (c Config) Handover() string { return filepath.Join(c.StateDir, "handover") }

// Log is where a bridge started by the CLI writes its output.
func (c Config) Log() string { return filepath.Join(c.StateDir, "bridge.log") }
