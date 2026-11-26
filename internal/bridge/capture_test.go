package bridge

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/capture"
	"github.com/codaset/tweak/internal/store"
	"github.com/codaset/tweak/internal/version"
)

// project is a session folder that's a git repo with one commit.
func project(t *testing.T, files map[string]string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	for name, body := range files {
		writeFile(t, filepath.Join(dir, name), body)
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// capturing starts a bridge with s1 working on tweak 1 in folder.
func capturing(t *testing.T, folder string, opts ...func(*Options)) (*harness, *socket) {
	t.Helper()
	h := start(t, opts...)
	h.register("s1", folder)
	h.claim("s1", "https://ernie.localhost/*")
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	if resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"})); resp.StatusCode != 200 {
		t.Fatalf("work: %d %s", resp.StatusCode, body)
	}
	return h, s
}

func (h *harness) before(session, path string) {
	h.t.Helper()
	resp, body := h.do(as(session, req{method: "POST", path: "/edits/before", body: map[string]string{"path": path}}))
	if resp.StatusCode != 204 {
		h.t.Fatalf("edits/before %s: %d %s", path, resp.StatusCode, body)
	}
}

func (h *harness) marked(session string) bool {
	_, err := os.Stat(h.cfg.Marker(session))
	return err == nil
}

// shown is a change's file list from an event, as the card gets it.
func shown(t *testing.T, ev map[string]any, list string) string {
	t.Helper()
	change, ok := ev["tweak"].(map[string]any)["change"].(map[string]any)
	if !ok {
		t.Fatalf("no change on %v", ev["tweak"])
	}
	var out []string
	for _, f := range change[list].([]any) {
		f := f.(map[string]any)
		p := f["path"].(string)
		if f["outside"] == true {
			p += " (outside)"
		}
		out = append(out, p)
	}
	return strings.Join(out, ", ")
}

// The round trip of a change: work starts capture and writes the marker;
// the hook's posts record before copies; done reads the after contents,
// runs the git check and logs the change with the status, once.
func TestATweaksChangeIsRecordedAndListed(t *testing.T) {
	dir := project(t, map[string]string{"app.css": ".a { color: red }\n", "sed.rb": "x = 1\n", "same.rb": "same\n"})
	home := t.TempDir()
	t.Setenv("HOME", home) // an outside file under it is shown from ~
	outside := filepath.Join(home, "dev", "shared-ui", "buttons.css")
	writeFile(t, outside, "old\n")
	h, s := capturing(t, dir)
	if !h.marked("s1") {
		t.Fatal("no marker while capturing")
	}

	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), ".a { color: green }\n")
	h.before("s1", filepath.Join(dir, "app.css")) // a second edit keeps the first before copy
	writeFile(t, filepath.Join(dir, "app.css"), ".a { color: blue }\n")
	h.before("s1", filepath.Join(dir, "web", "new.js")) // created by the edit
	writeFile(t, filepath.Join(dir, "web", "new.js"), "go()\n")
	h.before("s1", filepath.Join(dir, "same.rb")) // an edit denied after the hook ran
	h.before("s1", outside)
	writeFile(t, outside, "new\n")
	writeFile(t, filepath.Join(dir, "sed.rb"), "x = 2\n") // a shell edit: no hook

	if code, body := status(h, "1", "done", "made it blue"); code != 200 {
		t.Fatalf("done: %d %s", code, body)
	}
	ev := s.readUntilEvent("tweak-status")
	for ev["tweak"].(map[string]any)["status"] != "done" {
		ev = s.readUntilEvent("tweak-status")
	}
	if got := shown(t, ev, "files"); got != "app.css, web/new.js, ~/dev/shared-ui/buttons.css (outside)" {
		t.Fatalf("files: %s", got)
	}
	if got := shown(t, ev, "unrecorded"); got != "sed.rb" {
		t.Fatalf("unrecorded: %s", got)
	}
	if change := ev["tweak"].(map[string]any)["change"].(map[string]any); change["state"] != "recorded" || change["checked"] != true {
		t.Fatalf("change %v", change)
	}
	if h.marked("s1") {
		t.Fatal("the marker outlived the capture")
	}
	// The store keeps the first before copy.
	tw, _ := h.b.store.Tweak(1)
	if tw.Change.Files[0].Shown != "app.css" {
		t.Fatalf("store %+v", tw.Change)
	}
}

func TestWithoutACaptureTheHooksPostRecordsNothing(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "a\n"})
	h, _ := capturing(t, dir)
	h.register("s2", dir)
	h.before("s2", filepath.Join(dir, "app.css")) // s2 isn't capturing
	writeFile(t, filepath.Join(dir, "app.css"), "b\n")
	c, _ := h.b.store.Capturing("s1")
	if len(c.Files) != 0 {
		t.Fatalf("another session's edit was recorded: %+v", c.Files)
	}
	resp, body := h.do(as("s1", req{method: "POST", path: "/edits/before", body: map[string]string{"path": "app.css"}}))
	refused(t, resp, body, 400, "bad-request")
}

// Outside a git repo the check is skipped, so an empty change can't say no
// files changed.
func TestOutsideARepoNothingRecordedIsNoEditsRecorded(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))
	h, s := capturing(t, dir)
	status(h, "1", "done", "nothing to do")
	ev := s.readUntilEvent("tweak-status")
	for ev["tweak"].(map[string]any)["status"] != "done" {
		ev = s.readUntilEvent("tweak-status")
	}
	change := ev["tweak"].(map[string]any)["change"].(map[string]any)
	if change["state"] != "nothing-recorded" || change["checked"] != false {
		t.Fatalf("change %v", change)
	}
}

// Asking ends capture; working again after the reply extends the same
// change; releasing ends it too. Queueing another tweak doesn't.
func TestCaptureEndsAtAQuestionAndARelease(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n"})
	h, s := capturing(t, dir)
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "green\n")

	s.send(createMsg("r2", "https://ernie.localhost/other", "and this"))
	s.readUntil("result")
	if code, body := status(h, "2", "queued", ""); code != 200 {
		t.Fatalf("queue: %d %s", code, body)
	}
	if !h.marked("s1") {
		t.Fatal("queueing another tweak ended the capture")
	}

	status(h, "1", "question", "which green?")
	if h.marked("s1") {
		t.Fatal("asking didn't end the capture")
	}
	s.send(map[string]any{"type": "reply", "ref": "r3", "number": 1, "text": "the dark one"})
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	h.before("s1", filepath.Join(dir, "app.css")) // green now: the red before copy stays
	writeFile(t, filepath.Join(dir, "app.css"), "dark green\n")

	resp, body := h.do(as("s1", req{method: "DELETE", path: "/claims"}))
	if resp.StatusCode != 200 {
		t.Fatalf("release: %d %s", resp.StatusCode, body)
	}
	if h.marked("s1") {
		t.Fatal("releasing didn't end the capture")
	}
	tw, _ := h.b.store.Tweak(1)
	if tw.Change == nil || tw.Change.Capturing || tw.Change.State != "recorded" || len(tw.Change.Files) != 1 {
		t.Fatalf("change %+v", tw.Change)
	}
}

// Working on another tweak ends the first tweak's capture properly (its
// after contents read, its change recorded) before the second's starts.
func TestWorkingOnAnotherTweakEndsTheFirstsCapture(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n", "b.css": "b\n"})
	h, s := capturing(t, dir)
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "green\n")

	s.send(createMsg("r2", "https://ernie.localhost/other", "and this"))
	s.readUntil("result")
	if resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/2/work"})); resp.StatusCode != 200 {
		t.Fatalf("work 2: %d %s", resp.StatusCode, body)
	}
	first, _ := h.b.store.Tweak(1)
	if c := first.Change; c == nil || c.Capturing || c.State != "recorded" || len(c.Files) != 1 || c.Files[0].Shown != "app.css" {
		t.Fatalf("tweak 1's change %+v", first.Change)
	}
	if c, err := h.b.store.Capturing("s1"); err != nil || c.Tweak != 2 || !h.marked("s1") {
		t.Fatalf("capturing %+v %v, marked %v", c, err, h.marked("s1"))
	}
}

// A shell edit, then an Edit the developer denies after the hook ran: the
// before copy already holds the shell edit, so the file is dropped as
// unchanged, and the git check must still list it as unrecorded.
func TestAShellEditThenADeniedEditIsUnrecorded(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n"})
	h, _ := capturing(t, dir)
	writeFile(t, filepath.Join(dir, "app.css"), "sed green\n")
	h.before("s1", filepath.Join(dir, "app.css")) // then denied
	status(h, "1", "done", "made it green")
	tw, _ := h.b.store.Tweak(1)
	if c := tw.Change; len(c.Files) != 0 || len(c.Unrecorded) != 1 || c.Unrecorded[0].Shown != "app.css" {
		t.Fatalf("change %+v", c)
	}
}

// A hook request that waited past the hook's deadline (the edit has run by
// then) records nothing: its file is no longer the before copy.
func TestAnExpiredHookRequestRecordsNothing(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n"})
	h, _ := capturing(t, dir)
	h.b.captureMu.Lock() // another capture, busy
	raw, _ := json.Marshal(map[string]string{"path": filepath.Join(dir, "app.css")})
	r, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/edits/before", h.b.Port()), bytes.NewReader(raw))
	r.Header.Set("x-tweak", "1")
	r.Header.Set("x-tweak-protocol", fmt.Sprint(version.Protocol))
	r.Header.Set("x-tweak-session", "s1")
	if _, err := (&http.Client{Timeout: 200 * time.Millisecond}).Do(r); err == nil {
		t.Fatal("the request should have timed out")
	}
	writeFile(t, filepath.Join(dir, "app.css"), "green\n") // the edit runs
	time.Sleep(100 * time.Millisecond)
	h.b.captureMu.Unlock()
	time.Sleep(200 * time.Millisecond) // the handler, if it went on, has recorded by now
	if c, _ := h.b.store.Capturing("s1"); len(c.Files) != 0 {
		t.Fatalf("recorded the edited file as the before copy: %q", c.Files[0].Data)
	}
}

// A tweak declined after partial edits keeps them as an undoable change.
func TestADeclineAfterEditsKeepsTheChange(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n"})
	h, _ := capturing(t, dir)
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "half green\n")
	if code, body := status(h, "1", "declined", "it comes from the CMS"); code != 200 {
		t.Fatalf("decline: %d %s", code, body)
	}
	tw, _ := h.b.store.Tweak(1)
	if c := tw.Change; c == nil || c.Capturing || c.State != "recorded" || len(c.Files) != 1 || h.marked("s1") {
		t.Fatalf("change %+v, marked %v", tw.Change, h.marked("s1"))
	}
}

// A capture survives a bridge restart, and a crashed bridge's stale marker
// goes when the next one starts.
func TestMarkersFollowTheStoreAtStart(t *testing.T) {
	state := t.TempDir()
	dir := project(t, map[string]string{"app.css": "a\n"})
	h := start(t, func(o *Options) { o.Config.StateDir = state })
	h.register("s1", dir)
	h.claim("s1", "https://ernie.localhost/*")
	if _, err := h.b.store.CreateTweak(store.NewTweak{URL: "https://ernie.localhost/", Request: "make it green"}); err != nil {
		t.Fatal(err)
	}
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	h.b.Shutdown()
	<-h.done
	h.done <- nil // for the first harness's cleanup

	os.Remove(h.cfg.Marker("s1"))
	writeFile(t, h.cfg.Marker("gone"), "9\n")
	again := start(t, func(o *Options) { o.Config.StateDir = state })
	if !again.marked("s1") || again.marked("gone") {
		t.Fatalf("markers: s1 %v, gone %v", again.marked("s1"), again.marked("gone"))
	}
	// The capture itself carries on: an edit after the restart is recorded.
	again.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "b\n")
	if code, body := status(again, "1", "done", "made it b"); code != 200 {
		t.Fatalf("done: %d %s", code, body)
	}
	if tw, _ := again.b.store.Tweak(1); tw.Change == nil || len(tw.Change.Files) != 1 || tw.Change.Files[0].Shown != "app.css" {
		t.Fatalf("change after a restart %+v", tw.Change)
	}
}

// Releasing a claim ends capture only when the claim covers the capturing
// tweak's page, or no claim is left: releasing another page's claim leaves
// the tweak capturing, so its later edits are still recorded.
func TestReleaseEndsCaptureOnlyForItsOwnPage(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n"})
	h, _ := capturing(t, dir) // tweak 1 on https://ernie.localhost/
	h.claim("s1", "http://localhost:3000")
	release := func(pattern string) {
		t.Helper()
		resp, body := h.do(as("s1", req{method: "DELETE", path: "/claims?pattern=" + pattern}))
		if resp.StatusCode != 200 {
			t.Fatalf("release %s: %d %s", pattern, resp.StatusCode, body)
		}
	}
	release("http://localhost:3000/*")
	if !h.marked("s1") {
		t.Fatal("releasing another page's claim ended the capture")
	}
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "green\n")
	release("https://ernie.localhost/*")
	if h.marked("s1") {
		t.Fatal("releasing the tweak's own claim didn't end the capture")
	}
	if tw, _ := h.b.store.Tweak(1); tw.Change == nil || tw.Change.Capturing || len(tw.Change.Files) != 1 {
		t.Fatalf("change %+v", tw.Change)
	}
}

// A work that can't end the previous capture is refused, saying what to
// do, and changes nothing: the old capture and its marker stay, and the new
// tweak isn't started, so its edits can't land in the old tweak's change.
func TestAWorkThatCantEndThePreviousCaptureIsRefused(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n"})
	h, s := capturing(t, dir)
	h.before("s1", filepath.Join(dir, "app.css"))
	s.send(createMsg("r2", "https://ernie.localhost/other", "and this"))
	s.readUntil("result")

	// The end's write fails, as a full disk would make it.
	db, err := sql.Open("sqlite", h.cfg.Database())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TRIGGER fail BEFORE UPDATE OF capturing ON changes BEGIN SELECT RAISE(ABORT, 'disk full'); END`); err != nil {
		t.Fatal(err)
	}
	resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/2/work"}))
	refused(t, resp, body, 500, "internal")
	if want := "tweak 2 wasn't started: undo capture of tweak 1 couldn't end"; !strings.Contains(string(body), want) || !strings.Contains(string(body), "run tweak work 2 again") {
		t.Fatalf("refusal %s", body)
	}
	if tw, _ := h.b.store.Tweak(2); tw.Status == "working" || tw.Change != nil {
		t.Fatalf("tweak 2 started: %+v", tw)
	}
	if c, err := h.b.store.Capturing("s1"); err != nil || c.Tweak != 1 || !h.marked("s1") {
		t.Fatalf("capture %+v %v, marked %v", c, err, h.marked("s1"))
	}
}

// A file shell-edited before the hook first saw it: its before copy holds
// the shell edit, so Undo can't fully reverse it. It's listed as recorded,
// and also as changed without being recorded.
func TestAShellEditBeforeTheHookIsListedBothWays(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n", "b.css": "b\n"})
	h, _ := capturing(t, dir)
	writeFile(t, filepath.Join(dir, "app.css"), "sed red\n")
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "green\n")
	h.before("s1", filepath.Join(dir, "b.css")) // a clean edit, for contrast
	writeFile(t, filepath.Join(dir, "b.css"), "c\n")
	status(h, "1", "done", "made it green")
	tw, _ := h.b.store.Tweak(1)
	var files, unrecorded []string
	for _, f := range tw.Change.Files {
		files = append(files, f.Shown)
	}
	for _, f := range tw.Change.Unrecorded {
		unrecorded = append(unrecorded, f.Shown)
	}
	if strings.Join(files, " ") != "app.css b.css" || strings.Join(unrecorded, " ") != "app.css" {
		t.Fatalf("files %v, unrecorded %v", files, unrecorded)
	}
}

// The hook's post never waits on git: not on the snapshot of a work in
// progress, nor on the git check of an end in progress.
func TestTheHookNeverWaitsOnGit(t *testing.T) {
	dir := project(t, map[string]string{"app.css": "red\n", "b.css": "b\n"})
	h, s := capturing(t, dir)
	s.send(createMsg("r2", "https://ernie.localhost/other", "and this"))
	s.readUntil("result")

	inGit, release := make(chan struct{}, 1), make(chan struct{})
	slow := func() { inGit <- struct{}{}; <-release }
	snapshot, changed := h.b.gitSnapshot, h.b.gitChanged
	h.b.gitSnapshot = func(folder, scratch string) (capture.Tree, error) { slow(); return snapshot(folder, scratch) }
	h.b.gitChanged = func(t capture.Tree, scratch string) ([]string, error) { slow(); return changed(t, scratch) }

	quick := func(what string) {
		t.Helper()
		began := time.Now()
		h.before("s1", filepath.Join(dir, "app.css"))
		if took := time.Since(began); took > 300*time.Millisecond {
			t.Fatalf("the hook's post waited %s on %s", took, what)
		}
	}
	worked := make(chan struct{})
	go func() {
		h.do(as("s1", req{method: "POST", path: "/tweaks/2/work"}))
		close(worked)
	}()
	<-inGit // tweak 1's git check, as its capture ends
	quick("the end's git check")
	release <- struct{}{}
	<-inGit // tweak 2's snapshot
	quick("the snapshot")
	release <- struct{}{}
	<-worked
}

// lockedBuffer is a log the bridge writes while the test reads it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// A tweak's first edit is logged once to bridge.log, for the open
// measurement; the store times it (store.FirstEdit).
func TestATweaksFirstEditIsLoggedOnce(t *testing.T) {
	dir := project(t, map[string]string{"app.css": ".a { color: red }\n", "b.css": ""})
	var logged lockedBuffer
	h, _ := capturing(t, dir, func(o *Options) { o.Log = &logged })
	h.before("s1", filepath.Join(dir, "app.css"))
	h.before("s1", filepath.Join(dir, "b.css"))
	if n := strings.Count(logged.String(), "tweak 1: first edit"); n != 1 {
		t.Fatalf("logged %d times:\n%s", n, logged.String())
	}
}

func TestTheFirstEditLine(t *testing.T) {
	if got := firstEditLine(store.FirstEdit{Tweak: 12, Delivered: true, After: 34*time.Second + 600*time.Millisecond}); got != "tweak 12: first edit 34s after delivery" {
		t.Errorf("got %q", got)
	}
	if got := firstEditLine(store.FirstEdit{Tweak: 12}); got != "tweak 12: first edit, delivery not recorded" {
		t.Errorf("got %q", got)
	}
}
