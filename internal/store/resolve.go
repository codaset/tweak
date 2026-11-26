package store

import (
	"errors"
	"time"
)

// The developer finishing with a tweak (docs/design.md, "When the session
// goes quiet" and "Storage"): Withdraw takes back an open one, Resolve
// clears a finished one away; either way it's resolved and its pin leaves
// the page. Resolved tweaks are kept, with their changes, for Undo, until
// the bridge deletes them.

// Refusals of Withdraw and Resolve, as the card shows them.
var (
	ErrFinished  = errors.New("Claude has finished this tweak, so there's nothing to withdraw: resolve it instead")
	ErrStillOpen = errors.New("Claude hasn't finished this tweak yet: withdraw it instead")
)

// finishing are Claude's last words on a tweak: after a withdraw they end
// its capture and keep the change, and change no status.
var finishing = map[string]bool{StatusDone: true, StatusQuestion: true, StatusDeclined: true}

// Withdraw is the card's Withdraw: the developer takes back an open tweak
// before Claude finishes. It becomes withdrawn and resolved. One that
// reached its session (anything but sent, or sent again after a reply) is
// logged as tweak-withdrawn, its inbox's withdrawn line; a sent one is
// simply resolved. Capture isn't ended here: Claude may have edits under
// way, which its next command ends and keeps.
func (s *Store) Withdraw(number int64) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := getTweak(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if _, open := allowed[tw.Status]; !open || !tw.ResolvedAt.IsZero() {
		return Tweak{}, ErrFinished
	}
	event := EventTweakWithdrawn
	if tw.Status == StatusSent && tw.Change == nil {
		event = EventTweakResolved // it never reached Claude
	}
	if err := tx.resolve(number); err != nil {
		return Tweak{}, err
	}
	if tw, err = tx.change(number, StatusWithdrawn, nil, event); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// Resolve is the card's Resolve: the developer is finished with a done or
// declined tweak. Its status and change stay. Resolving one already
// resolved changes nothing.
func (s *Store) Resolve(number int64) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := getTweak(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if !tw.ResolvedAt.IsZero() {
		return tw, nil
	}
	if tw.Status != StatusDone && tw.Status != StatusDeclined {
		return Tweak{}, ErrStillOpen
	}
	if err := tx.resolve(number); err != nil {
		return Tweak{}, err
	}
	if tw, err = tx.change(number, tw.Status, nil, EventTweakResolved); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// lastSeq is the event log's end: the last sequence handed out, which
// stays even when the bridge deletes the event that had it (AUTOINCREMENT
// keeps it in sqlite_sequence), so a client's cursor never runs past it.
const lastSeq = `coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)`

func (t *eventTx) resolve(number int64) error {
	_, err := t.Exec(`UPDATE tweaks SET resolved_at = ? WHERE number = ?`, t.s.now(), number)
	return err
}

// endWithdrawn ends the session's capture of a withdrawn tweak with end,
// keeping the change, and logs the tweak with it.
func (t *eventTx) endWithdrawn(sessionID string, end CaptureEnd) (Tweak, error) {
	if err := t.endCapture(sessionID, end); err != nil {
		return Tweak{}, err
	}
	return t.change(end.Tweak, StatusWithdrawn, nil, EventTweakStatus)
}

// DeleteResolved deletes the tweaks resolved at least keep ago, with their
// conversations, changes and event-log entries, and returns their numbers
// (their screenshots are the bridge's to delete). A tweak whose change is
// still capturing (withdrawn while Claude worked) waits for the capture to
// end. Numbers are never reused.
func (s *Store) DeleteResolved(keep time.Duration) ([]int64, error) {
	tx, err := s.begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT number FROM tweaks t WHERE resolved_at IS NOT NULL AND resolved_at <= ?
		AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.tweak = t.number AND c.capturing IS NOT NULL) ORDER BY number`,
		s.now()-keep.Milliseconds())
	if err != nil {
		return nil, err
	}
	var gone []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return nil, err
		}
		gone = append(gone, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, n := range gone {
		for _, q := range []string{
			`DELETE FROM change_files WHERE change IN (SELECT id FROM changes WHERE tweak = ?)`,
			`DELETE FROM changes WHERE tweak = ?`,
			`DELETE FROM entries WHERE tweak = ?`,
			`DELETE FROM events WHERE tweak = ?`, // the log's end is lastSeq, so this may be its last

			`DELETE FROM tweaks WHERE number = ?`,
		} {
			if _, err := tx.Exec(q, n); err != nil {
				return nil, err
			}
		}
	}
	return gone, tx.commit()
}
