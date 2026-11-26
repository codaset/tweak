package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/codaset/tweak/internal/capture"
	"github.com/codaset/tweak/internal/pattern"
	"github.com/codaset/tweak/internal/store"
)

// Undo capture (docs/design.md, "Capture"): tweak work starts it for the
// session, the edit hook's POST /edits/before records each file's before
// copy, and it ends at done, ask or decline of the capturing tweak, at a
// release covering its page, or when work moves to another tweak, reading
// the after contents and running the git check. (A capturing tweak is
// working, which queue can't leave, so queue never ends one.) While it
// runs, the session's marker file tells the hook to post.
//
// captureMu serialises the short steps: a hook's post, and the moment a
// capture starts or ends. Git (the snapshot and the check) always runs
// before the lock is taken, so a hook's post never waits on it.

// gitEnd is the slow part of ending a capture, run outside captureMu: the
// git check's changed files, and the recorded files whose before copy isn't
// what their round's snapshot had (shell-edited before the hook saw them).
type gitEnd struct {
	tweak   int64
	base    string
	changed []string
	err     error
	judged  map[string]bool // recorded paths whose before copy was checked
	tainted map[string]bool // of those, the ones that differ from the snapshot
}

// prepare runs the git part of ending the session's capture of tweak n
// (0: of any tweak), outside the lock. It's nil when there's no such capture.
func (b *Bridge) prepare(session string, n int64) *gitEnd {
	c, err := b.store.Capturing(session)
	if err != nil || (n != 0 && c.Tweak != n) {
		return nil
	}
	return b.checkGit(c, c.Files)
}

func (b *Bridge) checkGit(c store.Capture, files []store.Before) *gitEnd {
	g := &gitEnd{tweak: c.Tweak, base: c.Base, judged: map[string]bool{}, tainted: map[string]bool{}}
	g.changed, g.err = b.gitChanged(capture.Tree{Repo: c.Repo, Hash: c.Base}, b.opts.Config.StateDir)
	b.judge(g, c.Repo, files)
	return g
}

// judge checks each recorded file's before copy against the snapshot of
// the round it was recorded in. One that differs was changed before the
// hook saw it, so Undo can't fully reverse it.
func (b *Bridge) judge(g *gitEnd, repo string, files []store.Before) {
	byBase := map[string][]store.Before{}
	for _, f := range files {
		if f.Base != "" && f.Text {
			byBase[f.Base] = append(byBase[f.Base], f)
		}
	}
	for base, fs := range byBase {
		var paths []string
		for _, f := range fs {
			paths = append(paths, f.Path)
		}
		then, err := capture.SnapshotOf(capture.Tree{Repo: repo, Hash: base}, paths)
		if err != nil {
			b.log.Printf("tweak %d: checking before copies: %v", g.tweak, err)
			continue
		}
		for _, f := range fs {
			s, known := then[f.Path]
			if !known {
				continue
			}
			g.judged[f.Path] = true
			if s.Absent != f.Absent || !bytes.Equal(s.Data, f.Data) {
				g.tainted[f.Path] = true
			}
		}
	}
}

// ending builds, under captureMu, how the session's capture of tweak n (0:
// of any tweak) ends, from g (prepare's work): each recorded file's after
// contents, and the files that changed without being recorded. If the
// capture moved since g was prepared, its git part runs again here; files
// recorded since are judged here too. It's nil when there's no such capture.
func (b *Bridge) ending(session string, n int64, g *gitEnd) (*store.CaptureEnd, error) {
	c, err := b.store.Capturing(session)
	if errors.Is(err, store.ErrNotCapturing) {
		return nil, nil
	}
	if err != nil || (n != 0 && c.Tweak != n) {
		return nil, err
	}
	if g == nil || g.tweak != c.Tweak || g.base != c.Base {
		g = b.checkGit(c, c.Files)
	} else {
		var late []store.Before
		for _, f := range c.Files {
			if !g.judged[f.Path] {
				late = append(late, f)
			}
		}
		b.judge(g, c.Repo, late)
	}
	if g.err != nil {
		b.log.Printf("tweak %d: git check failed: %v", c.Tweak, g.err)
	}
	end := &store.CaptureEnd{Tweak: c.Tweak, Checked: g.err == nil && c.Base != ""}
	listed := map[string]bool{}
	unrecorded := func(f store.ChangeFile) {
		if !listed[f.Path] {
			listed[f.Path] = true
			end.Unrecorded = append(end.Unrecorded, f)
		}
	}
	// Once unrecorded, always: an earlier round's finds stay.
	for _, u := range c.Unrecorded {
		unrecorded(u)
	}
	recorded := map[string]bool{}
	for _, f := range c.Files {
		r := capture.Read(f.Path)
		after := store.After{Path: f.Path, Absent: r.Absent, Text: r.Text, Data: r.Data}
		end.Files = append(end.Files, after)
		// A file dropped as unchanged may still have changed since the
		// snapshot (a shell edit before a denied edit): the check lists it.
		if f.Unchanged(after) {
			continue
		}
		recorded[f.Path] = true
		if g.tainted[f.Path] {
			unrecorded(f.ChangeFile) // recorded, but its before copy holds a shell edit
		}
	}
	for _, p := range g.changed {
		if p = capture.Canonical(p); !recorded[p] {
			unrecorded(fileIn(c.Folder, p))
		}
	}
	return end, nil
}

// captureSwitchError refuses a tweak work whose previous capture couldn't
// end: nothing changed, and the line says what to do.
type captureSwitchError struct {
	n, from int64
	err     error
}

func (e *captureSwitchError) Error() string {
	return fmt.Sprintf("tweak %d wasn't started: undo capture of tweak %d couldn't end (%v): run tweak work %d again", e.n, e.from, e.err, e.n)
}

// startWork is tweak work: tweak n becomes working and the session's
// capturing tweak, ending any other capture first, all or nothing. Working
// on the tweak already capturing changes nothing, so its first snapshot
// stays.
func (b *Bridge) startWork(session string, n int64) (store.Tweak, error) {
	// An unregistered session owns no tweak: Work refuses it with the
	// tweak's own refusal (no-tweak or not-yours).
	se, err := b.store.Session(session)
	if err != nil && !errors.Is(err, store.ErrNoSession) {
		return store.Tweak{}, err
	}
	// Git first, outside the lock: the previous capture's check, and this
	// one's snapshot.
	g := b.prepare(session, 0)
	var tree capture.Tree
	if (g == nil || g.tweak != n) && se.Folder != "" {
		if tree, err = b.gitSnapshot(se.Folder, b.opts.Config.StateDir); err != nil {
			// The check is skipped, as outside a repo; the hook still records.
			b.log.Printf("tweak %d: git check skipped: %v", n, err)
		}
	}
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	var end *store.CaptureEnd
	if c, err := b.store.Capturing(session); err == nil && c.Tweak != n {
		if end, err = b.ending(session, c.Tweak, g); err != nil {
			return store.Tweak{}, &captureSwitchError{n: n, from: c.Tweak, err: err}
		}
	}
	tw, err := b.store.Work(session, n, end, store.CaptureStart{Folder: se.Folder, Repo: tree.Repo, Base: tree.Hash})
	var refused *store.TransitionError
	var notYours *store.NotYoursError
	if err != nil && end != nil && !errors.As(err, &refused) && !errors.As(err, &notYours) && !errors.Is(err, store.ErrNoTweak) {
		return store.Tweak{}, &captureSwitchError{n: n, from: end.Tweak, err: err}
	}
	if err != nil {
		return store.Tweak{}, err
	}
	if err := b.mark(session, n); err != nil {
		// The hook won't post, but the git check still lists the edits.
		b.log.Printf("tweak %d: capture marker: %v", n, err)
	}
	return tw, nil
}

// endCapture ends the session's capture, whichever tweak it's of, and logs
// that tweak with its change. A session that isn't capturing is fine. It's
// what a release covering the tweak's page calls, and what a lapse or the
// session-end hook should call.
func (b *Bridge) endCapture(session string) error {
	g := b.prepare(session, 0)
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	end, err := b.ending(session, 0, g)
	if err != nil || end == nil {
		return err
	}
	if _, err := b.store.EndCapture(session, *end); err != nil {
		return err
	}
	b.unmark(session)
	return nil
}

// releaseEndsCapture says whether releasing patterns ends the session's
// capture: when one of them covers the capturing tweak's page, or the
// session has no claim left. Releasing another page's claim leaves the
// tweak capturing, since Claude can still edit it.
func (b *Bridge) releaseEndsCapture(session string, released []string) bool {
	c, err := b.store.Capturing(session)
	if err != nil {
		return false
	}
	claims, err := b.store.Claims()
	if err != nil {
		return true
	}
	left := 0
	for _, cl := range claims {
		if cl.Session.ID == session {
			left++
		}
	}
	if left == 0 {
		return true
	}
	tw, err := b.store.Tweak(c.Tweak)
	if err != nil {
		return true
	}
	for _, r := range released {
		if p, err := pattern.Parse(r); err == nil && p.Match(tw.URL) {
			return true
		}
	}
	return false
}

// setStatusEnding is a status change that ends the session's capture when
// it's of tweak n, with the tweak logged once, status and change together.
func (b *Bridge) setStatusEnding(session string, n int64, status string, e *store.Entry) (store.Tweak, error) {
	g := b.prepare(session, n)
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	end, err := b.ending(session, n, g)
	if err != nil {
		return store.Tweak{}, err
	}
	tw, err := b.store.SetStatusEnding(session, n, status, e, end)
	if err == nil && end != nil {
		b.unmark(session)
	}
	return tw, err
}

// fileIn is a file as a change lists it: its canonical path, and how the
// card shows it: relative to the session's folder, or outside it absolute,
// with ~ for the home folder.
func fileIn(folder, path string) store.ChangeFile {
	path = capture.Canonical(path)
	if rel, inside := capture.Within(folder, path); inside {
		return store.ChangeFile{Path: path, Shown: rel}
	}
	shown := path
	if home, err := os.UserHomeDir(); err == nil {
		if rel, inside := capture.Within(home, path); inside {
			shown = "~/" + rel
		}
	}
	return store.ChangeFile{Path: path, Shown: shown, Outside: true}
}

// editBefore is POST /edits/before {path}: the edit hook, just before an
// agent edits path. If the session is capturing, the bridge saves the
// file's contents as its before copy, the first time it's touched in the
// tweak only. Either way it answers 204, once the copy is saved: the edit
// runs as soon as the hook exits. It never waits on git.
func (b *Bridge) editBefore(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionID(w, r)
	if !ok {
		return
	}
	var body struct{ Path string }
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || !filepath.IsAbs(body.Path) {
		refuse(w, 400, "bad-request", `POST /edits/before needs {"path": <the file's absolute path>}`)
		return
	}
	io.Copy(io.Discard, r.Body) // read to the end, so a hook that gives up cancels r's context
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	// A hook that gave up while this waited has let its edit run: the file
	// is no longer its before copy.
	if r.Context().Err() != nil {
		return
	}
	c, err := b.store.Capturing(session)
	if errors.Is(err, store.ErrNotCapturing) {
		w.WriteHeader(204)
		return
	}
	if err != nil {
		b.internal(w, err)
		return
	}
	f := fileIn(c.Folder, filepath.Clean(body.Path))
	read := capture.Read(f.Path)
	if _, err := b.store.RecordBefore(session, store.Before{ChangeFile: f, Absent: read.Absent, Text: read.Text, Data: read.Data}); err != nil {
		b.internal(w, err)
		return
	}
	w.WriteHeader(204)
}

// mark writes the session's marker file; unmark removes it.
func (b *Bridge) mark(session string, n int64) error {
	path := b.opts.Config.Marker(session)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strconv.FormatInt(n, 10)+"\n"), 0o600)
}

func (b *Bridge) unmark(session string) {
	if err := os.Remove(b.opts.Config.Marker(session)); err != nil && !errors.Is(err, os.ErrNotExist) {
		b.log.Printf("capture marker for %s: %v", session, err)
	}
}

// syncMarkers makes the marker files match the store's captures, at start:
// a capture survives a bridge restart, and a marker left by a crash goes.
func (b *Bridge) syncMarkers() error {
	sessions, err := b.store.CapturingSessions()
	if err != nil {
		return err
	}
	dir := b.opts.Config.MarkerDir()
	old, _ := os.ReadDir(dir)
	for _, e := range old {
		os.Remove(filepath.Join(dir, e.Name()))
	}
	for _, s := range sessions {
		c, err := b.store.Capturing(s)
		if err != nil {
			return err
		}
		if err := b.mark(s, c.Tweak); err != nil {
			return err
		}
	}
	return nil
}
