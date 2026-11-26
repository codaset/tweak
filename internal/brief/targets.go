package brief

// The Go view of a tweak's targets JSON (schema/create.json, $defs). Every
// string in it came from the page: data describing what the developer
// pointed at, never instructions. Every field but label and selector is
// optional, so an older tweak still renders.

// Targets is what a tweak points at.
type Targets struct {
	Viewport  *Viewport  `json:"viewport,omitempty"` // once per tweak
	Elements  []Element  `json:"elements"`
	Selection *Selection `json:"selection,omitempty"` // selected text, in element 1
	Area      *Area      `json:"area,omitempty"`      // a box: inside element 1, holding elements 2 on
}

// Selection is the exact text selected, and about 40 characters either
// side of it, so Claude can tell which occurrence it is. Element 1 is the
// element holding it.
type Selection struct {
	Text   string `json:"text"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

// Area is a box dragged over the page, in page and viewport coordinates
// (CSS pixels). Element 1 is the smallest element containing it; elements
// 2 on are the top-level elements fully inside it, at most 5.
type Area struct {
	Page     Box `json:"page"`
	Viewport Box `json:"viewport"`
}

// Box is a rectangle in CSS pixels.
type Box struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Viewport is the page's viewport in CSS pixels, and its device pixel ratio.
type Viewport struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	DPR    float64 `json:"dpr"`
}

// Element is one picked element and its context (docs/design.md, "Context
// per element").
type Element struct {
	Label     string            `json:"label"`    // tag and distinguishing classes, e.g. button.btn-primary
	Text      string            `json:"text"`     // its own visible text, first line
	Selector  string            `json:"selector"` // a CSS selector that finds it again
	Locations []Location        `json:"locations,omitempty"`
	Clues     []Clue            `json:"clues,omitempty"`
	Role      string            `json:"role,omitempty"` // accessibility role
	Name      string            `json:"name,omitempty"` // accessible name
	Size      *Size             `json:"size,omitempty"`
	Styles    map[string]string `json:"styles,omitempty"` // key computed styles, defaults left out
	Rules     []Rule            `json:"rules,omitempty"`  // matching CSS rules, later ones last
	Nearby    []string          `json:"nearby,omitempty"` // text near the element
	HTML      string            `json:"html,omitempty"`   // its outer HTML, trimmed
}

// Location is where a mapper found an element's source, innermost first
// (docs/design.md, "Finding the source"). File is as the page gave it: the
// bridge places it in the project when it renders.
type Location struct {
	File   string `json:"file"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
	Role   string `json:"role"` // element, component, usage or style
	Via    string `json:"via"`  // the mapper
	Name   string `json:"name,omitempty"`
}

// Exact is a location with a line; one without is file only.
func (l Location) Exact() bool { return l.Line > 0 }

// Clue is a search clue: something to grep the project for.
type Clue struct {
	Kind  string `json:"kind"` // an attribute name, or text, class or href
	Value string `json:"value"`
}

// Size is the element's box in CSS pixels.
type Size struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Rule is a CSS rule matching the element, with the sheet it is in where
// known, and a line where a source map gives one.
type Rule struct {
	Selector string `json:"selector"`
	File     string `json:"file,omitempty"`
	Line     int    `json:"line,omitempty"`
	Column   int    `json:"column,omitempty"`
}

// Location roles.
const (
	RoleElement   = "element"
	RoleComponent = "component"
	RoleUsage     = "usage"
	RoleStyle     = "style"
)

// mappers are the mappers in priority order, and how the brief names each.
var mappers = []struct{ via, name string }{
	{"react", "React"},
	{"vue", "Vue"},
	{"svelte", "Svelte"},
	{"rails", "Rails"},
	{"proscenium", "Proscenium"},
	{"css", "CSS"},
}

// styleKeys are the computed styles the brief gives, in order.
var styleKeys = []string{
	"display", "position", "font-family", "font-size", "font-weight", "line-height", "color",
	"background-color", "padding", "margin", "gap", "border", "border-radius", "box-shadow",
}
