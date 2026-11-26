package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/pattern"
	"github.com/codaset/tweak/internal/version"
	"github.com/coder/websocket"
)

// Any write to the event log wakes the sockets, not only the HTTP handlers'.
func TestAnEventFromOutsideTheHTTPHandlersReachesTheSocket(t *testing.T) {
	h := start(t)
	h.register("s1", "/dev/a")
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")

	p, _ := pattern.Parse("https://elsewhere.localhost/*")
	if _, err := h.b.store.Claim("s1", p); err != nil {
		t.Fatal(err)
	}
	if e := s.next("event"); e["event"] != "claim-made" {
		t.Fatalf("event = %v", e)
	}
}

var ourOrigin = "chrome-extension://" + tweak.ExtensionID

// dial opens /ws the way the extension's service worker does.
func (h *harness) dial(origin, host string) (*websocket.Conn, *http.Response, error) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	if host != "" {
		hdr.Set("Host", host)
	}
	c, resp, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws", h.b.Port()), &websocket.DialOptions{HTTPHeader: hdr, Host: host})
	if c != nil {
		h.t.Cleanup(func() { c.CloseNow() })
	}
	return c, resp, err
}

type socket struct {
	t *testing.T
	c *websocket.Conn
}

func (h *harness) connect() *socket {
	h.t.Helper()
	c, _, err := h.dial(ourOrigin, "")
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	return &socket{t: h.t, c: c}
}

func (s *socket) send(v any) {
	s.t.Helper()
	raw, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.c.Write(ctx, websocket.MessageText, raw); err != nil {
		s.t.Fatalf("write: %v", err)
	}
}

func (s *socket) hello(protocol int) {
	s.t.Helper()
	s.send(map[string]any{"type": "hello", "protocol": protocol, "lastSeq": 0, "version": "1.2.3"})
}

// next reads one message, checks it against its schema ("" takes the
// message's own type as the schema), and decodes it.
func (s *socket) next(schema string) map[string]any {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := s.c.Read(ctx)
	if err != nil {
		s.t.Fatalf("read: %v", err)
	}
	var m map[string]any
	json.Unmarshal(raw, &m)
	if schema == "" {
		schema, _ = m["type"].(string)
	}
	conforms(s.t, schema, raw)
	return m
}

// closed waits for the bridge to close the socket and returns its status.
func (s *socket) closed() websocket.StatusCode {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := s.c.Read(ctx); err != nil {
			if ctx.Err() != nil {
				s.t.Fatal("socket still open")
			}
			return websocket.CloseStatus(err)
		}
	}
}

func TestSocketOnlyFromTheExtensionsExactOrigin(t *testing.T) {
	h := start(t)
	port := h.b.Port()
	for _, c := range []struct{ name, origin, host string }{
		{"no origin", "", ""},
		{"web origin", "https://evil.example", ""},
		{"dev server origin", fmt.Sprintf("http://localhost:%d", port), ""},
		{"the bridge's own origin", fmt.Sprintf("http://127.0.0.1:%d", port), ""},
		{"null origin", "null", ""},
		{"another extension", "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh", ""},
		{"our ID with a suffix", ourOrigin + "x", ""},
		{"our ID on another scheme", "https://" + tweak.ExtensionID, ""},
		{"rebinding host", ourOrigin, fmt.Sprintf("evil.example:%d", port)},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, resp, err := h.dial(c.origin, c.host)
			if err == nil {
				t.Fatal("socket accepted")
			}
			if resp == nil || resp.StatusCode != 403 {
				t.Fatalf("want 403, got %v %v", resp, err)
			}
			if resp.Header.Get("x-tweak-version") != "1.2.3" {
				t.Error("refusal without x-tweak-version")
			}
		})
	}
	if _, _, err := h.dial(ourOrigin, fmt.Sprintf("localhost:%d", port)); err != nil {
		t.Fatalf("the extension was refused: %v", err)
	}
}

func TestHelloGetsTheSnapshotThenClaimEvents(t *testing.T) {
	h := start(t)
	h.register("s1", "/dev/a")
	h.claim("s1", "https://a.localhost")

	s := h.connect()
	s.hello(version.Protocol)
	snap := s.next("snapshot")
	claims := snap["claims"].([]any)
	if len(claims) != 1 || claims[0].(map[string]any)["pattern"] != "https://a.localhost/*" {
		t.Fatalf("snapshot = %v", snap)
	}
	seq := snap["seq"].(float64)

	h.claim("s1", "https://b.localhost/*")
	made := s.next("event")
	if made["event"] != "claim-made" || made["claim"].(map[string]any)["pattern"] != "https://b.localhost/*" || made["seq"].(float64) <= seq {
		t.Fatalf("event = %v", made)
	}

	h.do(as("s1", req{method: "DELETE", path: "/claims?pattern=https://a.localhost/*"}))
	gone := s.next("event")
	if gone["event"] != "claim-released" || gone["claim"].(map[string]any)["pattern"] != "https://a.localhost/*" || gone["seq"].(float64) <= made["seq"].(float64) {
		t.Fatalf("event = %v", gone)
	}
}

func TestEveryConnectionGetsItsOwnSnapshot(t *testing.T) {
	h := start(t)
	h.register("s1", "/dev/a")
	h.claim("s1", "https://a.localhost/*")
	one := h.connect()
	one.hello(version.Protocol)
	one.next("snapshot")
	h.claim("s1", "https://b.localhost/*")
	one.next("event")

	// A worker restart says hello with lastSeq 0 and rebuilds from scratch.
	two := h.connect()
	two.hello(version.Protocol)
	if claims := two.next("snapshot")["claims"].([]any); len(claims) != 2 {
		t.Fatalf("snapshot claims = %v", claims)
	}
}

func TestSocketProtocolMismatchIsRefused(t *testing.T) {
	h := start(t)
	other := version.Protocol + 1
	s := h.connect()
	s.hello(other)
	m := s.next("refusal")
	want := fmt.Sprintf("This extension speaks protocol %d; the bridge speaks %d. Reload the extension.", other, version.Protocol)
	if m["error"] != "protocol" || m["message"] != want {
		t.Fatalf("refusal %v\nwant message %q", m, want)
	}
	if st := s.closed(); st != websocket.StatusPolicyViolation {
		t.Fatalf("close status %v", st)
	}
}

func TestSocketMustStartWithHello(t *testing.T) {
	h := start(t)
	s := h.connect()
	s.send(map[string]any{"type": "keepalive"})
	if m := s.next("refusal"); m["error"] != "bad-request" {
		t.Fatalf("refusal %v", m)
	}
	s.closed()
}

func TestAConnectedExtensionCountsAsABrowser(t *testing.T) {
	h := start(t)
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")
	if n := h.b.browsers.Load(); n != 1 {
		t.Fatalf("browsers = %d after hello", n)
	}
	s.c.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return h.b.browsers.Load() == 0 }, "browser count back to 0")
}

func TestKeepalivesHoldTheSocketAndSilenceDropsIt(t *testing.T) {
	h := start(t, func(o *Options) { o.SocketIdle = 300 * time.Millisecond })
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")
	for range 5 {
		time.Sleep(150 * time.Millisecond)
		s.send(map[string]any{"type": "keepalive"})
	}
	if h.b.browsers.Load() != 1 {
		t.Fatal("dropped a socket that sent keepalives")
	}
	s.closed() // silent for longer than SocketIdle
	waitFor(t, func() bool { return h.b.browsers.Load() == 0 }, "silent socket dropped")
}

func TestShutdownClosesSocketsAsRestarting(t *testing.T) {
	h := start(t)
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")
	h.b.Shutdown()
	if st := s.closed(); st != websocket.StatusServiceRestart {
		t.Fatalf("close status %v", st)
	}
}

func waitFor(t *testing.T, ok func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
