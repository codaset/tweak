package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
	// Resends and AgainAt are how the card tells a tweak Claude hasn't
	// picked up: the again: lines sent so far, and when the current wait
	// for Claude ends (none while an again: line waits to be printed).
	Resends int    `json:"resends,omitempty"`
	AgainAt string `json:"againAt,omitempty"`
}

func (b *Bridge) tweakJSON(t store.Tweak) tweakOut {
	out := tweakOut{Number: t.Number, Page: t.Page, URL: t.URL, Status: t.Status, StatusAt: stamp(t.StatusAt),
		Created: stamp(t.Created), Updated: stamp(t.Updated), Targets: t.Targets, Anchor: t.Anchor, Entries: []entryOut{}}
	if t.Status == store.StatusDelivered {
		out.Resends = t.Resends
		if !t.WaitFrom.IsZero() {
			out.AgainAt = stamp(t.WaitFrom.Add(b.opts.AgainAfter))
		}
	}
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

// replyLine is a tweak's "reply" event line: the developer's answer, on one
// line and cut at 300 characters.
func replyLine(number int64, text string) string {
	return fmt.Sprintf("tweak %d reply: %s", number, brief.Cut(text, requestCap))
}

// againLine is a delivered tweak sent again: "tweak <n> again: " and the
// line it repeats, the reply when the developer has answered a question
// (only a reply sends a tweak again after Claude has had it), else the new
// tweak's line.
func againLine(tw store.Tweak) string {
	repeat := newLine(tw.Number, tw.Page, tw.Request(), tw.Targets)
	if en, ok := tw.LastEntry(store.KindReply); ok {
		repeat = replyLine(tw.Number, en.Text)
	}
	return fmt.Sprintf("tweak %d again: %s", tw.Number, repeat)
}

// line is an inbox event as the watcher prints it.
func line(e store.Event) string {
	switch e.Type {
	case store.EventTweakCreated:
		return newLine(e.Tweak.Number, e.Tweak.Page, e.Tweak.Request(), e.Tweak.Targets)
	case store.EventTweakReplied:
		if en, ok := e.Tweak.LastEntry(store.KindReply); ok {
			return replyLine(e.Tweak.Number, en.Text)
		}
	case store.EventTweakAgain:
		return againLine(*e.Tweak)
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

// noTweak is the refusal for a tweak number that doesn't exist.
func noTweak(n string) string {
	return fmt.Sprintf("there is no tweak %s: check the number in the tweak's card", n)
}

// tweakNumber reads the session and :n, refusing a missing session ID or a bad number.
func tweakNumber(w http.ResponseWriter, r *http.Request) (string, int64, bool) {
	id, ok := sessionID(w, r)
	if !ok {
		return "", 0, false
	}
	n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err != nil || n < 1 {
		refuse(w, 404, "no-tweak", noTweak(r.PathValue("n")))
		return "", 0, false
	}
	return id, n, true
}

// setStatus answers a status change's errors, returning the tweak on success.
func (b *Bridge) setStatus(w http.ResponseWriter, session string, n int64, status string, e *store.Entry) (store.Tweak, bool) {
	tw, err := b.store.SetStatus(session, n, status, e)
	return tw, b.refuseChange(w, n, err)
}

// refuseChange answers a refused change to tweak n over HTTP. It reports
// whether there was nothing to refuse.
func (b *Bridge) refuseChange(w http.ResponseWriter, n int64, err error) bool {
	if err == nil {
		return true
	}
	status, code, message := b.refusalOf(n, err)
	refuse(w, status, code, message)
	return false
}

// refusalOf is how the bridge refuses a store error about tweak n, over HTTP
// or in a WebSocket result: the HTTP status, the error code, and the line
// saying what to do.
func (b *Bridge) refusalOf(n int64, err error) (status int, code, message string) {
	var notYours *store.NotYoursError
	var wrong *store.TransitionError
	switch {
	case errors.Is(err, store.ErrNoTweak):
		return 404, "no-tweak", noTweak(strconv.FormatInt(n, 10))
	case errors.As(err, &notYours):
		return 409, "not-yours", err.Error()
	case errors.As(err, &wrong):
		return 409, "wrong-status", err.Error()
	case errors.Is(err, store.ErrNotAsked):
		return 409, "not-asked", err.Error()
	case errors.Is(err, store.ErrBlankReply):
		return 400, "bad-request", err.Error()
	case errors.Is(err, store.ErrPickedUp):
		return 409, "picked-up", err.Error()
	}
	b.log.Print(err)
	return 500, "internal", "the bridge failed: " + err.Error()
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
	w.Write([]byte(brief.Render(tw, b.briefOptions(tw))))
}

// briefOptions are what the brief needs beyond the tweak: the folder of the
// session it's for, which the page's paths are placed in, and its
// screenshot, once there is one.
func (b *Bridge) briefOptions(tw store.Tweak) brief.Options {
	var o brief.Options
	if se, err := b.store.Session(tw.Session); err == nil {
		o.Folder = se.Folder
	}
	if shot := b.screenshotPath(tw.Number); fileExists(shot) {
		o.Screenshot = shot
	}
	return o
}

// screenshotPath is where tweak n's screenshot is kept, beside the database.
func (b *Bridge) screenshotPath(n int64) string {
	return filepath.Join(b.opts.Config.StateDir, "screenshots", strconv.FormatInt(n, 10)+".png")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// statusEntries are the statuses Claude sets with POST /tweaks/:n/status,
// each with the kind of entry its message becomes and the refusal for a
// missing one. Queued takes no message, and is refused one
// (schema/status-request.json).
var statusEntries = map[string]struct{ kind, missing string }{
	store.StatusDone:     {store.KindSummary, "done needs a summary: one sentence on what you changed"},
	store.StatusQuestion: {store.KindQuestion, "ask needs a question: what you need the developer to decide"},
	store.StatusDeclined: {store.KindReason, "decline needs a reason: why it can't or shouldn't be done here"},
	store.StatusQueued:   {},
}

// status is POST /tweaks/:n/status {status, message}: done, question and
// declined with Claude's message, or queued.
func (b *Bridge) status(w http.ResponseWriter, r *http.Request) {
	session, n, ok := tweakNumber(w, r)
	if !ok {
		return
	}
	var body struct {
		Status  string
		Message *string
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(&body)
	want, known := statusEntries[body.Status]
	if err != nil || !known {
		refuse(w, 400, "bad-request", `POST /tweaks/:n/status needs {"status": "done", "question", "declined" or "queued", "message": …}`)
		return
	}
	if want.kind == "" && body.Message != nil {
		refuse(w, 400, "bad-request", "queue takes no message: run tweak queue <n>… with the numbers only")
		return
	}
	var entry *store.Entry
	if want.kind != "" {
		if body.Message == nil {
			body.Message = new(string)
		}
		text := strings.TrimSpace(*body.Message)
		if text == "" {
			refuse(w, 400, "bad-request", want.missing)
			return
		}
		entry = &store.Entry{From: store.FromClaude, Kind: want.kind, Text: text}
	}
	tw, ok := b.setStatus(w, session, n, body.Status, entry)
	if !ok {
		return
	}
	reply(w, 200, statusOut{Number: tw.Number, Status: tw.Status})
}

// entries is POST /tweaks/:n/entries {kind: "plan", text}: Claude's plan,
// posted while it works. The status stays working.
func (b *Bridge) entries(w http.ResponseWriter, r *http.Request) {
	session, n, ok := tweakNumber(w, r)
	if !ok {
		return
	}
	var body struct{ Kind, Text string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Kind != store.KindPlan {
		refuse(w, 400, "bad-request", `POST /tweaks/:n/entries needs {"kind": "plan", "text": …}`)
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		refuse(w, 400, "bad-request", "plan needs a message: a short plan naming the file you're editing")
		return
	}
	tw, err := b.store.Plan(session, n, text)
	if !b.refuseChange(w, n, err) {
		return
	}
	reply(w, 200, statusOut{Number: tw.Number, Status: tw.Status})
}

type statusOut struct {
	Number int64  `json:"number"`
	Status string `json:"status"`
}
