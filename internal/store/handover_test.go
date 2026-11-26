package store

import (
	"errors"
	"testing"
	"time"
)

// Tweaks follow the page, not the session (docs/design.md, "When the
// session goes quiet"): a claim released, lapsed or ended sends its open
// tweaks back to sent, and the next session to claim the page gets them as
// new. A lapsed claim comes back to its session within 24 hours, unless
// another session claimed an overlapping pattern meanwhile.

const (
	lapseAfter = 10 * time.Minute
	restoreFor = 24 * time.Hour
)

// held is s1 claiming ernie.localhost with one tweak delivered to it, s2
// registered, on a hand-moved clock.
func held(t *testing.T) (*Store, *clock, Tweak) {
	t.Helper()
	s, c, tw, _ := printed(t)
	register(t, s, "s2", "/dev/ernie-2")
	return s, c, tw
}

func statusOf(t *testing.T, s *Store, n int64) Tweak {
	t.Helper()
	tw, err := s.Tweak(n)
	if err != nil {
		t.Fatal(err)
	}
	return tw
}

func lines(t *testing.T, s *Store, session string) []Event {
	t.Helper()
	in, err := s.Inbox(session, -1)
	if err != nil {
		t.Fatal(err)
	}
	return in.Events
}

func TestAReleasedPagesTweaksGoToTheNextClaimantAsNew(t *testing.T) {
	s, _, tw := held(t)
	if _, err := s.Release("s1", ""); err != nil {
		t.Fatal(err)
	}
	if got := statusOf(t, s, tw.Number); got.Status != StatusSent || got.Session != "" {
		t.Fatalf("after the release: %s for %q", got.Status, got.Session)
	}
	if _, err := s.Claim("s2", mustParse(t, "https://ernie.localhost/*")); err != nil {
		t.Fatal(err)
	}
	got := lines(t, s, "s2")
	if len(got) != 1 || got[0].Type != EventTweakHanded || got[0].Tweak.Number != tw.Number || got[0].Tweak.Session != "s2" {
		t.Fatalf("s2's inbox %v", types(got))
	}
	// s1 hears nothing more of it, even its old unacknowledged lines.
	if old := lines(t, s, "s1"); len(old) != 0 {
		t.Fatalf("s1's inbox %v", types(old))
	}
	// The ack delivers it to s2, which can work on it; s1 can't.
	in, _ := s.Inbox("s2", -1)
	s.Inbox("s2", in.Seq)
	if got := statusOf(t, s, tw.Number); got.Status != StatusDelivered {
		t.Fatalf("after s2's ack: %s", got.Status)
	}
	if _, err := s.SetStatus("s1", tw.Number, StatusQueued, nil); !errors.As(err, new(*NotYoursError)) {
		t.Fatalf("s1 queueing it: %v", err)
	}
}

func TestOnlyOpenTweaksOnTheReleasedPagesFollow(t *testing.T) {
	s, _, tw := held(t)
	s.Claim("s1", mustParse(t, "https://ernie.test/*"))
	other, _ := s.CreateTweak(newTweak("https://ernie.test/", "stays"))
	finished, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "finished"))
	s.Work("s1", finished.Number, nil, CaptureStart{})
	s.SetStatusEnding("s1", finished.Number, StatusDone, &Entry{From: FromClaude, Kind: KindSummary, Text: "did it"}, &CaptureEnd{Tweak: finished.Number})
	s.Release("s1", "https://ernie.localhost/*")
	if got := statusOf(t, s, tw.Number); got.Session != "" {
		t.Fatalf("the released page's tweak is still for %q", got.Session)
	}
	if got := statusOf(t, s, other.Number); got.Session != "s1" || got.Status != StatusSent {
		t.Fatalf("the other page's tweak: %s for %q", got.Status, got.Session)
	}
	if got := statusOf(t, s, finished.Number); got.Session != "s1" || got.Status != StatusDone {
		t.Fatalf("the done tweak: %s for %q", got.Status, got.Session)
	}
}

// A question asked by s1 and answered after s1 let go goes to s2 as new,
// with the conversation; its again: line repeats the new line, not the reply.
func TestAReplyGoesOnlyToTheAsker(t *testing.T) {
	s, _, tw := held(t)
	s.Work("s1", tw.Number, nil, CaptureStart{})
	s.SetStatusEnding("s1", tw.Number, StatusQuestion, &Entry{From: FromClaude, Kind: KindQuestion, Text: "which green?"}, &CaptureEnd{Tweak: tw.Number})
	s.Reply(tw.Number, "the dark one")
	s.Release("s1", "")
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	got := lines(t, s, "s2")
	if len(got) != 1 || got[0].Type != EventTweakHanded || len(got[0].Tweak.Entries) != 3 {
		t.Fatalf("s2's inbox %v", types(got))
	}
	if got[0].Tweak.Line != LineNew {
		t.Fatalf("handed over as %q", got[0].Tweak.Line)
	}
}

// A working tweak handed over keeps its change, and the next claimant's
// brief gets a notice naming the files already changed.
func TestAWorkingTweakHandedOverKeepsItsChangeWithANotice(t *testing.T) {
	s, _, tw := held(t)
	s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie", Repo: "/dev/ernie", Base: "abc"})
	s.RecordBefore("s1", text("/dev/ernie/app.css", "red"))
	s.Release("s1", "")
	s.EndCapture("s1", CaptureEnd{Tweak: tw.Number, Files: []After{after("/dev/ernie/app.css", "green")}, Checked: true})
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	got := statusOf(t, s, tw.Number)
	last := got.Entries[len(got.Entries)-1]
	want := "The session in /dev/ernie released this page. Files already changed: app.css."
	if last.From != FromBridge || last.Kind != KindNotice || last.Text != want {
		t.Fatalf("last entry %+v, want %q", last, want)
	}
	// s2's work extends the same change, keeping s1's before copy.
	if _, err := s.Work("s2", tw.Number, nil, CaptureStart{Folder: "/dev/ernie-2"}); err != nil {
		t.Fatal(err)
	}
	c, err := s.Capturing("s2")
	if err != nil || len(c.Files) != 1 || string(c.Files[0].Data) != "red" {
		t.Fatalf("s2's capture %+v %v", c, err)
	}
}

func TestALapsedClaimComesBackAtTheNextCheckIn(t *testing.T) {
	s, c, tw := held(t)
	s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie", Repo: "/dev/ernie", Base: "abc"})
	c.advance(lapseAfter - time.Second)
	if lapsing, _ := s.LapsingSessions(lapseAfter); len(lapsing) != 0 {
		t.Fatalf("lapsing before 10 minutes: %v", lapsing)
	}
	c.advance(time.Second)
	lapsing, _ := s.LapsingSessions(lapseAfter)
	if len(lapsing) != 1 || lapsing[0] != "s1" {
		t.Fatalf("lapsing %v", lapsing)
	}
	lapsed, err := s.Lapse("s1", lapseAfter)
	if err != nil || len(lapsed) != 1 {
		t.Fatalf("lapse %v %v", lapsed, err)
	}
	s.EndCapture("s1", CaptureEnd{Tweak: tw.Number})
	if n, _ := s.ClaimCount(); n != 0 {
		t.Fatalf("%d claims while lapsed", n)
	}
	if got := statusOf(t, s, tw.Number); got.Status != StatusSent || got.Session != "" {
		t.Fatalf("while lapsed: %s for %q", got.Status, got.Session)
	}
	if _, err := s.CreateTweak(newTweak("https://ernie.localhost/", "while lapsed")); !errors.Is(err, ErrNoClaim) {
		t.Fatalf("a tweak on a lapsed page: %v", err)
	}

	c.advance(time.Hour)
	back, err := s.Return("s1", restoreFor)
	if err != nil || len(back.Restored) != 1 || back.Restored[0].Pattern != "https://ernie.localhost/*" || back.Capturing != tw.Number {
		t.Fatalf("return %+v %v", back, err)
	}
	got := statusOf(t, s, tw.Number)
	if got.Status != StatusWorking || got.Session != "s1" {
		t.Fatalf("restored: %s for %q", got.Status, got.Session)
	}
	capt, err := s.Capturing("s1")
	if err != nil || capt.Base != "abc" {
		t.Fatalf("capture restarted %+v %v: the baseline must stay", capt, err)
	}
	in := lines(t, s, "s1")
	if len(in) != 1 || in[0].Type != EventClaimRestored {
		t.Fatalf("inbox %v", types(in))
	}
	// Checked in now: nothing more to restore.
	if again, _ := s.Return("s1", restoreFor); len(again.Restored) != 0 {
		t.Fatalf("restored twice: %+v", again)
	}
}

// A delivered tweak comes back delivered, with a fresh wait: no again: line.
func TestARestoredDeliveredTweakWaitsAfresh(t *testing.T) {
	s, c, tw := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	c.advance(time.Hour)
	s.Return("s1", restoreFor)
	if got := statusOf(t, s, tw.Number); got.Status != StatusDelivered || !got.WaitFrom.Equal(c.now()) {
		t.Fatalf("restored %s waiting from %v", got.Status, got.WaitFrom)
	}
	if again := resend(t, s); len(again) != 0 {
		t.Fatalf("sent again at once: %v", again)
	}
}

func TestALapseIsCancelledByACheckInMeanwhile(t *testing.T) {
	s, c, _ := held(t)
	c.advance(lapseAfter)
	s.CheckIn("s1")
	if lapsed, _ := s.Lapse("s1", lapseAfter); len(lapsed) != 0 {
		t.Fatalf("lapsed after a check-in: %v", lapsed)
	}
}

func TestALapsedClaimIsKeptFor24Hours(t *testing.T) {
	s, c, tw := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	c.advance(restoreFor)
	if err := s.ForgetLapsed(restoreFor); err != nil {
		t.Fatal(err)
	}
	back, _ := s.Return("s1", restoreFor)
	if len(back.Restored) != 0 {
		t.Fatalf("restored after 24 hours: %+v", back)
	}
	if got := statusOf(t, s, tw.Number); got.Session != "" {
		t.Fatalf("the tweak went back to %q", got.Session)
	}
	// The next claimant gets it as new, with a notice.
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	if got := lines(t, s, "s2"); len(got) != 1 || got[0].Type != EventTweakHanded {
		t.Fatalf("s2's inbox %v", types(got))
	}
}

func TestAnOverlappingClaimMeanwhileLosesTheLapsedOne(t *testing.T) {
	s, c, tw := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	if _, err := s.Claim("s2", mustParse(t, "https://ernie.localhost/admin/*")); err != nil {
		t.Fatalf("a lapsed claim must not block another: %v", err)
	}
	in := lines(t, s, "s1")
	if len(in) != 1 || in[0].Type != EventClaimLost || in[0].Claim.LostTo != "/dev/ernie-2" {
		t.Fatalf("s1's inbox %v", types(in))
	}
	back, err := s.Return("s1", restoreFor)
	if err != nil || len(back.Restored) != 0 || len(back.Lost) != 1 {
		t.Fatalf("return %+v %v", back, err)
	}
	want := "claim lost: https://ernie.localhost/* is now claimed by the session in /dev/ernie-2: leave its tweaks to that session, or claim another page with /tweak <url>"
	if s.LostLine(back.Lost[0]) != want {
		t.Fatalf("lost line %q", s.LostLine(back.Lost[0]))
	}
	// Reported once; its status commands keep getting the same refusal.
	if again, _ := s.Return("s1", restoreFor); len(again.Lost) != 0 {
		t.Fatalf("lost reported twice")
	}
	_, err = s.SetStatus("s1", tw.Number, StatusQueued, nil)
	if err == nil || err.Error() != want {
		t.Fatalf("a status command on a lost tweak: %v", err)
	}
	// The tweak on / isn't on s2's pages: it waits for a session.
	if got := statusOf(t, s, tw.Number); got.Session != "" {
		t.Fatalf("the tweak went to %q", got.Session)
	}
}

func TestASessionEndingReleasesEverything(t *testing.T) {
	s, c, tw := held(t)
	s.Claim("s1", mustParse(t, "https://ernie.test/*"))
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	s.CheckIn("s1")
	s.Claim("s1", mustParse(t, "https://bert.localhost/*"))
	if err := s.EndSession("s1"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.ClaimCount(); n != 0 {
		t.Fatalf("%d claims after the session ended", n)
	}
	if back, _ := s.Return("s1", restoreFor); len(back.Restored) != 0 {
		t.Fatalf("an ended session's lapsed claims came back: %+v", back)
	}
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	if got := statusOf(t, s, tw.Number); got.Session != "s2" {
		t.Fatalf("the tweak is for %q", got.Session)
	}
}

// A line s1 was given but never acknowledged isn't s1's once the tweak has
// passed to another session.
func TestOldLinesDontOutliveAHandover(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/ernie-2")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	s.Release("s1", "")
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	if got := lines(t, s, "s1"); len(got) != 0 {
		t.Fatalf("s1's inbox %v", types(got))
	}
}

// Claim IDs are reused once the claims table empties: a second lapse must
// still be kept beside the first.
func TestASecondLapseIsKeptBesideALostOne(t *testing.T) {
	s, c, _ := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	c.advance(lapseAfter)
	lapsed, err := s.Lapse("s2", lapseAfter)
	if err != nil || len(lapsed) != 1 {
		t.Fatalf("s2's lapse %v %v", lapsed, err)
	}
	if back, _ := s.Return("s2", restoreFor); len(back.Restored) != 1 {
		t.Fatalf("s2's return %+v", back)
	}
}

// A lost claim is forgotten 24 hours after it lapsed, even while its
// session keeps checking in.
func TestALostClaimIsForgottenAfter24Hours(t *testing.T) {
	s, c, tw := held(t)
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	s.Claim("s2", mustParse(t, "https://ernie.localhost/admin/*"))
	for range 25 {
		c.advance(time.Hour)
		s.Return("s1", restoreFor)
	}
	s.ForgetLapsed(restoreFor)
	_, err := s.SetStatus("s1", tw.Number, StatusQueued, nil)
	if !errors.As(err, new(*NotYoursError)) {
		t.Fatalf("a day later: %v", err)
	}
}

// A handed-over tweak whose old session's capture hasn't ended yet (its
// teardown is in the git check) can't be worked on by the new one until it
// has: the old round's baseline must judge the old round's edits.
func TestAHandedOverTweakWaitsForTheOldCaptureToEnd(t *testing.T) {
	s, c, tw := held(t)
	s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie", Repo: "/dev/ernie", Base: "abc"})
	c.advance(lapseAfter)
	s.Lapse("s1", lapseAfter)
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	if _, err := s.Work("s2", tw.Number, nil, CaptureStart{Folder: "/dev/ernie-2", Base: "def"}); !errors.Is(err, ErrCapturedElsewhere) {
		t.Fatalf("work while s1 still captures: %v", err)
	}
	if capt, err := s.Capturing("s1"); err != nil || capt.Base != "abc" {
		t.Fatalf("s1's capture %+v %v", capt, err)
	}
	s.EndCapture("s1", CaptureEnd{Tweak: tw.Number})
	if _, err := s.Work("s2", tw.Number, nil, CaptureStart{Folder: "/dev/ernie-2", Base: "def"}); err != nil {
		t.Fatalf("work once s1's capture ended: %v", err)
	}
}
