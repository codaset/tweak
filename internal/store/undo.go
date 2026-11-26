package store

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/codaset/tweak/internal/pattern"
)

// Reversing a change (docs/design.md, "Reversing"). The bridge reads what
// Undo needs (Undoable), checks every file, then either writes them all and
// marks the change undone (Undone), or writes nothing and asks the session
// that claims the tweak's page now to reverse it by hand (RequestUndo). That
// session resolves it (ResolveUndo, tweak undone) or declines it (a decline
// of the tweak, which keeps the change). Undo is final: no Redo in v1.

// ErrNotUndoable is matched (errors.Is) by every refusal to undo a change;
// each says why, as the card shows it.
var ErrNotUndoable = errors.New("this change can't be undone")

// ErrNotUndoRequested refuses tweak undone on a change no undo was asked of.
var ErrNotUndoRequested = errors.New("no undo was asked of this tweak's change")

// UndoError is a refusal to undo a change, worded for the card.
type UndoError struct{ Why string }

func (e *UndoError) Error() string        { return e.Why }
func (e *UndoError) Is(target error) bool { return target == ErrNotUndoable }

// The refusals, as the card shows them.
var (
	errUnfinished    = &UndoError{"Undo comes once Claude has finished this tweak"}
	errNothingToUndo = &UndoError{"No files changed, so there's nothing to undo"}
	errAsked         = &UndoError{"Claude has been asked to undo this already"}
	errUndone        = &UndoError{"This change is already undone"}
)

// UndoFile is a recorded file as Undo reverses it: its before and after
// contents, either of which may be absent (created, or deleted, by Claude).
type UndoFile struct {
	ChangeFile
	Before, After             []byte
	BeforeAbsent, AfterAbsent bool
}

// Undoing is a change as Undo needs it: the tweak (with its change) and its
// recorded files, oldest first. Only recorded files: Undo never touches the
// unrecorded ones. With none, only Claude can undo it (Ask Claude to undo).
type Undoing struct {
	Tweak Tweak
	Files []UndoFile
}

// Undoable reads tweak number's change for Undo, refusing one that isn't
// finished, has nothing to undo, or is already asked or undone.
func (s *Store) Undoable(number int64) (Undoing, error) {
	tx, err := s.begin()
	if err != nil {
		return Undoing{}, err
	}
	defer tx.Rollback()
	return undoable(tx, number)
}

func undoable(tx *eventTx, number int64) (Undoing, error) {
	tw, err := getTweak(tx, number)
	if err != nil {
		return Undoing{}, err
	}
	c := tw.Change
	if c == nil || c.Capturing || (tw.Status != StatusDone && tw.Status != StatusDeclined) {
		return Undoing{}, errUnfinished
	}
	switch c.State {
	case ChangeUndoRequested:
		return Undoing{}, errAsked
	case ChangeUndone:
		return Undoing{}, errUndone
	case ChangeNothingRecorded:
		if len(c.Unrecorded) == 0 && c.Checked {
			return Undoing{}, errNothingToUndo
		}
		return Undoing{Tweak: tw}, nil
	}
	files, err := undoFiles(tx, number)
	return Undoing{Tweak: tw, Files: files}, err
}

// ChangeFiles is tweak number's recorded files, as Undo reverses them,
// whatever its change's state: what tweak undo shows.
func (s *Store) ChangeFiles(number int64) ([]UndoFile, error) { return undoFiles(s.db, number) }

func undoFiles(q querier, number int64) ([]UndoFile, error) {
	rows, err := q.Query(`SELECT f.path, f.shown, f.outside, f.before, f.after FROM change_files f JOIN changes c ON c.id = f.change
		WHERE c.tweak = ? AND f.recordable = 1 ORDER BY f.id`, number)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UndoFile
	for rows.Next() {
		var f UndoFile
		if err := rows.Scan(&f.Path, &f.Shown, &f.Outside, &f.Before, &f.After); err != nil {
			return nil, err
		}
		f.BeforeAbsent, f.AfterAbsent = f.Before == nil, f.After == nil
		out = append(out, f)
	}
	return out, rows.Err()
}

// Undone marks tweak number's recorded change undone, once the bridge has
// written every file back, with your undo entry. It's logged as
// tweak-undone, which the page reloads on.
func (s *Store) Undone(number int64) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	u, err := undoable(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if u.Tweak.Change.State != ChangeRecorded {
		return Tweak{}, &UndoError{"No edits were recorded, so only Claude can undo this"}
	}
	var shown []string
	for _, f := range u.Files {
		shown = append(shown, f.Shown)
	}
	if err := tx.setChange(number, ChangeUndone, 0); err != nil {
		return Tweak{}, err
	}
	entry := &Entry{From: FromYou, Kind: KindUndo, Text: "Undid the change to " + strings.Join(shown, ", ")}
	tw, err := tx.change(number, u.Tweak.Status, entry, EventTweakUndone)
	if err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// RequestUndo asks for tweak number's change to be undone by hand:
// conflicts of its recorded files couldn't be reversed around later edits,
// or none were recorded (Ask Claude to undo). It goes to the session that
// claims the tweak's page now, which the tweak passes to, as a
// tweak-undo-conflict event in its inbox. With no claim it waits (Waiting),
// and goes to the next session that claims the page (Claim).
func (s *Store) RequestUndo(number int64, conflicts int) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	u, err := undoable(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if err := tx.setChange(number, ChangeUndoRequested, conflicts); err != nil {
		return Tweak{}, err
	}
	claims, err := listClaims(tx)
	if err != nil {
		return Tweak{}, err
	}
	session := sql.NullString{}
	for _, c := range claims {
		if p, err := pattern.Parse(c.Pattern); err == nil && p.Match(u.Tweak.URL) {
			session = sql.NullString{String: c.Session.ID, Valid: true}
			break
		}
	}
	if _, err := tx.Exec(`UPDATE tweaks SET session = ? WHERE number = ?`, session, number); err != nil {
		return Tweak{}, err
	}
	event := EventTweakStatus
	if session.Valid {
		event = EventTweakUndoConflict
	}
	tw, err := tx.change(number, u.Tweak.Status, nil, event)
	if err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// ResolveUndo is tweak undone: the session the undo went to reports it
// reversed the change by hand. The change becomes undone, with Claude's
// message as its undo entry, logged as tweak-undone.
func (s *Store) ResolveUndo(sessionID string, number int64, text string) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := ownTweak(tx, sessionID, number)
	if err != nil {
		return Tweak{}, err
	}
	if tw.Change == nil || tw.Change.State != ChangeUndoRequested {
		return Tweak{}, ErrNotUndoRequested
	}
	if err := tx.setChange(number, ChangeUndone, 0); err != nil {
		return Tweak{}, err
	}
	if tw, err = tx.change(number, tw.Status, &Entry{From: FromClaude, Kind: KindUndo, Text: text}, EventTweakUndone); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// declineUndo is tweak decline on an undo-requested change: the undo is
// refused, and the change kept as it was, recorded or nothing-recorded,
// with Claude's reason. The tweak's status stays.
func (t *eventTx) declineUndo(tw Tweak, entry *Entry) (Tweak, error) {
	if _, err := t.Exec(`UPDATE changes SET conflicts = 0,
		state = CASE WHEN EXISTS (SELECT 1 FROM change_files f WHERE f.change = changes.id AND f.recordable = 1) THEN ? ELSE ? END
		WHERE tweak = ?`, ChangeRecorded, ChangeNothingRecorded, tw.Number); err != nil {
		return Tweak{}, err
	}
	return t.change(tw.Number, tw.Status, entry, EventTweakStatus)
}

func (t *eventTx) setChange(number int64, state string, conflicts int) error {
	_, err := t.Exec(`UPDATE changes SET state = ?, conflicts = ? WHERE tweak = ?`, state, conflicts, number)
	return err
}

// passUndos gives the undos waiting for a session on p's pages to session,
// which claimed p: each is logged as tweak-undo-conflict for its inbox.
func (t *eventTx) passUndos(session string, p pattern.Pattern) error {
	waiting, err := t.undosWhere(`t.session IS NULL`)
	if err != nil {
		return err
	}
	for _, w := range waiting {
		if !p.Match(w.url) {
			continue
		}
		if _, err := t.Exec(`UPDATE tweaks SET session = ? WHERE number = ?`, session, w.number); err != nil {
			return err
		}
		if _, err := t.change(w.number, w.status, nil, EventTweakUndoConflict); err != nil {
			return err
		}
	}
	return nil
}

// dropUndos sends the undos waiting on session back to waiting for one,
// when it no longer claims their pages (claims, after a release).
func (t *eventTx) dropUndos(session string, claims []Claim) error {
	held, err := t.undosWhere(`t.session = ?`, session)
	if err != nil {
		return err
	}
	for _, h := range held {
		covered := false
		for _, c := range claims {
			if p, err := pattern.Parse(c.Pattern); err == nil && c.Session.ID == session && p.Match(h.url) {
				covered = true
			}
		}
		if covered {
			continue
		}
		if _, err := t.Exec(`UPDATE tweaks SET session = NULL WHERE number = ?`, h.number); err != nil {
			return err
		}
		if _, err := t.change(h.number, h.status, nil, EventTweakStatus); err != nil {
			return err
		}
	}
	return nil
}

type undoRow struct {
	number      int64
	url, status string
}

func (t *eventTx) undosWhere(where string, args ...any) ([]undoRow, error) {
	rows, err := t.Query(`SELECT t.number, t.page_url, t.status FROM tweaks t JOIN changes c ON c.tweak = t.number
		WHERE c.state = ? AND `+where+` ORDER BY t.number`, append([]any{ChangeUndoRequested}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []undoRow
	for rows.Next() {
		var r undoRow
		if err := rows.Scan(&r.number, &r.url, &r.status); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
