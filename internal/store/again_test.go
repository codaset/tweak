package store

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// clock is a time tests move on by hand.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

const wait = 3 * time.Minute

// printed is a session with one tweak whose line the watcher has printed
// and acknowledged: delivered, waiting to be confirmed.
func printed(t *testing.T) (*Store, *clock, Tweak, int64) {
	t.Helper()
	s := open(t)
	c := &clock{t: time.UnixMilli(1_800_000_000_000)}
	s.SetClock(c.now)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	in, _ := s.Inbox("s1", -1)
	ack, err := s.Inbox("s1", in.Seq)
	if err != nil {
		t.Fatal(err)
	}
	return s, c, tw, ack.Seq
}

func resend(t *testing.T, s *Store) []Tweak {
	t.Helper()
	got, err := s.Resend(wait)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// Acknowledging one line of two delivers only that tweak; the next watcher
// gets the other.
func TestEachLineIsAcknowledgedOnItsOwn(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	one, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "one"))
	two, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "two"))
	in, _ := s.Inbox("s1", -1)
	if len(in.Events) != 2 {
		t.Fatalf("inbox %v", types(in.Events))
	}
	s.Inbox("s1", in.Events[0].Seq) // the watcher printed one line, then stopped
	if got, _ := s.Tweak(one.Number); got.Status != StatusDelivered {
		t.Fatalf("tweak one: %s", got.Status)
	}
	if got, _ := s.Tweak(two.Number); got.Status != StatusSent {
		t.Fatalf("tweak two: %s", got.Status)
	}
	next, _ := s.Inbox("s1", -1)
	if len(next.Events) != 1 || next.Events[0].Tweak.Number != two.Number {
		t.Fatalf("the next watcher's inbox: %v", types(next.Events))
	}
}

// A tweak delivered before the upgrade waits from when it was delivered.
func TestUpgradingKeepsDeliveredTweaksWaiting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	old, err := openWith(path, "0.1.0", migrations[:2])
	if err != nil {
		t.Fatal(err)
	}
	// The code that wrote it is gone, so the rows go in by hand.
	old.db.Exec(`INSERT INTO sessions (id, agent, folder, last_check_in) VALUES ('s1', 'claude-code', '/dev/ernie', 0)`)
	for _, status := range []string{StatusDelivered, StatusWorking} {
		if _, err := old.db.Exec(`INSERT INTO tweaks (session, page, page_url, status, status_at, created, updated, targets)
			VALUES ('s1', 'https://ernie.localhost/', 'https://ernie.localhost/', ?, 1700000000000, 1, 1, '{}')`, status); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()

	s, err := Open(path, "0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if working, _ := s.Tweak(2); !working.WaitFrom.IsZero() {
		t.Fatalf("a working tweak waits from %v", working.WaitFrom)
	}
	got, _ := s.Tweak(1)
	if got.Status != StatusDelivered || !got.WaitFrom.Equal(time.UnixMilli(1700000000000)) {
		t.Fatalf("after the upgrade: %s, waiting from %v", got.Status, got.WaitFrom)
	}
}

func TestADeliveredTweakWaitsFromItsAck(t *testing.T) {
	s, c, tw, _ := printed(t)
	got, _ := s.Tweak(tw.Number)
	if got.Status != StatusDelivered || got.Resends != 0 || !got.WaitFrom.Equal(c.now()) {
		t.Fatalf("after the ack: %s, %d resends, waiting from %v", got.Status, got.Resends, got.WaitFrom)
	}
}

func TestAnUnconfirmedTweakComesBackAfterThreeMinutesAtMostTwice(t *testing.T) {
	s, c, tw, seq := printed(t)

	c.advance(wait - time.Second)
	if got := resend(t, s); len(got) != 0 {
		t.Fatalf("resent %d before 3 minutes", len(got))
	}
	c.advance(time.Second)
	if got := resend(t, s); len(got) != 1 || got[0].Number != tw.Number || got[0].Resends != 1 {
		t.Fatalf("at 3 minutes: %+v", got)
	}
	if got := resend(t, s); len(got) != 0 {
		t.Fatal("a second sweep resent it again")
	}
	in, _ := s.Inbox("s1", seq)
	if got := types(in.Events); len(got) != 1 || got[0] != EventTweakAgain || in.Events[0].Tweak.Number != tw.Number {
		t.Fatalf("inbox %v", got)
	}

	// The next wait runs from that line's ack, not from when it was logged.
	c.advance(time.Hour)
	if got := resend(t, s); len(got) != 0 {
		t.Fatal("resent before the again: line was printed")
	}
	ack, _ := s.Inbox("s1", in.Seq)
	if got, _ := s.Tweak(tw.Number); got.Status != StatusDelivered || !got.WaitFrom.Equal(c.now()) {
		t.Fatalf("after the again: ack: %s, waiting from %v", got.Status, got.WaitFrom)
	}
	c.advance(wait)
	if got := resend(t, s); len(got) != 1 || got[0].Resends != 2 {
		t.Fatalf("the second: %+v", got)
	}
	in, _ = s.Inbox("s1", ack.Seq)
	s.Inbox("s1", in.Seq)
	c.advance(time.Hour)
	if got := resend(t, s); len(got) != 0 {
		t.Fatal("resent a third time")
	}
	if got, _ := s.Tweak(tw.Number); got.Status != StatusDelivered || got.Resends != 2 {
		t.Fatalf("after two: %s, %d resends", got.Status, got.Resends)
	}
}

func TestWorkOrQueueConfirmsATweak(t *testing.T) {
	for _, status := range []string{StatusWorking, StatusQueued} {
		s, c, tw, _ := printed(t)
		if _, err := s.SetStatus("s1", tw.Number, status, nil); err != nil {
			t.Fatal(err)
		}
		c.advance(time.Hour)
		if got := resend(t, s); len(got) != 0 {
			t.Fatalf("a %s tweak was resent", status)
		}
	}
}

func TestASentTweakIsntResent(t *testing.T) {
	s := open(t)
	c := &clock{t: time.UnixMilli(1_800_000_000_000)}
	s.SetClock(c.now)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	s.CreateTweak(newTweak("https://ernie.localhost/", "never printed"))
	c.advance(time.Hour)
	if got := resend(t, s); len(got) != 0 {
		t.Fatal("a tweak no watcher printed was resent: it waits for a watcher instead")
	}
}

func TestAReplyDeliveredStartsAFreshWait(t *testing.T) {
	s, c, tw, seq := printed(t)
	c.advance(wait)
	resend(t, s)
	in, _ := s.Inbox("s1", seq)
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	s.SetStatus("s1", tw.Number, StatusQuestion, &Entry{From: FromClaude, Kind: KindQuestion, Text: "which green?"})
	s.Reply(tw.Number, "the dark one")
	in, _ = s.Inbox("s1", in.Seq)
	s.Inbox("s1", in.Seq)
	got, _ := s.Tweak(tw.Number)
	if got.Status != StatusDelivered || got.Resends != 0 || !got.WaitFrom.Equal(c.now()) {
		t.Fatalf("the reply delivered: %s, %d resends, waiting from %v", got.Status, got.Resends, got.WaitFrom)
	}
}

func TestSendAgainFromTheCard(t *testing.T) {
	s, _, tw, seq := printed(t)
	got, err := s.SendAgain(tw.Number)
	if err != nil || got.Resends != 1 || got.Status != StatusDelivered {
		t.Fatalf("send again: %+v %v", got, err)
	}
	in, _ := s.Inbox("s1", seq)
	if got := types(in.Events); len(got) != 1 || got[0] != EventTweakAgain {
		t.Fatalf("inbox %v", got)
	}
	// One already on its way isn't sent twice.
	if again, err := s.SendAgain(tw.Number); err != nil || again.Resends != 1 {
		t.Fatalf("second send again before the first was printed: %+v %v", again, err)
	}

	s.Inbox("s1", in.Seq)
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	if _, err := s.SendAgain(tw.Number); !errors.Is(err, ErrPickedUp) {
		t.Fatalf("send again on a working tweak: %v", err)
	}
	if _, err := s.SendAgain(999); !errors.Is(err, ErrNoTweak) {
		t.Fatalf("send again on no tweak: %v", err)
	}
}
