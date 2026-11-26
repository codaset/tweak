package bridge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const appCSS = "a\nb\nc\nd\ne\nf\ng\n"

// finished is a done tweak 1 whose change edited app.css (line b), created
// web/new.js, deleted gone.rb and shell-edited sed.rb (unrecorded).
func finished(t *testing.T) (*harness, *socket, string) {
	t.Helper()
	dir := project(t, map[string]string{"app.css": appCSS, "gone.rb": "old\n", "sed.rb": "x = 1\n", "web/keep.js": "keep\n"})
	h, s := capturing(t, dir)
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED\nc\nd\ne\nf\ng\n")
	h.before("s1", filepath.Join(dir, "web", "new.js"))
	writeFile(t, filepath.Join(dir, "web", "new.js"), "go()\n")
	h.before("s1", filepath.Join(dir, "gone.rb"))
	os.Remove(filepath.Join(dir, "gone.rb"))
	writeFile(t, filepath.Join(dir, "sed.rb"), "x = 2\n")
	if code, body := status(h, "1", "done", "changed b"); code != 200 {
		t.Fatalf("done: %d %s", code, body)
	}
	for ev := s.tweakEvent("tweak-status"); ev["status"] != "done"; ev = s.tweakEvent("tweak-status") {
	}
	return h, s, dir
}

func undoMsg(ref string, n int) map[string]any {
	return map[string]any{"type": "undo", "ref": ref, "number": n}
}

// undo sends an undo and reads its result and the tweak event that follows.
// They go out on their own, so either may come first.
func (s *socket) undo(ref string, n int, event string) (result, tweak map[string]any) {
	s.t.Helper()
	s.send(undoMsg(ref, n))
	for i := 0; i < 10 && (result == nil || tweak == nil); i++ {
		switch m := s.nextAny(); {
		case m["type"] == "result" && m["ref"] == ref:
			result = m
		case m["event"] == event:
			tweak = m["tweak"].(map[string]any)
		}
	}
	if result == nil || tweak == nil {
		s.t.Fatalf("undo %s: result %v, %s %v", ref, result, event, tweak)
	}
	return result, tweak
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return "<" + err.Error() + ">"
	}
	return string(data)
}

func absent(path string) bool {
	_, err := os.Lstat(path)
	return os.IsNotExist(err)
}

func change(ev map[string]any) map[string]any {
	c, _ := ev["change"].(map[string]any)
	return c
}

// Undo puts every recorded file back: the edit reversed, the new file
// deleted, the deleted one written again. The unrecorded file is left.
func TestUndoPutsEveryRecordedFileBack(t *testing.T) {
	h, s, dir := finished(t)
	r, ev := s.undo("u1", 1, "tweak-undone")
	if r["number"] != float64(1) || r["error"] != nil {
		t.Fatalf("undo: %v", r)
	}
	if c := change(ev); c["state"] != "undone" {
		t.Fatalf("change %v", c)
	}
	entries := ev["entries"].([]any)
	if last := entries[len(entries)-1].(map[string]any); last["from"] != "you" || last["kind"] != "undo" {
		t.Fatalf("last entry %v", last)
	}
	if got := read(t, filepath.Join(dir, "app.css")); got != appCSS {
		t.Errorf("app.css %q", got)
	}
	if !absent(filepath.Join(dir, "web", "new.js")) {
		t.Error("the file Claude created is still there")
	}
	if got := read(t, filepath.Join(dir, "gone.rb")); got != "old\n" {
		t.Errorf("gone.rb %q", got)
	}
	if got := read(t, filepath.Join(dir, "sed.rb")); got != "x = 2\n" {
		t.Errorf("the unrecorded sed.rb was touched: %q", got)
	}
	// A second click has nothing to undo.
	r = s.readUntilAfter(undoMsg("u2", 1))
	if r["error"] != "not-undoable" || r["message"] != "This change is already undone" {
		t.Fatalf("again: %v", r)
	}
	_ = h
}

// Later edits that don't touch the change are kept; a file already back
// to before is left as it is.
func TestUndoKeepsLaterEditsAndFilesAlreadyBack(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED\nc\nd\ne\nf\ng later\n")
	writeFile(t, filepath.Join(dir, "gone.rb"), "old\n") // put back by hand
	if r, _ := s.undo("u1", 1, "tweak-undone"); r["error"] != nil {
		t.Fatalf("undo: %v", r)
	}
	if got := read(t, filepath.Join(dir, "app.css")); got != "a\nb\nc\nd\ne\nf\ng later\n" {
		t.Errorf("app.css %q", got)
	}
	if got := read(t, filepath.Join(dir, "gone.rb")); got != "old\n" {
		t.Errorf("gone.rb %q", got)
	}
	_ = h
}

// Any conflicting file means nothing is written: the undo goes to the
// session claiming the page, as an undo-conflict line.
func TestAnyConflictWritesNothing(t *testing.T) {
	for _, c := range []struct {
		name  string
		later func(dir string)
	}{
		{"the changed line edited again", func(dir string) {
			writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
		}},
		{"the edited file deleted", func(dir string) { os.Remove(filepath.Join(dir, "app.css")) }},
		{"the created file edited", func(dir string) { writeFile(t, filepath.Join(dir, "web", "new.js"), "go()\nmore()\n") }},
		{"the deleted file recreated", func(dir string) { writeFile(t, filepath.Join(dir, "gone.rb"), "new\n") }},
		{"the edited file now binary", func(dir string) { writeFile(t, filepath.Join(dir, "app.css"), "a\x00b\n") }},
	} {
		t.Run(c.name, func(t *testing.T) {
			h, s, dir := finished(t)
			c.later(dir)
			snapshot := map[string]string{}
			for _, f := range []string{"app.css", "web/new.js", "gone.rb", "sed.rb"} {
				snapshot[f] = read(t, filepath.Join(dir, f))
			}
			in := poll(t, h, -1)
			r, ev := s.undo("u1", 1, "tweak-undo-conflict")
			if r["error"] != nil {
				t.Fatalf("undo: %v", r)
			}
			if ch := change(ev); ch["state"] != "undo-requested" || ch["conflicts"] != float64(1) {
				t.Fatalf("change %v", ch)
			}
			for f, was := range snapshot {
				if got := read(t, filepath.Join(dir, f)); got != was {
					t.Errorf("%s was written: %q, was %q", f, got, was)
				}
			}
			if got := texts(poll(t, h, in.Seq)); len(got) != 1 || got[0] != "tweak 1 undo-conflict: 1 of 3 files need resolving" {
				t.Fatalf("lines %q", got)
			}
		})
	}
}

// A write that fails part-way puts back the files already written, so
// the undo is still all or nothing.
func TestAFailedWriteRestoresWhatWasWritten(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a folder this user can't write")
	}
	h, s, dir := finished(t)
	web := filepath.Join(dir, "web")
	os.Chmod(web, 0o555) // new.js can't be deleted
	t.Cleanup(func() { os.Chmod(web, 0o755) })
	r := s.readUntilAfter(undoMsg("u1", 1))
	if r["error"] != "undo-failed" {
		t.Fatalf("undo: %v", r)
	}
	if got := read(t, filepath.Join(dir, "app.css")); got != "a\nB CHANGED\nc\nd\ne\nf\ng\n" {
		t.Errorf("app.css was left reversed: %q", got)
	}
	if !absent(filepath.Join(dir, "gone.rb")) {
		t.Error("gone.rb was left written")
	}
	tw, _ := h.b.store.Tweak(1)
	if tw.Change.State != "recorded" {
		t.Fatalf("state %s", tw.Change.State)
	}
}

func TestOnlyAFinishedTweakCanBeUndone(t *testing.T) {
	dir := project(t, map[string]string{"app.css": appCSS})
	h, s := capturing(t, dir)
	r := s.readUntilAfter(undoMsg("u1", 1))
	if r["error"] != "not-undoable" || !strings.Contains(r["message"].(string), "finished") {
		t.Fatalf("while working: %v", r)
	}
	if r := s.readUntilAfter(undoMsg("u2", 9)); r["error"] != "no-tweak" {
		t.Fatalf("no tweak: %v", r)
	}
	if r := s.readUntilAfter(undoMsg("u3", 0)); r["error"] != "bad-request" {
		t.Fatalf("no number: %v", r)
	}
	_ = h
}

// tweak undo shows the change to reverse by hand, conflicting files marked,
// without starting capture; tweak undone finishes it.
func TestAConflictIsResolvedByHand(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
	s.undo("u1", 1, "tweak-undo-conflict")

	resp, body := h.do(as("s1", req{method: "GET", path: "/tweaks/1/undo"}))
	if resp.StatusCode != 200 {
		t.Fatalf("undo: %d %s", resp.StatusCode, body)
	}
	out := string(body)
	for _, want := range []string{
		"1 of 3 files need resolving",
		"## `app.css`: conflicts",
		"-b\n+B CHANGED\n",
		"## `web/new.js`: created by this change",
		"## `gone.rb`: deleted by this change",
		"tweak undone 1",
		"tweak decline 1",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("tweak undo has no %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "sed.rb") {
		t.Errorf("the unrecorded file is in the change to undo:\n%s", out)
	}
	if h.marked("s1") {
		t.Fatal("tweak undo started capture")
	}

	resp, body = h.do(as("s1", req{method: "POST", path: "/tweaks/1/undone", body: map[string]string{"message": "reverted b, kept the later edit"}}))
	if resp.StatusCode != 200 {
		t.Fatalf("undone: %d %s", resp.StatusCode, body)
	}
	conforms(t, "status", body)
	ev := s.tweakEvent("tweak-undone")
	if change(ev)["state"] != "undone" {
		t.Fatalf("change %v", change(ev))
	}
	resp, body = h.do(as("s1", req{method: "POST", path: "/tweaks/1/undone", body: map[string]string{"message": "again"}}))
	refused(t, resp, body, 409, "not-undo-requested")
	resp, body = h.do(as("s1", req{method: "GET", path: "/tweaks/1/undo"}))
	refused(t, resp, body, 409, "not-undo-requested")
}

func TestUndoneNeedsAMessage(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
	s.readUntilAfter(undoMsg("u1", 1))
	resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/undone", body: map[string]string{"message": "  "}}))
	refused(t, resp, body, 400, "bad-request")
}

// Declining the undo keeps the change, and says so.
func TestDecliningAConflictKeepsTheChange(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
	s.undo("u1", 1, "tweak-undo-conflict")
	code, body := status(h, "1", "declined", "later work needs it")
	if code != 200 || !strings.Contains(string(body), `"undo":"declined"`) || !strings.Contains(string(body), `"status":"done"`) {
		t.Fatalf("decline: %d %s", code, body)
	}
	conforms(t, "status", body)
	if ch := change(s.tweakEvent("tweak-status")); ch["state"] != "recorded" {
		t.Fatalf("change %v", ch)
	}
}

// With nothing recorded, Ask Claude to undo goes to the session, and tweak
// undo gives Claude its summary and the files that changed.
func TestAskClaudeToUndo(t *testing.T) {
	dir := project(t, map[string]string{"sed.rb": "x = 1\n"})
	h, s := capturing(t, dir)
	writeFile(t, filepath.Join(dir, "sed.rb"), "x = 2\n")
	status(h, "1", "done", "ran sed on sed.rb")
	for ev := s.tweakEvent("tweak-status"); ev["status"] != "done"; ev = s.tweakEvent("tweak-status") {
	}
	in := poll(t, h, -1)
	if r := s.readUntilAfter(undoMsg("u1", 1)); r["error"] != nil {
		t.Fatalf("undo: %v", r)
	}
	if got := texts(poll(t, h, in.Seq)); len(got) != 1 || got[0] != "tweak 1 undo-conflict: no edits recorded, undo by hand" {
		t.Fatalf("lines %q", got)
	}
	if got := read(t, filepath.Join(dir, "sed.rb")); got != "x = 2\n" {
		t.Fatalf("sed.rb %q", got)
	}
	_, body := h.do(as("s1", req{method: "GET", path: "/tweaks/1/undo"}))
	for _, want := range []string{"No edits were recorded", "ran sed on sed.rb", "- `sed.rb`"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("tweak undo has no %q:\n%s", want, body)
		}
	}
}

// An undo waiting for a session goes to the next one to claim the page.
func TestAConflictWithNoClaimWaitsForOne(t *testing.T) {
	h, s, dir := finished(t)
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB CHANGED AGAIN\nc\nd\ne\nf\ng\n")
	h.do(as("s1", req{method: "DELETE", path: "/claims"}))
	if _, ev := s.undo("u1", 1, "tweak-status"); change(ev)["state"] != "undo-requested" || change(ev)["waiting"] != true {
		ch := change(ev)
		t.Fatalf("change %v", ch)
	}
	h.register("s2", dir)
	h.claim("s2", "https://ernie.localhost/*")
	_, body := h.do(as("s2", req{method: "GET", path: "/inbox"}))
	if !strings.Contains(string(body), "tweak 1 undo-conflict: 1 of 3 files need resolving") {
		t.Fatalf("s2's inbox %s", body)
	}
}
