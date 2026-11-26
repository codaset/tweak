package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/codaset/tweak/internal/capture"
	"github.com/codaset/tweak/internal/merge"
	"github.com/codaset/tweak/internal/store"
)

// Reversing a change (docs/design.md, "Reversing"): the card's Undo checks
// every recorded file before writing any, then writes them all, or none and
// asks the session that claims the page now to reverse it by hand. Undo
// never touches unrecorded files, and its writes are never captured: they
// don't pass the edit hook.

// fileState is what Undo finds a recorded file to be, now.
type fileState int

const (
	unchangedSince fileState = iota // as Claude left it: write the before contents back
	alreadyBack                     // already back to before: nothing to do
	editedSince                     // edited since, merged clean around the change
	conflicting                     // can't be reversed by the bridge
)

// filePlan is one recorded file's part of an undo: what it is now, and what
// to write (or delete) to reverse it.
type filePlan struct {
	file   store.UndoFile
	state  fileState
	why    string       // for a conflict, what's in the way
	now    capture.File // as it is now, to put back if the undo fails part-way
	write  []byte       // the contents to write, unless remove
	remove bool         // delete it: Claude created it
}

func (p filePlan) acts() bool { return p.state == unchangedSince || p.state == editedSince }

// planFile checks one recorded file against the change: base after, one
// side the file now, the other the before copy. An absent side can't be
// merged around, so a file deleted or recreated since, or edited since
// Claude created it, conflicts; so does one that's now binary or over 2 MB.
func planFile(f store.UndoFile) filePlan {
	now := capture.Read(f.Path)
	p := filePlan{file: f, now: now}
	is := func(absent bool, data []byte) bool {
		return now.Absent == absent && (absent || (now.Text && bytes.Equal(now.Data, data)))
	}
	switch {
	case !now.Absent && !now.Text:
		p.state, p.why = conflicting, "it's now binary or over 2 MB"
	case is(f.AfterAbsent, f.After):
		p.state, p.write, p.remove = unchangedSince, f.Before, f.BeforeAbsent
	case is(f.BeforeAbsent, f.Before):
		p.state = alreadyBack
	case now.Absent:
		p.state, p.why = conflicting, "it was deleted since"
	case f.AfterAbsent:
		p.state, p.why = conflicting, "it was created again since"
	case f.BeforeAbsent:
		p.state, p.why = conflicting, "it was edited since this change created it"
	default:
		r := merge.Merge(f.After, now.Data, f.Before)
		if r.Conflicts > 0 {
			p.state, p.why = conflicting, "it was edited since, on or next to the changed lines"
		} else {
			p.state, p.write = editedSince, r.Text
		}
	}
	return p
}

func planUndo(files []store.UndoFile) (plans []filePlan, conflicts int) {
	for _, f := range files {
		p := planFile(f)
		if p.state == conflicting {
			conflicts++
		}
		plans = append(plans, p)
	}
	return plans, conflicts
}

// errUndoFailed is a write that failed part-way; what was written is back.
type errUndoFailed struct{ err error }

func (e *errUndoFailed) Error() string {
	return fmt.Sprintf("Undo couldn't write the files (%v), so nothing was changed", e.err)
}

// apply writes every plan, all or nothing: if one write fails, the files
// already written are put back as they were.
func apply(plans []filePlan) error {
	var written []filePlan
	for _, p := range plans {
		if !p.acts() {
			continue
		}
		var err error
		if p.remove {
			err = os.Remove(p.file.Path)
		} else {
			err = writeAtomic(p.file.Path, p.write)
		}
		if err != nil {
			for _, w := range written {
				restore(w)
			}
			return &errUndoFailed{err}
		}
		written = append(written, p)
	}
	return nil
}

// restore puts a file back as it was before the undo.
func restore(p filePlan) {
	if p.now.Absent {
		os.Remove(p.file.Path)
		return
	}
	writeAtomic(p.file.Path, p.now.Data)
}

// writeAtomic replaces path with data through a temporary file beside it,
// keeping its mode (0644 for a file written anew, its folders made).
func writeAtomic(path string, data []byte) error {
	mode := fs.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	} else if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tweak-undo-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// undoChange is the card's Undo of tweak n. With every file clean it writes
// them all and the change is undone; with any conflict, or nothing
// recorded (Ask Claude to undo), it writes nothing and asks for it by hand.
// One undo runs at a time, so two clicks can't both write.
func (b *Bridge) undoChange(n int64) (store.Tweak, error) {
	b.undoMu.Lock()
	defer b.undoMu.Unlock()
	u, err := b.store.Undoable(n)
	if err != nil {
		return store.Tweak{}, err
	}
	plans, conflicts := planUndo(u.Files)
	if len(u.Files) == 0 || conflicts > 0 {
		tw, err := b.store.RequestUndo(n, conflicts)
		if err == nil {
			b.log.Printf("tweak %d: undo needs a session, %d of %d files conflict", n, conflicts, len(u.Files))
		}
		return tw, err
	}
	if err := apply(plans); err != nil {
		b.log.Printf("tweak %d: %v", n, err)
		return store.Tweak{}, err
	}
	tw, err := b.store.Undone(n)
	if err != nil {
		for _, p := range plans {
			if p.acts() {
				restore(p)
			}
		}
		return store.Tweak{}, err
	}
	b.log.Printf("tweak %d undone", n)
	return tw, nil
}

// undoIn is an undo message: the card's Undo, or Ask Claude to undo.
type undoIn struct {
	Ref    string `json:"ref"`
	Number int64  `json:"number"`
}

func (b *Bridge) undo(in undoIn) resultOut {
	out := resultOut{Type: "result", Ref: in.Ref}
	if in.Number < 1 {
		out.Error, out.Message = "bad-request", "undo needs the tweak's number"
		return out
	}
	tw, err := b.undoChange(in.Number)
	var failed *errUndoFailed
	switch {
	case errors.As(err, &failed):
		out.Error, out.Message = "undo-failed", err.Error()
	case err != nil:
		_, out.Error, out.Message = b.refusalOf(in.Number, err)
	default:
		out.Number = tw.Number
	}
	return out
}

// undoConflictLine is a tweak's undo-conflict event line.
func undoConflictLine(tw store.Tweak) string {
	c := tw.Change
	if c == nil || len(c.Files) == 0 {
		return fmt.Sprintf("tweak %d undo-conflict: no edits recorded, undo by hand", tw.Number)
	}
	return fmt.Sprintf("tweak %d undo-conflict: %d of %d files need resolving", tw.Number, c.Conflicts, len(c.Files))
}

// undoText is GET /tweaks/:n/undo, tweak undo: the change for Claude to
// reverse by hand, each file's diff with the conflicting ones marked; with
// nothing recorded, Claude's summary and the files that changed. It starts
// no capture and changes nothing.
func (b *Bridge) undoText(w http.ResponseWriter, r *http.Request) {
	session, n, ok := tweakNumber(w, r)
	if !ok {
		return
	}
	tw, err := b.store.Tweak(n)
	if err == nil && tw.Session != session {
		err = b.notYours(tw)
	}
	if err == nil && (tw.Change == nil || tw.Change.State != store.ChangeUndoRequested) {
		err = store.ErrNotUndoRequested
	}
	if !b.refuseChange(w, n, err) {
		return
	}
	files, err := b.store.ChangeFiles(n)
	if !b.refuseChange(w, n, err) {
		return
	}
	plans, conflicts := planUndo(files)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(200)
	w.Write([]byte(renderUndo(tw, plans, conflicts)))
}

// notYours is the refusal for a session asking about another's tweak.
func (b *Bridge) notYours(tw store.Tweak) error {
	e := &store.NotYoursError{Number: tw.Number}
	if se, err := b.store.Session(tw.Session); err == nil {
		e.Folder = se.Folder
	}
	return e
}

func renderUndo(tw store.Tweak, plans []filePlan, conflicts int) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# Undo tweak %d by hand\n\n", tw.Number)
	finish := fmt.Sprintf("Then run `tweak undone %d '<what you did>'`, or `tweak decline %d '<why not>'` to keep the change.\n", tw.Number, tw.Number)
	if len(plans) == 0 {
		out.WriteString("No edits were recorded for this tweak, so its change has to be found and reversed by hand.\n\n")
		if s, ok := tw.LastEntry(store.KindSummary); ok {
			fmt.Fprintf(&out, "Your summary when you finished it: %s\n\n", s.Text)
		}
		if tw.Change != nil && len(tw.Change.Unrecorded) > 0 {
			out.WriteString("Files that changed while you worked on it (some may not be yours):\n\n")
			for _, f := range tw.Change.Unrecorded {
				fmt.Fprintf(&out, "- `%s`\n", f.Shown)
			}
			out.WriteString("\n")
		}
		out.WriteString("Reverse only this tweak's change, keeping any other edits. " + finish)
		return out.String()
	}
	fmt.Fprintf(&out, "Reverse all of this change with your edit tools, keeping any edits made since. %d of %d files need resolving: they changed since in a way the bridge can't reverse. The others reverse cleanly, but nothing was written, so reverse those too.\n\n", conflicts, len(plans))
	for _, p := range plans {
		f := p.file
		label := map[fileState]string{
			unchangedSince: "unchanged since",
			alreadyBack:    "already back to before: nothing to do",
			editedSince:    "edited since, away from the change",
			conflicting:    "conflicts: " + p.why,
		}[p.state]
		switch {
		case f.BeforeAbsent:
			label = "created by this change, " + label
		case f.AfterAbsent:
			label = "deleted by this change, " + label
		}
		if f.Outside {
			label += " (outside this project)"
		}
		fmt.Fprintf(&out, "## `%s`: %s\n\n", f.Shown, label)
		fmt.Fprintf(&out, "The change, from before to after:\n\n```diff\n%s```\n\n", merge.Unified(f.Before, f.After))
	}
	out.WriteString(finish)
	return out.String()
}

// undone is POST /tweaks/:n/undone {message}, tweak undone: the session
// reversed a conflicting undo by hand.
func (b *Bridge) undone(w http.ResponseWriter, r *http.Request) {
	session, n, ok := tweakNumber(w, r)
	if !ok {
		return
	}
	var body struct{ Message string }
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		refuse(w, 400, "bad-request", `POST /tweaks/:n/undone needs {"message": …}`)
		return
	}
	text := strings.TrimSpace(body.Message)
	if text == "" {
		refuse(w, 400, "bad-request", "undone needs a message: what you did to reverse the change")
		return
	}
	tw, err := b.store.ResolveUndo(session, n, text)
	if !b.refuseChange(w, n, err) {
		return
	}
	reply(w, 200, statusOut{Number: tw.Number, Status: tw.Status, Undo: "undone"})
}
