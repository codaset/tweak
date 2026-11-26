package store

import (
	"errors"
	"testing"
	"time"
)

// The 24-hour restore window runs from the lapse, and, like the lapse
// itself, counts only time the bridge was up (docs/design.md, "When the
// bridge or extension is down"). Lost claims are forgotten by the same rule.

func TestTheRestoreWindowRunsFromTheLapse(t *testing.T) {
	s, c, _ := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter) // its last check-in was 10 minutes ago
	c.advance(restoreFor - time.Second)
	s.ForgetLapsed(restoreFor)
	if back, _ := s.Return("s1", restoreFor); len(back.Restored) != 1 {
		t.Fatalf("not restored a second inside 24 hours of the lapse: %+v", back)
	}
}

func TestTheRestoreWindowEndsTwentyFourHoursAfterTheLapse(t *testing.T) {
	s, c, _ := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	c.advance(restoreFor)
	if back, _ := s.Return("s1", restoreFor); len(back.Restored) != 0 {
		t.Fatalf("restored 24 hours after the lapse: %+v", back)
	}
}

// up is the bridge being up until now (its sweep marks it), then down for
// down, then starting again.
func downFor(t *testing.T, s *Store, c *clock, down time.Duration) {
	t.Helper()
	if err := s.MarkUp(); err != nil {
		t.Fatal(err)
	}
	c.advance(down)
	if err := s.Resume(); err != nil {
		t.Fatal(err)
	}
}

func TestDowntimeDoesntCountTowardTheRestoreWindow(t *testing.T) {
	s, c, _ := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	c.advance(time.Hour)
	downFor(t, s, c, 30*time.Hour)
	c.advance(restoreFor - time.Hour - time.Second) // 23:59:59 of up time since the lapse
	s.ForgetLapsed(restoreFor)
	if back, _ := s.Return("s1", restoreFor); len(back.Restored) != 1 {
		t.Fatalf("lost to downtime: %+v", back)
	}
}

func TestDowntimeDoesntCountTowardForgettingALostClaim(t *testing.T) {
	s, c, tw := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	s.Claim("s2", mustParse(t, "https://ernie.localhost/admin/*"))
	c.advance(time.Hour)
	downFor(t, s, c, 30*time.Hour)
	c.advance(restoreFor - time.Hour - time.Second)
	s.ForgetLapsed(restoreFor)
	if _, err := s.SetStatus("s1", tw.Number, StatusQueued, nil); !errors.As(err, new(*LostError)) {
		t.Fatalf("forgotten through downtime: %v", err)
	}
	c.advance(time.Second)
	s.ForgetLapsed(restoreFor)
	if _, err := s.SetStatus("s1", tw.Number, StatusQueued, nil); !errors.As(err, new(*NotYoursError)) {
		t.Fatalf("still lost after 24 hours up: %v", err)
	}
}

func TestLinesShowTheHomeFolderAsTilde(t *testing.T) {
	s := open(t)
	c := &clock{t: time.UnixMilli(1_800_000_000_000)}
	s.SetClock(c.now)
	s.SetHome("/Users/joel")
	register(t, s, "s1", "/Users/joel/dev/ernie")
	register(t, s, "s2", "/Users/joel/dev/ernie-2")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	s.Work("s1", tw.Number, nil, CaptureStart{})
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	s.EndCapture("s1", CaptureEnd{Tweak: tw.Number})
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))

	got := statusOf(t, s, tw.Number)
	if last := got.Entries[len(got.Entries)-1]; last.Text != "The session in ~/dev/ernie stopped responding." {
		t.Fatalf("notice %q", last.Text)
	}
	back, _ := s.Return("s1", restoreFor)
	want := "claim lost: https://ernie.localhost/* is now claimed by the session in ~/dev/ernie-2: leave its tweaks to that session, or claim another page with /tweak <url>"
	if len(back.Lost) != 1 || s.LostLine(back.Lost[0]) != want {
		t.Fatalf("lost %+v", back.Lost)
	}
	if _, err := s.SetStatus("s1", tw.Number, StatusQueued, nil); err == nil || err.Error() != want {
		t.Fatalf("refusal %v", err)
	}
}
