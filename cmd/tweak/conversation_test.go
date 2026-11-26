package main

import (
	"fmt"
	"strings"
	"testing"
)

// Claude asks; the developer's reply comes back to the watcher; work again
// carries the conversation; done finishes it.
func TestAskReplyDone(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	w := s.watch("s1", ernie)
	n := ext.create("https://ernie.localhost/", "make it green")
	w.line()
	s.tweak("s1", ernie, "work", fmt.Sprint(n))

	if r := s.tweak("s1", ernie, "plan", fmt.Sprint(n), "Editing buttons.css"); r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: plan posted\n", n) {
		t.Fatalf("plan: %d %q %q", r.code, r.stdout, r.stderr)
	}
	if r := s.tweak("s1", ernie, "ask", fmt.Sprint(n), "Solid or outline?"); r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: question\n", n) {
		t.Fatalf("ask: %d %q %q", r.code, r.stdout, r.stderr)
	}
	ext.send(map[string]any{"type": "reply", "ref": "r2", "number": n, "text": "outline"})
	if got := w.line(); got != fmt.Sprintf("tweak %d reply: outline", n) {
		t.Fatalf("line %q", got)
	}
	r := s.tweak("s1", ernie, "work", fmt.Sprint(n))
	if r.code != 0 || !strings.Contains(r.stdout, "**Latest:**") || !strings.Contains(r.stdout, "**You** (plan): Editing buttons.css") {
		t.Fatalf("work again: %d %q %q", r.code, r.stdout, r.stderr)
	}
	if r := s.tweak("s1", ernie, "done", fmt.Sprint(n), "made it outline green"); r.code != 0 {
		t.Fatalf("done: %q", r.stderr)
	}
}

func TestQueueAndDecline(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	a := ext.create("https://ernie.localhost/", "one")
	b := ext.create("https://ernie.localhost/", "two")

	// Each tweak gets its own line; a refused one says why on stderr, and
	// the others still go through.
	r := s.tweak("s1", ernie, "queue", fmt.Sprint(a), "99", fmt.Sprint(b))
	if r.code != 1 || r.stdout != fmt.Sprintf("tweak %d: queued\ntweak %d: queued\n", a, b) ||
		r.stderr != "there is no tweak 99: check the number in the tweak's card\n" {
		t.Fatalf("queue: %d %q %q", r.code, r.stdout, r.stderr)
	}
	if r := s.tweak("s1", ernie, "decline", fmt.Sprint(a), "it comes from the CMS"); r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: declined\n", a) {
		t.Fatalf("decline: %d %q %q", r.code, r.stdout, r.stderr)
	}
	if r := s.tweak("s1", ernie, "ask", fmt.Sprint(b), "which?"); r.code != 1 || r.stderr != fmt.Sprintf("tweak %d isn't being worked on: run tweak work %d first\n", b, b) {
		t.Fatalf("ask before work: %d %q", r.code, r.stderr)
	}
}

func TestConversationCommandsNeedTheirArguments(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	for _, args := range [][]string{{"plan", "1"}, {"ask", "x", "y"}, {"decline", "1"}, {"queue"}, {"queue", "1", "x"}} {
		if r := s.tweak("s1", ernie, args...); r.code != 2 || !strings.HasPrefix(r.stderr, "usage: tweak "+args[0]) {
			t.Errorf("%v: %d %q", args, r.code, r.stderr)
		}
	}
}
