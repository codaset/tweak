package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/codaset/tweak/internal/pattern"
)

// Claims when sessions end, lapse or come back (docs/design.md, "Claims"
// and "When the session goes quiet").
//
// Tweaks follow the page, not the session: when a session lets go of a
// claim (released, lapsed or ended), its open tweaks on those pages go back
// to sent with no session (dropTweaks), and the next session to claim the
// page gets each as new (passTweaks), the whole conversation with it.
//
// A lapsed claim (no check-in for 10 minutes) is kept for 24 hours and
// comes back at its session's next check-in (Return), with its tweaks as
// they were, unless another session has since claimed an overlapping
// pattern: then the claim is lost, and the session is told so.

// How a session let go of a tweak's page.
const (
	WhyLapsed   = "lapsed"
	WhyReleased = "released"
	WhyEnded    = "ended"
)

// What a session's last inbox line for a tweak was (Tweak.Line).
const (
	LineNew   = "new"
	LineReply = "reply"
)

// openStatuses are the statuses of a tweak that is still with its session:
// these follow the page.
const openStatuses = `'sent', 'delivered', 'queued', 'working', 'question'`

// LostError refuses a status command on a tweak of a claim the session lost.
type LostError struct{ Claim Claim }

func (e *LostError) Error() string { return e.Claim.LostLine() }

// LostLine says a lapsed claim was lost, and to whom.
func (c Claim) LostLine() string {
	return fmt.Sprintf("claim lost: %s is now claimed by the session in %s", c.Pattern, c.LostTo)
}

// Returned is what a session's check-in brought back: the lapsed claims
// restored, the lost ones it hadn't been told of yet, and the tweak whose
// capture started again (0 for none).
type Returned struct {
	Restored  []Claim
	Lost      []Claim
	Capturing int64
}

// dropTweaks sends the session's open tweaks that claims (every claim
// left, after the change) no longer give it back to sent, with no session,
// remembering why and how they were.
func (t *eventTx) dropTweaks(session, why string, claims []Claim) error {
	rows, err := t.Query(`SELECT t.number, t.page_url, coalesce(c.capturing = t.session, 0) FROM tweaks t
		LEFT JOIN changes c ON c.tweak = t.number
		WHERE t.session = ? AND t.resolved_at IS NULL AND t.status IN (`+openStatuses+`) ORDER BY t.number`, session)
	if err != nil {
		return err
	}
	type held struct {
		number    int64
		url       string
		capturing bool
	}
	var all []held
	for rows.Next() {
		var h held
		if err := rows.Scan(&h.number, &h.url, &h.capturing); err != nil {
			rows.Close()
			return err
		}
		all = append(all, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, h := range all {
		if covers(claims, session, h.url) {
			continue
		}
		if _, err := t.Exec(`UPDATE tweaks SET left_by = session, left_why = ?, left_status = status, left_status_at = status_at,
			left_capturing = ?, session = NULL, resends = 0, wait_from = NULL WHERE number = ?`, why, h.capturing, h.number); err != nil {
			return err
		}
		if _, err := t.change(h.number, StatusSent, nil, EventTweakStatus); err != nil {
			return err
		}
	}
	return nil
}

// covers says whether one of session's claims covers url.
func covers(claims []Claim, session, url string) bool {
	for _, c := range claims {
		if p, err := pattern.Parse(c.Pattern); err == nil && c.Session.ID == session && p.Match(url) {
			return true
		}
	}
	return false
}

// passTweaks gives the tweaks waiting for a session on p's pages to
// session, which claimed p: each is logged as tweak-handed, a new line in
// its inbox. A working tweak handed to another session gets a notice
// naming the files already changed.
func (t *eventTx) passTweaks(session string, p pattern.Pattern) error {
	rows, err := t.Query(`SELECT number, page_url, coalesce(left_by, ''), coalesce(left_why, ''), coalesce(left_status, '') FROM tweaks
		WHERE session IS NULL AND resolved_at IS NULL AND status = ? ORDER BY number`, StatusSent)
	if err != nil {
		return err
	}
	type waiting struct {
		number               int64
		url, by, why, wasNow string
	}
	var all []waiting
	for rows.Next() {
		var w waiting
		if err := rows.Scan(&w.number, &w.url, &w.by, &w.why, &w.wasNow); err != nil {
			rows.Close()
			return err
		}
		all = append(all, w)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, w := range all {
		if !p.Match(w.url) {
			continue
		}
		if _, err := t.Exec(`UPDATE tweaks SET session = ?, line = ?, left_by = NULL, left_why = NULL, left_status = NULL,
			left_status_at = NULL, left_capturing = 0 WHERE number = ?`, session, LineNew, w.number); err != nil {
			return err
		}
		var notice *Entry
		if w.wasNow == StatusWorking && w.by != "" && w.by != session {
			text, err := t.notice(w.number, w.by, w.why)
			if err != nil {
				return err
			}
			notice = &Entry{From: FromBridge, Kind: KindNotice, Text: text}
		}
		if _, err := t.change(w.number, StatusSent, notice, EventTweakHanded); err != nil {
			return err
		}
	}
	return nil
}

// notice is the conversation's note on a working tweak passing to another
// session: who stopped and why, and the files its change already holds.
func (t *eventTx) notice(number int64, by, why string) (string, error) {
	se, err := sessionIn(t, by)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	switch why {
	case WhyLapsed:
		fmt.Fprintf(&b, "The session in %s stopped responding.", se.Folder)
	case WhyEnded:
		fmt.Fprintf(&b, "The session in %s ended.", se.Folder)
	default:
		fmt.Fprintf(&b, "The session in %s released this page.", se.Folder)
	}
	c, err := changeOf(t, number)
	if err != nil {
		return "", err
	}
	var files []string
	if c != nil {
		for _, f := range append(append([]ChangeFile{}, c.Files...), c.Unrecorded...) {
			files = append(files, f.Shown)
		}
	}
	if len(files) > 0 {
		fmt.Fprintf(&b, " Files already changed: %s.", strings.Join(files, ", "))
	}
	return b.String(), nil
}

// loseLapsed marks the lapsed claims of other sessions that p overlaps as
// lost to the session in folder, each logged as claim-lost for its inbox.
func (t *eventTx) loseLapsed(session, folder string, p pattern.Pattern) error {
	lapsed, err := lapsedWhere(t, `l.session != ? AND l.lost_to IS NULL`, session)
	if err != nil {
		return err
	}
	for _, c := range lapsed {
		held, err := pattern.Parse(c.Pattern)
		if err != nil || !held.Overlaps(p) {
			continue
		}
		if _, err := t.Exec(`UPDATE lapsed_claims SET lost_to = ? WHERE id = ?`, folder, c.ID); err != nil {
			return err
		}
		c.LostTo = folder
		if err := t.logClaim(EventClaimLost, c); err != nil {
			return err
		}
	}
	return nil
}

// lapsedWhere lists lapsed claims, with their sessions, oldest first.
func lapsedWhere(q querier, where string, args ...any) ([]Claim, error) {
	rows, err := q.Query(`SELECT l.id, l.pattern, l.created, coalesce(l.lost_to, ''), s.id, s.agent, s.folder, s.label, s.last_check_in
		FROM lapsed_claims l JOIN sessions s ON s.id = l.session WHERE `+where+` ORDER BY l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Claim
	for rows.Next() {
		var c Claim
		var created, at int64
		if err := rows.Scan(&c.ID, &c.Pattern, &created, &c.LostTo, &c.Session.ID, &c.Session.Agent,
			&c.Session.Folder, &c.Session.Label, &at); err != nil {
			return nil, err
		}
		c.Created, c.Session.LastCheckIn = fromMillis(created), fromMillis(at)
		out = append(out, c)
	}
	return out, rows.Err()
}

// lostFor is the session's lost claim covering url, if it has one.
func lostFor(q querier, session, url string) (*Claim, error) {
	lost, err := lapsedWhere(q, `l.session = ? AND l.lost_to IS NOT NULL`, session)
	if err != nil {
		return nil, err
	}
	for _, c := range lost {
		if p, err := pattern.Parse(c.Pattern); err == nil && p.Match(url) {
			return &c, nil
		}
	}
	return nil, nil
}

// Stale lists the sessions holding claims that haven't checked in for
// after: their claims lapse.
func (s *Store) Stale(after time.Duration) ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT s.id FROM sessions s JOIN claims c ON c.session = s.id
		WHERE s.last_check_in <= ? ORDER BY s.id`, s.now()-after.Milliseconds())
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

// Lapse ends the session's claims, keeping each to come back, if it still
// hasn't checked in for after (a check-in since Stale cancels it). Its open
// tweaks and the undos it held go back to waiting for a session. It returns
// the lapsed claims.
func (s *Store) Lapse(session string, after time.Duration) ([]Claim, error) {
	tx, err := s.begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	se, err := sessionIn(tx, session)
	if err != nil {
		return nil, err
	}
	if se.LastCheckIn.UnixMilli() > s.now()-after.Milliseconds() {
		return nil, nil
	}
	claims, err := listClaims(tx)
	if err != nil {
		return nil, err
	}
	var lapsed []Claim
	for _, c := range claims {
		if c.Session.ID != session {
			continue
		}
		// Its own key: a claim's ID can be given out again once the claims
		// table empties.
		if _, err := tx.Exec(`INSERT INTO lapsed_claims (session, pattern, created, lapsed_at) VALUES (?, ?, ?, ?)`,
			session, c.Pattern, c.Created.UnixMilli(), s.now()); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`DELETE FROM claims WHERE id = ?`, c.ID); err != nil {
			return nil, err
		}
		if err := tx.logClaim(EventClaimLapsed, c); err != nil {
			return nil, err
		}
		lapsed = append(lapsed, c)
	}
	if err := tx.letGo(session, WhyLapsed); err != nil {
		return nil, err
	}
	return lapsed, tx.commit()
}

// letGo sends back to waiting the session's open tweaks and held undos on
// pages it no longer claims.
func (t *eventTx) letGo(session, why string) error {
	left, err := listClaims(t)
	if err != nil {
		return err
	}
	if err := t.dropTweaks(session, why, left); err != nil {
		return err
	}
	return t.dropUndos(session, left)
}

// Return is a session's check-in: it brings back its lapsed claims, unless
// they were lost meanwhile or it has been gone for restoreFor, with the
// tweaks they held as they were. A delivered tweak starts a fresh wait (no
// again: line at once), and the tweak that was capturing captures again,
// on its first snapshot. It reports the lost claims once.
func (s *Store) Return(session string, restoreFor time.Duration) (Returned, error) {
	tx, err := s.begin()
	if err != nil {
		return Returned{}, err
	}
	defer tx.Rollback()
	var r Returned
	lapsed, err := lapsedWhere(tx, `l.session = ?`, session)
	if err != nil {
		return r, err
	}
	now := s.now()
	for _, c := range lapsed {
		if c.Session.LastCheckIn.UnixMilli() <= now-restoreFor.Milliseconds() {
			if err := tx.expire(c); err != nil {
				return r, err
			}
			continue
		}
		if c.LostTo != "" {
			res, err := tx.Exec(`UPDATE lapsed_claims SET reported = 1 WHERE id = ? AND reported = 0`, c.ID)
			if err != nil {
				return r, err
			}
			if n, _ := res.RowsAffected(); n == 1 {
				r.Lost = append(r.Lost, c)
			}
			continue
		}
		restored, capturing, err := tx.restore(c)
		if err != nil {
			return r, err
		}
		r.Restored = append(r.Restored, restored)
		if capturing != 0 {
			r.Capturing = capturing
		}
	}
	if _, err := tx.Exec(`UPDATE sessions SET last_check_in = ? WHERE id = ?`, now, session); err != nil {
		return r, err
	}
	return r, tx.commit()
}

// restore brings a lapsed claim back, made again now (so its session's
// watcher has a minute to come back too), with its tweaks as they were.
func (t *eventTx) restore(c Claim) (Claim, int64, error) {
	if _, err := t.Exec(`DELETE FROM lapsed_claims WHERE id = ?`, c.ID); err != nil {
		return c, 0, err
	}
	c.Created = fromMillis(t.s.now())
	res, err := t.Exec(`INSERT INTO claims (session, pattern, created) VALUES (?, ?, ?)`, c.Session.ID, c.Pattern, c.Created.UnixMilli())
	if err != nil {
		return c, 0, err
	}
	c.ID, _ = res.LastInsertId()
	if err := t.logClaim(EventClaimRestored, c); err != nil {
		return c, 0, err
	}
	p, err := pattern.Parse(c.Pattern)
	if err != nil {
		return c, 0, err
	}
	rows, err := t.Query(`SELECT number, page_url, left_status, left_status_at, left_capturing FROM tweaks
		WHERE session IS NULL AND left_by = ? AND left_why = ? AND resolved_at IS NULL AND status = ? ORDER BY number`,
		c.Session.ID, WhyLapsed, StatusSent)
	if err != nil {
		return c, 0, err
	}
	type back struct {
		number    int64
		url, was  string
		at        int64
		capturing bool
	}
	var all []back
	for rows.Next() {
		var b back
		if err := rows.Scan(&b.number, &b.url, &b.was, &b.at, &b.capturing); err != nil {
			rows.Close()
			return c, 0, err
		}
		all = append(all, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return c, 0, err
	}
	var capturing int64
	now := t.s.now()
	for _, b := range all {
		if !p.Match(b.url) {
			continue
		}
		waitFrom := sql.NullInt64{}
		if b.was == StatusDelivered {
			waitFrom = sql.NullInt64{Int64: now, Valid: true}
		}
		if _, err := t.Exec(`UPDATE tweaks SET session = ?, status = ?, status_at = ?, wait_from = ?, updated = ?,
			left_by = NULL, left_why = NULL, left_status = NULL, left_status_at = NULL, left_capturing = 0 WHERE number = ?`,
			c.Session.ID, b.was, b.at, waitFrom, now, b.number); err != nil {
			return c, 0, err
		}
		if b.capturing {
			if _, _, err := capturingIn(t, c.Session.ID); errors.Is(err, ErrNotCapturing) {
				if _, err := t.Exec(`UPDATE changes SET capturing = ? WHERE tweak = ? AND capturing IS NULL`, c.Session.ID, b.number); err != nil {
					return c, 0, err
				}
				capturing = b.number
			} else if err != nil {
				return c, 0, err
			}
		}
		tw, err := getTweak(t, b.number)
		if err != nil {
			return c, 0, err
		}
		if err := t.logTweak(EventTweakStatus, tw); err != nil {
			return c, 0, err
		}
	}
	return c, capturing, t.passUndos(c.Session.ID, p)
}

// expire forgets a lapsed claim: its tweaks stay waiting for a session.
func (t *eventTx) expire(c Claim) error {
	_, err := t.Exec(`DELETE FROM lapsed_claims WHERE id = ?`, c.ID)
	return err
}

// Expire forgets the lapsed claims of sessions gone for restoreFor, and
// lost ones restoreFor after they lapsed, however often their session has
// checked in since.
func (s *Store) Expire(restoreFor time.Duration) error {
	cutoff := s.now() - restoreFor.Milliseconds()
	_, err := s.db.Exec(`DELETE FROM lapsed_claims WHERE (lost_to IS NOT NULL AND lapsed_at <= ?)
		OR session IN (SELECT id FROM sessions WHERE last_check_in <= ?)`, cutoff, cutoff)
	return err
}

// EndSession is the session ending (exit or /clear): its claims are
// released, its lapsed ones forgotten, and its open tweaks and held undos
// go back to waiting for a session. An unknown session is fine.
func (s *Store) EndSession(session string) error {
	tx, err := s.begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	claims, err := listClaims(tx)
	if err != nil {
		return err
	}
	for _, c := range claims {
		if c.Session.ID != session {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM claims WHERE id = ?`, c.ID); err != nil {
			return err
		}
		if err := tx.logClaim(EventClaimReleased, c); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM lapsed_claims WHERE session = ?`, session); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE tweaks SET left_why = ? WHERE left_by = ? AND left_why = ?`, WhyEnded, session, WhyLapsed); err != nil {
		return err
	}
	if err := tx.letGo(session, WhyEnded); err != nil {
		return err
	}
	return tx.commit()
}
