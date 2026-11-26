package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	tweak "github.com/codaset/tweak"
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
}

type eventOut struct {
	Type  string   `json:"type"`
	Seq   int64    `json:"seq"`
	Event string   `json:"event"`
	Claim claimOut `json:"claim"`
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

	seq, claims, err := b.store.Snapshot()
	if err != nil {
		b.log.Print(err)
		c.Close(websocket.StatusInternalError, "the bridge failed")
		return
	}
	snap := snapshotOut{Type: "snapshot", Seq: seq, Version: b.helloVersion(), Folder: b.helloFolder(), Claims: []claimOut{}}
	for _, cl := range claims {
		snap.Claims = append(snap.Claims, claimJSON(cl))
	}
	if write(ctx, c, snap) != nil {
		return
	}

	// Reading: keepalives, and the socket closing. Silence longer than
	// SocketIdle means the worker is gone.
	go func() {
		defer cancel()
		for {
			rctx, done := context.WithTimeout(ctx, b.opts.SocketIdle)
			_, _, err := c.Read(rctx)
			done()
			if err != nil {
				return
			}
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
			if write(ctx, c, eventOut{Type: "event", Seq: e.Seq, Event: e.Type, Claim: claimJSON(e.Claim)}) != nil {
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
