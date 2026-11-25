package main

import (
	"embed"
	"path"
	"regexp"
	"sort"
	"strings"
)

// The allowlist: each licence's text, word for word, with two markers.
// <<any>> stands for the copyright holder's name (1 to 12 words), and
// <<or-end>> is a point where the text may stop (Apache without its appendix).
//
//go:embed licences/*.txt
var licenceFiles embed.FS

type template struct {
	name string
	re   *regexp.Regexp
}

var templates = loadTemplates()

func loadTemplates() []template {
	entries, err := licenceFiles.ReadDir("licences")
	if err != nil {
		panic(err)
	}
	var out []template
	for _, e := range entries {
		text, err := licenceFiles.ReadFile("licences/" + e.Name())
		if err != nil {
			panic(err)
		}
		out = append(out, template{
			name: strings.TrimSuffix(e.Name(), path.Ext(e.Name())),
			re:   regexp.MustCompile(`^` + templatePattern(withoutPreamble(string(text))) + `$`),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// templatePattern turns a template into a regexp over normalised words.
func templatePattern(text string) string {
	optional := strings.Split(text, "<<or-end>>")
	var b strings.Builder
	for i, part := range optional {
		var elems []string
		for j, piece := range strings.Split(part, "<<any>>") {
			if j > 0 {
				elems = append(elems, `\S+(?: \S+){0,11}`)
			}
			for _, w := range words(piece) {
				elems = append(elems, regexp.QuoteMeta(w))
			}
		}
		if i > 0 {
			b.WriteString("(?: ")
		}
		b.WriteString(strings.Join(elems, " "))
	}
	b.WriteString(strings.Repeat(")?", len(optional)-1))
	return b.String()
}

var (
	// Lines a licence file may start with before the licence itself: blank
	// lines, copyright lines, "All rights reserved", a URL, or a short title
	// naming a licence ("MIT License (Expat)", "Apache License"). Anything
	// else, such as an added restriction, must be part of the licence text.
	copyrightLine = regexp.MustCompile(`(?i)^(copyright\b|\(c\)|©)`)
	rightsLine    = regexp.MustCompile(`(?i)^all rights reserved\.?$`)
	urlLine       = regexp.MustCompile(`^<?https?://\S+$`)
	titleLine     = regexp.MustCompile(`(?i)^(the )?[\w.-]+( [\w.-]+)? licen[cs]e( \([\w.-]+\))?$`)

	urls    = regexp.MustCompile(`<?https?://[^\s>]+>?`)
	nonWord = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	digits  = regexp.MustCompile(`^\p{N}+$`)
)

// withoutPreamble drops the lines before the licence itself.
func withoutPreamble(text string) string {
	lines := strings.SplitAfter(text, "\n")
	for i, line := range lines {
		l := strings.TrimSpace(strings.TrimLeft(line, " \t/*#"))
		if l != "" && !copyrightLine.MatchString(l) && !rightsLine.MatchString(l) &&
			!urlLine.MatchString(l) && !titleLine.MatchString(l) {
			return strings.Join(lines[i:], "")
		}
	}
	return ""
}

// words reduces a text to its lower-case words, so layout, punctuation,
// clause numbers and URLs don't matter.
func words(text string) []string {
	text = urls.ReplaceAllString(strings.ToLower(text), " ")
	var out []string
	for _, w := range nonWord.Split(text, -1) {
		if w != "" && !digits.MatchString(w) {
			out = append(out, w)
		}
	}
	return out
}

// identify names the allowlisted licence a licence file holds, or reports
// false when it holds anything else.
func identify(text string) (string, bool) {
	normal := strings.Join(words(withoutPreamble(text)), " ")
	for _, t := range templates {
		if t.re.MatchString(normal) {
			return t.name, true
		}
	}
	return "", false
}
