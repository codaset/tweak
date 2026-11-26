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

func (w *watcher) line() string {
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

	n := ext.create("https://ernie.localhost/admin?tab=2", "make it green")
	if got := w.line(); got != fmt.Sprintf("tweak %d new: make it green [on /admin, 1 element]", n) {
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

func TestAWatcherAcknowledgesWhatItPrintedBeforeExiting(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	old := ext.create("https://ernie.localhost/", "make it green")
	s.tweak("s1", ernie, "release")
	first := s.watch("s1", ernie)
	if got := first.line(); !strings.HasPrefix(got, fmt.Sprintf("tweak %d new:", old)) {
		t.Fatalf("first watcher's line %q", got)
	}
	if code := first.exited(); code != 0 {
		t.Fatalf("first watcher exited %d: %s", code, first.err)
	}

	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	w := s.watch("s1", ernie)
	n := ext.create("https://ernie.localhost/", "make it blue")
	if got := w.line(); !strings.HasPrefix(got, fmt.Sprintf("tweak %d new:", n)) {
		t.Fatalf("the next watcher's first line is %q, want tweak %d's", got, n)
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
