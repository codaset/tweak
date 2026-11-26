package brief

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The extension gathers what the brief renders: the caps on page text and
// the styles it reads must be the same on both sides.
func TestContextAgreesWithTheBrief(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "extension", "content", "context.js"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	for name, n := range map[string]int{
		"LABEL_CAP": labelCap, "TEXT_CAP": textCap, "HTML_CAP": htmlCap, "SELECTOR_CAP": selectorCap,
		"STYLE_CAP": styleCap, "RULES": ruleCount, "NEARBY": nearbyCount,
	} {
		if want := fmt.Sprintf("const %s = %d;", name, n); !strings.Contains(src, want) {
			t.Errorf("extension/content/context.js should say %q", want)
		}
	}

	pointing, err := os.ReadFile(filepath.Join("..", "..", "extension", "content", "pointing.js"))
	if err != nil {
		t.Fatal(err)
	}
	for name, n := range map[string]int{"SELECTION_CAP": selectionCap, "AROUND_CAP": aroundCap} {
		if want := fmt.Sprintf("const %s = %d;", name, n); !strings.Contains(string(pointing), want) {
			t.Errorf("extension/content/pointing.js should say %q", want)
		}
	}

	m := regexp.MustCompile(`(?s)const STYLE_KEYS = \[(.*?)\];`).FindStringSubmatch(src)
	if m == nil {
		t.Fatal("no STYLE_KEYS in extension/content/context.js")
	}
	var keys []string
	for _, q := range regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(m[1], -1) {
		keys = append(keys, q[1])
	}
	if !slices.Equal(keys, styleKeys) {
		t.Errorf("STYLE_KEYS is %q; the brief's are %q", keys, styleKeys)
	}
}
