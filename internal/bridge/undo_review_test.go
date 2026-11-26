package bridge

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// leftovers lists the undo's temporary and backup files left in dir.
func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && strings.Contains(d.Name(), ".tweak-undo") {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// An undo, kept or taken back, leaves no backup or temporary file.
func TestAnUndoLeavesNoBackups(t *testing.T) {
	_, s, dir := finished(t)
	s.undo("u1", 1, "tweak-undone")
	if got := leftovers(t, dir); len(got) != 0 {
		t.Fatalf("left %v", got)
	}
}

// Claude can't be handed an undo to make by hand while it's capturing
// another tweak: its edits would land in that tweak's change.
func TestTweakUndoWaitsForTheSessionsOtherCaptureToEnd(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
	s.undo("u1", 1, "tweak-undo-conflict")
	s.send(createMsg("r2", "https://ernie.localhost/", "another"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/2/work"}))

	resp, body := h.do(as("s1", req{method: "GET", path: "/tweaks/1/undo"}))
	refused(t, resp, body, 409, "still-capturing")
	if !strings.Contains(string(body), "tweak 2") {
		t.Fatalf("the refusal names the tweak to finish first: %s", body)
	}
	status(h, "2", "done", "did it")
	if resp, body := h.do(as("s1", req{method: "GET", path: "/tweaks/1/undo"})); resp.StatusCode != 200 {
		t.Fatalf("after tweak 2 is done: %d %s", resp.StatusCode, body)
	}
}

// A recorded file replaced by a symlink since, even to the after contents,
// conflicts: writing it back would replace the link.
func TestAFileNowASymlinkConflicts(t *testing.T) {
	h, s, dir := finished(t)
	app := filepath.Join(dir, "app.css")
	target := filepath.Join(dir, "shared.css")
	writeFile(t, target, read(t, app))
	os.Remove(app)
	if err := os.Symlink(target, app); err != nil {
		t.Skip(err)
	}
	r, ev := s.undo("u1", 1, "tweak-undo-conflict")
	if r["error"] != nil || change(ev)["conflicts"] != float64(1) {
		t.Fatalf("undo: %v, change %v", r, change(ev))
	}
	if fi, err := os.Lstat(app); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("app.css is no longer the link: %v %v", fi, err)
	}
	_ = h
}
