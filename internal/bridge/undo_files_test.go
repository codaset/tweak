package bridge

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/codaset/tweak/internal/capture"
)

// An empty file is a file: one Claude filled is emptied again, not
// deleted, and one Claude emptied gets its contents back.
func TestUndoKeepsEmptyFilesApartFromAbsentOnes(t *testing.T) {
	dir := project(t, map[string]string{"empty.txt": "", "full.txt": "full\n"})
	h, s := capturing(t, dir)
	h.before("s1", filepath.Join(dir, "empty.txt"))
	writeFile(t, filepath.Join(dir, "empty.txt"), "now text\n")
	h.before("s1", filepath.Join(dir, "full.txt"))
	writeFile(t, filepath.Join(dir, "full.txt"), "")
	status(h, "1", "done", "swapped them")
	for ev := s.tweakEvent("tweak-status"); ev["status"] != "done"; ev = s.tweakEvent("tweak-status") {
	}
	if r, _ := s.undo("u1", 1, "tweak-undone"); r["error"] != nil {
		t.Fatalf("undo: %v", r)
	}
	if got := read(t, filepath.Join(dir, "empty.txt")); got != "" {
		t.Errorf("empty.txt %q, want it there and empty", got)
	}
	if got := read(t, filepath.Join(dir, "full.txt")); got != "full\n" {
		t.Errorf("full.txt %q", got)
	}
}

// tweak undo shows paths from the folder of the session reading it, which
// may not be the one that made the change.
func TestTweakUndoShowsPathsFromTheReadersFolder(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
	h.do(as("s1", req{method: "DELETE", path: "/claims"}))
	h.register("s2", filepath.Join(dir, "web"))
	h.claim("s2", "https://ernie.localhost/*")
	s.undo("u1", 1, "tweak-undo-conflict")
	_, body := h.do(as("s2", req{method: "GET", path: "/tweaks/1/undo"}))
	out := string(body)
	if !strings.Contains(out, "## `new.js`: created") || !strings.Contains(out, "## `"+filepath.Join(capture.Canonical(dir), "app.css")+"`") {
		t.Fatalf("tweak undo from web/:\n%s", out)
	}
}
