package bridge

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/version"
	"github.com/coder/websocket"
)

// When the bridge or extension is down (docs/design.md): tweak claim's
// warnings about the extension, the watchers hearing it connect, and
// downtime across a restart. On the bridge's clock.

func downBridge(t *testing.T, opts ...func(*Options)) (*harness, *fakeClock) {
	t.Helper()
	c := &fakeClock{t: time.Now().Add(time.Hour).Truncate(time.Millisecond)}
	h := start(t, append([]func(*Options){func(o *Options) {
		o.Clock = c.now
		o.LapseCheck = 5 * time.Millisecond
		o.InboxWait = 100 * time.Millisecond
	}}, opts...)...)
	return h, c
}

// extensionConnects connects as the extension and waits for the snapshot.
func (h *harness) extensionConnects(fields ...map[string]any) *socket {
	h.t.Helper()
	s := h.connect()
	m := map[string]any{"type": "hello", "protocol": version.Protocol, "lastSeq": 0, "version": "1.2.3"}
	for _, f := range fields {
		for k, v := range f {
			m[k] = v
		}
	}
	s.send(m)
	s.next("snapshot")
	return s
}

func (s *socket) leaves(h *harness) {
	s.t.Helper()
	n := h.b.browsers.Load()
	s.c.Close(websocket.StatusNormalClosure, "")
	waitFor(s.t, func() bool { return h.b.browsers.Load() == n-1 }, "the extension gone")
}

func TestAClaimWithNoExtensionEverConnectedSaysHowToInstallIt(t *testing.T) {
	h, _ := downBridge(t)
	w := claimWarnings(t, h)
	folder := tilde(filepath.Join(h.cfg.StateDir, "extension"))
	want := "extension not connected: to install it, open chrome://extensions, turn on Developer mode, click Load unpacked and choose " + folder
	if len(w) != 1 || w[0] != want {
		t.Fatalf("warnings = %q, want %q", w, want)
	}
}

// On macOS the folder picker hides dot-folders such as ~/.local.
func TestTheInstallStepsSayHowToReachAHiddenFolder(t *testing.T) {
	got := notInstalled("~/.local/state/codaset-tweak/extension")
	want := "extension not connected: to install it, open chrome://extensions, turn on Developer mode, click Load unpacked and choose ~/.local/state/codaset-tweak/extension (on macOS the file picker hides ~/.local: press ⌘⇧G and paste the path)"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestAClaimSaysWhenTheExtensionWasLastSeen(t *testing.T) {
	h, c := downBridge(t)
	h.extensionConnects().leaves(h)
	c.advance(2 * time.Hour)
	w := claimWarnings(t, h)
	want := "Chrome extension not connected (last seen 2 h ago): is Chrome open with Codaset Tweak enabled?"
	if len(w) != 1 || w[0] != want {
		t.Fatalf("warnings = %q, want %q", w, want)
	}
}

func TestAgo(t *testing.T) {
	for d, want := range map[time.Duration]string{
		45 * time.Second:             "45 s",
		90 * time.Second:             "1 min",
		59 * time.Minute:             "59 min",
		2*time.Hour + 59*time.Minute: "2 h",
		47 * time.Hour:               "47 h",
		3*24*time.Hour + 5*time.Hour: "3 days",
	} {
		if got := ago(d); got != want {
			t.Errorf("ago(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestAClaimWhileTheExtensionIsConnectedHasNoWarning(t *testing.T) {
	h, c := downBridge(t)
	h.extensionConnects(map[string]any{"version": embeddedVersion(t)})
	c.advance(2 * time.Hour)
	if w := claimWarnings(t, h); len(w) != 0 {
		t.Fatalf("warnings = %q", w)
	}
}

// A connection that dropped a moment ago is a worker restarting, a
// self-update reloading or a handover: it is back within seconds.
func TestAClaimJustAfterTheExtensionLeftHasNoWarning(t *testing.T) {
	h, c := downBridge(t)
	h.extensionConnects().leaves(h)
	c.advance(10 * time.Second)
	if w := claimWarnings(t, h); len(w) != 0 {
		t.Fatalf("warnings = %q", w)
	}
}

// The time is kept across restarts: a new bridge doesn't think the
// extension was never installed. A bridge crashing with it connected leaves
// the sweep's last mark.
func TestWhenTheExtensionWasLastSeenOutlivesARestart(t *testing.T) {
	state := t.TempDir()
	h, c := downBridge(t, func(o *Options) { o.Config.StateDir = state })
	h.extensionConnects()
	c.advance(time.Hour)
	eventually(t, "the sweep marking the extension seen", func() bool {
		seen, _ := h.b.store.ExtensionSeen()
		return seen.Equal(c.now())
	})
	h.b.Shutdown()
	<-h.done
	h.done <- nil

	c.advance(3 * time.Hour)
	again := start(t, func(o *Options) { o.Config.StateDir = state; o.Clock = c.now })
	w := claimWarnings(t, again)
	if len(w) != 1 || !strings.Contains(w[0], "(last seen 3 h ago)") {
		t.Fatalf("warnings = %q", w)
	}
}

// The folder warning waits for the extension to settle: it says hello with
// the version it last reloaded itself for, and only once that reload is
// done and its version still differs is it loaded from another folder. A
// busy tab holding the reload back, or the reload under way, isn't.
func TestTheFolderWarningWaitsForTheExtensionsOwnUpdate(t *testing.T) {
	h, _ := downBridge(t)
	want := embeddedVersion(t)
	s := h.extensionConnects(map[string]any{"version": "0.0.1", "reloadedFor": ""})
	if w := claimWarnings(t, h); len(w) != 0 {
		t.Fatalf("warned before the extension reloaded: %q", w)
	}
	s.leaves(h)
	h.extensionConnects(map[string]any{"version": "0.0.1", "reloadedFor": want})
	w := claimWarnings(t, h)
	if len(w) != 1 || !strings.Contains(w[0], "loaded from another folder") {
		t.Fatalf("warnings = %q", w)
	}
}

// The watcher's line: each session with claims hears the extension connect
// after it was away, once.
func TestEachWatcherHearsTheExtensionConnect(t *testing.T) {
	h, c := downBridge(t)
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	h.register("s2", "/dev/idle")
	start := poll(t, h, -1)

	s := h.extensionConnects()
	if got := texts(poll(t, h, start.Seq)); len(got) != 1 || got[0] != "extension connected" {
		t.Fatalf("lines %q", got)
	}
	seq := poll(t, h, -1).Seq
	_, body := h.do(as("s2", req{method: "GET", path: "/inbox"}))
	if strings.Contains(string(body), "extension connected") {
		t.Fatalf("a session with no claims heard it: %s", body)
	}

	// A second connection alongside, or one back within seconds, is no news.
	alongside := h.extensionConnects()
	s.leaves(h)
	alongside.leaves(h)
	c.advance(10 * time.Second)
	h.extensionConnects().leaves(h)
	if got := texts(poll(t, h, seq)); len(got) != 0 {
		t.Fatalf("lines %q", got)
	}

	// Back after a while away is.
	c.advance(time.Minute)
	h.extensionConnects()
	if got := texts(poll(t, h, seq)); len(got) != 1 || got[0] != "extension connected" {
		t.Fatalf("lines %q", got)
	}
}

// A watcher already waiting hears it at once, not at the end of its long-poll.
func TestAWaitingWatcherHearsTheExtensionConnectAtOnce(t *testing.T) {
	h, _ := downBridge(t, func(o *Options) { o.InboxWait = 10 * time.Second })
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	got := make(chan []string, 1)
	go func() {
		_, body := h.do(as("s1", req{method: "GET", path: "/inbox?after=0"}))
		var in inboxReply
		json.Unmarshal(body, &in)
		got <- texts(in)
	}()
	time.Sleep(200 * time.Millisecond) // the long-poll is held
	began := time.Now()
	h.extensionConnects()
	select {
	case lines := <-got:
		if len(lines) != 1 || lines[0] != "extension connected" || time.Since(began) > 2*time.Second {
			t.Fatalf("lines %q after %v", lines, time.Since(began))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiting watcher didn't hear it")
	}
}

// Downtime doesn't count toward a lapse, across a real restart: a session
// that checked in just before the bridge went down for half an hour still
// has 10 minutes of the new bridge's time.
func TestDowntimeDoesntCountTowardALapse(t *testing.T) {
	state := t.TempDir()
	h, c := downBridge(t, func(o *Options) { o.Config.StateDir = state })
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	h.b.Shutdown()
	<-h.done
	h.done <- nil

	c.advance(30 * time.Minute)
	again := start(t, func(o *Options) {
		o.Config.StateDir = state
		o.Clock = c.now
		o.LapseCheck = 5 * time.Millisecond
	})
	held := func() bool {
		_, body := again.do(req{method: "GET", path: "/claims"})
		return strings.Contains(string(body), "ernie.localhost")
	}
	c.advance(10*time.Minute - time.Second)
	time.Sleep(50 * time.Millisecond) // a few sweeps
	if !held() {
		t.Fatal("lapsed at 9:59 of up time")
	}
	c.advance(time.Second)
	eventually(t, "the claim lapsing at 10:00 of up time", func() bool { return !held() })
}
