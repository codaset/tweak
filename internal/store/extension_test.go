package store

import (
	"path/filepath"
	"testing"
	"time"
)

// When the extension was last connected, for tweak claim's warning, and the
// extension connecting, for the watchers (docs/design.md, "The extension
// never connects").

func TestWhenTheExtensionWasLastSeenOutlivesTheBridge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	s, err := Open(path, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if seen, err := s.ExtensionSeen(); err != nil || !seen.IsZero() {
		t.Fatalf("a new database has seen an extension: %v %v", seen, err)
	}
	c := &clock{t: time.UnixMilli(1_800_000_000_000)}
	s.SetClock(c.now)
	if err := s.SawExtension(); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = Open(path, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if seen, err := s.ExtensionSeen(); err != nil || !seen.Equal(c.t) {
		t.Fatalf("last seen %v %v, want %v", seen, err, c.t)
	}
}

// Every session with claims hears that the extension connected, once; a
// session with none doesn't.
func TestTheExtensionConnectingIsInEachClaimedSessionsInbox(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/other")
	register(t, s, "s3", "/dev/idle")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	s.Claim("s1", mustParse(t, "https://admin.localhost/*"))
	s.Claim("s2", mustParse(t, "https://other.localhost/*"))
	if err := s.ExtensionConnected(); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int{"s1": 1, "s2": 1, "s3": 0} {
		in, err := s.Inbox(id, -1)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, e := range in.Events {
			if e.Type == EventExtensionConnected {
				n++
			}
		}
		if n != want {
			t.Errorf("%s heard the extension connect %d times, want %d", id, n, want)
		}
	}
}
