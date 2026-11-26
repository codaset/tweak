package brief

import (
	"fmt"
	"strings"
)

// What a tweak points at beyond its elements (docs/design.md, "Pointing at
// things"): selected text in element 1, or an area inside element 1 that
// holds elements 2 on. Each has its own section after the elements.

// selected is the "Selected text" section, or "" when nothing was selected.
// The selection is in a fence longer than any backtick run inside it; the
// text around it is quoted on one line, cut furthest from the selection.
func selected(s *Selection) string {
	if s == nil || strings.TrimSpace(s.Text) == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString("## Selected text, in element 1\n\n")
	b.WriteString(fenced(clip(s.Text, selectionCap), "text", ""))
	b.WriteString("\n")
	if before := cutStart(oneLine(s.Before), aroundCap); before != "" {
		fmt.Fprintf(&b, "- Before it: %s\n", Quote(before))
	}
	if after := Cut(s.After, aroundCap); after != "" {
		fmt.Fprintf(&b, "- After it: %s\n", Quote(after))
	}
	return b.String()
}

// cutStart shortens s to at most n characters from its start, beginning
// with … when it was longer, so the end nearest the selection is kept.
func cutStart(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return "…" + string(r[len(r)-n+1:])
	}
	return s
}

// area is the "Area" section, or "" when the tweak isn't an area: the box,
// the element it is inside (element 1) and the elements fully inside it.
func area(a *Area, elements int) string {
	if a == nil || elements == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("## Area\n\n")
	fmt.Fprintf(&b, "- Box: %s×%s at %s, %s on the page (%s, %s in the viewport)\n",
		px(a.Page.Width), px(a.Page.Height), px(a.Page.X), px(a.Page.Y), px(a.Viewport.X), px(a.Viewport.Y))
	b.WriteString("- Inside: element 1\n")
	switch elements {
	case 1:
		b.WriteString("- Contains: no elements; the box is over empty space in element 1\n")
	case 2:
		b.WriteString("- Contains: element 2\n")
	default:
		fmt.Fprintf(&b, "- Contains: elements 2–%d\n", elements)
	}
	return b.String()
}
