package brief

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Where the source is: placing the page's paths, the "Where to look" list,
// and how each location is described.

type renderer struct{ folder string }

// spot is a page-given location placed in the project once: file is the
// project-relative path, or the path as given when placed is false.
type spot struct {
	file         string
	placed       bool
	line, column int
}

func (r renderer) spot(file string, line, column int) spot {
	rel, ok := Place(r.folder, file)
	if !ok {
		rel = file
	}
	return spot{file: rel, placed: ok, line: line, column: column}
}

func (r renderer) at(l Location) spot { return r.spot(l.File, l.Line, l.Column) }

// String is the spot as the brief shows it: in the project, or as given and
// marked.
func (s spot) String() string {
	pos := ""
	if s.line > 0 {
		pos = ":" + strconv.Itoa(s.line)
		if s.column > 0 {
			pos += ":" + strconv.Itoa(s.column)
		}
	}
	if s.placed {
		return Code(s.file + pos)
	}
	return Code(Cut(s.file, pathCap)+pos) + " (not found in project)"
}

// place is a file and line: what "Where to look" lists once.
type place struct {
	file string
	line int
}

func (s spot) place() place { return place{s.file, s.line} }

// mapperName is how the brief names a mapper; never the raw string.
func mapperName(via string) string {
	for _, m := range mappers {
		if m.via == via {
			return m.name
		}
	}
	return "another mapper"
}

func mapperRank(via string) int {
	for i, m := range mappers {
		if m.via == via {
			return i
		}
	}
	return len(mappers)
}

func roleRank(role string) int {
	switch role {
	case RoleElement:
		return 0
	case RoleComponent:
		return 1
	case RoleUsage:
		return 2
	}
	return 3
}

// stronger says whether a outranks b: by role, then mapper priority.
func stronger(a, b Location) bool {
	if roleRank(a.Role) != roleRank(b.Role) {
		return roleRank(a.Role) < roleRank(b.Role)
	}
	return mapperRank(a.Via) < mapperRank(b.Via)
}

// how says what a location is, in brackets after it.
func how(l Location) string {
	switch {
	case l.Role == RoleElement && l.Exact():
		return "(" + mapperName(l.Via) + ", exact)"
	case l.Role == RoleElement:
		return "(" + mapperName(l.Via) + ", file only; search this file for its clues)"
	case l.Via == "rails":
		return "(Rails template)"
	case l.Role == RoleStyle:
		return "(" + mapperName(l.Via) + ")"
	}
	return "(" + mapperName(l.Via) + " component)"
}

// elements is "element 1", "elements 1 and 2" or "elements 1, 2 and 4".
func elements(ns []int) string {
	s := make([]string, len(ns))
	for i, n := range ns {
		s[i] = strconv.Itoa(n)
	}
	if len(s) == 1 {
		return "element " + s[0]
	}
	return "elements " + strings.Join(s[:len(s)-1], ", ") + " and " + s[len(s)-1]
}

// source is an element's innermost location and the ones enclosing it,
// leaving out styles.
func source(e Element) []Location {
	var out []Location
	for _, l := range e.Locations {
		if l.Role != RoleStyle && strings.TrimSpace(l.File) != "" {
			out = append(out, l)
		}
	}
	return out
}

// own splits an element's source into its own location (role element), if
// it has one, and the components or templates enclosing it.
func own(e Element) (self *Location, enclosing []Location) {
	for _, l := range source(e) {
		switch {
		case l.Role == RoleElement && self == nil:
			self = &l
		case l.Role != RoleElement:
			enclosing = append(enclosing, l)
		}
	}
	return self, enclosing
}

// entry is one line of "Where to look".
type entry struct {
	at    spot
	loc   Location
	rule  string // the rule's selector, for a CSS rule
	els   []int
	order int
}

func (en *entry) add(n int) {
	if en.els[len(en.els)-1] != n {
		en.els = append(en.els, n)
	}
}

// whereToLook lists, for every element, the innermost location each mapper
// found, then the CSS rules with a line and other style locations. The same
// file and line is listed once, with the strongest role and mapper found
// there. exact says whether any element or component location has a line.
func (r renderer) whereToLook(els []Element) (lines []string, exact bool) {
	var locs, rules []*entry
	byPlace := map[place]*entry{}
	ruled := map[place]*entry{}
	addLoc := func(l Location, n int) {
		s := r.at(l)
		if en, ok := byPlace[s.place()]; ok {
			en.add(n)
			if stronger(l, en.loc) {
				en.loc, en.at = l, s
			}
			return
		}
		en := &entry{at: s, loc: l, els: []int{n}, order: len(locs)}
		byPlace[s.place()] = en
		locs = append(locs, en)
	}
	for i, e := range els {
		seen := map[string]bool{}
		for _, l := range source(e) {
			if !seen[l.Via] {
				seen[l.Via] = true
				addLoc(l, i+1)
			}
		}
	}
	for i, e := range els {
		for _, ru := range e.Rules {
			if ru.File == "" || ru.Line <= 0 {
				continue
			}
			s := r.spot(ru.File, ru.Line, ru.Column)
			if en, ok := ruled[s.place()]; ok {
				en.add(i + 1)
				continue
			}
			en := &entry{at: s, loc: Location{Role: RoleStyle, Via: "css", Line: ru.Line}, rule: ru.Selector, els: []int{i + 1}}
			ruled[s.place()] = en
			rules = append(rules, en)
		}
	}
	for i, e := range els {
		for _, l := range e.Locations {
			if l.Role == RoleStyle && strings.TrimSpace(l.File) != "" {
				if en, ok := ruled[r.at(l).place()]; ok {
					en.add(i + 1)
				} else {
					addLoc(l, i+1)
				}
			}
		}
	}
	sort.SliceStable(locs, func(a, b int) bool {
		x, y := locs[a].loc, locs[b].loc
		if roleRank(x.Role) != roleRank(y.Role) {
			return roleRank(x.Role) < roleRank(y.Role)
		}
		if x.Exact() != y.Exact() {
			return x.Exact()
		}
		if mapperRank(x.Via) != mapperRank(y.Via) {
			return mapperRank(x.Via) < mapperRank(y.Via)
		}
		return locs[a].order < locs[b].order
	})
	// Styles go last (locs has them last already): the located rules, then
	// other style locations.
	split := sort.Search(len(locs), func(i int) bool { return locs[i].loc.Role == RoleStyle })
	all := append(append(append([]*entry{}, locs[:split]...), rules...), locs[split:]...)
	for _, en := range all {
		l := en.loc
		if l.Role != RoleStyle && l.Exact() {
			exact = true
		}
		switch {
		case en.rule != "":
			lines = append(lines, fmt.Sprintf("%s: %s, %s", en.at, Code(Cut(en.rule, selectorCap)), elements(en.els)))
		case l.Role == RoleElement:
			lines = append(lines, fmt.Sprintf("%s: %s %s", en.at, elements(en.els), how(l)))
		case l.Role == RoleUsage:
			lines = append(lines, fmt.Sprintf("%s: uses the component that renders %s %s", en.at, elements(en.els), how(l)))
		case l.Role == RoleStyle:
			lines = append(lines, fmt.Sprintf("%s: styles %s %s", en.at, elements(en.els), how(l)))
		default:
			lines = append(lines, fmt.Sprintf("%s: renders %s %s", en.at, elements(en.els), how(l)))
		}
	}
	return lines, exact
}

// enclosingName is a component or template as the brief names it.
func (r renderer) enclosingName(l Location) string {
	switch {
	case l.Name != "":
		return fmt.Sprintf("%s (%s)", Code(Cut(l.Name, labelCap)), r.at(l))
	case l.Via == "rails":
		return "template " + r.at(l).String()
	}
	return r.at(l).String()
}

// renderedBy names what renders an element with no location of its own.
func (r renderer) renderedBy(l Location) string {
	if l.Via == "rails" {
		return r.enclosingName(l)
	}
	return r.enclosingName(l) + " " + how(l)
}

// chain is the "rendered inside" list: up to 4 enclosing components or
// templates, one per file.
func (r renderer) chain(ls []Location) string {
	var parts []string
	files := map[string]bool{}
	for _, l := range ls {
		if len(parts) == chainCount {
			break
		}
		if files[l.File] {
			continue
		}
		files[l.File] = true
		parts = append(parts, r.enclosingName(l))
	}
	return strings.Join(parts, ", ")
}
