package brief

import (
	"strings"
	"testing"

	"github.com/codaset/tweak/internal/store"
)

func asked(entries ...store.Entry) store.Tweak {
	tw := tweak(`{"elements":[{"label":"button.btn-primary","text":"Save","selector":"#save"}]}`)
	tw.Entries = append([]store.Entry{{From: "you", Kind: "request", Text: "make these buttons green and say \"Save draft\""}}, entries...)
	return tw
}

// golden file holding both parts, as they are written into the brief.
func conversationGolden(t *testing.T, name string, c Conversation) {
	t.Helper()
	golden(t, name, c.Latest+"<!-- the brief's other sections -->\n\n"+c.Section)
}

func TestAfterAReplyTheBriefSaysSoAndCarriesTheConversation(t *testing.T) {
	c := ConversationOf(asked(
		store.Entry{From: "claude", Kind: "plan", Text: "Editing app/assets/stylesheets/buttons.css"},
		store.Entry{From: "claude", Kind: "question", Text: "Solid green, or the outline variant?"},
		store.Entry{From: "you", Kind: "reply", Text: "yes, the \"outline\" variant\nand keep the icon"},
	))
	conversationGolden(t, "conversation-reply", c)
}

// Working on it again without a reply (after a plan) shows the
// conversation, but there's no news to lead with.
func TestAPlanAloneHasNoLatestLine(t *testing.T) {
	c := ConversationOf(asked(store.Entry{From: "claude", Kind: "plan", Text: "Editing buttons.css"}))
	if c.Latest != "" {
		t.Fatalf("latest %q", c.Latest)
	}
	conversationGolden(t, "conversation-plan", c)
}

func TestTheFirstFetchHasNoConversation(t *testing.T) {
	if c := ConversationOf(asked()); c != (Conversation{}) {
		t.Fatalf("got %+v", c)
	}
}

// The renderer puts the Latest line under the title and the Conversation
// section after the elements, before the footer (docs/design.md, "The brief").
func TestTheBriefPlacesTheConversation(t *testing.T) {
	got := Render(asked(
		store.Entry{From: "claude", Kind: "question", Text: "Solid or outline?"},
		store.Entry{From: "you", Kind: "reply", Text: "outline"},
	))
	order := []string{"# Tweak 12\n\n**Latest:** ", "**Request:** ", "## Element 1: ", "## Conversation\n", "When finished"}
	at := 0
	for _, s := range order {
		i := strings.Index(got[at:], s)
		if i < 0 {
			t.Fatalf("%q missing or out of order:\n%s", s, got)
		}
		at += i
	}
}
