// Package merge is a line-based three-way merge (diff3), and the unified
// diff tweak undo prints. Undo reverses a change around later edits with it
// (docs/design.md, "Reversing"): the base is the change's after contents,
// one side is the file as it is now, the other the before copy.
//
// Lines keep their terminators, so CRLF files and a last line with no
// newline come back byte for byte. Changes on both sides that overlap, or
// touch (one ends on the line where the other starts), conflict unless
// they're the same: when in doubt, Undo asks Claude rather than guess.
package merge

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
)

// Result is a merge: the merged text, with each conflict marked as
//
//	<<<<<<< now
//	…the file as it is now…
//	||||||| after
//	…the change's after contents…
//	=======
//	…the before copy…
//	>>>>>>> before
//
// and how many conflicts there are. Text is the clean result when
// Conflicts is 0.
type Result struct {
	Text      []byte
	Conflicts int
}

// Merge merges ours and theirs, each changed from base.
func Merge(base, ours, theirs []byte) Result {
	o, a, b := split(base), split(ours), split(theirs)
	ha, okA := diff(o, a)
	hb, okB := diff(o, b)
	if !okA || !okB {
		// Too far apart to diff in reasonable time: all of it conflicts.
		var out bytes.Buffer
		conflict(&out, a, o, b)
		return Result{Text: out.Bytes(), Conflicts: 1}
	}
	type sided struct {
		hunk
		ours bool
	}
	var all []sided
	for _, h := range ha {
		all = append(all, sided{h, true})
	}
	for _, h := range hb {
		all = append(all, sided{h, false})
	}
	slices.SortStableFunc(all, func(x, y sided) int { return x.a0 - y.a0 })

	var out bytes.Buffer
	conflicts, pos := 0, 0
	for i := 0; i < len(all); {
		lo, hi := all[i].a0, all[i].a1
		j := i + 1
		for j < len(all) && all[j].a0 <= hi { // overlapping or touching
			hi = max(hi, all[j].a1)
			j++
		}
		var onOurs, onTheirs []hunk
		for _, h := range all[i:j] {
			if h.ours {
				onOurs = append(onOurs, h.hunk)
			} else {
				onTheirs = append(onTheirs, h.hunk)
			}
		}
		write(&out, o[pos:lo])
		mine, other := apply(o, a, lo, hi, onOurs), apply(o, b, lo, hi, onTheirs)
		switch {
		case len(onTheirs) == 0:
			write(&out, mine)
		case len(onOurs) == 0, slices.Equal(mine, other):
			write(&out, other)
		default:
			conflict(&out, mine, o[lo:hi], other)
			conflicts++
		}
		pos, i = hi, j
	}
	write(&out, o[pos:])
	return Result{Text: out.Bytes(), Conflicts: conflicts}
}

// apply is base's lines lo to hi with one side's hunks in that range applied.
func apply(base, side []string, lo, hi int, hunks []hunk) []string {
	var out []string
	cur := lo
	for _, h := range hunks {
		out = append(out, base[cur:h.a0]...)
		out = append(out, side[h.b0:h.b1]...)
		cur = h.a1
	}
	return append(out, base[cur:hi]...)
}

func conflict(out *bytes.Buffer, now, after, before []string) {
	section := func(marker string, ls []string) {
		out.WriteString(marker + "\n")
		write(out, ls)
		if n := len(ls); n > 0 && !strings.HasSuffix(ls[n-1], "\n") {
			out.WriteString("\n")
		}
	}
	section("<<<<<<< now", now)
	section("||||||| after", after)
	section("=======", before)
	out.WriteString(">>>>>>> before\n")
}

func write(out *bytes.Buffer, ls []string) {
	for _, l := range ls {
		out.WriteString(l)
	}
}

// context is the unchanged lines Unified shows around each change.
const context = 3

// Unified is the unified diff from a to b, hunks only (no file header), or
// "" when they're the same.
func Unified(a, b []byte) string {
	la, lb := split(a), split(b)
	hs, ok := diff(la, lb)
	if !ok {
		hs = []hunk{{0, len(la), 0, len(lb)}}
	}
	var out strings.Builder
	for i := 0; i < len(hs); {
		end := i
		for end+1 < len(hs) && hs[end+1].a0-hs[end].a1 <= 2*context {
			end++
		}
		a0, a1 := max(0, hs[i].a0-context), min(len(la), hs[end].a1+context)
		b0, b1 := hs[i].b0-(hs[i].a0-a0), hs[end].b1+(a1-hs[end].a1)
		fmt.Fprintf(&out, "@@ -%s +%s @@\n", span(a0, a1-a0), span(b0, b1-b0))
		cur := a0
		for _, h := range hs[i : end+1] {
			prefixed(&out, " ", la[cur:h.a0])
			prefixed(&out, "-", la[h.a0:h.a1])
			prefixed(&out, "+", lb[h.b0:h.b1])
			cur = h.a1
		}
		prefixed(&out, " ", la[cur:a1])
		i = end + 1
	}
	return out.String()
}

// span is a hunk header's range, as GNU diff writes it.
func span(start, count int) string {
	switch count {
	case 0:
		return fmt.Sprintf("%d,0", start)
	case 1:
		return fmt.Sprint(start + 1)
	}
	return fmt.Sprintf("%d,%d", start+1, count)
}

func prefixed(out *strings.Builder, prefix string, ls []string) {
	for _, l := range ls {
		out.WriteString(prefix + l)
		if !strings.HasSuffix(l, "\n") {
			out.WriteString("\n\\ No newline at end of file\n")
		}
	}
}

// split is text's lines, each with its terminator.
func split(text []byte) []string {
	var out []string
	for len(text) > 0 {
		i := bytes.IndexByte(text, '\n')
		if i < 0 {
			out = append(out, string(text))
			break
		}
		out = append(out, string(text[:i+1]))
		text = text[i+1:]
	}
	return out
}

// hunk is a run of lines a[a0:a1] that became b[b0:b1].
type hunk struct{ a0, a1, b0, b1 int }

// maxEdits bounds the diff: two texts further apart than this many line
// edits (after their common start and end) aren't diffed. It keeps a
// whole-file rewrite of a 2 MB file from taking seconds and memory.
const maxEdits = 2000

// diff is the hunks that turn a into b, in order, each separated from the
// next by at least one unchanged line. ok is false when a and b are more
// than maxEdits apart.
func diff(a, b []string) (hs []hunk, ok bool) {
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	ma, mb := a[pre:len(a)-suf], b[pre:len(b)-suf]
	matches, ok := myers(ma, mb)
	if !ok {
		return nil, false
	}
	i, j := 0, 0
	for _, m := range append(matches, [2]int{len(ma), len(mb)}) {
		if m[0] > i || m[1] > j {
			hs = append(hs, hunk{pre + i, pre + m[0], pre + j, pre + m[1]})
		}
		i, j = m[0]+1, m[1]+1
	}
	return hs, true
}

// myers is Myers' O(ND) diff: the matching lines (i in a, j in b) of a
// shortest edit script, in order.
func myers(a, b []string) ([][2]int, bool) {
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return nil, true
	}
	limit := min(n+m, maxEdits)
	off := limit + 1
	v := make([]int, 2*off+1)
	// trace[d] is v[-d..d] as it was before step d.
	var trace [][]int
	for d := 0; d <= limit; d++ {
		trace = append(trace, slices.Clone(v[off-d:off+d+1]))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x, y = x+1, y+1
			}
			v[off+k] = x
			if x >= n && y >= m {
				return backtrack(trace, n, m, d), true
			}
		}
	}
	return nil, false
}

func backtrack(trace [][]int, x, y, d int) [][2]int {
	var matches [][2]int
	for ; d > 0; d-- {
		v := trace[d]
		at := func(k int) int { return v[k+d] }
		k := x - y
		prev := k - 1
		if k == -d || (k != d && at(k-1) < at(k+1)) {
			prev = k + 1
		}
		px := at(prev)
		py := px - prev
		for x > px && y > py {
			x, y = x-1, y-1
			matches = append(matches, [2]int{x, y})
		}
		x, y = px, py
	}
	for x > 0 && y > 0 {
		x, y = x-1, y-1
		matches = append(matches, [2]int{x, y})
	}
	slices.Reverse(matches)
	return matches
}
