package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sessionEndJSON is Claude Code's SessionEnd hook input.
func sessionEndJSON(session, cwd, reason string) string {
	raw, _ := json.Marshal(map[string]any{
		"session_id":      session,
		"transcript_path": "/tmp/transcript.jsonl",
		"cwd":             cwd,
		"hook_event_name": "SessionEnd",
		"reason":          reason,
	})
	return string(raw)
}

func TestTheSessionEndHookReleasesTheSessionsClaims(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	s.hook(ernie, sessionEndJSON("s1", ernie, "clear"), "hook", "session-end")
	if r := s.tweak("s2", ernie, "claims"); strings.TrimSpace(r.stdout) != "no claims" {
		t.Fatalf("claims after the session ended: %q %q", r.stdout, r.stderr)
	}
}

// With no bridge running, the hook leaves a released marker and starts no
// bridge; the next bridge to start ends the session.
func TestTheSessionEndHookWithNoBridgeLeavesAMarker(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	s.stopBridge()
	s.hook(ernie, sessionEndJSON("s1", ernie, "prompt_input_exit"), "hook", "session-end")
	if _, ok := s.bridgeFile(); ok {
		t.Fatal("the hook started a bridge")
	}
	if raw, err := os.ReadFile(filepath.Join(s.state, "released", "s1")); err != nil || strings.TrimSpace(string(raw)) != "s1" {
		t.Fatalf("marker %q %v", raw, err)
	}
	if r := s.tweak("s2", ernie, "claims"); strings.TrimSpace(r.stdout) != "no claims" {
		t.Fatalf("claims once a bridge started: %q %q", r.stdout, r.stderr)
	}
}

func TestCommandsWarnOnStderrWithNoWatcher(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	s.extra = append(s.extra, "TWEAK_TEST_UNWATCHED_AFTER=200ms")
	ernie := s.folder("ernie")
	if r := s.tweak("s1", ernie, "claim", "https://ernie.localhost/*"); r.stderr != "" {
		t.Fatalf("claim warned: %q", r.stderr)
	}
	time.Sleep(300 * time.Millisecond)
	r := s.tweak("s1", ernie, "claims")
	if r.code != 0 || r.stderr != "no watcher running: start a Monitor with tweak watch\n" {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
}

// The marker is written to a temporary file and renamed into place, so a
// hook cut off mid-write never leaves an empty one.
func TestTheReleasedMarkerIsWrittenWhole(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.hook(ernie, sessionEndJSON("s1", ernie, "other"), "hook", "session-end")
	entries, _ := os.ReadDir(filepath.Join(s.state, "released"))
	if len(entries) != 1 || entries[0].Name() != "s1" {
		t.Fatalf("released/ holds %v", entries)
	}
}
