package store

import (
	"errors"
	"testing"
)

// Every status change Claude may ask for, from every status: the allowed
// moves go through, and each refusal says what to do instead.
func TestEveryStatusChangeIsGuarded(t *testing.T) {
	entryFor := map[string]*Entry{
		StatusWorking:  nil,
		StatusQueued:   nil,
		StatusQuestion: {From: "claude", Kind: "question", Text: "outline?"},
		StatusDone:     {From: "claude", Kind: "summary", Text: "made it green"},
		StatusDeclined: {From: "claude", Kind: "reason", Text: "it comes from the CMS"},
	}
	// reach puts a fresh tweak into a status the way it gets there for real.
	reach := map[string][]string{
		StatusSent:     {},
		StatusQueued:   {StatusQueued},
		StatusWorking:  {StatusWorking},
		StatusQuestion: {StatusWorking, StatusQuestion},
		StatusDone:     {StatusWorking, StatusDone},
		StatusDeclined: {StatusDeclined},
	}
	const notWorking = "tweak 1 isn't being worked on: run tweak work 1 first"
	const asked = "tweak 1 is waiting for the developer's reply to your question: carry on when its reply event arrives"
	const isDone = "tweak 1 is already done: there's nothing more to do"
	const declined = "tweak 1 was declined: there's nothing more to do"
	cases := []struct{ from, to, refusal string }{
		{StatusSent, StatusWorking, ""},
		{StatusSent, StatusQueued, ""},
		{StatusSent, StatusQuestion, notWorking},
		{StatusSent, StatusDone, notWorking},
		{StatusSent, StatusDeclined, ""},
		{StatusDelivered, StatusWorking, ""},
		{StatusDelivered, StatusQueued, ""},
		{StatusDelivered, StatusQuestion, notWorking},
		{StatusDelivered, StatusDone, notWorking},
		{StatusDelivered, StatusDeclined, ""},
		{StatusQueued, StatusWorking, ""},
		{StatusQueued, StatusQueued, ""},
		{StatusQueued, StatusQuestion, notWorking},
		{StatusQueued, StatusDone, notWorking},
		{StatusQueued, StatusDeclined, ""},
		{StatusWorking, StatusWorking, ""},
		{StatusWorking, StatusQueued, "tweak 1 is being worked on: finish it with tweak done, ask or decline"},
		{StatusWorking, StatusQuestion, ""},
		{StatusWorking, StatusDone, ""},
		{StatusWorking, StatusDeclined, ""},
		{StatusQuestion, StatusWorking, asked},
		{StatusQuestion, StatusQueued, asked},
		{StatusQuestion, StatusQuestion, asked},
		{StatusQuestion, StatusDone, asked},
		{StatusQuestion, StatusDeclined, ""},
		{StatusDone, StatusQueued, isDone},
		{StatusDone, StatusQuestion, isDone},
		{StatusDone, StatusDeclined, isDone},
		{StatusDeclined, StatusWorking, declined},
		{StatusDeclined, StatusQueued, declined},
		{StatusDeclined, StatusQuestion, declined},
		{StatusDeclined, StatusDone, declined},
		{StatusDeclined, StatusDeclined, declined},
	}
	for _, c := range cases {
		t.Run(c.from+" to "+c.to, func(t *testing.T) {
			s := open(t)
			register(t, s, "s1", "/dev/ernie")
			s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
			tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
			if c.from == StatusDelivered {
				// The watcher printed it, and its next poll acknowledged it.
				in, _ := s.Inbox("s1", -1)
				s.Inbox("s1", in.Seq)
			}
			for _, step := range reach[c.from] {
				if _, err := s.SetStatus("s1", tw.Number, step, entryFor[step]); err != nil {
					t.Fatalf("reaching %s: %v", c.from, err)
				}
			}
			before, _ := s.Tweak(tw.Number)
			if before.Status != c.from {
				t.Fatalf("reached %s, not %s", before.Status, c.from)
			}
			got, err := s.SetStatus("s1", tw.Number, c.to, entryFor[c.to])
			if c.refusal == "" {
				if err != nil || got.Status != c.to {
					t.Fatalf("got %q %v", got.Status, err)
				}
				if e := entryFor[c.to]; e != nil && got.Entries[len(got.Entries)-1].Kind != e.Kind {
					t.Fatalf("entries %+v", got.Entries)
				}
				return
			}
			var te *TransitionError
			if !errors.As(err, &te) || err.Error() != c.refusal {
				t.Fatalf("got %v, want %q", err, c.refusal)
			}
			if after, _ := s.Tweak(tw.Number); after.Status != before.Status || len(after.Entries) != len(before.Entries) {
				t.Fatalf("a refusal changed the tweak: %+v", after)
			}
		})
	}
}

// A reply answers Claude's question: it joins the conversation, the tweak
// is sent again, and only a tweak with a question can take one.
func TestAReplyReopensAQuestion(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))

	if _, err := s.Reply(tw.Number, "the outline one"); !errors.Is(err, ErrNotAsked) {
		t.Fatalf("reply before a question: %v", err)
	}
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	s.SetStatus("s1", tw.Number, StatusQuestion, &Entry{From: "claude", Kind: "question", Text: "solid or outline?"})
	if _, err := s.Reply(tw.Number, "  \n "); !errors.Is(err, ErrBlankReply) {
		t.Fatalf("blank reply: %v", err)
	}
	if _, err := s.Reply(99, "x"); !errors.Is(err, ErrNoTweak) {
		t.Fatalf("no such tweak: %v", err)
	}

	got, err := s.Reply(tw.Number, "  the outline one\n")
	if err != nil || got.Status != StatusSent || got.StatusAt.Before(tw.StatusAt) {
		t.Fatalf("reply: %+v %v", got, err)
	}
	last := got.Entries[len(got.Entries)-1]
	if len(got.Entries) != 3 || last.From != "you" || last.Kind != "reply" || last.Text != "the outline one" {
		t.Fatalf("entries %+v", got.Entries)
	}
	if _, err := s.Reply(tw.Number, "again"); !errors.Is(err, ErrNotAsked) {
		t.Fatalf("a second reply: %v", err)
	}
	// The reply reopens the tweak for Claude.
	if again, err := s.SetStatus("s1", tw.Number, StatusWorking, nil); err != nil || again.Status != StatusWorking {
		t.Fatalf("work after the reply: %+v %v", again, err)
	}
}

// A plan is an entry while working; it doesn't change the status.
func TestAPlanIsPostedWhileWorking(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/bert")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))

	var te *TransitionError
	if _, err := s.Plan("s1", tw.Number, "edit buttons.css"); !errors.As(err, &te) || err.Error() != "tweak 1 isn't being worked on: run tweak work 1 first" {
		t.Fatalf("plan before work: %v", err)
	}
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	var notYours *NotYoursError
	if _, err := s.Plan("s2", tw.Number, "x"); !errors.As(err, &notYours) {
		t.Fatalf("another session's plan: %v", err)
	}
	working, _ := s.Tweak(tw.Number)
	got, err := s.Plan("s1", tw.Number, "edit buttons.css")
	if err != nil || got.Status != StatusWorking || !got.StatusAt.Equal(working.StatusAt) {
		t.Fatalf("plan: %+v %v", got, err)
	}
	if e := got.Entries[len(got.Entries)-1]; e.From != "claude" || e.Kind != "plan" || e.Text != "edit buttons.css" {
		t.Fatalf("entries %+v", got.Entries)
	}
}

// A reply reaches the session that asked, and no other, as a reply event;
// acknowledging it marks the tweak delivered, as for a new tweak.
func TestAReplyIsInTheAskingSessionsInbox(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/bert")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	s.Claim("s2", mustParse(t, "https://bert.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	first, _ := s.Inbox("s1", -1)
	s.Inbox("s2", -1)
	s.SetStatus("s1", tw.Number, StatusWorking, nil)
	s.SetStatus("s1", tw.Number, StatusQuestion, &Entry{From: "claude", Kind: "question", Text: "solid or outline?"})
	s.Reply(tw.Number, "outline")

	in, err := s.Inbox("s1", first.Seq)
	if err != nil {
		t.Fatal(err)
	}
	if got := types(in.Events); len(got) != 1 || got[0] != EventTweakReplied || in.Events[0].Tweak.Number != tw.Number {
		t.Fatalf("s1's inbox %v", got)
	}
	if other, _ := s.Inbox("s2", -1); len(other.Events) != 0 {
		t.Fatalf("s2 heard of the reply: %v", types(other.Events))
	}
	if got, _ := s.Tweak(tw.Number); got.Status != StatusSent {
		t.Fatalf("before the ack: %s", got.Status)
	}
	s.Inbox("s1", in.Seq)
	if got, _ := s.Tweak(tw.Number); got.Status != StatusDelivered {
		t.Fatalf("after the ack: %s", got.Status)
	}
}
