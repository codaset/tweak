package store

import (
	"path/filepath"
	"testing"
)

// A database from before tweaks existed upgrades, and its sessions' inboxes
// start at the end of the log rather than replaying old releases.
func TestUpgradingStartsEachInboxAtTheEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	old, err := openWith(path, "0.1.0", migrations[:1])
	if err != nil {
		t.Fatal(err)
	}
	old.db.Exec(`INSERT INTO sessions (id, agent, folder, last_check_in) VALUES ('s1', 'claude-code', '/dev/ernie', 0)`)
	old.db.Exec(`INSERT INTO events (type, claim, payload, at) VALUES ('claim-released', 1, '{"session":"s1","pattern":"https://old.localhost/*"}', 0)`)
	old.Close()

	s, err := Open(path, "0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if in, err := s.Inbox("s1", -1); err != nil || len(in.Events) != 0 {
		t.Fatalf("inbox %+v %v", in, err)
	}
	s.Claim("s1", mustParse(t, "https://a.localhost/*"))
	if tw, err := s.CreateTweak(newTweak("https://a.localhost/", "first")); err != nil || tw.Number != 1 {
		t.Fatalf("first tweak %+v %v", tw, err)
	}
}

// A v3 database (before undo capture) upgrades to it: its rows keep
// their data, none is capturing, and a tweak can then be worked and captured.
func TestUpgradingAddsUndoCapture(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	old, err := openWith(path, "0.1.0", migrations[:3])
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO sessions (id, agent, folder, last_check_in) VALUES ('s1', 'claude-code', '/dev/ernie', 0)`,
		`INSERT INTO tweaks (number, session, page, page_url, status, status_at, created, updated, targets) VALUES (1, 's1', 'https://a.localhost/', 'https://a.localhost/', 'done', 0, 0, 0, '{}')`,
		`INSERT INTO changes (id, tweak, state) VALUES (1, 1, 'recorded')`,
		`INSERT INTO change_files (change, path, before, after) VALUES (1, '/dev/ernie/a.css', 'red', 'green')`,
	} {
		if _, err := old.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	old.Close()

	s, err := Open(path, "0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tw, err := s.Tweak(1)
	if err != nil || tw.Change == nil || tw.Change.Capturing || tw.Change.State != ChangeRecorded || len(tw.Change.Files) != 1 || tw.Change.Files[0].Path != "/dev/ernie/a.css" {
		t.Fatalf("change %+v %v", tw.Change, err)
	}
	if sessions, _ := s.CapturingSessions(); len(sessions) != 0 {
		t.Fatalf("capturing after the upgrade: %v", sessions)
	}
	s.Claim("s1", mustParse(t, "https://b.localhost/*"))
	tw2, _ := s.CreateTweak(newTweak("https://b.localhost/", "second"))
	if _, err := s.Work("s1", tw2.Number, nil, CaptureStart{Folder: "/dev/ernie"}); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.RecordBefore("s1", Before{ChangeFile: ChangeFile{Path: "/dev/ernie/a.css", Shown: "a.css"}, Text: true, Data: []byte("x")}); !ok || err != nil {
		t.Fatalf("record %v %v", ok, err)
	}
}

func types(events []Event) []string {
	var out []string
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

func TestTheInboxHoldsTheSessionsOwnTweaksAndReleases(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/bert")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	s.Claim("s1", mustParse(t, "https://ernie.test/*"))
	s.Claim("s2", mustParse(t, "https://bert.localhost/*"))
	mine, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "mine"))
	s.CreateTweak(newTweak("https://bert.localhost/", "theirs"))
	s.Release("s1", "https://ernie.test/*")

	// A watcher starting fresh begins where the last one acknowledged:
	// for a new session, at the end of the log when it registered. It
	// gets the tweaks waiting, but not releases from before it started.
	in, err := s.Inbox("s1", -1)
	if err != nil {
		t.Fatal(err)
	}
	if got := types(in.Events); len(got) != 1 || got[0] != EventTweakCreated || in.Events[0].Tweak.Number != mine.Number || in.Claims != 1 {
		t.Fatalf("fresh inbox %v %+v", got, in)
	}

	// Asking for what's after a sequence acknowledges everything up to it:
	// the tweak is delivered, and a fresh watcher doesn't get it again.
	next, err := s.Inbox("s1", in.Seq)
	if err != nil || len(next.Events) != 0 {
		t.Fatalf("after %d: %+v %v", in.Seq, next, err)
	}
	if tw, _ := s.Tweak(mine.Number); tw.Status != StatusDelivered {
		t.Fatalf("status %s, want delivered", tw.Status)
	}
	if again, _ := s.Inbox("s1", -1); len(again.Events) != 0 {
		t.Fatalf("redelivered after the ack: %v", types(again.Events))
	}

	// A running watcher hears a release.
	s.Release("s1", "https://ernie.localhost/*")
	after, _ := s.Inbox("s1", next.Seq)
	if len(after.Events) != 1 || after.Events[0].Claim.Pattern != "https://ernie.localhost/*" || after.Claims != 0 {
		t.Fatalf("after %d: %v", next.Seq, types(after.Events))
	}
}

func TestAnUnacknowledgedLineIsDeliveredAgain(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "mine"))

	first, _ := s.Inbox("s1", -1)
	// The watcher died before asking again: its successor gets the line too.
	second, _ := s.Inbox("s1", -1)
	if len(first.Events) != 1 || len(second.Events) != 1 || second.Events[0].Tweak.Number != tw.Number {
		t.Fatalf("first %v, second %v", types(first.Events), types(second.Events))
	}
	if got, _ := s.Tweak(tw.Number); got.Status != StatusSent {
		t.Fatalf("status %s before any ack", got.Status)
	}
}

func TestAnAckDoesntUndoLaterProgress(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "mine"))
	in, _ := s.Inbox("s1", -1)
	s.SetStatus("s1", tw.Number, StatusWorking, nil) // Claude was quicker than the next poll
	s.Inbox("s1", in.Seq)
	if got, _ := s.Tweak(tw.Number); got.Status != StatusWorking {
		t.Fatalf("status %s, want working", got.Status)
	}
}
