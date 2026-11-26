package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func status(h *harness, n, status, message string) (int, []byte) {
	body := map[string]string{"status": status}
	if message != "" {
		body["message"] = message
	}
	resp, out := h.do(as("s1", req{method: "POST", path: "/tweaks/" + n + "/status", body: body}))
	return resp.StatusCode, out
}

// Claude asks, the developer replies from the card, the reply reaches the
// watcher, and the next brief carries the conversation.
func TestAQuestionAndItsReply(t *testing.T) {
	h, s := tracer(t, func(o *Options) { o.InboxWait = 300 * time.Millisecond })
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	_, body := h.do(as("s1", req{method: "GET", path: "/inbox"}))
	var in struct {
		Seq   int64
		Lines []struct{ Text string }
	}
	json.Unmarshal(body, &in)
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))

	code, body := status(h, "1", "question", "Solid green, or the outline variant?")
	if code != 200 {
		t.Fatalf("ask: %d %s", code, body)
	}
	conforms(t, "status", body)
	if !strings.Contains(string(body), `"status":"question"`) {
		t.Fatalf("ask: %s", body)
	}
	asked := s.readUntilEvent("tweak-status")
	for asked["tweak"].(map[string]any)["status"] != "question" {
		asked = s.readUntilEvent("tweak-status")
	}

	s.send(map[string]any{"type": "reply", "ref": "r2", "number": 1, "text": "the outline one"})
	if r := s.readUntil("result"); r["ref"] != "r2" || r["number"] != 1.0 {
		t.Fatalf("result %v", r)
	}
	replied := s.readUntilEvent("tweak-replied")["tweak"].(map[string]any)
	if replied["status"] != "sent" {
		t.Fatalf("replied %v", replied)
	}

	_, body = h.do(as("s1", req{method: "GET", path: "/inbox?after=" + jsonInt(in.Seq)}))
	conforms(t, "inbox", body)
	json.Unmarshal(body, &in)
	if len(in.Lines) != 1 || in.Lines[0].Text != "tweak 1 reply: the outline one" {
		t.Fatalf("inbox %s", body)
	}

	_, brief := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if !strings.Contains(string(brief), `**Latest:** the developer replied to your question: "the outline one".`) ||
		!strings.Contains(string(brief), "## Conversation") {
		t.Fatalf("brief after the reply:\n%s", brief)
	}
}

func TestReplyRefusals(t *testing.T) {
	_, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	for _, c := range []struct {
		name  string
		msg   map[string]any
		error string
	}{
		{"no question asked", map[string]any{"number": 1, "text": "x"}, "not-asked"},
		{"no such tweak", map[string]any{"number": 9, "text": "x"}, "no-tweak"},
		{"no number", map[string]any{"text": "x"}, "bad-request"},
	} {
		c.msg["type"], c.msg["ref"] = "reply", c.name
		s.send(c.msg)
		if r := s.readUntil("result"); r["ref"] != c.name || r["error"] != c.error {
			t.Errorf("%s: result %v", c.name, r)
		}
	}
}

// A blank reply is refused once Claude has asked.
func TestABlankReplyIsRefused(t *testing.T) {
	h, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	status(h, "1", "question", "Which one?")
	s.send(map[string]any{"type": "reply", "ref": "r2", "number": 1, "text": "  "})
	if r := s.readUntil("result"); r["error"] != "bad-request" {
		t.Fatalf("result %v", r)
	}
}

func TestPlanQueueAndDecline(t *testing.T) {
	h, s := tracer(t)
	for _, r := range []string{"r1", "r2"} {
		s.send(createMsg(r, "https://ernie.localhost/", "make it green"))
		s.readUntil("result")
	}

	if code, body := status(h, "2", "queued", ""); code != 200 || !strings.Contains(string(body), `"status":"queued"`) {
		t.Fatalf("queue: %d %s", code, body)
	}

	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/entries", body: map[string]string{"kind": "plan", "text": "Editing buttons.css"}}))
	if resp.StatusCode != 200 {
		t.Fatalf("plan: %d %s", resp.StatusCode, body)
	}
	conforms(t, "status", body)
	planned := s.readUntilEvent("tweak-status")["tweak"].(map[string]any)
	for planned["status"] != "working" || len(planned["entries"].([]any)) < 2 {
		planned = s.readUntilEvent("tweak-status")["tweak"].(map[string]any)
	}
	if e := planned["entries"].([]any)[1].(map[string]any); e["kind"] != "plan" || e["from"] != "claude" {
		t.Fatalf("plan entry %v", e)
	}

	if code, body := status(h, "1", "declined", "the text comes from the CMS"); code != 200 || !strings.Contains(string(body), `"status":"declined"`) {
		t.Fatalf("decline: %d %s", code, body)
	}
	declined := s.readUntilEvent("tweak-status")["tweak"].(map[string]any)
	for declined["status"] != "declined" {
		declined = s.readUntilEvent("tweak-status")["tweak"].(map[string]any)
	}
	entries := declined["entries"].([]any)
	if e := entries[len(entries)-1].(map[string]any); e["kind"] != "reason" || e["text"] != "the text comes from the CMS" {
		t.Fatalf("reason entry %v", e)
	}
}

func TestConversationRefusals(t *testing.T) {
	h, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	for _, c := range []struct {
		name, path    string
		body          any
		status        int
		code, message string
	}{
		{"an unknown status", "/tweaks/1/status", map[string]string{"status": "working"}, 400, "bad-request", ""},
		{"a question with no text", "/tweaks/1/status", map[string]string{"status": "question", "message": " "}, 400, "bad-request", "ask needs a question"},
		{"a decline with no reason", "/tweaks/1/status", map[string]string{"status": "declined"}, 400, "bad-request", "decline needs a reason"},
		{"a question before work", "/tweaks/1/status", map[string]string{"status": "question", "message": "?"}, 409, "wrong-status", "run tweak work 1 first"},
		{"a plan before work", "/tweaks/1/entries", map[string]string{"kind": "plan", "text": "x"}, 409, "wrong-status", "run tweak work 1 first"},
		{"a plan with no text", "/tweaks/1/entries", map[string]string{"kind": "plan", "text": ""}, 400, "bad-request", "plan needs a message"},
		{"an entry that isn't a plan", "/tweaks/1/entries", map[string]string{"kind": "summary", "text": "x"}, 400, "bad-request", ""},
		{"a plan for no tweak", "/tweaks/9/entries", map[string]string{"kind": "plan", "text": "x"}, 404, "no-tweak", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			resp, body := h.do(as("s1", req{method: "POST", path: c.path, body: c.body}))
			refused(t, resp, body, c.status, c.code)
			if c.message != "" && !strings.Contains(string(body), c.message) {
				t.Fatalf("body %s, want message %q", body, c.message)
			}
		})
	}
}

// The handler and the schema agree: every request the schema refuses, the
// bridge refuses too, and changes nothing.
func TestEveryInvalidStatusRequestIsRefused(t *testing.T) {
	examples, _ := filepath.Glob(filepath.Join("..", "..", "schema", "examples", "invalid", "status-request.*.json"))
	if len(examples) == 0 {
		t.Fatal("no invalid status-request examples")
	}
	h, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	for _, ex := range examples {
		t.Run(filepath.Base(ex), func(t *testing.T) {
			raw, err := os.ReadFile(ex)
			if err != nil {
				t.Fatal(err)
			}
			resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/status", body: json.RawMessage(raw)}))
			refused(t, resp, body, 400, "bad-request")
		})
	}
	if tw, _ := h.b.store.Tweak(1); tw.Status != "working" || len(tw.Entries) != 1 {
		t.Fatalf("a refused request changed the tweak: %+v", tw)
	}
}

func TestReplyLines(t *testing.T) {
	long := strings.Repeat("é", 400)
	for _, c := range []struct{ text, want string }{
		{"the outline one", "tweak 7 reply: the outline one"},
		{"two\nlines", "tweak 7 reply: two lines"},
		{long, "tweak 7 reply: " + strings.Repeat("é", 299) + "…"},
	} {
		if got := replyLine(7, c.text); got != c.want {
			t.Errorf("got  %q\nwant %q", got, c.want)
		}
	}
}
