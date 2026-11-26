package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/store"
	"github.com/codaset/tweak/internal/version"
)

func createMsg(ref, url, request string) map[string]any {
	return map[string]any{
		"type": "create", "ref": ref, "url": url, "request": request,
		"targets": map[string]any{"elements": []any{map[string]any{"label": "button.save", "text": "Save", "selector": "#save"}}},
		"anchor":  map[string]any{"x": 0.5, "y": 0.25},
	}
}

// readUntil reads socket messages until one has the given type, checking
// each against its schema, and returns it.
func (s *socket) readUntil(typ string) map[string]any {
	s.t.Helper()
	for range 10 {
		m := s.nextAny()
		if m["type"] == typ {
			return m
		}
	}
	s.t.Fatalf("no %s message", typ)
	return nil
}

func (s *socket) nextAny() map[string]any {
	s.t.Helper()
	m := s.next("") // see next: "" picks the schema from the message's type
	return m
}

// tracer sets up a session s1 claiming ernie.localhost, with a connected,
// greeted extension socket.
func tracer(t *testing.T, opts ...func(*Options)) (*harness, *socket) {
	h := start(t, opts...)
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")
	return h, s
}

func TestCreateGivesTheTweakABridgeWideNumber(t *testing.T) {
	h, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/admin?tab=2", "make it green"))
	result := s.readUntil("result")
	if result["ref"] != "r1" || result["number"] != 1.0 {
		t.Fatalf("result %v", result)
	}
	s.send(createMsg("r2", "https://ernie.localhost/other", "another page"))
	if r := s.readUntil("result"); r["ref"] != "r2" || r["number"] != 2.0 {
		t.Fatalf("second result %v", r)
	}

	// A fresh connection's snapshot has both, with the page by origin and path.
	two := h.connect()
	two.hello(version.Protocol)
	tweaks := two.next("snapshot")["tweaks"].([]any)
	first := tweaks[0].(map[string]any)
	if len(tweaks) != 2 || first["page"] != "https://ernie.localhost/admin" || first["status"] != "sent" {
		t.Fatalf("snapshot tweaks %v", tweaks)
	}
}

// A page no claim covers gets no tweak: the composer shows why.
func TestCreateOnAnUnclaimedPageIsRefused(t *testing.T) {
	_, s := tracer(t)
	s.send(createMsg("r1", "http://localhost:3000/", "make it green"))
	r := s.readUntil("result")
	if r["error"] != "no-claim" || r["message"] != "No session claims this page. Claim it from Claude Code with /tweak http://localhost:3000" {
		t.Fatalf("result %v", r)
	}
}

func TestABadCreateIsRefusedWithItsRef(t *testing.T) {
	_, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "  "))
	r := s.readUntil("result")
	if r["ref"] != "r1" || r["error"] != "bad-request" || r["message"] == "" {
		t.Fatalf("result %v", r)
	}
	for i, bad := range []map[string]any{
		{"anchor": nil},
		{"anchor": map[string]any{"x": 1.5, "y": 0}},
		{"targets": map[string]any{"elements": []any{map[string]any{"label": "p"}}}},
	} {
		m := createMsg("bad", "https://ernie.localhost/", "make it green")
		for k, v := range bad {
			m[k] = v
		}
		if r := s.readUntilAfter(m); r["error"] != "bad-request" {
			t.Fatalf("case %d: result %v", i, r)
		}
	}
	// The socket stays open for the next try.
	s.send(createMsg("r2", "https://ernie.localhost/", "make it green"))
	if r := s.readUntil("result"); r["number"] != 1.0 {
		t.Fatalf("result %v", r)
	}
}

func TestTheRoundTrip(t *testing.T) {
	h, s := tracer(t, func(o *Options) { o.InboxWait = 500 * time.Millisecond })
	resp, body := h.do(as("s1", req{method: "GET", path: "/inbox"}))
	if resp.StatusCode != 200 {
		t.Fatalf("inbox %d %s", resp.StatusCode, body)
	}
	conforms(t, "inbox", body)
	var in struct {
		Seq    int64
		Claims int
		Lines  []struct{ Text string }
	}
	json.Unmarshal(body, &in)
	if len(in.Lines) != 0 || in.Claims != 1 {
		t.Fatalf("empty inbox %s", body)
	}

	// The watcher's long-poll returns as soon as a tweak arrives.
	got := make(chan []byte, 1)
	go func() {
		_, body := h.do(as("s1", req{method: "GET", path: "/inbox?after=" + jsonInt(in.Seq)}))
		got <- body
	}()
	time.Sleep(100 * time.Millisecond)
	s.send(createMsg("r1", "https://ernie.localhost/admin/users?x=1", "make it green"))
	// A broken wake would answer empty at InboxWait, which the line check
	// below catches; the wide window only allows for a loaded runner.
	select {
	case body = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the long-poll didn't return when the tweak arrived")
	}
	conforms(t, "inbox", body)
	json.Unmarshal(body, &in)
	if len(in.Lines) != 1 || in.Lines[0].Text != "tweak 1 new: make it green [on /admin/users, 1 element]" {
		t.Fatalf("inbox %s", body)
	}

	// Asking again acknowledges the line: the card hears "delivered".
	h.do(as("s1", req{method: "GET", path: "/inbox?after=" + jsonInt(in.Seq)}))
	if e := s.readUntilEvent("tweak-status"); e["tweak"].(map[string]any)["status"] != "delivered" {
		t.Fatalf("event %v", e)
	}

	resp, body = h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/markdown") ||
		!strings.HasPrefix(string(body), "# Tweak 1\n") || !strings.Contains(string(body), "`#save`") {
		t.Fatalf("work: %d %q %s", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	working := s.readUntilEvent("tweak-status")["tweak"].(map[string]any)
	if working["status"] != "working" {
		t.Fatalf("event %v", working)
	}

	resp, body = h.do(as("s1", req{method: "POST", path: "/tweaks/1/status", body: map[string]string{"status": "done", "message": "made it green"}}))
	if resp.StatusCode != 200 {
		t.Fatalf("done: %d %s", resp.StatusCode, body)
	}
	conforms(t, "status", body)
	done := s.readUntilEvent("tweak-status")["tweak"].(map[string]any)
	entries := done["entries"].([]any)
	if done["status"] != "done" || len(entries) != 2 || entries[1].(map[string]any)["text"] != "made it green" {
		t.Fatalf("event %v", done)
	}
}

// The brief places the page's paths in the folder of the session working
// on the tweak, and names the screenshot once there is one.
func TestTheBriefUsesTheSessionsFolderAndTheScreenshot(t *testing.T) {
	h := start(t)
	folder := t.TempDir()
	os.MkdirAll(filepath.Join(folder, "src"), 0o755)
	os.WriteFile(filepath.Join(folder, "src", "App.tsx"), nil, 0o644)
	h.register("s1", folder)
	h.claim("s1", "http://localhost:5173/*")
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")

	m := createMsg("r1", "http://localhost:5173/", "make it green")
	m["targets"] = map[string]any{"elements": []any{map[string]any{"label": "p", "selector": "p",
		"locations": []any{map[string]any{"file": "http://localhost:5173/src/App.tsx?t=1", "line": 3, "role": "element", "via": "react"}}}}}
	s.send(m)
	s.readUntil("result")

	_, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if !strings.Contains(string(body), "- `src/App.tsx:3`: element 1 (React, exact)\n") || !strings.Contains(string(body), "Screenshot: none (capture failed)\n") {
		t.Fatalf("brief:\n%s", body)
	}

	shot := filepath.Join(h.cfg.StateDir, "screenshots", "1.png")
	os.MkdirAll(filepath.Dir(shot), 0o700)
	os.WriteFile(shot, []byte("png"), 0o600)
	if _, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"})); !strings.Contains(string(body), "Screenshot: "+shot+". View it") {
		t.Fatalf("brief:\n%s", body)
	}
}

// Targets grow with styles, HTML and locations: a create bigger than the
// WebSocket library's 32 KiB default still arrives.
func TestALargeCreateArrives(t *testing.T) {
	_, s := tracer(t)
	m := createMsg("r1", "https://ernie.localhost/", "make it green")
	var els []any
	for range 5 {
		els = append(els, map[string]any{"label": "div", "selector": "div", "html": strings.Repeat("<i>x</i>", 200), "nearby": []string{strings.Repeat("y", 80)}})
	}
	for range 40 {
		els = append(els, map[string]any{"label": "div", "selector": "div", "html": strings.Repeat("<b>z</b>", 199)})
	}
	m["targets"] = map[string]any{"elements": els}
	if raw, _ := json.Marshal(m); len(raw) < 64<<10 {
		t.Fatalf("only %d bytes", len(raw))
	}
	s.send(m)
	if r := s.readUntil("result"); r["number"] != 1.0 {
		t.Fatalf("result %v", r)
	}
}

func TestStatusRefusals(t *testing.T) {
	h, s := tracer(t)
	h.register("s2", "/dev/bert")
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	for _, c := range []struct {
		name, session, path string
		body                any
		status              int
		code, message       string
	}{
		{"no such tweak", "s1", "/tweaks/9/work", nil, 404, "no-tweak", "there is no tweak 9: check the number in the tweak's card"},
		{"not a number", "s1", "/tweaks/x/work", nil, 404, "no-tweak", "there is no tweak x: check the number in the tweak's card"},
		{"another session's", "s2", "/tweaks/1/work", nil, 409, "not-yours", "tweak 1 is for the session in /dev/ernie: work on it from that session"},
		{"no session ID", "", "/tweaks/1/work", nil, 400, "no-session-id", ""},
		{"a status Claude doesn't set", "s1", "/tweaks/1/status", map[string]string{"status": "withdrawn", "message": "x"}, 400, "bad-request", ""},
		{"done without a summary", "s1", "/tweaks/1/status", map[string]string{"status": "done", "message": " "}, 400, "bad-request", ""},
		{"done before work", "s1", "/tweaks/1/status", map[string]string{"status": "done", "message": "x"}, 409, "wrong-status", "run tweak work 1 first"},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := req{method: "POST", path: c.path, body: c.body}
			if c.session != "" {
				r = as(c.session, r)
			}
			resp, body := h.do(r)
			refused(t, resp, body, c.status, c.code)
			if c.message != "" && !strings.Contains(string(body), c.message) {
				t.Fatalf("body %s, want message %q", body, c.message)
			}
		})
	}
}

func TestADoneTweakIsntWorkedOrDoneAgain(t *testing.T) {
	h, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/status", body: map[string]string{"status": "done", "message": "made it green"}}))
	resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	refused(t, resp, body, 409, "wrong-status")
	resp, body = h.do(as("s1", req{method: "POST", path: "/tweaks/1/status", body: map[string]string{"status": "done", "message": "again"}}))
	refused(t, resp, body, 409, "wrong-status")
	if !strings.Contains(string(body), "tweak 1 is already done") {
		t.Fatalf("body %s", body)
	}
}

func TestTheInboxLongPollEndsAtShutdown(t *testing.T) {
	h, _ := tracer(t)
	done := make(chan struct{})
	go func() {
		h.do(as("s1", req{method: "GET", path: "/inbox?after=999"}))
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	h.b.Shutdown()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a held long-poll kept the bridge from stopping")
	}
}

func TestEventLines(t *testing.T) {
	long := strings.Repeat("é", 400)
	for _, c := range []struct{ request, elements, want string }{
		{"make it green", `[{}]`, "tweak 7 new: make it green [on /a/b, 1 element]"},
		{"two\nlines\t here", `[{},{}]`, "tweak 7 new: two lines here [on /a/b, 2 elements]"},
		{long, `[{}]`, "tweak 7 new: " + strings.Repeat("é", 299) + "… [on /a/b, 1 element]"},
	} {
		got := newLine(7, "https://x.localhost/a/b", c.request, json.RawMessage(`{"elements":`+c.elements+`}`))
		if got != c.want {
			t.Errorf("got  %q\nwant %q", got, c.want)
		}
	}
}

func (s *socket) readUntilAfter(msg map[string]any) map[string]any {
	s.t.Helper()
	s.send(msg)
	return s.readUntil("result")
}

func TestALongPathStaysInsideTheLineCap(t *testing.T) {
	got := newLine(7, "https://x.localhost/"+strings.Repeat("a", 600), strings.Repeat("b", 400), json.RawMessage(`{"elements":[{}]}`))
	if n := len([]rune(got)); n > 500 {
		t.Fatalf("line of %d characters", n)
	}
	again := againLine(store.Tweak{Number: 1_000_000, Page: "https://x.localhost/" + strings.Repeat("a", 600),
		Targets: json.RawMessage(`{"elements":[{}]}`), Entries: []store.Entry{{Kind: store.KindRequest, Text: strings.Repeat("b", 400)}}})
	if n := len([]rune(again)); n > 500 {
		t.Fatalf("again: line of %d characters", n)
	}
}

func jsonInt(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

func (s *socket) readUntilEvent(event string) map[string]any {
	s.t.Helper()
	for range 10 {
		m := s.nextAny()
		if m["type"] == "event" && m["event"] == event {
			return m
		}
	}
	s.t.Fatalf("no %s event", event)
	return nil
}
