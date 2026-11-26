package bridge

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/codaset/tweak/internal/capture"
	"github.com/codaset/tweak/internal/store"
)

// Undo capture (docs/design.md, "Capture"): tweak work starts it for the
// session, the edit hook's POST /edits/before records each file's before
// copy, and it ends at done, ask, decline, queue or release, reading the
// after contents and running the git check. While it runs, the session's
// marker file tells the hook to post. captureMu serialises all of it, so a
// hook's post never lands in a capture that's ending.

// startCapture makes tweak n the session's capturing tweak, ending any
// other first. Working on the tweak already capturing changes nothing, so
// its first git snapshot stays.
func (b *Bridge) startCapture(session string, n int64) error {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	if c, err := b.store.Capturing(session); err == nil && c.Tweak == n {
		return b.mark(session, n)
	}
	if err := b.endLocked(session); err != nil {
		return err
	}
	se, err := b.store.Session(session)
	if err != nil {
		return err
	}
	tree, err := capture.Snapshot(se.Folder, b.opts.Config.StateDir)
	if err != nil {
		// The check is skipped, as outside a repo; the hook still records.
		b.log.Printf("tweak %d: git check skipped: %v", n, err)
	}
	if err := b.store.StartCapture(session, n, se.Folder, tree.Repo, tree.Hash); err != nil {
		return err
	}
	return b.mark(session, n)
}

// endCapture ends the session's capture, whichever tweak it's of, and logs
// that tweak with its change. A session that isn't capturing is fine. It's
// what release calls, and what a lapse or the session-end hook should call.
func (b *Bridge) endCapture(session string) error {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	return b.endLocked(session)
}

func (b *Bridge) endLocked(session string) error {
	end, err := b.ending(session, 0)
	if err != nil || end == nil {
		return err
	}
	if _, err := b.store.EndCapture(session, *end); err != nil {
		return err
	}
	b.unmark(session)
	return nil
}

// setStatusEnding is a status change that ends the session's capture when
// it's of tweak n, with the tweak logged once, status and change together.
func (b *Bridge) setStatusEnding(session string, n int64, status string, e *store.Entry) (store.Tweak, error) {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	end, err := b.ending(session, n)
	if err != nil {
		return store.Tweak{}, err
	}
	tw, err := b.store.SetStatusEnding(session, n, status, e, end)
	if err == nil && end != nil {
		b.unmark(session)
	}
	return tw, err
}

// ending reads how the session's capture of tweak n (0: of any tweak) ends:
// each recorded file's after contents, and the files the git check finds
// changed that weren't recorded, added to those found before. It's nil when
// the session isn't capturing that tweak.
func (b *Bridge) ending(session string, n int64) (*store.CaptureEnd, error) {
	c, err := b.store.Capturing(session)
	if errors.Is(err, store.ErrNotCapturing) {
		return nil, nil
	}
	if err != nil || (n != 0 && c.Tweak != n) {
		return nil, err
	}
	end := &store.CaptureEnd{Tweak: c.Tweak}
	seen := map[string]bool{}
	for _, f := range c.Files {
		r := capture.Read(f.Path)
		after := store.After{Path: f.Path, Absent: r.Absent, Text: r.Text, Data: r.Data}
		end.Files = append(end.Files, after)
		// A file dropped as unchanged may still have changed since the git
		// snapshot (a shell edit before a denied edit): the check lists it.
		if !f.Unchanged(after) {
			seen[f.Path] = true
		}
	}
	changed, err := capture.Changed(capture.Tree{Repo: c.Repo, Hash: c.Base}, b.opts.Config.StateDir)
	if err != nil {
		b.log.Printf("tweak %d: git check failed: %v", c.Tweak, err)
	}
	end.Checked = err == nil && c.Base != ""
	for _, u := range c.Unrecorded {
		if !seen[u.Path] {
			seen[u.Path] = true
			end.Unrecorded = append(end.Unrecorded, u)
		}
	}
	for _, p := range changed {
		if p = capture.Canonical(p); !seen[p] {
			seen[p] = true
			end.Unrecorded = append(end.Unrecorded, fileIn(c.Folder, p))
		}
	}
	return end, nil
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
// runs as soon as the hook exits.
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
