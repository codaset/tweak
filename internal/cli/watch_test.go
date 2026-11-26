package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/config"
)

// A stand-in bridge that answers GET /inbox from a script, and a log of what
// the watcher printed and asked for, in the order it happened.
type fakeInbox struct {
	mu      sync.Mutex
	log     []string
	printed []time.Time
	answer  func(after string) map[string]any
}

func (f *fakeInbox) record(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log = append(f.log, s)
}

// Write is the watcher's stdout: one line per call.
func (f *fakeInbox) Write(p []byte) (int, error) {
	f.mu.Lock()
	f.printed = append(f.printed, time.Now())
	f.mu.Unlock()
	f.record("print " + strings.TrimSpace(string(p)))
	return len(p), nil
}

func line(seq int, text string) map[string]any { return map[string]any{"seq": seq, "text": text} }

func inbox(seq, claims int, lines ...map[string]any) map[string]any {
	if lines == nil {
		lines = []map[string]any{}
	}
	return map[string]any{"seq": seq, "claims": claims, "lines": lines}
}

func (f *fakeInbox) watch(t *testing.T) error {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(bridge.HeaderVersion, "1.0.0")
		if r.URL.Path != "/inbox" {
			return
		}
		after := r.URL.Query().Get("after")
		if after == "" {
			f.record("poll")
		} else {
			f.record("ask after " + after)
		}
		json.NewEncoder(w).Encode(f.answer(after))
	}))
	t.Cleanup(srv.Close)
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	state := t.TempDir()
	os.WriteFile(filepath.Join(state, "bridge.json"), []byte(fmt.Sprintf(`{"port": %s}`, port)), 0o600)
	c := &context{Env: Env{Getenv: func(string) string { return "" }, Stdout: f, Stderr: f}, cfg: config.Config{StateDir: state}, session: "s1"}
	return watch(c, nil)
}

func (f *fakeInbox) assertLog(t *testing.T, want ...string) {
	t.Helper()
	if got := strings.Join(f.log, "\n"); got != strings.Join(want, "\n") {
		t.Fatalf("got\n%s\n\nwant\n%s", got, strings.Join(want, "\n"))
	}
}

func (f *fakeInbox) assertPaced(t *testing.T) {
	t.Helper()
	for i := 1; i < len(f.printed); i++ {
		if gap := f.printed[i].Sub(f.printed[i-1]); gap < linePace {
			t.Fatalf("line %d came %v after the one before: want at least %v", i+1, gap, linePace)
		}
	}
}

// Each line is acknowledged as soon as it is printed, before the next, and
// the lines go out at most one per 250 ms.
func TestWatchPrintsOneLineAtATimeAndAcknowledgesEach(t *testing.T) {
	f := &fakeInbox{answer: func(after string) map[string]any {
		if after == "" {
			return inbox(9, 1, line(4, "tweak 1 new: a"), line(6, "tweak 2 new: b"), line(9, "tweak 3 new: c"))
		}
		if after == "9" {
			return inbox(9, 0)
		}
		return inbox(9, 1, line(9, "tweak 3 new: c")) // what's left, which the watcher already has
	}}
	if err := f.watch(t); err != nil {
		t.Fatal(err)
	}
	f.assertLog(t,
		"poll",
		"print tweak 1 new: a", "ask after 4",
		"print tweak 2 new: b", "ask after 6",
		"print tweak 3 new: c", "ask after 9",
	)
	f.assertPaced(t)
}

// Two lines in separate replies are paced too.
func TestWatchPacesLinesAcrossPolls(t *testing.T) {
	f := &fakeInbox{answer: func(after string) map[string]any {
		switch after {
		case "":
			return inbox(1, 1, line(1, "tweak 1 new: a"))
		case "1":
			return inbox(2, 1, line(2, "tweak 2 new: b"))
		}
		return inbox(2, 0)
	}}
	if err := f.watch(t); err != nil {
		t.Fatal(err)
	}
	f.assertLog(t, "poll", "print tweak 1 new: a", "ask after 1", "print tweak 2 new: b", "ask after 2")
	f.assertPaced(t)
}

// With its last claim released, the watcher still prints and acknowledges
// every line before it exits.
func TestWatchAcknowledgesEveryLineBeforeExiting(t *testing.T) {
	f := &fakeInbox{answer: func(after string) map[string]any {
		if after == "" {
			return inbox(5, 0, line(3, "tweak 1 new: a"), line(5, "claim released: https://ernie.localhost/*"))
		}
		return inbox(5, 0)
	}}
	if err := f.watch(t); err != nil {
		t.Fatal(err)
	}
	f.assertLog(t, "poll", "print tweak 1 new: a", "ask after 3", "print claim released: https://ernie.localhost/*", "ask after 5")
	f.assertPaced(t)
}

// downBridge is a watcher's view of a bridge that isn't answering: nothing
// listens on bridge.json's port or the configured one until the watcher
// starts a bridge, which comes up as the stand-in. Its waits move a fake
// clock, so the backoff is checked without waiting for it.
type downBridge struct {
	fakeInbox
	at       time.Duration   // the fake clock, from the watcher's start
	sleeps   []time.Duration // each wait between tries
	started  []time.Duration // when the watcher started a bridge
	startErr error           // what starting one says; nil comes up
}

func closedPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// standIn is a bridge answering GET /inbox from answer; a nil answer is a 500.
func standIn(f *fakeInbox) *httptest.Server {
	return httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(bridge.HeaderVersion, "1.0.0")
		if r.URL.Path != "/inbox" {
			return
		}
		f.record("poll after " + r.URL.Query().Get("after"))
		a := f.answer(r.URL.Query().Get("after"))
		if a == nil {
			w.WriteHeader(500)
			fmt.Fprint(w, `{"error":"internal","message":"the bridge failed: disk I/O error"}`)
			return
		}
		json.NewEncoder(w).Encode(a)
	}))
}

func portOf(srv *httptest.Server) int {
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

func (d *downBridge) watch(t *testing.T) error {
	t.Helper()
	srv := standIn(&d.fakeInbox)
	t.Cleanup(srv.Close)
	state := t.TempDir()
	os.WriteFile(filepath.Join(state, "bridge.json"), []byte(fmt.Sprintf(`{"port": %d}`, closedPort(t))), 0o600)
	c := &context{Env: Env{Getenv: func(string) string { return "" }, Stdout: &d.fakeInbox, Stderr: &d.fakeInbox},
		cfg: config.Config{StateDir: state, Port: closedPort(t)}, session: "s1",
		sleep: func(x time.Duration) { d.sleeps = append(d.sleeps, x); d.at += x },
		now:   func() time.Time { return time.Unix(0, 0).Add(d.at) },
		start: func() (int, error) {
			d.started = append(d.started, d.at)
			if d.startErr != nil {
				return 0, d.startErr
			}
			srv.Start()
			return portOf(srv), nil
		},
	}
	return watch(c, nil)
}

// With no bridge answering, the watcher asks again after 1, 2 and 5
// seconds, starts the bridge itself once 10 seconds have gone without an
// answer, and says nothing about it.
func TestWatchStartsTheBridgeAfterTenSecondsWithoutAnAnswer(t *testing.T) {
	d := &downBridge{}
	d.answer = func(string) map[string]any {
		return inbox(3, 0, line(3, "claim released: https://ernie.localhost/*"))
	}
	if err := d.watch(t); err != nil {
		t.Fatal(err)
	}
	if want := []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 2 * time.Second}; fmt.Sprint(d.sleeps) != fmt.Sprint(want) {
		t.Fatalf("waits %v, want %v", d.sleeps, want)
	}
	if fmt.Sprint(d.started) != fmt.Sprint([]time.Duration{10 * time.Second}) {
		t.Fatalf("started a bridge at %v, want once at 10s", d.started)
	}
	d.assertLog(t, "poll after ", "print claim released: https://ernie.localhost/*", "poll after 3")
}

// A bridge that can't be started ends the watcher with the one line saying why.
func TestWatchExitsWhenTheBridgeCantBeStarted(t *testing.T) {
	d := &downBridge{startErr: errors.New("port 47391 is in use by another program: set TWEAK_PORT")}
	err := d.watch(t)
	if err == nil || err.Error() != "port 47391 is in use by another program: set TWEAK_PORT" {
		t.Fatalf("err = %v", err)
	}
	if fmt.Sprint(d.started) != fmt.Sprint([]time.Duration{10 * time.Second}) {
		t.Fatalf("started a bridge at %v, want once at 10s", d.started)
	}
	d.assertLog(t)
}

// A bridge that answers but fails (a 5xx) is asked again, every 10 seconds
// once the backoff has run out, and is never replaced: only a refusal, a
// released claim or a failed start ends the watcher.
func TestWatchAsksAgainWhenTheBridgeFails(t *testing.T) {
	failures := 6
	f := &fakeInbox{}
	f.answer = func(string) map[string]any {
		if failures > 0 {
			failures--
			return nil
		}
		return inbox(1, 0, line(1, "claim released: https://ernie.localhost/*"))
	}
	srv := standIn(f)
	srv.Start()
	t.Cleanup(srv.Close)
	state := t.TempDir()
	os.WriteFile(filepath.Join(state, "bridge.json"), []byte(fmt.Sprintf(`{"port": %d}`, portOf(srv))), 0o600)
	var sleeps []time.Duration
	at := time.Duration(0)
	c := &context{Env: Env{Getenv: func(string) string { return "" }, Stdout: f, Stderr: f}, cfg: config.Config{StateDir: state}, session: "s1",
		sleep: func(d time.Duration) { sleeps = append(sleeps, d); at += d },
		now:   func() time.Time { return time.Unix(0, 0).Add(at) },
		start: func() (int, error) { t.Error("started a bridge while one answers"); return portOf(srv), nil },
	}
	if err := watch(c, nil); err != nil {
		t.Fatal(err)
	}
	if want := []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 10 * time.Second, 10 * time.Second}; fmt.Sprint(sleeps) != fmt.Sprint(want) {
		t.Fatalf("waits %v, want %v", sleeps, want)
	}
	if !strings.HasSuffix(strings.Join(f.log, "\n"), "print claim released: https://ernie.localhost/*\npoll after 1") {
		t.Fatalf("log %q", f.log)
	}
}
