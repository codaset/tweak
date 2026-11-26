package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/codaset/tweak/internal/pattern"
)

// Session is one agent conversation that can claim pages.
type Session struct {
	ID          string
	Agent       string
	Folder      string
	Label       string
	LastCheckIn time.Time
}

// Claim is a session's ownership of the pages matching Pattern.
type Claim struct {
	ID      int64
	Pattern string // normalised
	Session Session
	Created time.Time
	// LostTo is, for a lapsed claim that can't come back, the folder of the
	// session that has since claimed an overlapping pattern.
	LostTo string
	// LapsedAt is when a lapsed claim lapsed, moved on by any downtime since.
	LapsedAt time.Time
}

// OverlapError refuses a claim that overlaps another session's.
type OverlapError struct {
	Pattern string // the pattern asked for
	Holder  Claim
	Shown   string // the holder's folder as lines show it, from ~
}

func (e *OverlapError) Error() string {
	return fmt.Sprintf("%s overlaps %s, claimed by the session in %s (%s)",
		e.Pattern, e.Holder.Pattern, e.Shown, e.Holder.Session.ID)
}

// RegisterSession records a session, or updates its agent and folder, and
// checks it in. A new session's inbox starts at the end of the event log.
func (s *Store) RegisterSession(se Session) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO sessions (id, agent, folder, label, last_check_in) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET agent = excluded.agent, folder = excluded.folder,
			label = excluded.label, last_check_in = excluded.last_check_in`,
		se.ID, se.Agent, se.Folder, se.Label, s.now()); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO deliveries (session, last_ack)
		VALUES (?, (SELECT coalesce(max(seq), 0) FROM events))`, se.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// Session returns a registered session, or ErrNoSession.
func (s *Store) Session(id string) (Session, error) {
	var se Session
	var at int64
	err := s.db.QueryRow(`SELECT id, agent, folder, label, last_check_in FROM sessions WHERE id = ?`, id).
		Scan(&se.ID, &se.Agent, &se.Folder, &se.Label, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return se, ErrNoSession
	}
	se.LastCheckIn = fromMillis(at)
	return se, err
}

// CheckIn records that a session was heard from. It reports false for a
// session that isn't registered.
func (s *Store) CheckIn(id string) (bool, error) {
	r, err := s.db.Exec(`UPDATE sessions SET last_check_in = ? WHERE id = ?`, s.now(), id)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n > 0, err
}

// CheckInAll sets every session's last check-in to now. The bridge runs it on
// start, so time it was down doesn't count toward a lapse.
func (s *Store) CheckInAll() error {
	_, err := s.db.Exec(`UPDATE sessions SET last_check_in = ?`, s.now())
	return err
}

// Claim gives the session the pages matching p, unless any claim overlaps it,
// the session's own included (an *OverlapError naming it): every page has
// exactly one claim. Claiming the same pattern again returns the existing
// claim, as after /reload-plugins. The check and the insert are one
// transaction, so two sessions can't both win.
func (s *Store) Claim(sessionID string, p pattern.Pattern) (Claim, error) {
	tx, err := s.begin()
	if err != nil {
		return Claim{}, err
	}
	defer tx.Rollback()

	claims, err := listClaims(tx)
	if err != nil {
		return Claim{}, err
	}
	want := p.String()
	for _, c := range claims {
		if c.Session.ID == sessionID && c.Pattern == want {
			return c, nil
		}
	}
	for _, c := range claims {
		held, err := pattern.Parse(c.Pattern)
		if err != nil {
			return Claim{}, fmt.Errorf("stored claim %d: %w", c.ID, err)
		}
		if held.Overlaps(p) {
			return Claim{}, &OverlapError{Pattern: want, Holder: c, Shown: s.Shown(c.Session.Folder)}
		}
	}

	var se Session
	var at int64
	err = tx.QueryRow(`SELECT id, agent, folder, label, last_check_in FROM sessions WHERE id = ?`, sessionID).
		Scan(&se.ID, &se.Agent, &se.Folder, &se.Label, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return Claim{}, ErrNoSession
	} else if err != nil {
		return Claim{}, err
	}
	se.LastCheckIn = fromMillis(at)

	created := s.now()
	r, err := tx.Exec(`INSERT INTO claims (session, pattern, created) VALUES (?, ?, ?)`, sessionID, want, created)
	if err != nil {
		return Claim{}, err
	}
	id, _ := r.LastInsertId()
	c := Claim{ID: id, Pattern: want, Session: se, Created: fromMillis(created)}
	if err := tx.logClaim(EventClaimMade, c); err != nil {
		return Claim{}, err
	}
	if err := tx.passUndos(sessionID, p); err != nil {
		return Claim{}, err
	}
	// Tweaks follow the page: those waiting on p's pages come here, and a
	// lapsed claim p overlaps can no longer come back.
	if err := tx.loseLapsed(sessionID, se.Folder, p); err != nil {
		return Claim{}, err
	}
	if err := tx.passTweaks(sessionID, p); err != nil {
		return Claim{}, err
	}
	if err := tx.commit(); err != nil {
		return Claim{}, err
	}
	return c, nil
}

// Claims lists every claim, oldest first, with its session.
func (s *Store) Claims() ([]Claim, error) { return listClaims(s.db) }

// ClaimCount is the number of claims held.
func (s *Store) ClaimCount() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM claims`).Scan(&n)
	return n, err
}

// Release ends the session's claim on pattern (normalised), or all its claims
// when pattern is "". It returns the released patterns; releasing a pattern
// the session doesn't hold is ErrNotClaimed. Its open tweaks and held undos
// on those pages go back to waiting for a session.
func (s *Store) Release(sessionID, pat string) ([]string, error) {
	tx, err := s.begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	claims, err := listClaims(tx)
	if err != nil {
		return nil, err
	}
	var released []string
	for _, c := range claims {
		if c.Session.ID != sessionID || (pat != "" && c.Pattern != pat) {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM claims WHERE id = ?`, c.ID); err != nil {
			return nil, err
		}
		if err := tx.logClaim(EventClaimReleased, c); err != nil {
			return nil, err
		}
		released = append(released, c.Pattern)
	}
	if pat != "" && len(released) == 0 {
		return nil, ErrNotClaimed
	}
	if err := tx.letGo(sessionID, WhyReleased); err != nil {
		return nil, err
	}
	return released, tx.commit()
}

type querier interface {
	Query(string, ...any) (*sql.Rows, error)
}

func listClaims(q querier) ([]Claim, error) {
	rows, err := q.Query(`SELECT c.id, c.pattern, c.created, s.id, s.agent, s.folder, s.label, s.last_check_in
		FROM claims c JOIN sessions s ON s.id = c.session ORDER BY c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Claim
	for rows.Next() {
		var c Claim
		var created, at int64
		if err := rows.Scan(&c.ID, &c.Pattern, &created, &c.Session.ID, &c.Session.Agent,
			&c.Session.Folder, &c.Session.Label, &at); err != nil {
			return nil, err
		}
		c.Created, c.Session.LastCheckIn = fromMillis(created), fromMillis(at)
		out = append(out, c)
	}
	return out, rows.Err()
}
