package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/version"
)

// When the session goes quiet (docs/design.md), on the bridge's clock: the
// sweep runs every few milliseconds of real time, and the test moves the
// clock on by minutes.

func quietBridge(t *testing.T, folder string, opts ...func(*Options)) (*harness, *socket, *fakeClock) {
	t.Helper()
	c := &fakeClock{t: time.Now().Add(time.Hour).Truncate(time.Millisecond)}
	h := start(t, append([]func(*Options){func(o *Options) {
		o.Clock = c.now
		o.LapseCheck = 5 * time.Millisecond
		o.AgainCheck = 5 * time.Millisecond
		o.InboxWait = 100 * time.Millisecond
	}}, opts...)...)
	h.register("s1", folder)
	h.claim("s1", "https://ernie.localhost/*")
	s := h.connect()
	s.hello(version.Protocol)
	s.next("snapshot")
	return h, s, c
}

// eventOf reads socket messages until the event, checking each against its schema.
func (s *socket) eventOf(event string) map[string]any {
	s.t.Helper()
	for range 40 {
		if m := s.nextAny(); m["type"] == "event" && m["event"] == event {
			return m
		}
	}
	s.t.Fatalf("no %s event", event)
	return nil
}

// eventually waits up to 2 s of real time for ok.
func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("%s didn't happen", what)
}

func (h *harness) tweakStatus(n int) map[string]any {
	h.t.Helper()
	snap := h.connect()
	snap.hello(version.Protocol)
	for _, tw := range snap.next("snapshot")["tweaks"].([]any) {
		if tw := tw.(map[string]any); tw["number"] == float64(n) {
			return tw
		}
	}
	h.t.Fatalf("no tweak %d in the snapshot", n)
	return nil
}

func TestALapseEndsCaptureAndTheSessionGetsItsTweakBack(t *testing.T) {
	folder := project(t, map[string]string{"app.css": "red", "b.css": "one"})
	h, s, c := quietBridge(t, folder)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	poll(t, h, poll(t, h, -1).Seq)
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	h.before("s1", filepath.Join(folder, "app.css"))
	writeFile(t, filepath.Join(folder, "app.css"), "green")

	c.advance(10*time.Minute - time.Second)
	time.Sleep(50 * time.Millisecond)
	if !h.marked("s1") {
		t.Fatal("lapsed before 10 minutes")
	}
	c.advance(time.Second)
	lapsed := s.eventOf("claim-lapsed")
	if lapsed["claim"].(map[string]any)["pattern"] != "https://ernie.localhost/*" {
		t.Fatalf("lapsed %v", lapsed)
	}
	eventually(t, "the capture ending", func() bool { return !h.marked("s1") })
	ended := s.eventOf("tweak-status")
	for ended["tweak"].(map[string]any)["change"] == nil {
		ended = s.eventOf("tweak-status")
	}
	if tw := ended["tweak"].(map[string]any); tw["status"] != "sent" || shown(t, ended, "files") != "app.css" {
		t.Fatalf("after the lapse %v", tw)
	}
	// Edits made while lapsed pass the hook with no marker: unrecorded.
	writeFile(t, filepath.Join(folder, "b.css"), "two")

	c.advance(time.Hour)
	resp, _ := h.do(as("s1", req{method: "GET", path: "/claims"}))
	if w := resp.Header.Values("x-tweak-warning"); len(w) != 0 {
		t.Fatalf("warnings on a return: %v", w)
	}
	if s.eventOf("claim-restored")["claim"].(map[string]any)["pattern"] != "https://ernie.localhost/*" {
		t.Fatal("no claim-restored")
	}
	if !h.marked("s1") {
		t.Fatal("capture didn't start again")
	}
	if tw := h.tweakStatus(1); tw["status"] != "working" {
		t.Fatalf("restored as %v", tw["status"])
	}
	if got := texts(poll(t, h, -1)); len(got) != 1 || got[0] != "claim restored: https://ernie.localhost/*" {
		t.Fatalf("inbox %v", got)
	}
	status(h, "1", "done", "made it green")
	done := s.eventOf("tweak-status")
	for done["tweak"].(map[string]any)["status"] != "done" {
		done = s.eventOf("tweak-status")
	}
	if f, u := shown(t, done, "files"), shown(t, done, "unrecorded"); f != "app.css" || u != "b.css" {
		t.Fatalf("files %q, unrecorded %q", f, u)
	}
}

func TestAWatcherHoldingItsLongPollDoesntLapse(t *testing.T) {
	h, s, c := quietBridge(t, "/dev/ernie", func(o *Options) { o.InboxWait = 400 * time.Millisecond })
	in := poll(t, h, -1)
	held := make(chan struct{})
	go func() {
		defer close(held)
		h.do(as("s1", req{method: "GET", path: "/inbox?after=" + jsonInt(in.Seq)}))
	}()
	time.Sleep(50 * time.Millisecond)
	c.advance(time.Hour)
	time.Sleep(100 * time.Millisecond)
	<-held
	time.Sleep(50 * time.Millisecond)
	_, body := h.do(req{method: "GET", path: "/claims"})
	if !strings.Contains(string(body), "ernie.localhost") {
		t.Fatalf("lapsed while its watcher listened: %s", body)
	}
	_ = s
}

func TestAClaimLostMeanwhileIsSaidAndRefused(t *testing.T) {
	h, s, c := quietBridge(t, "/dev/ernie")
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	in := poll(t, h, -1)
	poll(t, h, in.Seq)
	c.advance(10 * time.Minute)
	s.eventOf("claim-lapsed")

	h.register("s2", "/dev/ernie-2")
	if resp, body := h.claim("s2", "https://ernie.localhost/*"); resp.StatusCode != 201 {
		t.Fatalf("claiming a lapsed page: %d %s", resp.StatusCode, body)
	}
	// The tweak goes to s2 as new.
	_, body := h.do(as("s2", req{method: "GET", path: "/inbox"}))
	var in2 inboxReply
	json.Unmarshal(body, &in2)
	if got := texts(in2); len(got) != 1 || got[0] != "tweak 1 new: make it green [on /, 1 element]" {
		t.Fatalf("s2's inbox %v", got)
	}

	const lost = "claim lost: https://ernie.localhost/* is now claimed by the session in /dev/ernie-2"
	resp, _ := h.do(as("s1", req{method: "GET", path: "/claims"}))
	if w := resp.Header.Values("x-tweak-warning"); len(w) != 1 || w[0] != lost {
		t.Fatalf("warnings %v", w)
	}
	if resp, _ := h.do(as("s1", req{method: "GET", path: "/claims"})); len(resp.Header.Values("x-tweak-warning")) != 0 {
		t.Fatal("told twice")
	}
	code, body := status(h, "1", "done", "did it")
	if code != 409 || !strings.Contains(string(body), lost) {
		t.Fatalf("done on a lost tweak: %d %s", code, body)
	}
	conforms(t, "error", body)
	// Its watcher says so, then stops: no claims left.
	_, body = h.do(as("s1", req{method: "GET", path: "/inbox"}))
	var in1 inboxReply
	json.Unmarshal(body, &in1)
	if got := texts(in1); len(got) != 1 || got[0] != lost {
		t.Fatalf("s1's inbox %v", got)
	}
}

func TestCommandsWarnAfterAMinuteWithNoWatcher(t *testing.T) {
	h, _, c := quietBridge(t, "/dev/ernie")
	warned := func() bool {
		resp, _ := h.do(as("s1", req{method: "GET", path: "/claims"}))
		w := resp.Header.Values("x-tweak-warning")
		return len(w) == 1 && w[0] == "no watcher running: start a Monitor with tweak watch"
	}
	c.advance(59 * time.Second)
	if warned() {
		t.Fatal("warned before a minute")
	}
	c.advance(time.Second)
	if !warned() {
		t.Fatal("no warning after a minute")
	}
	// The watcher's own poll isn't warned, and resets the minute.
	in := poll(t, h, -1)
	resp, _ := h.do(as("s1", req{method: "GET", path: "/inbox?after=" + jsonInt(in.Seq)}))
	if len(resp.Header.Values("x-tweak-warning")) != 0 {
		t.Fatal("the watcher was warned")
	}
	if warned() {
		t.Fatal("warned straight after a poll")
	}
	// A session with no claims isn't warned.
	h.register("s2", "/dev/bert")
	c.advance(time.Hour)
	resp, _ = h.do(as("s2", req{method: "GET", path: "/claims"}))
	if len(resp.Header.Values("x-tweak-warning")) != 0 {
		t.Fatal("a session with no claims was warned")
	}
}

func TestASessionEndingReleasesItsClaimsAndEndsCapture(t *testing.T) {
	folder := project(t, map[string]string{"app.css": "red"})
	h, s, _ := quietBridge(t, folder)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	in := poll(t, h, -1)
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if resp, body := h.do(as("s1", req{method: "POST", path: "/sessions/end"})); resp.StatusCode != 204 {
		t.Fatalf("end: %d %s", resp.StatusCode, body)
	}
	if h.marked("s1") {
		t.Fatal("still capturing")
	}
	if got := texts(poll(t, h, in.Seq)); len(got) != 1 || got[0] != "claim released: https://ernie.localhost/*" {
		t.Fatalf("the watcher heard %v", got)
	}
	if tw := h.tweakStatus(1); tw["status"] != "sent" {
		t.Fatalf("the tweak is %v", tw["status"])
	}
}

func TestASessionEndedWhileNoBridgeRanIsEndedAtStart(t *testing.T) {
	state := t.TempDir()
	h := start(t, func(o *Options) { o.Config.StateDir = state })
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	h.b.Shutdown()
	<-h.done
	h.done <- nil

	marker := h.cfg.Released("s1")
	os.MkdirAll(filepath.Dir(marker), 0o700)
	os.WriteFile(marker, []byte("s1\n"), 0o600)
	again := start(t, func(o *Options) { o.Config.StateDir = state })
	_, body := again.do(req{method: "GET", path: "/claims"})
	if strings.Contains(string(body), "ernie.localhost") {
		t.Fatalf("still claimed: %s", body)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("the marker is still there")
	}
}

func TestAWorkingTweakHandedOverBringsANoticeToTheBrief(t *testing.T) {
	folder := project(t, map[string]string{"app.css": "red"})
	h, s, _ := quietBridge(t, folder)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	h.before("s1", filepath.Join(folder, "app.css"))
	writeFile(t, filepath.Join(folder, "app.css"), "green")
	h.do(as("s1", req{method: "DELETE", path: "/claims"}))
	h.register("s2", folder)
	h.claim("s2", "https://ernie.localhost/*")
	_, brief := h.do(as("s2", req{method: "POST", path: "/tweaks/1/work"}))
	want := "The session in " + folder + " released this page. Files already changed: app.css."
	if !strings.Contains(string(brief), want) {
		t.Fatalf("the brief has no notice %q:\n%s", want, brief)
	}
	if ev := s.eventOf("tweak-handed"); ev["tweak"].(map[string]any)["status"] != "sent" {
		t.Fatalf("handed %v", ev)
	}
}

// A question answered after its asker let go reaches the next session as
// new, and so does its again: line.
func TestAHandedOverTweaksAgainLineRepeatsNew(t *testing.T) {
	h, s, c := quietBridge(t, "/dev/ernie")
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	status(h, "1", "question", "which green?")
	s.readUntilAfter(map[string]any{"type": "reply", "ref": "r2", "number": 1, "text": "the dark one"})
	h.do(as("s1", req{method: "DELETE", path: "/claims"}))
	h.register("s2", "/dev/ernie-2")
	h.claim("s2", "https://ernie.localhost/*")
	get := func(after int64) inboxReply {
		path := "/inbox"
		if after >= 0 {
			path += "?after=" + jsonInt(after)
		}
		_, body := h.do(as("s2", req{method: "GET", path: path}))
		var in inboxReply
		json.Unmarshal(body, &in)
		return in
	}
	in := get(-1)
	const line = "tweak 1 new: make it green [on /, 1 element]"
	if got := texts(in); len(got) != 1 || got[0] != line {
		t.Fatalf("s2's inbox %v", got)
	}
	in = get(in.Seq)
	c.advance(3 * time.Minute)
	var again []string
	eventually(t, "an again: line", func() bool { again = texts(get(in.Seq)); return len(again) > 0 })
	if again[0] != "tweak 1 again: "+line {
		t.Fatalf("again %v", again)
	}
}

// tweak work on a lost tweak, while capturing another, is refused with the
// claim lost line, and the capture carries on.
func TestWorkOnALostTweakWhileCapturingIsRefusedAsLost(t *testing.T) {
	folder := project(t, map[string]string{"app.css": "red"})
	h, s, c := quietBridge(t, folder)
	h.claim("s1", "https://ernie.test/*")
	s.send(createMsg("r1", "https://ernie.localhost/", "lost one"))
	s.readUntil("result")
	s.send(createMsg("r2", "https://ernie.test/", "kept one"))
	s.readUntil("result")
	h.do(as("s1", req{method: "POST", path: "/tweaks/2/work"}))
	c.advance(10 * time.Minute)
	eventually(t, "the lapse", func() bool { return !h.marked("s1") })
	h.register("s2", "/dev/ernie-2")
	h.claim("s2", "https://ernie.localhost/*")
	h.do(as("s1", req{method: "GET", path: "/claims"})) // back: ernie.test, capturing 2 again
	if !h.marked("s1") {
		t.Fatal("tweak 2 isn't capturing again")
	}
	resp, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if resp.StatusCode != 409 || !strings.Contains(string(body), "claim lost: https://ernie.localhost/*") {
		t.Fatalf("work on the lost tweak: %d %s", resp.StatusCode, body)
	}
	if !h.marked("s1") {
		t.Fatal("the refused work ended tweak 2's capture")
	}
}
