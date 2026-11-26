package brief

import (
	"fmt"
	"strings"

	"github.com/codaset/tweak/internal/store"
)

// The conversation's parts of the brief (docs/design.md, "The brief"): the
// Latest line, the Conversation section, and the finishing commands in the
// footer. Render places them and owns the blank lines around them, so each
// hook returns its text alone, or "" for none.

// latest is the **Latest** line, after a reply: it goes straight after the
// title. On a first fetch there is none.
var latest = func(tw store.Tweak) string { return strings.TrimSpace(ConversationOf(tw).Latest) }

// conversation is the ## Conversation section, plans included: after the
// element sections, before the footer. On a first fetch there is none.
var conversation = func(tw store.Tweak) string { return strings.TrimRight(ConversationOf(tw).Section, "\n") }

// finishers are the commands that end a turn on tweak n, for the footer.
var finishers = func(n int64) []string {
	return []string{fmt.Sprintf("tweak done %d '…'", n)}
}

// Conversation is what a tweak's entries add to its brief: the Latest line
// and the Conversation section. On a first fetch, when the request is the
// only entry, both are empty.
type Conversation struct {
	Latest  string // "**Latest:** …" and a blank line, or ""
	Section string // "## Conversation" with every entry, plans included, or ""
}

// speakers name each side of the conversation from Claude's point of view.
var speakers = map[string]string{store.FromYou: "Developer", store.FromClaude: "You", store.FromBridge: "Tweak"}

// ConversationOf renders the Latest line and the Conversation section from
// tw's entries. Every entry is the developer's, Claude's or the bridge's own
// words, never page text, so a multi-line one keeps its lines, indented to
// stay inside its list item.
func ConversationOf(tw store.Tweak) Conversation {
	if len(tw.Entries) < 2 {
		return Conversation{}
	}
	var c Conversation
	if reply, ok := latestReply(tw); ok {
		c.Latest = fmt.Sprintf("**Latest:** the developer replied to your question: %s. Carry on from it.\n\n", Quote(reply.Text))
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

// latestReply is the developer's answer to Claude's last question, if it
// has one: a plan posted since doesn't hide it, a newer question does.
func latestReply(tw store.Tweak) (store.Entry, bool) {
	for i := len(tw.Entries) - 1; i >= 0; i-- {
		switch e := tw.Entries[i]; e.Kind {
		case store.KindReply:
			return e, true
		case store.KindQuestion:
			return store.Entry{}, false
		}
	}
	return store.Entry{}, false
}
