package store

import "database/sql"

// The inbox: the events waiting for a session (its new tweaks, its released
// claims), read from the event log after the session's cursor. Delivery is at
// least once: asking for what comes after a sequence acknowledges everything
// up to it, so a line handed out but never acknowledged (the watcher died) is
// handed out again. This is the first stage of "No lost tweaks": a line
// acknowledged is printed, and a tweak printed is delivered. The second
// stage, Claude confirming it, is in again.go.

// Inbox is one read of a session's inbox.
type Inbox struct {
	Events []Event // the session's events after the cursor, in order
	Seq    int64   // the cursor to ask after next: the end of the log as read
	Claims int     // how many claims the session holds now
}

// inboxWhere picks the events a session's watcher hears about: its new
// tweaks and those handed to it, the replies to its questions, the tweaks
// sent again, undo conflicts, the tweaks withdrawn from it, its claims
// released, restored or lost, and the extension connecting. A tweak's lines
// are only for the session it is for now: one that passed to another session
// is no longer this one's. A withdrawn tweak's new, reply and again: lines
// still waiting are left out: its withdrawn line (or nothing, for one that
// never reached Claude) replaces them.
const inboxWhere = `json_extract(payload, '$.session') = ? AND type IN ('tweak-created', 'tweak-handed', 'tweak-replied', 'tweak-again', 'tweak-undo-conflict', 'tweak-withdrawn', 'claim-released', 'claim-restored', 'claim-lost', 'extension-connected')
	AND (tweak IS NULL OR tweak IN (SELECT number FROM tweaks WHERE session = ?))
	AND NOT (type IN ('tweak-created', 'tweak-handed', 'tweak-replied', 'tweak-again') AND tweak IN (SELECT number FROM tweaks WHERE status = 'withdrawn'))`

// Inbox acknowledges the session's events up to after, then returns those
// after it. after < 0 means "where the last watcher left off" and
// acknowledges nothing. Acknowledging a new tweak marks it delivered.
func (s *Store) Inbox(sessionID string, after int64) (Inbox, error) {
	tx, err := s.begin()
	if err != nil {
		return Inbox{}, err
	}
	defer tx.Rollback()

	var in Inbox
	if err := tx.QueryRow(`SELECT ` + lastSeq).Scan(&in.Seq); err != nil {
		return Inbox{}, err
	}
	var acked int64
	if err := tx.QueryRow(`SELECT last_ack FROM deliveries WHERE session = ?`, sessionID).Scan(&acked); err != nil {
		return Inbox{}, ErrNoSession
	}
	cursor := acked
	if after >= 0 {
		cursor = min(after, in.Seq)
		if cursor > acked {
			if err := tx.deliver(sessionID, acked, cursor); err != nil {
				return Inbox{}, err
			}
		}
	}

	where := inboxWhere
	if after < 0 {
		// A fresh watcher gets the tweaks waiting, not releases from before
		// it started: "claim released" would tell it to stop.
		where += ` AND type != 'claim-released'`
	}
	rows, err := tx.Query(`SELECT seq, type, payload, at FROM events WHERE seq > ? AND seq <= ? AND `+where+` ORDER BY seq`,
		cursor, in.Seq, sessionID, sessionID)
	if err != nil {
		return Inbox{}, err
	}
	for rows.Next() {
		var e Event
		var payload string
		var at int64
		if err := rows.Scan(&e.Seq, &e.Type, &payload, &at); err != nil {
			rows.Close()
			return Inbox{}, err
		}
		if err := decodeEvent(&e, payload); err != nil {
			rows.Close()
			return Inbox{}, err
		}
		e.At = fromMillis(at)
		in.Events = append(in.Events, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Inbox{}, err
	}
	if err := tx.QueryRow(`SELECT count(*) FROM claims WHERE session = ?`, sessionID).Scan(&in.Claims); err != nil {
		return Inbox{}, err
	}
	return in, tx.commit()
}

// deliver moves the session's cursor from acked to upto. The new tweaks and
// replies acknowledged in between become delivered if they are still sent
// to it, and start their wait for Claude to confirm them; a delivered
// tweak's again: line acknowledged starts its next wait.
func (t *eventTx) deliver(sessionID string, acked, upto int64) error {
	if _, err := t.Exec(`UPDATE deliveries SET last_ack = ? WHERE session = ?`, upto, sessionID); err != nil {
		return err
	}
	at := t.s.now()
	// A tweak sent again after upto (a reply since) waits for that line's ack.
	sent, err := t.acknowledged(`'tweak-created', 'tweak-handed', 'tweak-replied'`, sessionID, acked, upto)
	if err != nil {
		return err
	}
	err = t.updateLogging(sent, func(n int64) (sql.Result, error) {
		return t.Exec(`UPDATE tweaks SET status = ?, status_at = ?, updated = ?, resends = 0, wait_from = ?
			WHERE number = ? AND session = ? AND status = ?`, StatusDelivered, at, at, at, n, sessionID, StatusSent)
	})
	if err != nil {
		return err
	}
	// The first line acknowledged for a tweak is its delivery, which its
	// first edit is timed from, whatever its status is by now.
	for _, n := range sent {
		if _, err := t.Exec(`UPDATE tweaks SET delivered_at = ? WHERE number = ? AND delivered_at IS NULL`, at, n); err != nil {
			return err
		}
	}
	again, err := t.acknowledged(`'tweak-again'`, sessionID, acked, upto)
	if err != nil {
		return err
	}
	return t.updateLogging(again, func(n int64) (sql.Result, error) {
		return t.Exec(`UPDATE tweaks SET wait_from = ?, updated = ?
			WHERE number = ? AND session = ? AND status = ? AND wait_from IS NULL`, at, at, n, sessionID, StatusDelivered)
	})
}

// acknowledged lists the tweaks with a line of one of types for the session
// in (acked, upto], leaving out any with a later such line still to come.
func (t *eventTx) acknowledged(types, sessionID string, acked, upto int64) ([]int64, error) {
	rows, err := t.Query(`SELECT DISTINCT tweak FROM events e WHERE seq > ? AND seq <= ? AND type IN (`+types+`)
		AND json_extract(payload, '$.session') = ?
		AND NOT EXISTS (SELECT 1 FROM events l WHERE l.tweak = e.tweak AND l.seq > ? AND l.type IN (`+types+`))`,
		acked, upto, sessionID, upto)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var numbers []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		numbers = append(numbers, n)
	}
	return numbers, rows.Err()
}

// updateLogging runs update on each tweak, and logs tweak-status for each
// one it changed.
func (t *eventTx) updateLogging(numbers []int64, update func(int64) (sql.Result, error)) error {
	for _, n := range numbers {
		r, err := update(n)
		if err != nil {
			return err
		}
		if changed, _ := r.RowsAffected(); changed == 0 {
			continue
		}
		tw, err := getTweak(t, n)
		if err != nil {
			return err
		}
		if err := t.logTweak(EventTweakStatus, tw); err != nil {
			return err
		}
	}
	return nil
}
