package brief

import (
	"fmt"
	"strings"

	"github.com/codaset/tweak/internal/store"
)

// Conversation is what a tweak's entries add to its brief (docs/design.md,
// "The brief"): the Latest line, written under the title, and the
// Conversation section, written after the elements and before the footer.
// On a first fetch, when the request is the only entry, both are empty.
type Conversation struct {
	Latest  string // "**Latest:** …" and a blank line, or ""
	Section string // "## Conversation" with every entry, plans included, or ""
}

// speakers name each side of the conversation from Claude's point of view.
var speakers = map[string]string{"you": "Developer", "claude": "You", "bridge": "Tweak"}

// ConversationOf renders the Latest line and the Conversation section from
// tw's entries. Every entry is the developer's, Claude's or the bridge's own
// words, never page text, so a multi-line one keeps its lines, indented to
// stay inside its list item.
func ConversationOf(tw store.Tweak) Conversation {
	if len(tw.Entries) < 2 {
		return Conversation{}
	}
	var c Conversation
	if last := tw.Entries[len(tw.Entries)-1]; last.From == "you" && last.Kind == "reply" {
		c.Latest = fmt.Sprintf("**Latest:** the developer replied to your question: %s. Carry on from it.\n\n", Quote(last.Text))
	}
	var b strings.Builder
	b.WriteString("## Conversation\n\n")
	for i, e := range tw.Entries {
		who := speakers[e.From]
		if who == "" {
			who = e.From
		}
		marker := fmt.Sprintf("%d. ", i+1)
		text := strings.ReplaceAll(strings.TrimSpace(e.Text), "\n", "\n"+strings.Repeat(" ", len(marker)))
		fmt.Fprintf(&b, "%s**%s** (%s): %s\n", marker, who, e.Kind, text)
	}
	b.WriteString("\n")
	c.Section = b.String()
	return c
}
