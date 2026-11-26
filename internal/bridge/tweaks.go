package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/codaset/tweak/internal/brief"
	"github.com/codaset/tweak/internal/store"
)

// Tweaks over HTTP, for the CLI: the inbox the watcher long-polls, the brief
// (tweak work) and status changes (tweak done). See docs/design.md, "Bridge
// contract" and "The tweak CLI".

type entryOut struct {
	From string `json:"from"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	At   string `json:"at"`
}

type tweakOut struct {
	Number   int64           `json:"number"`
	Page     string          `json:"page"`
	URL      string          `json:"url"`
	Status   string          `json:"status"`
	StatusAt string          `json:"statusAt"`
	Created  string          `json:"created"`
	Updated  string          `json:"updated"`
	Targets  json.RawMessage `json:"targets"`
	Anchor   json.RawMessage `json:"anchor"`
	Entries  []entryOut      `json:"entries"`
}

func tweakJSON(t store.Tweak) tweakOut {
	out := tweakOut{Number: t.Number, Page: t.Page, URL: t.URL, Status: t.Status, StatusAt: stamp(t.StatusAt),
		Created: stamp(t.Created), Updated: stamp(t.Updated), Targets: t.Targets, Anchor: t.Anchor, Entries: []entryOut{}}
	for _, e := range t.Entries {
		out.Entries = append(out.Entries, entryOut{From: e.From, Kind: e.Kind, Text: e.Text, At: stamp(e.At)})
	}
	return out
}

type lineOut struct {
	Seq  int64  `json:"seq"`
	Text string `json:"text"`
}

type inboxOut struct {
	Seq    int64     `json:"seq"`
	Claims int       `json:"claims"`
	Lines  []lineOut `json:"lines"`
}

// requestCap and pathCap keep an event line well under Monitor's 500 characters.
const (
	requestCap = 300
	pathCap    = 120
)

// newLine is a tweak's "new" event line: only the developer's own words, on
// one line and cut at 300 characters, then the path and element count, which
// come from the bridge. Page text never goes in a line.
func newLine(number int64, page, request string, targets json.RawMessage) string {
	var t brief.Targets
	json.Unmarshal(targets, &t)
	n := len(t.Elements)
	count := fmt.Sprintf("%d elements", n)
	if n == 1 {
		count = "1 element"
	}
	path := page
	if u, err := url.Parse(page); err == nil {
		path = u.EscapedPath()
	}
	return fmt.Sprintf("tweak %d new: %s [on %s, %s]", number, brief.Cut(request, requestCap), brief.Cut(path, pathCap), count)
}

// line is an inbox event as the watcher prints it.
func line(e store.Event) string {
	switch e.Type {
	case store.EventTweakCreated:
		return newLine(e.Tweak.Number, e.Tweak.Page, e.Tweak.Request(), e.Tweak.Targets)
	case store.EventClaimReleased:
		return "claim released: " + e.Claim.Pattern
	}
	return ""
}

// inbox is GET /inbox?after=<seq>: the session's lines after seq, held open
// up to InboxWait while there are none. Asking after a seq acknowledges
// every line up to it; with no after, it starts where the last watcher left off.
func (b *Bridge) inbox(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}
	after := int64(-1)
	if raw := r.URL.Query().Get("after"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			refuse(w, 400, "bad-request", "after must be an event sequence (0 or more)")
			return
		}
		after = n
	}
	deadline := time.NewTimer(b.opts.InboxWait)
	defer deadline.Stop()
	for {
		wake := b.changed()
		in, err := b.store.Inbox(id, after)
		if errors.Is(err, store.ErrNoSession) {
			refuse(w, 404, "no-session", fmt.Sprintf("session %s isn't registered: run tweak claim", id))
			return
		}
		if err != nil {
			b.internal(w, err)
			return
		}
		if len(in.Events) > 0 || in.Claims == 0 {
			b.replyInbox(w, in)
			return
		}
		// Nothing yet: everything up to in.Seq is now acknowledged; wait for more.
		after = in.Seq
		select {
		case <-wake:
			continue
		case <-deadline.C:
		case <-r.Context().Done():
		case <-b.closing.Done():
		}
		b.replyInbox(w, in)
		return
	}
}

func (b *Bridge) replyInbox(w http.ResponseWriter, in store.Inbox) {
	out := inboxOut{Seq: in.Seq, Claims: in.Claims, Lines: []lineOut{}}
	for _, e := range in.Events {
		if text := line(e); text != "" {
			out.Lines = append(out.Lines, lineOut{Seq: e.Seq, Text: text})
		}
	}
	reply(w, 200, out)
}

// tweakNumber reads the session and :n, refusing a missing session ID or a bad number.
func tweakNumber(w http.ResponseWriter, r *http.Request) (string, int64, bool) {
	id, ok := sessionID(w, r)
	if !ok {
		return "", 0, false
	}
	n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err != nil || n < 1 {
		refuse(w, 404, "no-tweak", fmt.Sprintf("there is no tweak %s", r.PathValue("n")))
		return "", 0, false
	}
	return id, n, true
}

// setStatus answers a status change's errors, returning the tweak on success.
func (b *Bridge) setStatus(w http.ResponseWriter, session string, n int64, status string, e *store.Entry) (store.Tweak, bool) {
	tw, err := b.store.SetStatus(session, n, status, e)
	var notYours *store.NotYoursError
	switch {
	case errors.Is(err, store.ErrNoTweak):
		refuse(w, 404, "no-tweak", fmt.Sprintf("there is no tweak %d", n))
	case errors.As(err, &notYours):
		refuse(w, 409, "not-yours", err.Error())
	case err != nil:
		b.internal(w, err)
	default:
		return tw, true
	}
	return tw, false
}

// work is POST /tweaks/:n/work: sets working and returns the brief.
func (b *Bridge) work(w http.ResponseWriter, r *http.Request) {
	session, n, ok := tweakNumber(w, r)
	if !ok {
		return
	}
	tw, ok := b.setStatus(w, session, n, store.StatusWorking, nil)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(200)
	w.Write([]byte(brief.Render(tw)))
}

// status is POST /tweaks/:n/status {status, message}. Only done so far.
func (b *Bridge) status(w http.ResponseWriter, r *http.Request) {
	session, n, ok := tweakNumber(w, r)
	if !ok {
		return
	}
	var body struct{ Status, Message string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Status != store.StatusDone {
		refuse(w, 400, "bad-request", `POST /tweaks/:n/status needs {"status": "done", "message": …}`)
		return
	}
	summary := strings.TrimSpace(body.Message)
	if summary == "" {
		refuse(w, 400, "bad-request", "done needs a summary: one sentence on what you changed")
		return
	}
	tw, ok := b.setStatus(w, session, n, store.StatusDone, &store.Entry{From: "claude", Kind: "summary", Text: summary})
	if !ok {
		return
	}
	reply(w, 200, statusOut{Number: tw.Number, Status: tw.Status})
}

type statusOut struct {
	Number int64  `json:"number"`
	Status string `json:"status"`
}
