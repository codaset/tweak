package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/version"
	"github.com/coder/websocket"
)

// extensionSaysHello connects to the sandbox's bridge as the extension, at
// extensionVersion, and stays connected for the rest of the test.
func (s *sandbox) extensionSaysHello(extensionVersion string) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hdr := http.Header{"Origin": {"chrome-extension://" + tweak.ExtensionID}}
	c, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws", s.port), &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(func() { c.CloseNow() })
	hello, _ := json.Marshal(map[string]any{"type": "hello", "protocol": version.Protocol, "lastSeq": 0, "version": extensionVersion})
	if err := c.Write(ctx, websocket.MessageText, hello); err != nil {
		s.t.Fatal(err)
	}
	if _, _, err := c.Read(ctx); err != nil { // the snapshot: hello is recorded
		s.t.Fatal(err)
	}
}

// claimAfterHello starts the sandbox's bridge, has an extension at 0.0.1
// say hello, and claims.
func claimAfterHello(t *testing.T, s *sandbox) result {
	t.Helper()
	dir := s.folder("app")
	if r := s.tweak("", dir, "claims"); r.code != 0 { // starts the bridge
		t.Fatalf("tweak claims: %+v", r)
	}
	s.extensionSaysHello("0.0.1")
	r := s.tweak("s1", dir, "claim", "https://app.localhost")
	if r.code != 0 {
		t.Fatalf("tweak claim: %+v", r)
	}
	return r
}

func TestClaimRelaysTheAnotherFolderWarning(t *testing.T) {
	s := newSandbox(t)
	s.installed = true
	r := claimAfterHello(t, s)
	want := "Chrome has Codaset Tweak 0.0.1 loaded from another folder: remove it in chrome://extensions and load " + filepath.Join(s.state, "extension")
	if !strings.Contains(r.stdout, want) {
		t.Fatalf("stdout = %q, want %q", r.stdout, want)
	}
}

// A development bridge (TWEAK_BIN) never asks the extension to update, so it
// has nothing to warn about.
func TestADevelopmentClaimGivesNoFolderWarning(t *testing.T) {
	r := claimAfterHello(t, newSandbox(t))
	if strings.Contains(r.stdout, "another folder") {
		t.Fatalf("stdout = %q", r.stdout)
	}
}
