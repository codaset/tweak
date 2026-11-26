package merge

import (
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

// lines joins its arguments, each ending "\n".
func lines(ls ...string) string {
	if len(ls) == 0 {
		return ""
	}
	return strings.Join(ls, "\n") + "\n"
}

func TestMergeReversesAChangeAroundLaterEdits(t *testing.T) {
	cases := []struct {
		name                    string
		base, ours, theirs, out string
		conflicts               int
	}{
		{
			name:   "an edit elsewhere in the file is kept",
			base:   lines("a", "b CHANGED", "c", "d", "e"),
			ours:   lines("a", "b CHANGED", "c", "d", "e later"),
			theirs: lines("a", "b", "c", "d", "e"),
			out:    lines("a", "b", "c", "d", "e later"),
		},
		{
			name:   "lines added above move the change, which is still reversed",
			base:   lines("a", "b CHANGED", "c"),
			ours:   lines("new 1", "new 2", "a", "b CHANGED", "c"),
			theirs: lines("a", "b", "c"),
			out:    lines("new 1", "new 2", "a", "b", "c"),
		},
		{
			name:   "an inserted block is removed",
			base:   lines("a", "x", "y", "b", "c", "d"),
			ours:   lines("a", "x", "y", "b", "c", "d later"),
			theirs: lines("a", "b", "c", "d"),
			out:    lines("a", "b", "c", "d later"),
		},
		{
			name:      "the same line edited again conflicts",
			base:      lines("a", "b CHANGED", "c"),
			ours:      lines("a", "b CHANGED AGAIN", "c"),
			theirs:    lines("a", "b", "c"),
			out:       lines("a", "<<<<<<< now", "b CHANGED AGAIN", "||||||| after", "b CHANGED", "=======", "b", ">>>>>>> before", "c"),
			conflicts: 1,
		},
		{
			name:      "an edit on the line next to the change conflicts",
			base:      lines("a", "b CHANGED", "c", "d"),
			ours:      lines("a", "b CHANGED", "c later", "d"),
			theirs:    lines("a", "b", "c", "d"),
			out:       lines("a", "<<<<<<< now", "b CHANGED", "c later", "||||||| after", "b CHANGED", "c", "=======", "b", "c", ">>>>>>> before", "d"),
			conflicts: 1,
		},
		{
			name:      "lines inserted right after the change conflict",
			base:      lines("a", "b CHANGED", "c"),
			ours:      lines("a", "b CHANGED", "inserted", "c"),
			theirs:    lines("a", "b", "c"),
			out:       lines("a", "<<<<<<< now", "b CHANGED", "inserted", "||||||| after", "b CHANGED", "=======", "b", ">>>>>>> before", "c"),
			conflicts: 1,
		},
		{
			name:   "the same change made on both sides is clean",
			base:   lines("a", "b CHANGED", "c"),
			ours:   lines("a", "b", "c", "d"),
			theirs: lines("a", "b", "c"),
			out:    lines("a", "b", "c", "d"),
		},
		{
			name:      "two conflicts are counted apart",
			base:      lines("a X", "b", "c", "d", "e", "f X", "g"),
			ours:      lines("a Y", "b", "c", "d", "e", "f Y", "g"),
			theirs:    lines("a", "b", "c", "d", "e", "f", "g"),
			out:       lines("<<<<<<< now", "a Y", "||||||| after", "a X", "=======", "a", ">>>>>>> before", "b", "c", "d", "e", "<<<<<<< now", "f Y", "||||||| after", "f X", "=======", "f", ">>>>>>> before", "g"),
			conflicts: 2,
		},
		{
			name:   "CRLF line endings are kept as they are",
			base:   "a\r\nb CHANGED\r\nc\r\nd\r\n",
			ours:   "a\r\nb CHANGED\r\nc\r\nd later\r\n",
			theirs: "a\r\nb\r\nc\r\nd\r\n",
			out:    "a\r\nb\r\nc\r\nd later\r\n",
		},
		{
			name:   "a last line with no newline stays without one",
			base:   "a\nb CHANGED\nc\nd",
			ours:   "a\nb CHANGED\nc\nd later",
			theirs: "a\nb\nc\nd",
			out:    "a\nb\nc\nd later",
		},
		{
			name:   "a newline Claude added at the end is taken away",
			base:   "a\nb\nc\nd\n",
			ours:   "top\na\nb\nc\nd\n",
			theirs: "a\nb\nc\nd",
			out:    "top\na\nb\nc\nd",
		},
		{
			name:   "an empty before copy",
			base:   lines("a"),
			ours:   lines("a"),
			theirs: "",
			out:    "",
		},
		{
			name:   "repeated lines don't confuse the match",
			base:   lines("x", "x", "CHANGED", "x", "x", "x", "x"),
			ours:   lines("x", "x", "CHANGED", "x", "x", "x", "x", "later"),
			theirs: lines("x", "x", "x", "x", "x", "x"),
			out:    lines("x", "x", "x", "x", "x", "x", "later"),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Merge([]byte(c.base), []byte(c.ours), []byte(c.theirs))
			if string(got.Text) != c.out || got.Conflicts != c.conflicts {
				t.Errorf("Merge gave %d conflicts:\n%q\nwant %d:\n%q", got.Conflicts, got.Text, c.conflicts, c.out)
			}
		})
	}
}

// Merging with nothing changed on one side gives the other side back.
func TestMergeIdentities(t *testing.T) {
	texts := []string{"", "a\n", "a\nb\nc\n", "a\r\nb", lines("x", "y", "x", "y", "z"), "no newline"}
	for _, base := range texts {
		for _, other := range texts {
			if got := Merge([]byte(base), []byte(base), []byte(other)); string(got.Text) != other || got.Conflicts != 0 {
				t.Errorf("Merge(%q, base, %q) = %q (%d conflicts)", base, other, got.Text, got.Conflicts)
			}
			if got := Merge([]byte(base), []byte(other), []byte(base)); string(got.Text) != other || got.Conflicts != 0 {
				t.Errorf("Merge(%q, %q, base) = %q (%d conflicts)", base, other, got.Text, got.Conflicts)
			}
			if got := Merge([]byte(base), []byte(other), []byte(other)); string(got.Text) != other || got.Conflicts != 0 {
				t.Errorf("Merge(%q, x, x) with x %q = %q (%d conflicts)", base, other, got.Text, got.Conflicts)
			}
		}
	}
}

// A change too big to diff in reasonable time is a conflict, never a guess.
func TestAHugeRewriteConflicts(t *testing.T) {
	var base, ours, theirs strings.Builder
	for i := range 20000 {
		base.WriteString("base " + strings.Repeat("x", i%7) + "\n")
		ours.WriteString("ours " + strings.Repeat("y", i%5) + "\n")
		theirs.WriteString("theirs " + strings.Repeat("z", i%3) + "\n")
	}
	got := Merge([]byte(base.String()), []byte(ours.String()), []byte(theirs.String()))
	if got.Conflicts == 0 {
		t.Error("a whole-file rewrite on both sides merged clean")
	}
}

func TestUnifiedShowsAChange(t *testing.T) {
	cases := []struct {
		name, a, b, want string
	}{
		{"no change", "a\n", "a\n", ""},
		{
			"one line changed, with context",
			lines("1", "2", "3", "4", "5", "6", "7", "8"),
			lines("1", "2", "3", "4 new", "5", "6", "7", "8"),
			lines("@@ -1,7 +1,7 @@", " 1", " 2", " 3", "-4", "+4 new", " 5", " 6", " 7"),
		},
		{
			"two far apart changes are two hunks",
			lines("a", "1", "2", "3", "4", "5", "6", "7", "8", "z"),
			lines("A", "1", "2", "3", "4", "5", "6", "7", "8", "Z"),
			lines("@@ -1,4 +1,4 @@", "-a", "+A", " 1", " 2", " 3", "@@ -7,4 +7,4 @@", " 6", " 7", " 8", "-z", "+Z"),
		},
		{
			"a new file",
			"",
			lines("a", "b"),
			lines("@@ -0,0 +1,2 @@", "+a", "+b"),
		},
		{
			"no newline at the end",
			"a\nb",
			"a\nc",
			lines("@@ -1,2 +1,2 @@", " a", "-b", `\ No newline at end of file`, "+c", `\ No newline at end of file`),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Unified([]byte(c.a), []byte(c.b)); got != c.want {
				t.Errorf("Unified:\n%s\nwant:\n%s", got, c.want)
			}
		})
	}
}

// Applying a diff's hunks to a gives b, for many small random texts, and
// each hunk is separated from the next by an unchanged line.
func TestDiffTurnsAIntoB(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	text := func() []string {
		var ls []string
		for range rng.IntN(12) {
			ls = append(ls, string(rune('x'+rng.IntN(3)))+"\n")
		}
		return ls
	}
	for range 5000 {
		a, b := text(), text()
		hs, ok := diff(a, b)
		if !ok {
			t.Fatal("small texts weren't diffed")
		}
		got := apply(a, b, 0, len(a), hs)
		if !slices.Equal(got, b) && !(len(got) == 0 && len(b) == 0) {
			t.Fatalf("diff(%q, %q) applied gives %q", a, b, got)
		}
		for i := 1; i < len(hs); i++ {
			if hs[i].a0 <= hs[i-1].a1 {
				t.Fatalf("diff(%q, %q): hunks %v and %v touch", a, b, hs[i-1], hs[i])
			}
		}
	}
}
