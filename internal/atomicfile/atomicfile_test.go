package atomicfile

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteLeavesTheWholeFileAndNothingElse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := Write(path, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, []byte("two"), 0o640); err != nil { // replaces it
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	entries, _ := os.ReadDir(dir)
	if string(raw) != "two" || info.Mode().Perm() != 0o640 || len(entries) != 1 {
		t.Fatalf("got %q, mode %v, folder %v", raw, info.Mode().Perm(), entries)
	}
}

// A write cut off before its rename leaves the old file as it was and no
// temporary file behind.
func TestAWriteCutOffLeavesTheOldFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	os.WriteFile(path, []byte("old"), 0o600)
	var seen string
	rename = func(from, _ string) error {
		seen = filepath.Base(from)
		return errors.New("cut off")
	}
	t.Cleanup(func() { rename = os.Rename })
	if err := Write(path, []byte("new"), 0o600); err == nil {
		t.Fatal("no error")
	}
	raw, _ := os.ReadFile(path)
	entries, _ := os.ReadDir(dir)
	if string(raw) != "old" || len(entries) != 1 {
		t.Fatalf("got %q, folder %v", raw, entries)
	}
	// Readers of a folder of markers skip dot-files, so the temporary file
	// is one: it can't be read as a whole file while it's being written.
	if !strings.HasPrefix(seen, ".a.txt.") {
		t.Errorf("the temporary file was %q", seen)
	}
}

func TestWriteIntoAMissingFolderFails(t *testing.T) {
	if err := Write(filepath.Join(t.TempDir(), "no", "a.txt"), nil, 0o600); err == nil {
		t.Fatal("no error")
	}
}
