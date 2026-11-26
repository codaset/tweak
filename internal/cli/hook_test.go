package cli

import (
	"os"
	"path/filepath"
	"testing"
)

// The released marker is written whole (atomicfile owns how), into a
// released/ folder the hook makes, leaving nothing else beside it.
func TestTheReleasedMarkerIsWrittenWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), "released", "s1")
	writeWhole(path, "s1\n")
	entries, _ := os.ReadDir(filepath.Dir(path))
	raw, _ := os.ReadFile(path)
	if len(entries) != 1 || string(raw) != "s1\n" {
		t.Fatalf("released/ holds %v, the marker %q", entries, raw)
	}
}
