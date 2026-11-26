package store

import (
	"errors"
	"testing"
)

// finished gives s1 a done tweak whose change recorded a.css (red to
// green) and created new.rb, and lists unrecorded sed.rb.
func finished(t *testing.T, s *Store) Tweak {
	t.Helper()
	tw := working(t, s)
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	s.RecordBefore("s1", Before{ChangeFile: ChangeFile{Path: "/dev/ernie/new.rb", Shown: "new.rb"}, Absent: true})
	end := CaptureEnd{Tweak: tw.Number, Checked: true, Files: []After{after("/dev/ernie/a.css", "green"), after("/dev/ernie/new.rb", "class New; end")},
		Unrecorded: []ChangeFile{{Path: "/dev/ernie/sed.rb", Shown: "sed.rb"}}}
	done, err := s.SetStatusEnding("s1", tw.Number, StatusDone, &Entry{From: FromClaude, Kind: KindSummary, Text: "green"}, &end)
	if err != nil {
		t.Fatal(err)
	}
	return done
}

func TestAnUndoGetsTheRecordedFilesOnly(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	u, err := s.Undoable(tw.Number)
	if err != nil {
		t.Fatal(err)
	}
	if len(u.Files) != 2 {
		t.Fatalf("files %+v, want a.css and new.rb (never the unrecorded sed.rb)", u.Files)
	}
	a, n := u.Files[0], u.Files[1]
	if a.Path != "/dev/ernie/a.css" || string(a.Before) != "red" || string(a.After) != "green" || a.BeforeAbsent || a.AfterAbsent {
		t.Fatalf("a.css %+v", a)
	}
	if n.Path != "/dev/ernie/new.rb" || !n.BeforeAbsent || n.Before != nil || string(n.After) != "class New; end" {
		t.Fatalf("new.rb %+v", n)
	}
}

func TestOnlyAFinishedChangeCanBeUndone(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	if _, err := s.Undoable(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("while working and capturing: %v", err)
	}
	if _, err := s.Undoable(99); !errors.Is(err, ErrNoTweak) {
		t.Fatalf("no tweak: %v", err)
	}
	// A question ends capture, but the tweak isn't finished.
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	end := CaptureEnd{Tweak: tw.Number, Checked: true, Files: []After{after("/dev/ernie/a.css", "green")}}
	s.SetStatusEnding("s1", tw.Number, StatusQuestion, &Entry{From: FromClaude, Kind: KindQuestion, Text: "which?"}, &end)
	if _, err := s.Undoable(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("with a question: %v", err)
	}
	// Declined after edits: undoable.
	if _, err := s.SetStatus("s1", tw.Number, StatusDeclined, &Entry{From: FromClaude, Kind: KindReason, Text: "CMS"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Undoable(tw.Number); err != nil {
		t.Fatalf("declined after edits: %v", err)
	}
}

func TestNoFilesChangedHasNothingToUndo(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	s.SetStatusEnding("s1", tw.Number, StatusDone, &Entry{From: FromClaude, Kind: KindSummary, Text: "nothing"}, &CaptureEnd{Tweak: tw.Number, Checked: true})
	if _, err := s.Undoable(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("no files changed: %v", err)
	}
}

func TestACleanUndoIsUndoneOnce(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	seq, _, _, _ := s.Snapshot()
	undone, err := s.Undone(tw.Number)
	if err != nil {
		t.Fatal(err)
	}
	if undone.Change.State != ChangeUndone || undone.Status != StatusDone {
		t.Fatalf("change %s, status %s", undone.Change.State, undone.Status)
	}
	if e := undone.Entries[len(undone.Entries)-1]; e.From != FromYou || e.Kind != KindUndo {
		t.Fatalf("last entry %+v, want your undo", e)
	}
	events, _ := s.EventsAfter(seq)
	if got := types(events); len(got) != 1 || got[0] != EventTweakUndone {
		t.Fatalf("events %v, want one tweak-undone", got)
	}
	// A second click finds nothing to undo.
	if _, err := s.Undone(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("again: %v", err)
	}
	if _, err := s.Undoable(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("undoable again: %v", err)
	}
}

func TestAConflictGoesToTheSessionClaimingThePageNow(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	// s1 lets the page go; s2 claims it.
	s.Release("s1", "")
	register(t, s, "s2", "/dev/ernie-2")
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	in, _ := s.Inbox("s2", -1)

	asked, err := s.RequestUndo(tw.Number, 1)
	if err != nil {
		t.Fatal(err)
	}
	if asked.Change.State != ChangeUndoRequested || asked.Change.Conflicts != 1 || asked.Session != "s2" {
		t.Fatalf("change %+v, session %q", asked.Change, asked.Session)
	}
	got, _ := s.Inbox("s2", in.Seq)
	if len(got.Events) != 1 || got.Events[0].Type != EventTweakUndoConflict || got.Events[0].Tweak.Change.Conflicts != 1 {
		t.Fatalf("s2's inbox %v", types(got.Events))
	}
	// The session that resolves it owns it now.
	if _, err := s.ResolveUndo("s1", tw.Number, "done by hand"); !errors.As(err, new(*NotYoursError)) {
		t.Fatalf("s1 resolving: %v", err)
	}
	seq, _, _, _ := s.Snapshot()
	resolved, err := s.ResolveUndo("s2", tw.Number, "reverted it, kept the later edits")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Change.State != ChangeUndone {
		t.Fatalf("state %s", resolved.Change.State)
	}
	if e := resolved.Entries[len(resolved.Entries)-1]; e.From != FromClaude || e.Kind != KindUndo || e.Text != "reverted it, kept the later edits" {
		t.Fatalf("last entry %+v", e)
	}
	if events, _ := s.EventsAfter(seq); len(events) != 1 || events[0].Type != EventTweakUndone {
		t.Fatalf("events %v, want tweak-undone", types(events))
	}
	if _, err := s.ResolveUndo("s2", tw.Number, "again"); !errors.Is(err, ErrNotUndoRequested) {
		t.Fatalf("resolving twice: %v", err)
	}
}

func TestWithNoClaimTheConflictWaitsForOne(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	s.Release("s1", "")
	asked, err := s.RequestUndo(tw.Number, 2)
	if err != nil {
		t.Fatal(err)
	}
	if asked.Session != "" || !asked.Change.Waiting {
		t.Fatalf("session %q, change %+v: it should wait for a session", asked.Session, asked.Change)
	}
	// Another page's claim doesn't take it.
	register(t, s, "s2", "/dev/bert")
	s.Claim("s2", mustParse(t, "https://bert.localhost/*"))
	in, _ := s.Inbox("s2", -1)
	if len(in.Events) != 0 {
		t.Fatalf("bert's session heard %v", types(in.Events))
	}
	// A claim covering the page gets it, and hears of it.
	register(t, s, "s3", "/dev/ernie-3")
	s.Claim("s3", mustParse(t, "https://ernie.localhost/*"))
	in, _ = s.Inbox("s3", -1)
	if len(in.Events) != 1 || in.Events[0].Type != EventTweakUndoConflict {
		t.Fatalf("s3's inbox %v", types(in.Events))
	}
	if now, _ := s.Tweak(tw.Number); now.Session != "s3" || now.Change.Waiting {
		t.Fatalf("session %q", now.Session)
	}
}

func TestReleasingThePageSendsAWaitingUndoBackToWaiting(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	s.RequestUndo(tw.Number, 1)
	s.Release("s1", "")
	if now, _ := s.Tweak(tw.Number); now.Session != "" || !now.Change.Waiting {
		t.Fatalf("after the release: session %q", now.Session)
	}
	register(t, s, "s2", "/dev/ernie-2")
	s.Claim("s2", mustParse(t, "https://ernie.localhost/*"))
	if in, _ := s.Inbox("s2", -1); len(in.Events) != 1 || in.Events[0].Type != EventTweakUndoConflict {
		t.Fatalf("s2's inbox %v", types(in.Events))
	}
}

func TestDecliningAnUndoKeepsTheChange(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	s.RequestUndo(tw.Number, 1)
	kept, err := s.SetStatus("s1", tw.Number, StatusDeclined, &Entry{From: FromClaude, Kind: KindReason, Text: "later work needs it"})
	if err != nil {
		t.Fatal(err)
	}
	if kept.Status != StatusDone || kept.Change.State != ChangeRecorded || kept.Change.Conflicts != 0 {
		t.Fatalf("status %s, change %+v: the tweak stays done and the change recorded", kept.Status, kept.Change)
	}
	if e := kept.Entries[len(kept.Entries)-1]; e.Kind != KindReason || e.Text != "later work needs it" {
		t.Fatalf("last entry %+v", e)
	}
	// It can be undone again later.
	if _, err := s.Undoable(tw.Number); err != nil {
		t.Fatalf("undoable after a declined undo: %v", err)
	}
	// Declining a done tweak with no undo asked is still refused.
	if _, err := s.SetStatus("s1", tw.Number, StatusDeclined, &Entry{From: FromClaude, Kind: KindReason, Text: "again"}); !errors.As(err, new(*TransitionError)) {
		t.Fatalf("declining a done tweak: %v", err)
	}
}

func TestAskingClaudeToUndoWhenNothingWasRecorded(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	end := CaptureEnd{Tweak: tw.Number, Checked: true, Unrecorded: []ChangeFile{{Path: "/dev/ernie/sed.rb", Shown: "sed.rb"}}}
	s.SetStatusEnding("s1", tw.Number, StatusDone, &Entry{From: FromClaude, Kind: KindSummary, Text: "sed"}, &end)
	u, err := s.Undoable(tw.Number)
	if err != nil || len(u.Files) != 0 {
		t.Fatalf("%+v %v", u, err)
	}
	if _, err := s.Undone(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("nothing recorded can't be undone by the bridge: %v", err)
	}
	asked, err := s.RequestUndo(tw.Number, 0)
	if err != nil || asked.Change.State != ChangeUndoRequested {
		t.Fatalf("%+v %v", asked.Change, err)
	}
	kept, err := s.SetStatus("s1", tw.Number, StatusDeclined, &Entry{From: FromClaude, Kind: KindReason, Text: "no"})
	if err != nil || kept.Change.State != ChangeNothingRecorded {
		t.Fatalf("declined: %+v %v", kept.Change, err)
	}
}

func TestAnUndoCanBeRequestedOnce(t *testing.T) {
	s := open(t)
	tw := finished(t, s)
	s.RequestUndo(tw.Number, 1)
	if _, err := s.RequestUndo(tw.Number, 1); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("twice: %v", err)
	}
	if _, err := s.Undoable(tw.Number); !errors.Is(err, ErrNotUndoable) {
		t.Fatalf("undoable while requested: %v", err)
	}
}
