package brief

import (
	"bytes"
	"encoding/json"
	"strings"
)

// How page text is kept from passing for the brief's own voice: every page
// string is on one line, in backticks or JSON-quoted, or (HTML) in a fence
// longer than any backtick run inside it; and it is capped.

// oneLine collapses every run of whitespace, newlines included, to a space.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// Cut puts s on one line and shortens it to at most n characters, ending in
// … when it was longer.
func Cut(s string, n int) string { return clip(oneLine(s), n) }

// clip shortens s to at most n characters, ending in … when it was longer.
func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// longestRun is the longest run of backticks in s.
func longestRun(s string) int {
	longest, run := 0, 0
	for _, r := range s {
		if r == '`' {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	return longest
}

// Code is s on one line as a Markdown code span, its backtick run longer
// than any inside it.
func Code(s string) string {
	s = oneLine(s)
	if s == "" {
		return `""` // an empty span would pair with the next backtick run
	}
	fence := strings.Repeat("`", longestRun(s)+1)
	if strings.HasPrefix(s, "`") || strings.HasSuffix(s, "`") {
		s = " " + s + " "
	}
	return fence + s + fence
}

// Quote is s on one line, in double quotes with JSON escaping.
func Quote(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(oneLine(s))
	return strings.TrimSuffix(buf.String(), "\n")
}

// fenced is s in a fenced code block of the given language, every line
// indented by indent, the fence longer than any backtick run inside.
func fenced(s, lang, indent string) string {
	fence := strings.Repeat("`", max(3, longestRun(s)+1))
	var b strings.Builder
	b.WriteString(indent + fence + lang + "\n")
	s = strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(s)
	for _, line := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
		b.WriteString(indent + line + "\n")
	}
	b.WriteString(indent + fence + "\n")
	return b.String()
}
