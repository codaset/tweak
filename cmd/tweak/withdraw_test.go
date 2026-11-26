package main

import (
	"fmt"
	"testing"
)

// A tweak withdrawn while Claude works on it, from Claude's side, through
// the built binary: the withdrawn line, Claude's decline (exit 0, the change
// kept), and tweak work, which says to skip it.
func TestAWithdrawnTweakIsHandledFromTheCLI(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	w := s.watch("s1", ernie)
	n := ext.create("https://ernie.localhost/", "make it green")
	w.line()
	s.tweak("s1", ernie, "work", fmt.Sprint(n))

	ext.send(map[string]any{"type": "withdraw", "ref": "w", "number": n})
	if r := ext.until("result"); r["number"] != float64(n) {
		t.Fatalf("withdraw: %v", r)
	}
	if got := w.line(); got != fmt.Sprintf("tweak %d withdrawn", n) {
		t.Fatalf("line %q", got)
	}
	r := s.tweak("s1", ernie, "decline", fmt.Sprint(n), "withdrawn")
	if r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: withdrawn, change kept for Undo\n", n) {
		t.Fatalf("decline: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = s.tweak("s1", ernie, "work", fmt.Sprint(n))
	if r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: withdrawn, skip it\n", n) {
		t.Fatalf("work: %d %q %q", r.code, r.stdout, r.stderr)
	}
}
