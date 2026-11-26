package cli

import (
	"encoding/json"
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
