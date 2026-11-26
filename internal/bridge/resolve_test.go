package bridge

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/store"
	"github.com/codaset/tweak/internal/version"
)

// Withdraw, Resolve and retention (docs/design.md, "When the session goes
// quiet", "Storage").

// withdraw sends the card's Withdraw and reads its result and the event
// that follows, in either order.
func (s *socket) withdraw(ref string, n int, event string) (result, tweak map[string]any) {
	s.t.Helper()
	return s.request(map[string]any{"type": "withdraw", "ref": ref, "number": n}, ref, event)
}

func (s *socket) resolve(ref string, n int, event string) (result, tweak map[string]any) {
	s.t.Helper()
	return s.request(map[string]any{"type": "resolve", "ref": ref, "number": n}, ref, event)
}

// request sends msg, then reads its result and, unless event is "", the
// tweak event that follows. They go out on their own, so either may come
// first.
func (s *socket) request(msg map[string]any, ref, event string) (result, tweak map[string]any) {
	s.t.Helper()
	s.send(msg)
	for i := 0; i < 10 && (result == nil || (event != "" && tweak == nil)); i++ {
		switch m := s.nextAny(); {
		case m["type"] == "result" && m["ref"] == ref:
			result = m
		case m["event"] == event:
			tweak = m["tweak"].(map[string]any)
		}
	}
	if result == nil || (event != "" && tweak == nil) {
		s.t.Fatalf("%s %s: result %v, %s %v", msg["type"], ref, result, event, tweak)
	}
	return result, tweak
}

// A tweak withdrawn while Claude works on it: the session hears it, the
// capture goes on until Claude's next command, which keeps the change and
// leaves it withdrawn; the change can then be undone.
func TestAWithdrawWhileWorkingReachesClaudeAndKeepsTheChange(t *testing.T) {
	dir := project(t, map[string]string{"app.css": appCSS})
	h, s := capturing(t, dir)
	from := poll(t, h, -1).Seq // the new line
	h.before("s1", filepath.Join(dir, "app.css"))
	writeFile(t, filepath.Join(dir, "app.css"), "a\nB\nc\nd\ne\nf\ng\n")

	result, tw := s.withdraw("w1", 1, "tweak-withdrawn")
	if result["number"] != 1.0 || tw["status"] != "withdrawn" || tw["resolvedAt"] == nil || tw["deleteAt"] == nil {
		t.Fatalf("result %v, tweak %v", result, tw)
	}
	if got := texts(poll(t, h, from)); len(got) != 1 || got[0] != "tweak 1 withdrawn" {
		t.Fatalf("inbox %q", got)
	}
	if !h.marked("s1") {
		t.Fatal("the click ended the capture: an edit under way would go unrecorded")
	}

	code, body := status(h, "1", "declined", "withdrawn")
	if code != 200 || !strings.Contains(string(body), `"status":"withdrawn"`) {
		t.Fatalf("decline: %d %s", code, body)
	}
	if h.marked("s1") {
		t.Fatal("still capturing after Claude's decline")
	}
	ended, _ := h.b.store.Tweak(1)
	if ended.Status != store.StatusWithdrawn || ended.Change.State != store.ChangeRecorded || len(ended.Change.Files) != 1 {
		t.Fatalf("status %s, change %+v", ended.Status, ended.Change)
	}
	if result, _ := s.undo("u1", 1, "tweak-undone"); result["number"] != 1.0 {
		t.Fatalf("undo %v", result)
	}
	if read(t, filepath.Join(dir, "app.css")) != appCSS {
		t.Fatal("app.css isn't back")
	}
}

// tweak work on a withdrawn tweak says to skip it, exits cleanly and starts
// no capture; one that was capturing ends.
func TestWorkOnAWithdrawnTweakSaysSkipIt(t *testing.T) {
	dir := project(t, map[string]string{"app.css": appCSS})
	h, s := capturing(t, dir)
	s.withdraw("w1", 1, "tweak-withdrawn")
	resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if resp.StatusCode != 200 || string(body) != "tweak 1: withdrawn, skip it\n" {
		t.Fatalf("work: %d %q", resp.StatusCode, body)
	}
	if h.marked("s1") {
		t.Fatal("still capturing a withdrawn tweak after tweak work")
	}
	if tw, _ := h.b.store.Tweak(1); tw.Status != store.StatusWithdrawn {
		t.Fatalf("status %s", tw.Status)
	}
}

func TestOnlyAnOpenTweakIsWithdrawnAndOnlyAFinishedOneResolved(t *testing.T) {
	h, s := tracer(t, func(o *Options) { o.InboxWait = 100 * time.Millisecond })
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	if result, _ := s.resolve("x1", 1, ""); result["error"] != "not-finished" {
		t.Fatalf("resolve of a sent tweak: %v", result)
	}
	// A sent tweak is simply resolved: Claude hears nothing.
	_, tw := s.withdraw("w1", 1, "tweak-resolved")
	if tw["status"] != "withdrawn" {
		t.Fatalf("tweak %v", tw)
	}
	if got := texts(poll(t, h, -1)); len(got) != 0 {
		t.Fatalf("inbox %q, want nothing", got)
	}
	if result, _ := s.withdraw("w2", 1, ""); result["error"] != "not-open" {
		t.Fatalf("withdraw again: %v", result)
	}
	if result, _ := s.withdraw("w3", 9, ""); result["error"] != "no-tweak" {
		t.Fatalf("withdraw of no tweak: %v", result)
	}
}

// Resolve takes the pin off the page: a new snapshot lists the tweak among
// the resolved ones, not the open ones.
func TestAResolvedTweakIsListedApart(t *testing.T) {
	h, s, _ := finished(t)
	result, tw := s.resolve("x1", 1, "tweak-resolved")
	if result["number"] != 1.0 || tw["status"] != "done" || tw["resolvedAt"] == nil {
		t.Fatalf("result %v, tweak %v", result, tw)
	}
	again := h.connect()
	again.hello(version.Protocol)
	snap := again.next("snapshot")
	if open, resolved := snap["tweaks"].([]any), snap["resolved"].([]any); len(open) != 0 || len(resolved) != 1 {
		t.Fatalf("open %v, resolved %v", open, resolved)
	}
}

// Resolved tweaks, their changes and screenshots go 7 days after
// resolution; open ones stay.
func TestResolvedTweaksAreDeletedAfterAWeek(t *testing.T) {
	c := &fakeClock{t: time.Now().Add(time.Hour).Truncate(time.Millisecond)}
	h, s := tracer(t, func(o *Options) {
		o.Clock = c.now
		o.ExpireCheck = 5 * time.Millisecond
	})
	for _, r := range []string{"r1", "r2"} {
		s.send(createMsg(r, "https://ernie.localhost/", "make it green"))
		s.readUntil("result")
	}
	shot := h.b.screenshotPath(1)
	writeFile(t, shot, "\x89PNG")
	s.withdraw("w1", 1, "tweak-resolved")
	c.advance(7*24*time.Hour - time.Second)
	time.Sleep(50 * time.Millisecond)
	if _, err := h.b.store.Tweak(1); err != nil {
		t.Fatalf("deleted early: %v", err)
	}
	c.advance(time.Second)
	waitFor(t, func() bool {
		_, err := h.b.store.Tweak(1)
		return errors.Is(err, store.ErrNoTweak)
	}, "tweak 1 to be deleted")
	if _, err := os.Stat(shot); !os.IsNotExist(err) {
		t.Fatalf("its screenshot is still there: %v", err)
	}
	if _, err := h.b.store.Tweak(2); err != nil {
		t.Fatalf("the open tweak: %v", err)
	}
}
