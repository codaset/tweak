package store

import (
	"encoding/json"
	"errors"
	"testing"
)

func newTweak(url, request string) NewTweak {
	return NewTweak{
		URL:     url,
		Request: request,
		Targets: json.RawMessage(`{"elements":[{"label":"button.save","text":"Save","selector":"#save"}]}`),
		Anchor:  json.RawMessage(`{"x":0.5,"y":0.25}`),
	}
}

func TestATweakGoesToTheSessionClaimingItsPage(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))

	tw, err := s.CreateTweak(newTweak("https://ernie.localhost/admin/users?tab=2#top", "make it green"))
	if err != nil {
		t.Fatal(err)
	}
	if tw.Number != 1 || tw.Session != "s1" || tw.Status != StatusSent {
		t.Fatalf("got %+v", tw)
	}
	// A page is its origin and path: the query and hash don't count.
	if tw.Page != "https://ernie.localhost/admin/users" || tw.URL != "https://ernie.localhost/admin/users?tab=2#top" {
		t.Fatalf("page %q, url %q", tw.Page, tw.URL)
	}
	if len(tw.Entries) != 1 || tw.Entries[0] != (Entry{From: "you", Kind: "request", Text: "make it green", At: tw.Created}) {
		t.Fatalf("entries %+v", tw.Entries)
	}
	if string(tw.Anchor) != `{"x":0.5,"y":0.25}` {
		t.Fatalf("anchor %s", tw.Anchor)
	}

	// A page nobody claims gets no tweak: every tweak has a session.
	if _, err := s.CreateTweak(newTweak("http://localhost:3000/", "hello")); !errors.Is(err, ErrNoClaim) {
		t.Fatalf("unclaimed: %v", err)
	}
}

func TestTweakNumbersAreNeverReused(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/a")
	s.Claim("s1", mustParse(t, "https://a.localhost/*"))
	a, _ := s.CreateTweak(newTweak("https://a.localhost/", "one"))
	b, _ := s.CreateTweak(newTweak("https://a.localhost/", "two"))
	s.db.Exec(`DELETE FROM entries WHERE tweak = ?`, b.Number)
	s.db.Exec(`DELETE FROM tweaks WHERE number = ?`, b.Number)
	c, err := s.CreateTweak(newTweak("https://a.localhost/", "three"))
	if err != nil || a.Number != 1 || c.Number != 3 {
		t.Fatalf("numbers %d %d %d (%v)", a.Number, b.Number, c.Number, err)
	}
}

func TestATweakNeedsARequestAndAWebPage(t *testing.T) {
	s := open(t)
	for _, n := range []NewTweak{
		newTweak("https://a.localhost/", "   "),
		newTweak("file:///etc/passwd", "x"),
		newTweak("not a url", "x"),
	} {
		if _, err := s.CreateTweak(n); !errors.Is(err, ErrBadTweak) {
			t.Errorf("%+v: got %v", n, err)
		}
	}
}

func TestStatusChangesAreTheSessionsOwn(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/bert")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))

	working, err := s.SetStatus("s1", tw.Number, StatusWorking, nil)
	if err != nil || working.Status != StatusWorking || working.StatusAt.Before(tw.StatusAt) {
		t.Fatalf("working: %+v %v", working, err)
	}
	done, err := s.SetStatus("s1", tw.Number, StatusDone, &Entry{From: "claude", Kind: "summary", Text: "made it green"})
	if err != nil || done.Status != StatusDone {
		t.Fatalf("done: %+v %v", done, err)
	}
	if len(done.Entries) != 2 || done.Entries[1].Kind != "summary" || done.Entries[1].Text != "made it green" {
		t.Fatalf("entries %+v", done.Entries)
	}

	var notYours *NotYoursError
	if _, err := s.SetStatus("s2", tw.Number, StatusWorking, nil); !errors.As(err, &notYours) || notYours.Folder != "/dev/ernie" {
		t.Fatalf("another session: %v", err)
	}
	if _, err := s.SetStatus("s1", 99, StatusWorking, nil); !errors.Is(err, ErrNoTweak) {
		t.Fatalf("no such tweak: %v", err)
	}
}

// The status moves only forward: sent or delivered, to working (again is
// fine), to done once.
func TestStatusTransitionsAreGuarded(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	summary := func() *Entry { return &Entry{From: "claude", Kind: "summary", Text: "made it green"} }
	refused := func(n int64, status string, want string) {
		t.Helper()
		_, err := s.SetStatus("s1", n, status, summary())
		var te *TransitionError
		if !errors.As(err, &te) || err.Error() != want {
			t.Fatalf("%s on tweak %d: got %v, want %q", status, n, err, want)
		}
	}

	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	refused(tw.Number, StatusDone, "tweak 1 isn't being worked on: run tweak work 1 first")
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	if again, err := s.SetStatus("s1", tw.Number, StatusWorking, nil); err != nil || again.Status != StatusWorking {
		t.Fatalf("work again: %+v %v", again, err)
	}
	if _, err := s.SetStatus("s1", tw.Number, StatusDone, summary()); err != nil {
		t.Fatal(err)
	}
	refused(tw.Number, StatusDone, "tweak 1 is already done: its summary is saved, so there's nothing more to do")
	refused(tw.Number, StatusWorking, "tweak 1 is already done: there's nothing more to work on")
	if got, _ := s.Tweak(tw.Number); len(got.Entries) != 2 {
		t.Fatalf("entries %+v, want the request and one summary", got.Entries)
	}
}

func TestTweakChangesAreLoggedAndInTheSnapshot(t *testing.T) {
	s := open(t)
	woken := 0
	s.OnEvent(func() { woken++ })
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	seq, _, _, _ := s.Snapshot()

	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	if woken != 3 {
		t.Fatalf("woken %d times, want 3 (claim, create, status)", woken)
	}

	events, err := s.EventsAfter(seq)
	if err != nil || len(events) != 2 {
		t.Fatalf("events %+v %v", events, err)
	}
	if events[0].Type != EventTweakCreated || events[0].Tweak.Status != StatusSent || events[0].Claim != nil {
		t.Errorf("first event %+v", events[0])
	}
	if events[1].Type != EventTweakStatus || events[1].Tweak.Status != StatusWorking || events[1].Tweak.Entries[0].Text != "make it green" {
		t.Errorf("second event %+v", events[1])
	}

	latest, _, tweaks, _ := s.Snapshot()
	if latest != events[1].Seq || len(tweaks) != 1 || tweaks[0].Status != StatusWorking || string(tweaks[0].Anchor) != `{"x":0.5,"y":0.25}` {
		t.Fatalf("snapshot %d %+v", latest, tweaks)
	}
}

func TestNotYoursSaysWhatToDo(t *testing.T) {
	for _, c := range []struct {
		err  NotYoursError
		want string
	}{
		{NotYoursError{Number: 3, Folder: "/dev/ernie"}, "tweak 3 is for the session in /dev/ernie: work on it from that session"},
		{NotYoursError{Number: 3}, "tweak 3 isn't for this session: no session claims its page, so send it again from the page once one does"},
	} {
		if got := c.err.Error(); got != c.want {
			t.Errorf("got %q, want %q", got, c.want)
		}
	}
}
