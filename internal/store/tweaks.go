package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/codaset/tweak/internal/pattern"
)

// Statuses (docs/design.md, "Statuses"). Withdrawn comes with Withdraw.
const (
	StatusSent      = "sent"
	StatusDelivered = "delivered"
	StatusQueued    = "queued"
	StatusWorking   = "working"
	StatusQuestion  = "question"
	StatusDone      = "done"
	StatusDeclined  = "declined"
)

// Who wrote an entry, and its kind (docs/design.md, "Conversation entries").
const (
	FromYou    = "you"    // the developer
	FromClaude = "claude" // the session
	FromBridge = "bridge" // Tweak itself

	KindRequest  = "request"
	KindPlan     = "plan"
	KindQuestion = "question"
	KindReply    = "reply"
	KindSummary  = "summary"
	KindReason   = "reason"
	KindUndo     = "undo"
	KindNotice   = "notice"
)

// Tweak is a request left on a page, with its conversation and status.
type Tweak struct {
	Number   int64
	Session  string // the session it's for; "" while no claim covers its page
	Page     string // origin and path: what the tweak belongs to
	URL      string // the full URL it was sent from
	Status   string
	StatusAt time.Time // when Status last changed
	Created  time.Time
	Updated  time.Time
	Targets  json.RawMessage // what it points at, as the extension sent it
	Anchor   json.RawMessage // where its pin sits
	Entries  []Entry
	// Resends counts the again: lines sent while it is delivered and
	// unconfirmed; WaitFrom is when the wait for Claude to confirm it
	// began, zero while an again: line waits to be printed (or once it is
	// no longer delivered). See docs/design.md, "No lost tweaks".
	Resends  int
	WaitFrom time.Time
}

// Entry is one turn of a tweak's conversation.
type Entry struct {
	From string // FromYou, FromClaude or FromBridge
	Kind string // KindRequest, KindSummary, ...
	Text string
	At   time.Time
}

// Request is the developer's own words: the first request entry.
func (t Tweak) Request() string {
	for _, e := range t.Entries {
		if e.Kind == KindRequest {
			return e.Text
		}
	}
	return ""
}

// LastEntry is the newest entry of a kind, if there is one.
func (t Tweak) LastEntry(kind string) (Entry, bool) {
	for i := len(t.Entries) - 1; i >= 0; i-- {
		if t.Entries[i].Kind == kind {
			return t.Entries[i], true
		}
	}
	return Entry{}, false
}

// NewTweak is what the extension sends to create a tweak.
type NewTweak struct {
	URL     string
	Request string
	Targets json.RawMessage
	Anchor  json.RawMessage
}

// Errors about tweaks.
var (
	ErrBadTweak = errors.New("a tweak needs a request and an http or https page")
	ErrNoTweak  = errors.New("no such tweak")
	ErrNoClaim  = errors.New("no session claims this page")
	// ErrNotAsked refuses a reply to a tweak Claude asked nothing about.
	// It and ErrBlankReply are shown on the card as they are.
	ErrNotAsked   = errors.New("Claude has no question on this tweak, so there's nothing to answer: send a new tweak instead")
	ErrBlankReply = errors.New("Write your answer first")
)

// allowed is every status change Claude may make, from each status: the one
// place the rule lives. Claude works on a tweak before asking about it or
// finishing it, and may queue or decline one it hasn't started. A question
// waits for the developer: only their reply (Reply) reopens it, as sent.
// Done and declined are final.
var allowed = map[string][]string{
	StatusSent:      {StatusWorking, StatusQueued, StatusDeclined},
	StatusDelivered: {StatusWorking, StatusQueued, StatusDeclined},
	StatusQueued:    {StatusWorking, StatusQueued, StatusDeclined},
	StatusWorking:   {StatusWorking, StatusQuestion, StatusDone, StatusDeclined},
	StatusQuestion:  {StatusDeclined},
}

// TransitionError refuses a status change the tweak's status doesn't allow,
// saying what to do instead. To is the status asked for, or "" for a plan,
// which changes no status but needs the tweak to be working.
type TransitionError struct {
	Number   int64
	From, To string
}

func (e *TransitionError) Error() string {
	switch {
	case e.From == StatusDone && e.To == StatusDone:
		return fmt.Sprintf("tweak %d is already done: its summary is saved, so there's nothing more to do", e.Number)
	case e.From == StatusDone && e.To == StatusWorking:
		return fmt.Sprintf("tweak %d is already done: there's nothing more to work on", e.Number)
	case e.From == StatusDone:
		return fmt.Sprintf("tweak %d is already done: there's nothing more to do", e.Number)
	case e.From == StatusDeclined:
		return fmt.Sprintf("tweak %d was declined: there's nothing more to do", e.Number)
	case e.From == StatusQuestion:
		return fmt.Sprintf("tweak %d is waiting for the developer's reply to your question: their answer comes as a reply event; or decline it with tweak decline %d '<why>'", e.Number, e.Number)
	case e.From == StatusWorking && e.To == StatusQueued:
		return fmt.Sprintf("tweak %d is being worked on: finish it with tweak done, ask or decline", e.Number)
	case e.To == StatusDone, e.To == StatusQuestion, e.To == "":
		return fmt.Sprintf("tweak %d isn't being worked on: run tweak work %d first", e.Number, e.Number)
	}
	return fmt.Sprintf("tweak %d is %s: it can't become %s", e.Number, e.From, e.To)
}

func canMove(from, to string) bool {
	for _, s := range allowed[from] {
		if s == to {
			return true
		}
	}
	return false
}

// NotYoursError refuses a status change from a session the tweak isn't for.
type NotYoursError struct {
	Number int64
	Folder string // the folder of the session it is for; "" if none
}

func (e *NotYoursError) Error() string {
	if e.Folder == "" {
		return fmt.Sprintf("tweak %d isn't for this session: no session claims its page, so send it again from the page once one does", e.Number)
	}
	return fmt.Sprintf("tweak %d is for the session in %s: work on it from that session", e.Number, e.Folder)
}

// PageOf is the page a URL belongs to: its origin and path, without the
// query or hash (/admin?tab=2 is /admin).
func PageOf(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", ErrBadTweak
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + path, nil
}

// CreateTweak gives a new tweak the next bridge-wide number, for the session
// whose claim covers its page, with status sent. A page no claim covers is
// refused (ErrNoClaim): every tweak has a session.
func (s *Store) CreateTweak(n NewTweak) (Tweak, error) {
	page, err := PageOf(n.URL)
	request := strings.TrimSpace(n.Request)
	if err != nil || request == "" {
		return Tweak{}, ErrBadTweak
	}
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()

	claims, err := listClaims(tx)
	if err != nil {
		return Tweak{}, err
	}
	var session sql.NullString
	for _, c := range claims {
		if p, err := pattern.Parse(c.Pattern); err == nil && p.Match(n.URL) {
			session = sql.NullString{String: c.Session.ID, Valid: true}
			break
		}
	}
	if !session.Valid {
		return Tweak{}, ErrNoClaim
	}
	at := s.now()
	r, err := tx.Exec(`INSERT INTO tweaks (session, page, page_url, status, status_at, created, updated, targets, click_anchor)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		session, page, n.URL, StatusSent, at, at, at, string(orEmpty(n.Targets)), string(orEmpty(n.Anchor)))
	if err != nil {
		return Tweak{}, err
	}
	number, _ := r.LastInsertId()
	if _, err := tx.Exec(`INSERT INTO entries (tweak, "from", kind, text, at) VALUES (?, ?, ?, ?, ?)`, number, FromYou, KindRequest, request, at); err != nil {
		return Tweak{}, err
	}
	tw, err := getTweak(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if err := tx.logTweak(EventTweakCreated, tw); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// Tweak returns one tweak, or ErrNoTweak.
func (s *Store) Tweak(number int64) (Tweak, error) { return getTweak(s.db, number) }

// SetStatus moves a tweak to status for the session it is for, adding entry
// to its conversation when given. A tweak already at status with no entry
// is returned unchanged and nothing is logged.
//
// Undo capture (docs/design.md, "Capture") hangs off these moves: it starts
// when a session's tweak becomes working, and ends when the session asks,
// finishes, declines or queues.
func (s *Store) SetStatus(sessionID string, number int64, status string, entry *Entry) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := ownTweak(tx, sessionID, number)
	if err != nil {
		return Tweak{}, err
	}
	if !canMove(tw.Status, status) {
		return Tweak{}, &TransitionError{Number: number, From: tw.Status, To: status}
	}
	if tw.Status == status && entry == nil {
		return tw, nil
	}
	if tw, err = tx.change(number, status, entry, EventTweakStatus); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// Plan adds Claude's plan to a tweak it is working on. The status stays.
func (s *Store) Plan(sessionID string, number int64, text string) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := ownTweak(tx, sessionID, number)
	if err != nil {
		return Tweak{}, err
	}
	if tw.Status != StatusWorking {
		return Tweak{}, &TransitionError{Number: number, From: tw.Status}
	}
	if tw, err = tx.change(number, StatusWorking, &Entry{From: FromClaude, Kind: KindPlan, Text: text}, EventTweakStatus); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// Reply is the developer's answer to Claude's question, from the card. It
// joins the conversation and sends the tweak again (status sent): its
// tweak-replied event goes to the inbox of the session that asked, which
// is the session the tweak is for.
func (s *Store) Reply(number int64, text string) (Tweak, error) {
	text = strings.TrimSpace(text)
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := getTweak(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if tw.Status != StatusQuestion {
		return Tweak{}, ErrNotAsked
	}
	if text == "" {
		return Tweak{}, ErrBlankReply
	}
	if tw, err = tx.change(number, StatusSent, &Entry{From: FromYou, Kind: KindReply, Text: text}, EventTweakReplied); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// ownTweak reads a tweak for the session it is for, refusing another's.
func ownTweak(tx *eventTx, sessionID string, number int64) (Tweak, error) {
	tw, err := getTweak(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if tw.Session != sessionID {
		e := &NotYoursError{Number: number}
		if tw.Session != "" {
			if se, err := sessionIn(tx, tw.Session); err == nil {
				e.Folder = se.Folder
			}
		}
		return Tweak{}, e
	}
	return tw, nil
}

// change sets a tweak's status, adds entry when given, and logs the tweak
// as it now is. status_at moves only when the status does.
func (t *eventTx) change(number int64, status string, entry *Entry, event string) (Tweak, error) {
	at := t.s.now()
	if _, err := t.Exec(`UPDATE tweaks SET status = ?, status_at = CASE WHEN status = ? THEN status_at ELSE ? END, updated = ? WHERE number = ?`,
		status, status, at, at, number); err != nil {
		return Tweak{}, err
	}
	if entry != nil {
		if _, err := t.Exec(`INSERT INTO entries (tweak, "from", kind, text, at) VALUES (?, ?, ?, ?, ?)`,
			number, entry.From, entry.Kind, entry.Text, at); err != nil {
			return Tweak{}, err
		}
	}
	tw, err := getTweak(t, number)
	if err != nil {
		return Tweak{}, err
	}
	return tw, t.logTweak(event, tw)
}

type queryRower interface {
	querier
	QueryRow(string, ...any) *sql.Row
}

func sessionIn(q queryRower, id string) (Session, error) {
	var se Session
	var at int64
	err := q.QueryRow(`SELECT id, agent, folder, label, last_check_in FROM sessions WHERE id = ?`, id).
		Scan(&se.ID, &se.Agent, &se.Folder, &se.Label, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return se, ErrNoSession
	}
	se.LastCheckIn = fromMillis(at)
	return se, err
}

const tweakColumns = `number, coalesce(session, ''), page, page_url, status, status_at, created, updated, targets, coalesce(click_anchor, ''), resends, coalesce(wait_from, 0)`

func scanTweak(row interface{ Scan(...any) error }) (Tweak, error) {
	var tw Tweak
	var statusAt, created, updated, waitFrom int64
	var targets, anchor string
	err := row.Scan(&tw.Number, &tw.Session, &tw.Page, &tw.URL, &tw.Status, &statusAt, &created, &updated, &targets, &anchor, &tw.Resends, &waitFrom)
	if waitFrom != 0 && tw.Status == StatusDelivered {
		tw.WaitFrom = fromMillis(waitFrom)
	}
	tw.StatusAt, tw.Created, tw.Updated = fromMillis(statusAt), fromMillis(created), fromMillis(updated)
	tw.Targets, tw.Anchor = json.RawMessage(targets), orEmpty(json.RawMessage(anchor))
	return tw, err
}

func getTweak(q queryRower, number int64) (Tweak, error) {
	tw, err := scanTweak(q.QueryRow(`SELECT `+tweakColumns+` FROM tweaks WHERE number = ?`, number))
	if errors.Is(err, sql.ErrNoRows) {
		return Tweak{}, ErrNoTweak
	}
	if err != nil {
		return Tweak{}, err
	}
	tw.Entries, err = entriesOf(q, number)
	return tw, err
}

// openTweaks lists the unresolved tweaks, oldest first, with their entries.
func openTweaks(q queryRower) ([]Tweak, error) {
	rows, err := q.Query(`SELECT ` + tweakColumns + ` FROM tweaks WHERE resolved_at IS NULL ORDER BY number`)
	if err != nil {
		return nil, err
	}
	var out []Tweak
	for rows.Next() {
		tw, err := scanTweak(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, tw)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Entries, err = entriesOf(q, out[i].Number); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func entriesOf(q querier, number int64) ([]Entry, error) {
	rows, err := q.Query(`SELECT "from", kind, text, at FROM entries WHERE tweak = ? ORDER BY id`, number)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		var at int64
		if err := rows.Scan(&e.From, &e.Kind, &e.Text, &at); err != nil {
			return nil, err
		}
		e.At = fromMillis(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

func orEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}
