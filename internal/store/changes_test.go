package store

import (
	"errors"
	"testing"
	"time"
)

// working gives s1 a tweak it's working on and capturing.
func working(t *testing.T, s *Store) Tweak {
	t.Helper()
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, err := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie", Repo: "/dev/ernie", Base: "abc123"}); err != nil {
		t.Fatal(err)
	}
	return tw
}

func text(path, data string) Before {
	return Before{ChangeFile: ChangeFile{Path: path, Shown: path[len("/dev/ernie/"):]}, Text: true, Data: []byte(data)}
}

func after(path, data string) After { return After{Path: path, Text: true, Data: []byte(data)} }

func TestOnlyTheFirstBeforeCopyIsKept(t *testing.T) {
	s := open(t)
	working(t, s)
	if r, err := s.RecordBefore("s1", text("/dev/ernie/a.css", "red")); !r.Saved || err != nil {
		t.Fatalf("first: %+v %v", r, err)
	}
	if r, err := s.RecordBefore("s1", text("/dev/ernie/a.css", "green")); r.Saved || err != nil {
		t.Fatalf("second: %+v %v", r, err)
	}
	c, err := s.Capturing("s1")
	if err != nil || len(c.Files) != 1 || string(c.Files[0].Data) != "red" {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := s.RecordBefore("s2", text("/dev/ernie/b.css", "")); !errors.Is(err, ErrNotCapturing) {
		t.Fatalf("a session that isn't capturing: %v", err)
	}
}

// A tweak's first before copy is its first edit, timed from when the
// tweak was delivered (docs/design.md, "Open measurements"). Later copies,
// and a later round of work, aren't first.
func TestTheFirstEditIsTimedFromDelivery(t *testing.T) {
	s := open(t)
	now := time.UnixMilli(1_700_000_000_000)
	s.SetClock(func() time.Time { return now })
	register(t, s, "s1", "/dev/ernie")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	tw, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "make it green"))
	in, _ := s.Inbox("s1", -1)
	s.Inbox("s1", in.Seq) // acknowledges the new line: delivered
	now = now.Add(5 * time.Second)
	if _, err := s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie"}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(29 * time.Second)
	r, err := s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	if err != nil || r.First == nil || *r.First != (FirstEdit{Tweak: tw.Number, Delivered: true, After: 34 * time.Second}) {
		t.Fatalf("first: %+v %+v %v", r, r.First, err)
	}
	now = now.Add(time.Second)
	if r, _ := s.RecordBefore("s1", text("/dev/ernie/b.css", "blue")); !r.Saved || r.First != nil {
		t.Fatalf("second file: %+v", r)
	}
}

// A tweak worked on before its line was acknowledged has no delivery time:
// its first edit is still reported, without one.
func TestAFirstEditWithoutADeliveryTime(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	r, err := s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	if err != nil || r.First == nil || *r.First != (FirstEdit{Tweak: tw.Number}) {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestEndingCaptureReadsAfterContentsAndDropsUnchangedFiles(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	s.RecordBefore("s1", text("/dev/ernie/empty.txt", ""))
	s.RecordBefore("s1", text("/dev/ernie/denied.rb", "same"))
	s.RecordBefore("s1", Before{ChangeFile: ChangeFile{Path: "/dev/ernie/new.rb", Shown: "new.rb"}, Absent: true})
	s.RecordBefore("s1", Before{ChangeFile: ChangeFile{Path: "/dev/ernie/logo.png", Shown: "logo.png"}}) // binary
	s.RecordBefore("s1", text("/dev/ernie/grew.txt", "small"))
	s.RecordBefore("s1", Before{ChangeFile: ChangeFile{Path: "/elsewhere/x.css", Shown: "/elsewhere/x.css", Outside: true}, Text: true, Data: []byte("a")})

	c, _ := s.Capturing("s1")
	if !c.Files[1].Text || c.Files[1].Absent || c.Files[1].Data == nil {
		t.Fatalf("an empty file's before copy is empty, not absent: %+v", c.Files[1])
	}
	if !c.Files[3].Absent {
		t.Fatalf("a new file is absent: %+v", c.Files[3])
	}

	end := CaptureEnd{Tweak: tw.Number, Checked: true, Files: []After{
		after("/dev/ernie/a.css", "green"),
		after("/dev/ernie/empty.txt", "now text"),
		after("/dev/ernie/denied.rb", "same"),
		after("/dev/ernie/new.rb", "class New; end"),
		{Path: "/dev/ernie/logo.png"},
		{Path: "/dev/ernie/grew.txt"}, // now over 2 MB
		after("/elsewhere/x.css", "b"),
	}, Unrecorded: []ChangeFile{{Path: "/dev/ernie/sed.rb", Shown: "sed.rb"}}}
	done, err := s.SetStatusEnding("s1", tw.Number, StatusDone, &Entry{From: FromClaude, Kind: KindSummary, Text: "green"}, &end)
	if err != nil {
		t.Fatal(err)
	}
	ch := done.Change
	if ch == nil || ch.Capturing || ch.State != ChangeRecorded || !ch.Checked {
		t.Fatalf("change %+v", ch)
	}
	var files, unrecorded []string
	for _, f := range ch.Files {
		files = append(files, f.Shown)
	}
	for _, f := range ch.Unrecorded {
		unrecorded = append(unrecorded, f.Shown)
	}
	if got := join(files); got != "a.css empty.txt new.rb /elsewhere/x.css" {
		t.Fatalf("files %s", got)
	}
	if got := join(unrecorded); got != "sed.rb logo.png grew.txt" {
		t.Fatalf("unrecorded %s", got)
	}
	if !ch.Files[3].Outside {
		t.Fatalf("outside: %+v", ch.Files[3])
	}
	if _, err := s.Capturing("s1"); !errors.Is(err, ErrNotCapturing) {
		t.Fatalf("still capturing: %v", err)
	}
	// The done event carries the change.
	events, _ := s.EventsAfter(0)
	last := events[len(events)-1]
	if last.Type != EventTweakStatus || last.Tweak.Status != StatusDone || last.Tweak.Change == nil || len(last.Tweak.Change.Files) != 4 {
		t.Fatalf("last event %+v", last.Tweak)
	}
}

func join(s []string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += " "
		}
		out += x
	}
	return out
}

func TestNothingRecordedOrNothingChanged(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	tw, err := s.EndCapture("s1", CaptureEnd{Tweak: tw.Number, Checked: true, Files: []After{after("/dev/ernie/a.css", "red")}})
	if err != nil {
		t.Fatal(err)
	}
	if c := tw.Change; c.State != ChangeNothingRecorded || len(c.Files) != 0 || len(c.Unrecorded) != 0 || !c.Checked {
		t.Fatalf("no files changed: %+v", c)
	}
}

func TestAReplyThenWorkExtendsTheSameChange(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	end := CaptureEnd{Tweak: tw.Number, Files: []After{after("/dev/ernie/a.css", "green")}, Unrecorded: []ChangeFile{{Path: "/dev/ernie/sed.rb", Shown: "sed.rb"}}}
	if _, err := s.SetStatusEnding("s1", tw.Number, StatusQuestion, &Entry{From: FromClaude, Kind: KindQuestion, Text: "which?"}, &end); err != nil {
		t.Fatal(err)
	}
	s.Reply(tw.Number, "the dark one")
	if _, err := s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie", Repo: "/dev/ernie", Base: "def456"}); err != nil {
		t.Fatal(err)
	}
	// The second round's hook finds a.css green: the first before copy stays.
	s.RecordBefore("s1", text("/dev/ernie/a.css", "green"))
	c, _ := s.Capturing("s1")
	if c.Base != "def456" || len(c.Files) != 1 || string(c.Files[0].Data) != "red" || len(c.Unrecorded) != 1 {
		t.Fatalf("capture %+v", c)
	}
}

func TestOneCapturingTweakPerSession(t *testing.T) {
	s := open(t)
	first := working(t, s)
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	second, _ := s.CreateTweak(newTweak("https://ernie.localhost/", "and this"))

	// Working on another tweak needs the first capture's end, or it's refused
	// and nothing changes: edits never land in the wrong tweak's change.
	if _, err := s.Work("s1", second.Number, nil, CaptureStart{Folder: "/dev/ernie"}); !errors.Is(err, ErrStillCapturing) {
		t.Fatalf("work without ending the first: %v", err)
	}
	if _, err := s.Work("s1", second.Number, &CaptureEnd{Tweak: second.Number}, CaptureStart{Folder: "/dev/ernie"}); !errors.Is(err, ErrNotCapturing) {
		t.Fatalf("work ending the wrong tweak: %v", err)
	}
	if tw, _ := s.Tweak(second.Number); tw.Status != StatusSent {
		t.Fatalf("a refused work moved the tweak to %s", tw.Status)
	}
	if c, _ := s.Capturing("s1"); c.Tweak != first.Number {
		t.Fatalf("a refused work moved the capture to %d", c.Tweak)
	}

	end := CaptureEnd{Tweak: first.Number, Files: []After{after("/dev/ernie/a.css", "green")}}
	if _, err := s.Work("s1", second.Number, &end, CaptureStart{Folder: "/dev/ernie"}); err != nil {
		t.Fatal(err)
	}
	c, _ := s.Capturing("s1")
	if c.Tweak != second.Number {
		t.Fatalf("capturing %d", c.Tweak)
	}
	if tw, _ := s.Tweak(first.Number); tw.Change.Capturing || tw.Change.State != ChangeRecorded {
		t.Fatalf("the first tweak's change %+v", tw.Change)
	}
	sessions, _ := s.CapturingSessions()
	if len(sessions) != 1 || sessions[0] != "s1" {
		t.Fatalf("capturing sessions %v", sessions)
	}
	// Ending names the tweak it ends.
	if _, err := s.EndCapture("s1", CaptureEnd{Tweak: first.Number}); !errors.Is(err, ErrNotCapturing) {
		t.Fatalf("ending another tweak: %v", err)
	}
}

// A file shell-edited before the hook recorded it: its before copy isn't
// what the git snapshot had, so it's listed as recorded and as unrecorded.
// Each file is judged against the snapshot of the round it was recorded in.
func TestBeforeCopiesRememberTheirRoundsSnapshot(t *testing.T) {
	s := open(t)
	tw := working(t, s)
	s.RecordBefore("s1", text("/dev/ernie/a.css", "red"))
	c, _ := s.Capturing("s1")
	if c.Files[0].Base != "abc123" {
		t.Fatalf("base %q", c.Files[0].Base)
	}
	s.SetStatusEnding("s1", tw.Number, StatusQuestion, &Entry{From: FromClaude, Kind: KindQuestion, Text: "?"}, &CaptureEnd{Tweak: tw.Number, Files: []After{after("/dev/ernie/a.css", "green")}})
	s.Reply(tw.Number, "yes")
	s.Work("s1", tw.Number, nil, CaptureStart{Folder: "/dev/ernie", Repo: "/dev/ernie", Base: "def456"})
	s.RecordBefore("s1", text("/dev/ernie/b.css", "blue"))
	c, _ = s.Capturing("s1")
	if c.Files[0].Base != "abc123" || c.Files[1].Base != "def456" {
		t.Fatalf("bases %q %q", c.Files[0].Base, c.Files[1].Base)
	}
}
