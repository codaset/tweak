package cli

import (
	"testing"
	"time"
)

// Only a development build shortens the bridge's waits.
func TestTheTimingKnobsAreForDevelopmentBuildsOnly(t *testing.T) {
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
		if got := testDuration(func(k string) string { return env[k] }, "TWEAK_TEST_AGAIN_AFTER"); got != c.want {
			t.Errorf("TWEAK_BIN=%q TWEAK_TEST_AGAIN_AFTER=%q: %v, want %v", c.bin, c.after, got, c.want)
		}
	}
}

// A test build (testBuild, stamped by the CLI tests' release builds) reads
// them without TWEAK_BIN; a release, without the stamp, never does.
func TestTheTimingKnobsAreForTestBuildsToo(t *testing.T) {
	env := func(k string) string { return map[string]string{"TWEAK_TEST_HANDOVER_START": "1s"}[k] }
	if got := testDuration(env, "TWEAK_TEST_HANDOVER_START"); got != 0 {
		t.Fatalf("a release read the knob: %v", got)
	}
	testBuild = "1"
	defer func() { testBuild = "" }()
	if got := testDuration(env, "TWEAK_TEST_HANDOVER_START"); got != time.Second {
		t.Fatalf("a test build: %v, want 1s", got)
	}
}
