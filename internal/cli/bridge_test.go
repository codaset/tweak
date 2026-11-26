package cli

import (
	"testing"
	"time"
)

// Only a development build shortens the bridge's 3-minute wait.
func TestTheAgainKnobIsForDevelopmentBuildsOnly(t *testing.T) {
	for _, c := range []struct {
		bin, after string
		want       time.Duration
	}{
		{"/dev/tweak", "2s", 2 * time.Second},
		{"", "2s", 0},
		{"/dev/tweak", "", 0},
		{"/dev/tweak", "soon", 0},
		{"/dev/tweak", "-1s", 0},
	} {
		env := map[string]string{"TWEAK_BIN": c.bin, "TWEAK_TEST_AGAIN_AFTER": c.after}
		if got := testAgainAfter(func(k string) string { return env[k] }); got != c.want {
			t.Errorf("TWEAK_BIN=%q TWEAK_TEST_AGAIN_AFTER=%q: %v, want %v", c.bin, c.after, got, c.want)
		}
	}
}
