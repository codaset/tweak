package version

import "testing"

func TestOlder(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.3.2", "1.4.0", true},
		{"1.9.0", "1.10.0", true}, // numeric, not text
		{"1.4.0", "1.3.2", false},
		{"1.4.0", "1.4.0", false},
		{"0.9.9", "1.0.0", true},
		// A development build is never handed over, nor hands over.
		{"dev", "1.0.0", false},
		{"1.0.0", "dev", false},
		{"dev", "dev", false},
		{"1.0", "1.0.1", false},
		{"", "1.0.0", false},
		{"1.0.0-rc1", "1.0.1", false},
	}
	for _, c := range cases {
		if got := Older(c.a, c.b); got != c.want {
			t.Errorf("Older(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
