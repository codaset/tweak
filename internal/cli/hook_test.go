package cli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The released marker appears whole or not at all: it's written to a
// temporary file, which the bridge ignores, then renamed into place. A hook
// cut off before the rename leaves no marker to misread.
func TestTheReleasedMarkerAppearsWholeOrNotAtAll(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "released", "s1")

	renameFile = func(string, string) error { return errors.New("cut off") }
	t.Cleanup(func() { renameFile = os.Rename })
	writeWhole(path, "s1\n")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a marker appeared without its rename")
	}

	renameFile = os.Rename
	writeWhole(path, "s1\n")
	entries, _ := os.ReadDir(filepath.Dir(path))
	raw, _ := os.ReadFile(path)
	if len(entries) != 1 || string(raw) != "s1\n" {
		t.Fatalf("released/ holds %v, the marker %q", entries, raw)
	}
}
