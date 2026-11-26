package store

import "testing"

func TestClaimChangesAreLoggedAfterTheSnapshot(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/a")
	a, err := s.Claim("s1", mustParse(t, "https://a.localhost/*"))
	if err != nil {
		t.Fatal(err)
	}

	seq, claims, _, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Pattern != "https://a.localhost/*" {
		t.Fatalf("snapshot claims = %+v", claims)
	}

	// Claiming the same pattern again changes nothing, so it logs nothing.
	if _, err := s.Claim("s1", mustParse(t, "https://a.localhost/*")); err != nil {
		t.Fatal(err)
	}
	b, err := s.Claim("s1", mustParse(t, "https://b.localhost/*"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Release("s1", "https://a.localhost/*"); err != nil {
		t.Fatal(err)
	}

	events, err := s.EventsAfter(seq)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		typ     string
		id      int64
		pattern string
	}{{"claim-made", b.ID, "https://b.localhost/*"}, {"claim-released", a.ID, "https://a.localhost/*"}}
	if len(events) != len(want) {
		t.Fatalf("events after %d = %+v", seq, events)
	}
	for i, w := range want {
		e := events[i]
		if e.Type != w.typ || e.Claim.ID != w.id || e.Claim.Pattern != w.pattern || e.Claim.Session.Folder != "/dev/a" {
			t.Errorf("event %d = %+v, want %s of claim %d %s", i, e, w.typ, w.id, w.pattern)
		}
		if e.Seq <= seq || (i > 0 && e.Seq <= events[i-1].Seq) {
			t.Errorf("event %d seq %d isn't after %d", i, e.Seq, seq)
		}
	}
	if latest, _, _, _ := s.Snapshot(); latest != events[1].Seq {
		t.Errorf("snapshot seq %d, want the last event's %d", latest, events[1].Seq)
	}
}

func TestReleasingEveryClaimLogsEach(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/a")
	s.Claim("s1", mustParse(t, "https://a.localhost/*"))
	s.Claim("s1", mustParse(t, "https://b.localhost/*"))
	seq, _, _, _ := s.Snapshot()
	if _, err := s.Release("s1", ""); err != nil {
		t.Fatal(err)
	}
	events, _ := s.EventsAfter(seq)
	if len(events) != 2 || events[0].Type != "claim-released" || events[1].Type != "claim-released" {
		t.Fatalf("events = %+v", events)
	}
}

func TestCommittedEventsWakeTheListener(t *testing.T) {
	s := open(t)
	woken := 0
	s.OnEvent(func() { woken++ })
	register(t, s, "s1", "/dev/a")

	s.Claim("s1", mustParse(t, "https://a.localhost/*"))
	if woken != 1 {
		t.Fatalf("woken %d times after a claim, want 1", woken)
	}
	s.Claim("s1", mustParse(t, "https://a.localhost/*")) // the same claim: nothing logged
	s.Release("s1", "https://b.localhost/*")             // not held: nothing logged
	if woken != 1 {
		t.Fatalf("woken %d times with nothing logged, want 1", woken)
	}
	s.Release("s1", "")
	if woken != 2 {
		t.Fatalf("woken %d times after a release, want 2", woken)
	}
}
