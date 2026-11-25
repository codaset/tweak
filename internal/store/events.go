package store

import (
	"database/sql"
	"encoding/json"
	"time"
)

// Event types in the event log.
const (
	EventClaimMade     = "claim-made"
	EventClaimReleased = "claim-released"
)

// Event is one entry in the append-only event log. Seq is monotonic.
type Event struct {
	Seq   int64
	Type  string
	Claim Claim // the claim as it was when the event happened
	At    time.Time
}

// claimRecord is a claim as stored in an event's payload, so a released
// claim can still be described after its row is gone.
type claimRecord struct {
	ID          int64  `json:"id"`
	Pattern     string `json:"pattern"`
	Created     int64  `json:"created"`
	Session     string `json:"session"`
	Agent       string `json:"agent"`
	Folder      string `json:"folder"`
	Label       string `json:"label"`
	LastCheckIn int64  `json:"lastCheckIn"`
}

type execer interface {
	Exec(string, ...any) (sql.Result, error)
}

func logClaimEvent(x execer, typ string, c Claim) error {
	payload, _ := json.Marshal(claimRecord{
		ID: c.ID, Pattern: c.Pattern, Created: c.Created.UnixMilli(),
		Session: c.Session.ID, Agent: c.Session.Agent, Folder: c.Session.Folder,
		Label: c.Session.Label, LastCheckIn: c.Session.LastCheckIn.UnixMilli(),
	})
	_, err := x.Exec(`INSERT INTO events (type, claim, payload, at) VALUES (?, ?, ?, ?)`, typ, c.ID, string(payload), now())
	return err
}

// Snapshot returns the current claims and the sequence of the last event
// they include, read together so events after seq are exactly what changed
// since.
func (s *Store) Snapshot() (seq int64, claims []Claim, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	if err := tx.QueryRow(`SELECT coalesce(max(seq), 0) FROM events`).Scan(&seq); err != nil {
		return 0, nil, err
	}
	if claims, err = listClaims(tx); err != nil {
		return 0, nil, err
	}
	return seq, claims, tx.Commit()
}

// EventsAfter returns the logged events with a sequence above seq, in order.
func (s *Store) EventsAfter(seq int64) ([]Event, error) {
	rows, err := s.db.Query(`SELECT seq, type, payload, at FROM events WHERE seq > ? ORDER BY seq`, seq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var payload string
		var at int64
		if err := rows.Scan(&e.Seq, &e.Type, &payload, &at); err != nil {
			return nil, err
		}
		var r claimRecord
		if err := json.Unmarshal([]byte(payload), &r); err != nil {
			return nil, err
		}
		e.At = fromMillis(at)
		e.Claim = Claim{ID: r.ID, Pattern: r.Pattern, Created: fromMillis(r.Created), Session: Session{
			ID: r.Session, Agent: r.Agent, Folder: r.Folder, Label: r.Label, LastCheckIn: fromMillis(r.LastCheckIn),
		}}
		out = append(out, e)
	}
	return out, rows.Err()
}
