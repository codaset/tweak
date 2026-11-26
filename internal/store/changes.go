package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// A change's states (docs/design.md, "Undo").
const (
	ChangeRecorded        = "recorded"         // files were recorded: Undo can reverse them
	ChangeNothingRecorded = "nothing-recorded" // no file was recorded
	ChangeUndoRequested   = "undo-requested"
	ChangeUndone          = "undone"
)

// ErrNotCapturing means the session has no tweak capturing.
var ErrNotCapturing = errors.New("this session isn't capturing")

// ErrCapturedElsewhere refuses tweak work on a tweak whose previous
// session's capture of it is still ending.
var ErrCapturedElsewhere = errors.New("its previous session's capture is still ending")

// ErrStillCapturing refuses to start a capture while the session's capture
// of another tweak hasn't been ended with it (Work's end).
var ErrStillCapturing = errors.New("this session is still capturing another tweak")

// Change is what a tweak changed, as its card lists it. Files are the
// recorded files, oldest first; Unrecorded are the files that changed while
// Claude worked without being recorded: the git check's finds, and files
// the hook saw that are binary or over 2 MB. Checked says the git check
// ran when capture last ended, so an empty change means no files changed.
// While undo-requested, Conflicts is how many files couldn't be reversed
// around later edits, and Waiting says no claim covers the tweak's page, so
// no session has been asked yet.
type Change struct {
	State      string       `json:"state"`
	Capturing  bool         `json:"capturing"`
	Checked    bool         `json:"checked"`
	Files      []ChangeFile `json:"files"`
	Unrecorded []ChangeFile `json:"unrecorded"`
	Conflicts  int          `json:"conflicts,omitempty"`
	Waiting    bool         `json:"waiting,omitempty"`
}

// ChangeFile is one file of a change: its absolute path, how the card shows
// it, and whether it's outside the session's project.
type ChangeFile struct {
	Path    string `json:"path"`
	Shown   string `json:"shown"`
	Outside bool   `json:"outside"`
}

// Before is a file's before copy, as the edit hook's POST /edits/before
// reads it: absent (the edit creates it), text (Data), or unrecordable.
type Before struct {
	ChangeFile
	Absent bool
	Text   bool
	Data   []byte
	Base   string // the git snapshot of the round it was recorded in ("" for none)
}

// Unchanged says a recorded file's after contents match its before copy
// (an edit denied after the hook ran): capture end drops it.
func (b Before) Unchanged(a After) bool {
	return b.Text && (a.Text || a.Absent) && a.Absent == b.Absent && bytes.Equal(a.Data, b.Data)
}

// Capture is a session's capturing change, as ending it needs it: the
// recorded files with their before copies, the unrecorded files found so
// far, and the git check's working tree from tweak work.
type Capture struct {
	Tweak      int64
	Folder     string
	Repo, Base string // the git check's repo and tree; "" outside a repo
	Files      []Before
	Unrecorded []ChangeFile
}

// After is a recorded file's contents when capture ends.
type After struct {
	Path   string
	Absent bool
	Text   bool
	Data   []byte
}

// CaptureEnd is how a capture ends: each recorded file's after contents
// (Capture.Files, in any order), and the unrecorded files, already without
// the recorded ones. Checked says the git check ran.
type CaptureEnd struct {
	Tweak      int64
	Files      []After
	Unrecorded []ChangeFile
	Checked    bool
}

// CaptureStart is where a capture starts: the session's folder, and the git
// check's repo and working tree ("" outside a repo).
type CaptureStart struct {
	Folder, Repo, Base string
}

// Work is tweak work: it moves tweak number to working for the session and
// makes it the session's capturing tweak, all in one transaction. If the
// session is capturing another tweak, end must end that capture, or nothing
// changes (ErrStillCapturing): a new tweak's edits can never land in the
// old tweak's change. Working on the tweak already capturing keeps its
// capture as it is. A tweak keeps its one change across rounds: the first
// before copies stay.
func (s *Store) Work(sessionID string, number int64, end *CaptureEnd, start CaptureStart) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := ownTweak(tx, sessionID, number)
	if err != nil {
		return Tweak{}, err
	}
	if !canMove(tw.Status, StatusWorking) {
		return Tweak{}, &TransitionError{Number: number, From: tw.Status, To: StatusWorking}
	}
	// A tweak handed over from a session whose capture of it hasn't ended
	// yet (a lapse or release still reading its after contents): that round's
	// baseline must judge that round's edits first.
	var elsewhere int
	if err := tx.QueryRow(`SELECT count(*) FROM changes WHERE tweak = ? AND capturing IS NOT NULL AND capturing != ?`, number, sessionID).Scan(&elsewhere); err != nil {
		return Tweak{}, err
	}
	if elsewhere > 0 {
		return Tweak{}, ErrCapturedElsewhere
	}
	c, _, err := capturingIn(tx, sessionID)
	capturing := err == nil
	if err != nil && !errors.Is(err, ErrNotCapturing) {
		return Tweak{}, err
	}
	switch {
	case capturing && c.Tweak == number:
		end = nil // carrying on: the capture stays as it is
	case capturing && end == nil:
		return Tweak{}, ErrStillCapturing
	case end != nil:
		if err := tx.endCapture(sessionID, *end); err != nil {
			return Tweak{}, err
		}
		ended, err := getTweak(tx, end.Tweak)
		if err != nil {
			return Tweak{}, err
		}
		if err := tx.logTweak(EventTweakStatus, ended); err != nil {
			return Tweak{}, err
		}
	}
	if !capturing || c.Tweak != number {
		if _, err := tx.Exec(`INSERT INTO changes (tweak, state, capturing, folder, repo, base_tree) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (tweak) DO UPDATE SET capturing = excluded.capturing, folder = excluded.folder, repo = excluded.repo, base_tree = excluded.base_tree`,
			number, ChangeNothingRecorded, sessionID, start.Folder, start.Repo, start.Base); err != nil {
			return Tweak{}, err
		}
	}
	if tw.Status != StatusWorking {
		if tw, err = tx.change(number, StatusWorking, nil, EventTweakStatus); err != nil {
			return Tweak{}, err
		}
	} else if tw, err = getTweak(tx, number); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// Capturing is the session's capturing change, or ErrNotCapturing.
func (s *Store) Capturing(sessionID string) (Capture, error) {
	tx, err := s.begin()
	if err != nil {
		return Capture{}, err
	}
	defer tx.Rollback()
	c, _, err := capturingIn(tx, sessionID)
	return c, err
}

// CapturingSessions lists the sessions capturing now, for the markers.
func (s *Store) CapturingSessions() ([]string, error) {
	rows, err := s.db.Query(`SELECT capturing FROM changes WHERE capturing IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func capturingIn(tx *eventTx, sessionID string) (Capture, int64, error) {
	var c Capture
	var id int64
	var unrecorded string
	err := tx.QueryRow(`SELECT id, tweak, folder, repo, base_tree, unrecorded_files FROM changes WHERE capturing = ?`, sessionID).
		Scan(&id, &c.Tweak, &c.Folder, &c.Repo, &c.Base, &unrecorded)
	if errors.Is(err, sql.ErrNoRows) {
		return c, 0, ErrNotCapturing
	}
	if err != nil {
		return c, 0, err
	}
	json.Unmarshal([]byte(unrecorded), &c.Unrecorded)
	rows, err := tx.Query(`SELECT path, shown, outside, recordable, before, base_tree FROM change_files WHERE change = ? ORDER BY id`, id)
	if err != nil {
		return c, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var b Before
		var before []byte
		if err := rows.Scan(&b.Path, &b.Shown, &b.Outside, &b.Text, &before, &b.Base); err != nil {
			return c, 0, err
		}
		b.Absent = b.Text && before == nil
		b.Data = before
		c.Files = append(c.Files, b)
	}
	return c, id, rows.Err()
}

// Recorded is what RecordBefore did.
type Recorded struct {
	Saved bool       // a before copy was saved: the file's first touch
	First *FirstEdit // the tweak's first edit, or nil
}

// FirstEdit is a tweak's first before copy, timed from its delivery: the
// open measurement in docs/design.md.
type FirstEdit struct {
	Tweak     int64
	Delivered bool          // whether its delivery was recorded
	After     time.Duration // since its delivery, when it was
}

// RecordBefore saves a file's before copy in the session's capturing change,
// the first time the file is touched only, and stamps the tweak's first
// edit. It is ErrNotCapturing when the session isn't capturing.
func (s *Store) RecordBefore(sessionID string, b Before) (Recorded, error) {
	tx, err := s.begin()
	if err != nil {
		return Recorded{}, err
	}
	defer tx.Rollback()
	var change, tweak int64
	var base string
	err = tx.QueryRow(`SELECT id, tweak, base_tree FROM changes WHERE capturing = ?`, sessionID).Scan(&change, &tweak, &base)
	if errors.Is(err, sql.ErrNoRows) {
		return Recorded{}, ErrNotCapturing
	}
	if err != nil {
		return Recorded{}, err
	}
	before := any(nil) // absent, or unrecordable
	if b.Text && !b.Absent {
		before = orNone(b.Data)
	}
	r, err := tx.Exec(`INSERT INTO change_files (change, path, shown, outside, recordable, before, base_tree) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (change, path) DO NOTHING`, change, b.Path, b.Shown, b.Outside, b.Text || b.Absent, before, base)
	if err != nil {
		return Recorded{}, err
	}
	var out Recorded
	if n, _ := r.RowsAffected(); n == 1 {
		out.Saved = true
		at := s.now()
		var delivered sql.NullInt64
		err := tx.QueryRow(`UPDATE tweaks SET first_edit_at = ? WHERE number = ? AND first_edit_at IS NULL RETURNING delivered_at`, at, tweak).Scan(&delivered)
		switch {
		case err == nil:
			out.First = &FirstEdit{Tweak: tweak, Delivered: delivered.Valid}
			if delivered.Valid {
				out.First.After = time.Duration(at-delivered.Int64) * time.Millisecond
			}
		case !errors.Is(err, sql.ErrNoRows):
			return Recorded{}, err
		}
	}
	return out, tx.commit()
}

// orNone keeps an empty file's contents as an empty blob, not NULL (absent).
func orNone(data []byte) []byte {
	if data == nil {
		return []byte{}
	}
	return data
}

// EndCapture ends the session's capture with end, logging its tweak with
// the change as it now is. It's ErrNotCapturing when the session isn't
// capturing end.Tweak.
func (s *Store) EndCapture(sessionID string, end CaptureEnd) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	if err := tx.endCapture(sessionID, end); err != nil {
		return Tweak{}, err
	}
	tw, err := getTweak(tx, end.Tweak)
	if err != nil {
		return Tweak{}, err
	}
	if err := tx.logTweak(EventTweakStatus, tw); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// endCapture applies end: a file whose after matches its before (an edit
// denied after the hook ran) is dropped; one that's now binary or over
// 2 MB becomes unrecorded. The change is recorded if any file is left.
func (t *eventTx) endCapture(sessionID string, end CaptureEnd) error {
	c, id, err := capturingIn(t, sessionID)
	if err != nil {
		return err
	}
	if c.Tweak != end.Tweak {
		return ErrNotCapturing
	}
	before := map[string]Before{}
	for _, f := range c.Files {
		before[f.Path] = f
	}
	for _, a := range end.Files {
		b, ok := before[a.Path]
		switch {
		case !ok || !b.Text:
		case !a.Text && !a.Absent:
			_, err = t.Exec(`UPDATE change_files SET recordable = 0, before = NULL, after = NULL WHERE change = ? AND path = ?`, id, a.Path)
		case b.Unchanged(a):
			_, err = t.Exec(`DELETE FROM change_files WHERE change = ? AND path = ?`, id, a.Path)
		default:
			after := any(nil)
			if !a.Absent {
				after = orNone(a.Data)
			}
			_, err = t.Exec(`UPDATE change_files SET after = ? WHERE change = ? AND path = ?`, after, id, a.Path)
		}
		if err != nil {
			return err
		}
	}
	unrecorded, _ := json.Marshal(orNoFiles(end.Unrecorded))
	_, err = t.Exec(`UPDATE changes SET capturing = NULL, checked = ?, unrecorded_files = ?,
		state = CASE WHEN EXISTS (SELECT 1 FROM change_files WHERE change = ? AND recordable = 1) THEN ? ELSE ? END
		WHERE id = ?`, end.Checked, string(unrecorded), id, ChangeRecorded, ChangeNothingRecorded, id)
	return err
}

func orNoFiles(f []ChangeFile) []ChangeFile {
	if f == nil {
		return []ChangeFile{}
	}
	return f
}

// changeOf is a tweak's change as its card lists it, or nil if capture
// never started for it.
func changeOf(q queryRower, number int64) (*Change, error) {
	var c Change
	var id int64
	var capturing sql.NullString
	var unrecorded string
	var unclaimed bool
	err := q.QueryRow(`SELECT c.id, c.state, c.capturing, c.checked, c.unrecorded_files, c.conflicts, t.session IS NULL
		FROM changes c JOIN tweaks t ON t.number = c.tweak WHERE c.tweak = ?`, number).
		Scan(&id, &c.State, &capturing, &c.Checked, &unrecorded, &c.Conflicts, &unclaimed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.Capturing = capturing.Valid
	c.Waiting = unclaimed && c.State == ChangeUndoRequested
	json.Unmarshal([]byte(unrecorded), &c.Unrecorded)
	rows, err := q.Query(`SELECT path, shown, outside, recordable FROM change_files WHERE change = ? ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var f ChangeFile
		var recordable bool
		if err := rows.Scan(&f.Path, &f.Shown, &f.Outside, &recordable); err != nil {
			return nil, err
		}
		if recordable {
			c.Files = append(c.Files, f)
		} else if !c.lists(f.Path) {
			c.Unrecorded = append(c.Unrecorded, f)
		}
	}
	return &c, rows.Err()
}

func (c *Change) lists(path string) bool {
	for _, u := range c.Unrecorded {
		if u.Path == path {
			return true
		}
	}
	return false
}
