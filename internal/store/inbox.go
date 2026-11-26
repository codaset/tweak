package store

// The inbox: the events waiting for a session (its new tweaks, its released
// claims), read from the event log after the session's cursor. Delivery is at
// least once: asking for what comes after a sequence acknowledges everything
// up to it, so a line handed out but never acknowledged (the watcher died) is
// handed out again. The two-stage acknowledgement of "No lost tweaks" builds
// on this cursor.

// Inbox is one read of a session's inbox.
type Inbox struct {
	Events []Event // the session's events after the cursor, in order
	Seq    int64   // the cursor to ask after next: the end of the log as read
	Claims int     // how many claims the session holds now
}

// inboxEvents are the event types a session's watcher hears about.
const inboxWhere = `json_extract(payload, '$.session') = ? AND type IN ('tweak-created', 'claim-released')`

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
	if err := tx.QueryRow(`SELECT coalesce(max(seq), 0) FROM events`).Scan(&in.Seq); err != nil {
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
		cursor, in.Seq, sessionID)
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

// deliver moves the session's cursor from acked to upto, marking the new
// tweaks acknowledged in between delivered if they are still sent to it.
func (t *eventTx) deliver(sessionID string, acked, upto int64) error {
	if _, err := t.Exec(`UPDATE deliveries SET last_ack = ? WHERE session = ?`, upto, sessionID); err != nil {
		return err
	}
	rows, err := t.Query(`SELECT tweak FROM events WHERE seq > ? AND seq <= ? AND type = 'tweak-created' AND json_extract(payload, '$.session') = ?`,
		acked, upto, sessionID)
	if err != nil {
		return err
	}
	var numbers []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		numbers = append(numbers, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, n := range numbers {
		at := now()
		r, err := t.Exec(`UPDATE tweaks SET status = ?, status_at = ?, updated = ? WHERE number = ? AND session = ? AND status = ?`,
			StatusDelivered, at, at, n, sessionID, StatusSent)
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
