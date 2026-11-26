package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/brief"
	"github.com/codaset/tweak/internal/store"
	"github.com/codaset/tweak/internal/version"
	"github.com/coder/websocket"
)

// The WebSocket half of the bridge contract: the extension's service worker
// holds one socket to /ws, says hello, gets a snapshot, then every event
// after it. See docs/design.md, "Bridge contract".

type helloIn struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	LastSeq  int64  `json:"lastSeq"`
	Version  string `json:"version"`
}

type snapshotOut struct {
	Type    string     `json:"type"`
	Seq     int64      `json:"seq"`
	Version string     `json:"version,omitempty"` // none from a development bridge
	Folder  string     `json:"folder,omitempty"`  // where that version is, with it
	Claims  []claimOut `json:"claims"`
	Lapsed  []claimOut `json:"lapsed"` // lapsed claims that can still come back to their session
	Tweaks  []tweakOut `json:"tweaks"`
	// Resolved are the resolved tweaks still kept: the side panel's list.
	Resolved []tweakOut `json:"resolved"`
}

type eventOut struct {
	Type  string    `json:"type"`
	Seq   int64     `json:"seq"`
	Event string    `json:"event"`
	Claim *claimOut `json:"claim,omitempty"`
	Tweak *tweakOut `json:"tweak,omitempty"`
}

func (b *Bridge) eventJSON(e store.Event) eventOut {
	out := eventOut{Type: "event", Seq: e.Seq, Event: e.Type}
	if e.Claim != nil {
		c := claimJSON(*e.Claim)
		switch e.Type {
		case store.EventClaimMade, store.EventClaimRestored, store.EventClaimListening:
			c = b.heldClaimJSON(*e.Claim)
		}
		out.Claim = &c
	}
	if e.Tweak != nil {
		t := b.tweakJSON(*e.Tweak)
		out.Tweak = &t
	}
	return out
}

// createIn is a create message: the extension sends a new tweak.
type createIn struct {
	Ref     string          `json:"ref"`
	URL     string          `json:"url"`
	Request string          `json:"request"`
	Targets json.RawMessage `json:"targets"`
	Anchor  json.RawMessage `json:"anchor"`
	// Screenshot says the worker holds a capture it uploads once the tweak
	// has its number.
	Screenshot bool `json:"screenshot"`
}

// resultOut answers a message carrying a ref: the tweak's number, or why not.
type resultOut struct {
	Type    string `json:"type"`
	Ref     string `json:"ref"`
	Number  int64  `json:"number,omitempty"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

type refusalOut struct {
	Type    string `json:"type"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// changed returns a channel that is closed at the next change to the event log.
func (b *Bridge) changed() <-chan struct{} {
	b.changeMu.Lock()
	defer b.changeMu.Unlock()
	return b.change
}

// notify wakes every socket to send the events logged since its last one.
func (b *Bridge) notify() {
	b.changeMu.Lock()
	defer b.changeMu.Unlock()
	close(b.change)
	b.change = make(chan struct{})
}

// readLimit is the largest message the extension may send. A create's
// targets carry each element's context (HTML up to 1600 characters, styles,
// rules, locations), so it is well above the library's 32 KiB default.
const readLimit = 4 << 20

func (b *Bridge) socket(w http.ResponseWriter, r *http.Request) {
	// guard has already checked the Origin is exactly the extension's; the
	// library checks it again against the same ID.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{tweak.ExtensionID}})
	if err != nil {
		return
	}
	b.sockets.Add(1)
	defer b.sockets.Done()
	defer c.CloseNow()
	c.SetReadLimit(readLimit)

	// ctx is this socket's life. It isn't derived from b.closing, because a
	// cancelled read drops the connection without a close frame; shutdown is
	// handled in the loop below, which says "restarting" first.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hello, ok := b.readHello(b.closing, c)
	if !ok {
		return
	}
	b.BrowserConnected()
	defer b.BrowserDisconnected()
	b.log.Printf("extension %s connected", hello.Version)
	b.heardFrom(hello.Version)
	defer b.log.Printf("extension disconnected")

	seq, claims, tweaks, err := b.store.Snapshot()
	if err != nil {
		b.log.Print(err)
		c.Close(websocket.StatusInternalError, "the bridge failed")
		return
	}
	snap := snapshotOut{Type: "snapshot", Seq: seq, Version: b.helloVersion(), Folder: b.helloFolder(), Claims: []claimOut{}, Lapsed: []claimOut{}, Tweaks: []tweakOut{}, Resolved: []tweakOut{}}
	for _, cl := range claims {
		snap.Claims = append(snap.Claims, b.heldClaimJSON(cl))
	}
	lapsed, err := b.store.LapsedClaims()
	if err != nil {
		b.log.Print(err)
	}
	for _, cl := range lapsed {
		snap.Lapsed = append(snap.Lapsed, claimJSON(cl))
	}
	for _, tw := range tweaks {
		if tw.ResolvedAt.IsZero() {
			snap.Tweaks = append(snap.Tweaks, b.tweakJSON(tw))
		} else {
			snap.Resolved = append(snap.Resolved, b.tweakJSON(tw))
		}
	}
	if write(ctx, c, snap) != nil {
		return
	}

	// Reading: keepalives, requests, and the socket closing. Silence longer
	// than SocketIdle means the worker is gone.
	go func() {
		defer cancel()
		for {
			rctx, done := context.WithTimeout(ctx, b.opts.SocketIdle)
			_, raw, err := c.Read(rctx)
			done()
			if err != nil {
				return
			}
			b.handle(ctx, c, raw)
		}
	}()

	for {
		wake := b.changed()
		events, err := b.store.EventsAfter(seq)
		if err != nil {
			b.log.Print(err)
			return
		}
		for _, e := range events {
			// A lost claim is news for its session only: the page already
			// left the extension's claims when it lapsed.
			if e.Type == store.EventClaimLost {
				seq = e.Seq
				continue
			}
			if write(ctx, c, b.eventJSON(e)) != nil {
				return
			}
			seq = e.Seq
		}
		select {
		case <-ctx.Done():
			return
		case <-b.closing.Done():
			c.Close(websocket.StatusServiceRestart, "restarting")
			return
		case <-wake:
		}
	}
}

// handle answers one message from the extension after its hello. Writes may
// run alongside the event loop's: the library allows concurrent writers.
func (b *Bridge) handle(ctx context.Context, c *websocket.Conn, raw []byte) {
	var m struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	switch m.Type {
	case "create":
		var in createIn
		if json.Unmarshal(raw, &in) != nil || in.Ref == "" {
			return // nothing to answer to
		}
		write(ctx, c, b.create(in))
	case "reply":
		var in replyIn
		if json.Unmarshal(raw, &in) != nil || in.Ref == "" {
			return
		}
		write(ctx, c, b.reply(in))
	case "again":
		var in againIn
		if json.Unmarshal(raw, &in) != nil || in.Ref == "" {
			return
		}
		write(ctx, c, b.again(in))
	case "undo":
		var in undoIn
		if json.Unmarshal(raw, &in) != nil || in.Ref == "" {
			return
		}
		write(ctx, c, b.undo(in))
	case "withdraw", "resolve":
		var in againIn
		if json.Unmarshal(raw, &in) != nil || in.Ref == "" {
			return
		}
		write(ctx, c, map[string]func(againIn) resultOut{"withdraw": b.withdraw, "resolve": b.resolve}[m.Type](in))
	}
}

// againIn is an again message: the card's Send again, for a tweak Claude
// hasn't picked up.
type againIn struct {
	Ref    string `json:"ref"`
	Number int64  `json:"number"`
}

// again sends a delivered tweak to its session once more; its tweak-again
// event is the inbox line, and reaches every socket through the log.
func (b *Bridge) again(in againIn) resultOut {
	out := resultOut{Type: "result", Ref: in.Ref}
	if in.Number < 1 {
		out.Error, out.Message = "bad-request", "send again needs the tweak's number"
		return out
	}
	tw, err := b.store.SendAgain(in.Number)
	if err != nil {
		_, out.Error, out.Message = b.refusalOf(in.Number, err)
		return out
	}
	out.Number = tw.Number
	return out
}

// replyIn is a reply message: the developer's answer to Claude's question,
// from the card.
type replyIn struct {
	Ref    string `json:"ref"`
	Number int64  `json:"number"`
	Text   string `json:"text"`
}

// reply stores the developer's answer; its tweak-replied event reaches the
// asking session's inbox and every socket through the log.
func (b *Bridge) reply(in replyIn) resultOut {
	out := resultOut{Type: "result", Ref: in.Ref}
	if in.Number < 1 {
		out.Error, out.Message = "bad-request", "a reply needs the tweak's number"
		return out
	}
	tw, err := b.store.Reply(in.Number, in.Text)
	if err != nil {
		_, out.Error, out.Message = b.refusalOf(in.Number, err)
		return out
	}
	out.Number = tw.Number
	return out
}

// create stores a new tweak; its tweak-created event reaches every socket
// through the log.
func (b *Bridge) create(in createIn) resultOut {
	out := resultOut{Type: "result", Ref: in.Ref}
	if msg := checkCreate(in); msg != "" {
		out.Error, out.Message = "bad-request", msg
		return out
	}
	tw, err := b.store.CreateTweak(store.NewTweak{URL: in.URL, Request: in.Request, Targets: in.Targets, Anchor: in.Anchor})
	switch {
	case errors.Is(err, store.ErrBadTweak):
		out.Error, out.Message = "bad-request", err.Error()
	case errors.Is(err, store.ErrNoClaim):
		origin := in.URL
		if u, err := url.Parse(in.URL); err == nil {
			origin = u.Scheme + "://" + u.Host
		}
		out.Error, out.Message = "no-claim", "No session claims this page. Claim it from Claude Code with /tweak "+origin
	case err != nil:
		b.log.Print(err)
		out.Error, out.Message = "internal", "the bridge failed: "+err.Error()
	default:
		out.Number = tw.Number
		if in.Screenshot {
			b.expectScreenshot(tw.Number)
		}
		b.log.Printf("tweak %d created on %s", tw.Number, tw.Page)
	}
	return out
}

// checkCreate says what's wrong with a create's targets and anchor, or "".
// (The store checks the request and the URL.)
func checkCreate(in createIn) string {
	var t brief.Targets
	if json.Unmarshal(in.Targets, &t) != nil || len(t.Elements) == 0 {
		return "a tweak needs at least one element"
	}
	for _, e := range t.Elements {
		if e.Label == "" || e.Selector == "" {
			return "each element needs a label and a selector"
		}
	}
	var a struct{ X, Y *float64 }
	if json.Unmarshal(in.Anchor, &a) != nil || a.X == nil || a.Y == nil || *a.X < 0 || *a.X > 1 || *a.Y < 0 || *a.Y > 1 {
		return "a tweak needs an anchor: x and y from 0 to 1"
	}
	return ""
}

// readHello reads the first message, which must be a hello in the bridge's
// protocol; anything else is refused and the socket closed.
func (b *Bridge) readHello(ctx context.Context, c *websocket.Conn) (helloIn, bool) {
	var h helloIn
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, raw, err := c.Read(rctx)
	if err != nil {
		return h, false
	}
	if json.Unmarshal(raw, &h) != nil || h.Type != "hello" {
		b.refuseSocket(ctx, c, "bad-request", "the first message must be hello")
		return h, false
	}
	if h.Protocol != version.Protocol {
		b.refuseSocket(ctx, c, "protocol", fmt.Sprintf("This extension speaks protocol %d; the bridge speaks %d. Reload the extension.", h.Protocol, version.Protocol))
		return h, false
	}
	return h, true
}

func (b *Bridge) refuseSocket(ctx context.Context, c *websocket.Conn, code, message string) {
	write(ctx, c, refusalOut{Type: "refusal", Error: code, Message: message})
	c.Close(websocket.StatusPolicyViolation, code)
}

func write(ctx context.Context, c *websocket.Conn, v any) error {
	raw, _ := json.Marshal(v)
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, raw)
}
