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

// A licence file may start with up to this many words before the licence
// itself: a title, the project's name, copyright lines.
const maxPreamble = 40

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
		body := templatePattern(string(text))
		out = append(out, template{
			name: strings.TrimSuffix(e.Name(), path.Ext(e.Name())),
			re:   regexp.MustCompile(`^(?:(\S+(?: \S+)*?) )?` + body + `$`),
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
	urls    = regexp.MustCompile(`<?https?://[^\s>]+>?`)
	nonWord = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	digits  = regexp.MustCompile(`^\p{N}+$`)
)

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
	normal := strings.Join(words(text), " ")
	for _, t := range templates {
		m := t.re.FindStringSubmatch(normal)
		if m != nil && len(strings.Fields(m[1])) <= maxPreamble {
			return t.name, true
		}
	}
	return "", false
}
