package store

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// Event types in the event log.
const (
	EventClaimMade      = "claim-made"
	EventClaimReleased  = "claim-released"
	EventClaimLapsed    = "claim-lapsed"    // its session stopped checking in: kept 24 hours to come back
	EventClaimRestored  = "claim-restored"  // a lapsed claim back with its session
	EventClaimLost      = "claim-lost"      // a lapsed claim that can't come back: another session claimed an overlapping pattern
	EventClaimListening = "claim-listening" // its session's watcher went, or came back
	EventClaimForgotten = "claim-forgotten" // a lapsed claim that can't come back: its session ended
	EventTweakCreated   = "tweak-created"
	EventTweakStatus    = "tweak-status"  // its status changed, or an entry was added
	EventTweakReplied   = "tweak-replied" // the developer answered Claude's question
	EventTweakAgain     = "tweak-again"   // a delivered tweak Claude hasn't confirmed, sent again
	EventTweakHanded    = "tweak-handed"  // a tweak whose session let go of its page, sent to the session claiming it now
	// An undo that needs Claude: to the session that claims the page now.
	EventTweakUndoConflict = "tweak-undo-conflict"
	// A change undone, by the bridge or by Claude by hand: the page reloads
	// as after a change.
	EventTweakUndone = "tweak-undone"
	// Withdrawn by the developer after it reached its session: the inbox's
	// withdrawn line. (A sent tweak withdrawn is logged as tweak-resolved.)
	EventTweakWithdrawn = "tweak-withdrawn"
	// Resolved by the developer: its pin leaves the page.
	EventTweakResolved = "tweak-resolved"
)

// Event is one entry in the append-only event log. Seq is monotonic. It
// carries the claim or the tweak as it was when the event happened.
type Event struct {
	Seq   int64
	Type  string
	Claim *Claim // claim events
	Tweak *Tweak // tweak events
	At    time.Time
}

func isTweakEvent(typ string) bool { return strings.HasPrefix(typ, "tweak-") }

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
	LostTo      string `json:"lostTo,omitempty"`
	LapsedAt    int64  `json:"lapsedAt,omitempty"`
}

// OnEvent sets the function called after every commit that wrote to the event
// log, so its readers (the extension's sockets) hear of it whoever wrote it.
// Set it before the store is shared.
func (s *Store) OnEvent(fn func()) { s.onEvent = fn }

// eventTx is the only way to write to the event log: a transaction whose
// commit calls the OnEvent function when it logged anything.
type eventTx struct {
	*sql.Tx
	s      *Store
	logged bool
}

func (s *Store) begin() (*eventTx, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	return &eventTx{Tx: tx, s: s}, nil
}

func (t *eventTx) commit() error {
	if err := t.Tx.Commit(); err != nil {
		return err
	}
	if t.logged && t.s.onEvent != nil {
		t.s.onEvent()
	}
	return nil
}

func (t *eventTx) logClaim(typ string, c Claim) error {
	payload, _ := json.Marshal(claimRecord{
		ID: c.ID, Pattern: c.Pattern, Created: c.Created.UnixMilli(),
		Session: c.Session.ID, Agent: c.Session.Agent, Folder: c.Session.Folder,
		Label: c.Session.Label, LastCheckIn: c.Session.LastCheckIn.UnixMilli(), LostTo: c.LostTo,
		LapsedAt: millisOrZero(c.LapsedAt),
	})
	_, err := t.Exec(`INSERT INTO events (type, claim, payload, at) VALUES (?, ?, ?, ?)`, typ, c.ID, string(payload), t.s.now())
	t.logged = t.logged || err == nil
	return err
}

// tweakRecord is a tweak as stored in an event's payload.
type tweakRecord struct {
	Number   int64           `json:"number"`
	Session  string          `json:"session"`
	Page     string          `json:"page"`
	URL      string          `json:"url"`
	Status   string          `json:"status"`
	StatusAt int64           `json:"statusAt"`
	Created  int64           `json:"created"`
	Updated  int64           `json:"updated"`
	Targets  json.RawMessage `json:"targets"`
	Anchor   json.RawMessage `json:"anchor"`
	Entries  []entryRecord   `json:"entries"`
	Resends  int             `json:"resends,omitempty"`
	WaitFrom int64           `json:"waitFrom,omitempty"`
	Change   *Change         `json:"change,omitempty"`
	Line     string          `json:"line,omitempty"`
	LeftBy   string          `json:"leftBy,omitempty"`
	LeftWhy  string          `json:"leftWhy,omitempty"`
	Resolved int64           `json:"resolvedAt,omitempty"`
}

type entryRecord struct {
	From string `json:"from"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

func (t *eventTx) logTweak(typ string, tw Tweak) error {
	r := tweakRecord{Number: tw.Number, Session: tw.Session, Page: tw.Page, URL: tw.URL, Status: tw.Status,
		StatusAt: tw.StatusAt.UnixMilli(), Created: tw.Created.UnixMilli(), Updated: tw.Updated.UnixMilli(),
		Targets: tw.Targets, Anchor: tw.Anchor, Entries: []entryRecord{}, Resends: tw.Resends, Change: tw.Change, Line: tw.Line, LeftBy: tw.LeftFolder, LeftWhy: tw.LeftWhy}
	if !tw.WaitFrom.IsZero() {
		r.WaitFrom = tw.WaitFrom.UnixMilli()
	}
	if !tw.ResolvedAt.IsZero() {
		r.Resolved = tw.ResolvedAt.UnixMilli()
	}
	for _, e := range tw.Entries {
		r.Entries = append(r.Entries, entryRecord{From: e.From, Kind: e.Kind, Text: e.Text, At: e.At.UnixMilli()})
	}
	payload, _ := json.Marshal(r)
	_, err := t.Exec(`INSERT INTO events (type, tweak, payload, at) VALUES (?, ?, ?, ?)`, typ, tw.Number, string(payload), t.s.now())
	t.logged = t.logged || err == nil
	return err
}

func (r tweakRecord) tweak() *Tweak {
	tw := &Tweak{Number: r.Number, Session: r.Session, Page: r.Page, URL: r.URL, Status: r.Status,
		StatusAt: fromMillis(r.StatusAt), Created: fromMillis(r.Created), Updated: fromMillis(r.Updated),
		Targets: r.Targets, Anchor: r.Anchor, Resends: r.Resends, Change: r.Change, Line: r.Line, LeftFolder: r.LeftBy, LeftWhy: r.LeftWhy}
	if r.WaitFrom != 0 {
		tw.WaitFrom = fromMillis(r.WaitFrom)
	}
	if r.Resolved != 0 {
		tw.ResolvedAt = fromMillis(r.Resolved)
	}
	for _, e := range r.Entries {
		tw.Entries = append(tw.Entries, Entry{From: e.From, Kind: e.Kind, Text: e.Text, At: fromMillis(e.At)})
	}
	return tw
}

func (r claimRecord) claim() *Claim {
	var lapsed time.Time
	if r.LapsedAt != 0 {
		lapsed = fromMillis(r.LapsedAt)
	}
	return &Claim{ID: r.ID, Pattern: r.Pattern, Created: fromMillis(r.Created), LostTo: r.LostTo, LapsedAt: lapsed, Session: Session{
		ID: r.Session, Agent: r.Agent, Folder: r.Folder, Label: r.Label, LastCheckIn: fromMillis(r.LastCheckIn),
	}}
}

// decodeEvent fills in an event's claim or tweak from its payload.
func decodeEvent(e *Event, payload string) error {
	if isTweakEvent(e.Type) {
		var r tweakRecord
		if err := json.Unmarshal([]byte(payload), &r); err != nil {
			return err
		}
		e.Tweak = r.tweak()
		return nil
	}
	var r claimRecord
	if err := json.Unmarshal([]byte(payload), &r); err != nil {
		return err
	}
	e.Claim = r.claim()
	return nil
}

// Snapshot returns the current claims and the tweaks kept (open, and
// resolved ones with ResolvedAt set) and the sequence of
// the last event they include, read together so events after seq are
// exactly what changed since.
func (s *Store) Snapshot() (seq int64, claims []Claim, tweaks []Tweak, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, nil, nil, err
	}
	defer tx.Rollback()
	if err := tx.QueryRow(`SELECT ` + lastSeq).Scan(&seq); err != nil {
		return 0, nil, nil, err
	}
	if claims, err = listClaims(tx); err != nil {
		return 0, nil, nil, err
	}
	if tweaks, err = keptTweaks(tx); err != nil {
		return 0, nil, nil, err
	}
	return seq, claims, tweaks, tx.Commit()
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
		if err := decodeEvent(&e, payload); err != nil {
			return nil, err
		}
		e.At = fromMillis(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

func millisOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}
