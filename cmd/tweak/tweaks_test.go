package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/version"
	"github.com/coder/websocket"
)

// extension stands in for the Chrome extension: a socket to the sandbox's
// bridge that has said hello.
type extension struct {
	t *testing.T
	c *websocket.Conn
}

func (s *sandbox) extension() *extension {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hdr := map[string][]string{"Origin": {"chrome-extension://" + tweak.ExtensionID}}
	c, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws", s.port), &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		s.t.Fatalf("dial: %v", err)
	}
	s.t.Cleanup(func() { c.CloseNow() })
	e := &extension{t: s.t, c: c}
	e.send(map[string]any{"type": "hello", "protocol": version.Protocol, "lastSeq": 0, "version": "0.1.0"})
	e.until("snapshot")
	return e
}

func (e *extension) send(v any) {
	e.t.Helper()
	raw, _ := json.Marshal(v)
	if err := e.c.Write(context.Background(), websocket.MessageText, raw); err != nil {
		e.t.Fatal(err)
	}
}

func (e *extension) until(typ string) map[string]any {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, raw, err := e.c.Read(ctx)
		if err != nil {
			e.t.Fatalf("waiting for %s: %v", typ, err)
		}
		var m map[string]any
		json.Unmarshal(raw, &m)
		if m["type"] == typ {
			return m
		}
	}
}

// create sends a tweak as the extension does and returns its number.
func (e *extension) create(url, request string) int {
	e.t.Helper()
	e.send(map[string]any{
		"type": "create", "ref": "r", "url": url, "request": request,
		"targets": map[string]any{"elements": []any{map[string]any{"label": "button.save", "text": "Save", "selector": "#save"}}},
		"anchor":  map[string]any{"x": 0.5, "y": 0.5},
	})
	r := e.until("result")
	n, ok := r["number"].(float64)
	if !ok {
		e.t.Fatalf("result %v", r)
	}
	return int(n)
}

// watcher is a running tweak watch, its lines read as they come.
type watcher struct {
	t     *testing.T
	cmd   *exec.Cmd
	lines chan string
	done  chan error
	err   *bytes.Buffer
}

func (s *sandbox) watch(session, folder string) *watcher {
	s.t.Helper()
	cmd := exec.Command(tweakBin, "watch")
	cmd.Env = append(s.env(), "CLAUDE_CODE_SESSION_ID="+session)
	cmd.Dir = folder
	out, _ := cmd.StdoutPipe()
	w := &watcher{t: s.t, cmd: cmd, lines: make(chan string, 10), done: make(chan error, 1), err: &bytes.Buffer{}}
	cmd.Stderr = w.err
	if err := cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			w.lines <- sc.Text()
		}
		w.done <- cmd.Wait()
	}()
	s.t.Cleanup(func() { cmd.Process.Kill() })
	return w
}

// line is the watcher's next line about tweaks and claims. The stand-in
// extension connecting after the claim is no news to these tests, so
// "extension connected" is passed over; next reads every line.
func (w *watcher) line() string {
	w.t.Helper()
	for {
		if l := w.next(); l != "extension connected" {
			return l
		}
	}
}

func (w *watcher) next() string {
	w.t.Helper()
	select {
	case l := <-w.lines:
		return l
	case <-time.After(10 * time.Second):
		w.t.Fatalf("no line from tweak watch (stderr %q)", w.err)
		return ""
	}
}

func (w *watcher) exited() int {
	w.t.Helper()
	select {
	case <-w.done:
		return w.cmd.ProcessState.ExitCode()
	case <-time.After(10 * time.Second):
		w.t.Fatal("tweak watch didn't exit")
		return 0
	}
}

func TestWatchWorkDone(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	if r := s.tweak("s1", ernie, "claim", "https://ernie.localhost/*"); r.code != 0 {
		t.Fatal(r.stderr)
	}
	ext := s.extension()
	w := s.watch("s1", ernie)
	// The extension connected after the claim: the watcher says so first.
	if got := w.next(); got != "extension connected" {
		t.Fatalf("first line %q", got)
	}

	n := ext.create("https://ernie.localhost/admin?tab=2", "make it green")
	if got := w.next(); got != fmt.Sprintf("tweak %d new: make it green [on /admin, 1 element]", n) {
		t.Fatalf("line %q", got)
	}

	r := s.tweak("s1", ernie, "work", fmt.Sprint(n))
	if r.code != 0 || !strings.HasPrefix(r.stdout, fmt.Sprintf("# Tweak %d\n", n)) || !strings.Contains(r.stdout, "**Request:** make it green") {
		t.Fatalf("work: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = s.tweak("s1", ernie, "done", fmt.Sprint(n), "made it green")
	if r.code != 0 || r.stdout != fmt.Sprintf("tweak %d: done\n", n) {
		t.Fatalf("done: %d %q %q", r.code, r.stdout, r.stderr)
	}

	// The watcher stops once the session's last claim is released.
	s.tweak("s1", ernie, "release")
	if got := w.line(); got != "claim released: https://ernie.localhost/*" {
		t.Fatalf("line %q", got)
	}
	if code := w.exited(); code != 0 {
		t.Fatalf("watch exited %d: %s", code, w.err)
	}
}

// A watcher outlives its bridge: with none answering for 10 seconds it starts
// one itself, says nothing about it, and carries on.
func TestTheWatcherStartsAGoneBridge(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	w := s.watch("s1", ernie)
	time.Sleep(500 * time.Millisecond) // let it start its long-poll
	s.stopBridge()
	gone := time.Now()

	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if _, ok := s.bridgeFile(); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the watcher didn't start a bridge")
		}
	}
	if waited := time.Since(gone); waited < 9*time.Second {
		t.Fatalf("started a bridge %v after the last went: want about 10 s", waited)
	}
	n := s.extension().create("https://ernie.localhost/", "make it green")
	if got := w.line(); !strings.HasPrefix(got, fmt.Sprintf("tweak %d new:", n)) {
		t.Fatalf("line %q", got)
	}
	w.cmd.Process.Kill()
	<-w.done // stderr is complete
	if w.err.Len() != 0 {
		t.Fatalf("stderr %q", w.err)
	}
}

// A watcher started after a release and a new claim doesn't stop on the old
// release: its first line is the next tweak.
func TestANewWatcherSkipsAnOldRelease(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	first := s.watch("s1", ernie)
	time.Sleep(500 * time.Millisecond) // let it start its long-poll
	s.tweak("s1", ernie, "release")
	first.line()
	first.exited()
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")

	w := s.watch("s1", ernie)
	n := s.extension().create("https://ernie.localhost/", "make it green")
	if got := w.line(); !strings.HasPrefix(got, fmt.Sprintf("tweak %d new:", n)) {
		t.Fatalf("first line %q", got)
	}
}

// A watcher whose session has no claims left prints what's waiting (here,
// its lapsed claim lost to another session) and acknowledges it before it
// exits, so the next watcher doesn't print it again.
func TestAWatcherAcknowledgesWhatItPrintedBeforeExiting(t *testing.T) {
	s := newSandbox(t)
	s.extra = append(s.extra, "TWEAK_TEST_LAPSE_AFTER=300ms")
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	time.Sleep(700 * time.Millisecond)
	if r := s.tweak("s2", s.folder("ernie-2"), "claim", "https://ernie.localhost/*"); r.code != 0 {
		t.Fatalf("claiming the lapsed page: %s", r.stderr)
	}
	first := s.watch("s1", ernie)
	if got := first.line(); !strings.HasPrefix(got, "claim lost: https://ernie.localhost/* is now claimed by the session in ") {
		t.Fatalf("first watcher's line %q", got)
	}
	if code := first.exited(); code != 0 {
		t.Fatalf("first watcher exited %d: %s", code, first.err)
	}

	// The next watcher has nothing left to print, so it stops at once.
	r := s.tweak("s1", ernie, "watch")
	if r.code != 1 || r.stdout != "" || !strings.Contains(r.stderr, "this session has no claims") {
		t.Fatalf("the next watcher: exit %d, stdout %q, stderr %q", r.code, r.stdout, r.stderr)
	}
}

func TestWatchExitsAtOnceWithNoClaims(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	s.tweak("s1", ernie, "release")
	w := s.watch("s1", ernie)
	if code := w.exited(); code != 1 || !strings.Contains(w.err.String(), "tweak claim") {
		t.Fatalf("exit %d, stderr %q", code, w.err)
	}
}

func TestADashReadsTheMessageFromStdin(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	n := ext.create("https://ernie.localhost/", "make it green")
	s.tweak("s1", ernie, "work", fmt.Sprint(n))

	r := s.tweakIn(strings.NewReader("it's green now\n"), "s1", ernie, "done", fmt.Sprint(n), "-")
	if r.code != 0 {
		t.Fatalf("done -: %d %q", r.code, r.stderr)
	}
	ev := ext.until("event")
	for ev["tweak"].(map[string]any)["status"] != "done" {
		ev = ext.until("event")
	}
	entries := ev["tweak"].(map[string]any)["entries"].([]any)
	if got := entries[len(entries)-1].(map[string]any)["text"]; got != "it's green now" {
		t.Fatalf("summary %q", got)
	}
}

func TestWorkAndDoneNeedATweakNumber(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	for _, args := range [][]string{{"work"}, {"work", "x"}, {"done", "1"}, {"done", "1", "a", "b"}} {
		if r := s.tweak("s1", ernie, args...); r.code != 2 || !strings.HasPrefix(r.stderr, "usage: tweak "+args[0]) {
			t.Errorf("%v: %d %q", args, r.code, r.stderr)
		}
	}
	if r := s.tweak("s1", ernie, "work", "7"); r.code != 1 || r.stderr != "there is no tweak 7: check the number in the tweak's card\n" {
		t.Errorf("no such tweak: %d %q", r.code, r.stderr)
	}
}

// tweakIn runs the binary with stdin.
func (s *sandbox) tweakIn(stdin io.Reader, session, folder string, args ...string) result {
	s.t.Helper()
	cmd := exec.Command(tweakBin, args...)
	cmd.Env = append(s.env(), "CLAUDE_CODE_SESSION_ID="+session)
	cmd.Dir = folder
	cmd.Stdin = stdin
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	cmd.Run()
	return result{cmd.ProcessState.ExitCode(), out.String(), errOut.String()}
}

// A tweak the session never picks up comes back as again: lines, twice. A
// development bridge takes its wait from TWEAK_TEST_AGAIN_AFTER.
func TestAnUnconfirmedTweakComesBackAgain(t *testing.T) {
	s := newSandbox(t)
	s.extra = []string{"TWEAK_TEST_AGAIN_AFTER=300ms"}
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	w := s.watch("s1", ernie)
	n := ext.create("https://ernie.localhost/", "make it green")
	first := w.line()
	for range 2 {
		if got := w.line(); got != fmt.Sprintf("tweak %d again: %s", n, first) {
			t.Fatalf("line %q", got)
		}
	}
	s.tweak("s1", ernie, "work", fmt.Sprint(n))
}

// A burst of tweaks reaches the Monitor one line at a time, outside its
// 200 ms batching window.
func TestWatchPacesABurst(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	for _, r := range []string{"one", "two", "three"} {
		ext.create("https://ernie.localhost/", r)
	}
	w := s.watch("s1", ernie)
	var at []time.Time
	for range 3 {
		w.line()
		at = append(at, time.Now())
	}
	for i := 1; i < len(at); i++ {
		if gap := at[i].Sub(at[i-1]); gap < 100*time.Millisecond {
			t.Fatalf("line %d came %v after the one before", i+1, gap)
		}
	}
}
