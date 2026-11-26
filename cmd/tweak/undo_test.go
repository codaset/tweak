package main

import (
	"fmt"
	"strings"
	"testing"
)

// The undo-conflict round from Claude's side, through the built binary:
// the line, tweak undo, a declined undo, then tweak undone. Nothing was
// recorded here (the folder isn't a git repo, and no edit passed the
// hook), so the card's Ask Claude to undo is what sends it.
func TestAnUndoConflictIsHandledFromTheCLI(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	w := s.watch("s1", ernie)
	n := ext.create("https://ernie.localhost/", "make it green")
	w.line()
	s.tweak("s1", ernie, "work", fmt.Sprint(n))
	s.tweak("s1", ernie, "done", fmt.Sprint(n), "made it green with sed")

	askUndo := func() {
		t.Helper()
		ext.send(map[string]any{"type": "undo", "ref": "u", "number": n})
		if r := ext.until("result"); r["number"] != float64(n) {
			t.Fatalf("undo: %v", r)
		}
		if got := w.line(); got != fmt.Sprintf("tweak %d undo-conflict: no edits recorded, undo by hand", n) {
			t.Fatalf("line %q", got)
		}
	}
	askUndo()
	r := s.tweak("s1", ernie, "undo", fmt.Sprint(n))
	if r.code != 0 || !strings.Contains(r.stdout, "No edits were recorded") || !strings.Contains(r.stdout, "made it green with sed") {
		t.Fatalf("undo: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = s.tweak("s1", ernie, "decline", fmt.Sprint(n), "later work needs it")
	if r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: undo declined, change kept\n", n) {
		t.Fatalf("decline: %d %q %q", r.code, r.stdout, r.stderr)
	}

	askUndo()
	r = s.tweak("s1", ernie, "undone", fmt.Sprint(n), "put the colour back by hand")
	if r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: undone\n", n) {
		t.Fatalf("undone: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = s.tweak("s1", ernie, "undo", fmt.Sprint(n))
	if r.code != 1 || !strings.Contains(r.stderr, "no undo was asked of tweak") {
		t.Fatalf("undo after undone: %d %q", r.code, r.stderr)
	}
}

func TestUndoCommandsNeedTheirArguments(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	for _, args := range [][]string{{"undo"}, {"undo", "x"}, {"undone", "1"}, {"undone", "x", "y"}} {
		if r := s.tweak("s1", ernie, args...); r.code != 2 || !strings.HasPrefix(r.stderr, "usage: tweak "+args[0]) {
			t.Errorf("%v: %d %q", args, r.code, r.stderr)
		}
	}
}
