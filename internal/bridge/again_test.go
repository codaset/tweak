package bridge

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// fakeClock is the bridge's time, moved on by the test.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// againBridge is the tracer setup on a fake clock that starts ahead of real
// time, swept every few milliseconds, with short long-polls.
func againBridge(t *testing.T) (*harness, *socket, *fakeClock) {
	c := &fakeClock{t: time.Now().Add(time.Hour).Truncate(time.Millisecond)}
	h, s := tracer(t, func(o *Options) {
		o.Clock = c.now
		o.AgainCheck = 5 * time.Millisecond
		o.InboxWait = 200 * time.Millisecond
	})
	return h, s, c
}

type inboxReply struct {
	Seq   int64
	Lines []struct{ Text string }
}

func poll(t *testing.T, h *harness, after int64) inboxReply {
	t.Helper()
	path := "/inbox"
	if after >= 0 {
		path += "?after=" + jsonInt(after)
	}
	_, body := h.do(as("s1", req{method: "GET", path: path}))
	conforms(t, "inbox", body)
	var in inboxReply
	json.Unmarshal(body, &in)
	return in
}

func texts(in inboxReply) []string {
	var out []string
	for _, l := range in.Lines {
		out = append(out, l.Text)
	}
	return out
}

// tweakEvent reads socket messages until a tweak event of the given type.
func (s *socket) tweakEvent(event string) map[string]any {
	s.t.Helper()
	return s.readUntilEvent(event)["tweak"].(map[string]any)
}

func TestAnUnconfirmedTweakComesBackAsAgainAtMostTwice(t *testing.T) {
	h, s, c := againBridge(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	in := poll(t, h, -1)
	const line = "tweak 1 new: make it green [on /, 1 element]"
	if got := texts(in); len(got) != 1 || got[0] != line {
		t.Fatalf("first line %v", got)
	}
	in = poll(t, h, in.Seq) // the ack: delivered, waiting 3 minutes from now
	delivered := s.tweakEvent("tweak-status")
	want := stamp(c.now().Add(3 * time.Minute))
	if delivered["status"] != "delivered" || delivered["againAt"] != want || delivered["resends"] != nil {
		t.Fatalf("delivered %v, want againAt %s", delivered, want)
	}

	c.advance(3*time.Minute - time.Second)
	if got := texts(poll(t, h, in.Seq)); len(got) != 0 {
		t.Fatalf("sent again before 3 minutes: %v", got)
	}
	again := "tweak 1 again: " + line
	for n := 1.0; n <= 2; n++ {
		c.advance(3 * time.Minute)
		in = poll(t, h, in.Seq)
		if got := texts(in); len(got) != 1 || got[0] != again {
			t.Fatalf("again %v: %v", n, got)
		}
		if tw := s.tweakEvent("tweak-again"); tw["status"] != "delivered" || tw["resends"] != n || tw["againAt"] != nil {
			t.Fatalf("again event %v", tw)
		}
		// The next wait starts when this line is printed: its ack.
		c.advance(time.Hour)
		in = poll(t, h, in.Seq)
		if tw := s.tweakEvent("tweak-status"); tw["againAt"] != stamp(c.now().Add(3*time.Minute)) || tw["resends"] != n {
			t.Fatalf("after again %v's ack: %v", n, tw)
		}
	}
	c.advance(time.Hour)
	if got := texts(poll(t, h, in.Seq)); len(got) != 0 {
		t.Fatalf("a third again: %v", got)
	}
}

func TestWorkConfirmsATweak(t *testing.T) {
	h, s, c := againBridge(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	in := poll(t, h, -1)
	in = poll(t, h, in.Seq)
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	c.advance(time.Hour)
	if got := texts(poll(t, h, in.Seq)); len(got) != 0 {
		t.Fatalf("a tweak being worked on came back: %v", got)
	}
}

func TestAnAgainLineRepeatsTheReply(t *testing.T) {
	h, s, c := againBridge(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	in := poll(t, h, -1)
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	status(h, "1", "question", "which green?")
	s.readUntilAfter(map[string]any{"type": "reply", "ref": "r2", "number": 1, "text": "the dark one"})
	in = poll(t, h, in.Seq)
	in = poll(t, h, in.Seq)
	c.advance(3 * time.Minute)
	if got := texts(poll(t, h, in.Seq)); len(got) != 1 || got[0] != "tweak 1 again: tweak 1 reply: the dark one" {
		t.Fatalf("again after a reply: %v", got)
	}
}

func TestSendAgainFromTheCard(t *testing.T) {
	h, s, _ := againBridge(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	in := poll(t, h, -1)
	in = poll(t, h, in.Seq)

	r := s.readUntilAfter(map[string]any{"type": "again", "ref": "r2", "number": 1})
	if r["ref"] != "r2" || r["number"] != 1.0 {
		t.Fatalf("result %v", r)
	}
	in = poll(t, h, in.Seq)
	if got := texts(in); len(got) != 1 || got[0] != "tweak 1 again: tweak 1 new: make it green [on /, 1 element]" {
		t.Fatalf("inbox %v", got)
	}

	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	r = s.readUntilAfter(map[string]any{"type": "again", "ref": "r3", "number": 1})
	if r["error"] != "picked-up" || r["message"] != "Claude has picked this up already" {
		t.Fatalf("send again once working: %v", r)
	}
	if r = s.readUntilAfter(map[string]any{"type": "again", "ref": "r4", "number": 9}); r["error"] != "no-tweak" {
		t.Fatalf("send again on no tweak: %v", r)
	}
	if r = s.readUntilAfter(map[string]any{"type": "again", "ref": "r5"}); r["error"] != "bad-request" {
		t.Fatalf("send again with no number: %v", r)
	}
}
