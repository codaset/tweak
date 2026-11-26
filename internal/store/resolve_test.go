package store

import (
	"errors"
	"testing"
	"time"
)

// Withdraw, Resolve and retention (docs/design.md, "When the session goes
// quiet", "Storage").

func TestASentTweakIsSimplyResolvedWhenWithdrawn(t *testing.T) {
	s, c := clocked(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	c.advance(time.Minute)
	got, err := s.Withdraw(tw.Number)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusWithdrawn || !got.ResolvedAt.Equal(c.now()) {
		t.Fatalf("status %s, resolved at %v", got.Status, got.ResolvedAt)
	}
	// Its new line isn't handed out: Claude never hears of it.
	in, _ := s.Inbox("s1", -1)
	if len(in.Events) != 0 {
		t.Fatalf("inbox %v, want nothing", types(in.Events))
	}
}

func TestAWithdrawnTweakThatReachedTheSessionIsInItsInbox(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	in, _ := s.Inbox("s1", -1)
	from := in.Seq
	got, err := s.Withdraw(tw.Number)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusWithdrawn || got.ResolvedAt.IsZero() {
		t.Fatalf("status %s, resolved at %v", got.Status, got.ResolvedAt)
	}
	// Capture isn't ended at the click: edits Claude has started still count.
	if c, err := s.Capturing("s1"); err != nil || c.Tweak != tw.Number {
		t.Fatalf("capture %+v, %v: want it still capturing", c, err)
	}
	in, _ = s.Inbox("s1", from)
	if len(in.Events) != 1 || in.Events[0].Type != EventTweakWithdrawn {
		t.Fatalf("inbox %v, want tweak-withdrawn", types(in.Events))
	}
}

func TestOnlyAnOpenTweakCanBeWithdrawn(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	if _, err := s.Withdraw(tw.Number); !errors.Is(err, ErrFinished) {
		t.Fatalf("withdrawing a done tweak: %v", err)
	}
	if _, err := s.Withdraw(99); !errors.Is(err, ErrNoTweak) {
		t.Fatalf("no tweak: %v", err)
	}
}

func TestAFinishedTweakIsResolvedAndAnOpenOneIsNot(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	got, err := s.Resolve(tw.Number)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusDone || got.ResolvedAt.IsZero() {
		t.Fatalf("status %s, resolved at %v", got.Status, got.ResolvedAt)
	}
	other, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "and blue"))
	if _, err := s.Resolve(other.Number); !errors.Is(err, ErrStillOpen) {
		t.Fatalf("resolving a sent tweak: %v", err)
	}
	// A resolved tweak is still in the snapshot, so the side panel lists it.
	_, _, tweaks, _ := s.Snapshot()
	if len(tweaks) != 2 || tweaks[0].ResolvedAt.IsZero() || !tweaks[1].ResolvedAt.IsZero() {
		t.Fatalf("snapshot %+v", tweaks)
	}
}

func TestAfterAWithdrawClaudesLastWordKeepsTheChange(t *testing.T) {
	for _, status := range []string{StatusDone, StatusQuestion, StatusDeclined} {
		t.Run(status, func(t *testing.T) {
			s := open(t)
			tw := working(t, s)
			s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
			s.Withdraw(tw.Number)
			end := CaptureEnd{Tweak: tw.Number, Checked: true, Files: []After{after("/dev/ernie/a.css", "green")}}
			got, err := s.SetStatusEnding("s1", tw.Number, status, &Entry{From: FromClaude, Kind: KindReason, Text: "withdrawn"}, &end)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != StatusWithdrawn || got.Change == nil || got.Change.State != ChangeRecorded || got.Change.Capturing {
				t.Fatalf("status %s, change %+v", got.Status, got.Change)
			}
			if _, err := s.Undoable(tw.Number); err != nil {
				t.Fatalf("a withdrawn tweak's change is undoable: %v", err)
			}
		})
	}
}

func TestAWithdrawnTweakCantBeWorkedOrQueued(t *testing.T) {
	s := open(t)
	tw, _ := func() (Tweak, error) {
		register(t, s, "s1", "/dev/ernie")
		s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
		return s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	}()
	s.Withdraw(tw.Number)
	var wrong *TransitionError
	if _, err := s.Work("s1", tw.Number, nil, CaptureStart{}); !errors.As(err, &wrong) {
		t.Fatalf("work: %v", err)
	}
	if _, err := s.SetStatus("s1", tw.Number, StatusQueued, nil); !errors.As(err, &wrong) || wrong.Error() != "tweak 1 was withdrawn by the developer: skip it" {
		t.Fatalf("queue: %v", err)
	}
}

func TestResolvedTweaksAreDeletedAfterTheyAreKept(t *testing.T) {
	s, c := clocked(t)
	tw := finished(t, s)
	kept, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "still open"))
	s.Resolve(tw.Number)
	const keep = 7 * 24 * time.Hour
	c.advance(keep - time.Second)
	if gone, err := s.DeleteResolved(keep); err != nil || len(gone) != 0 {
		t.Fatalf("a second early: %v, %v", gone, err)
	}
	c.advance(time.Second)
	end, _, _, _ := s.Snapshot() // the resolve was the log's last event
	gone, err := s.DeleteResolved(keep)
	if seq, _, _, _ := s.Snapshot(); seq != end {
		t.Fatalf("the log ends at %d after the delete, want %d: a cursor would run past it", seq, end)
	}
	if ev, _ := s.EventsAfter(0); len(ev) != 2 || ev[1].Tweak.Number != kept.Number {
		t.Fatalf("events left %v, want the claim and the open tweak's", types(ev))
	}
	if err != nil || len(gone) != 1 || gone[0] != tw.Number {
		t.Fatalf("expired %v, %v", gone, err)
	}
	if _, err := s.Tweak(tw.Number); !errors.Is(err, ErrNoTweak) {
		t.Fatalf("the resolved tweak: %v", err)
	}
	if n, _ := s.ChangeFiles(tw.Number); len(n) != 0 {
		t.Fatalf("its change files %+v", n)
	}
	if _, err := s.Tweak(kept.Number); err != nil {
		t.Fatalf("the open tweak: %v", err)
	}
	// Numbers are never reused.
	next, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "new"))
	if next.Number <= kept.Number {
		t.Fatalf("number %d reused", next.Number)
	}
}

func TestAWithdrawnTweakStillCapturingIsKept(t *testing.T) {
	s, c := clocked(t)
	tw := working(t, s)
	s.Withdraw(tw.Number)
	c.advance(8 * 24 * time.Hour)
	if gone, err := s.DeleteResolved(7 * 24 * time.Hour); err != nil || len(gone) != 0 {
		t.Fatalf("expired %v, %v: a capture still records into it", gone, err)
	}
}

// clocked is an empty store on a clock tests move by hand.
func clocked(t *testing.T) (*Store, *clock) {
	t.Helper()
	s := open(t)
	c := &clock{t: time.UnixMilli(1_800_000_000_000)}
	s.SetClock(c.now)
	return s, c
}
