package pattern

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestParseNormalises(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://ernie.localhost/*", "https://ernie.localhost/*"},
		{"https://ernie.localhost/admin/*", "https://ernie.localhost/admin/*"},
		{"https://*.bert.localhost/*", "https://*.bert.localhost/*"},
		// A bare origin means the whole site.
		{"https://ernie.localhost", "https://ernie.localhost/*"},
		{"https://ernie.localhost/", "https://ernie.localhost/*"},
		{"http://localhost:3000", "http://localhost:3000/*"},
		// Chrome refuses upper-case schemes; hosts are case-insensitive.
		{"HTTPS://Ernie.LocalHost/Admin/*", "https://ernie.localhost/Admin/*"},
		// Chrome stores :* as no port, and accepts leading zeros.
		{"https://*.localhost:*/*", "https://*.localhost/*"},
		{"http://localhost:03000/*", "http://localhost:3000/*"},
		{"*://localhost/*", "*://localhost/*"},
		{"http://*/*", "http://*/*"},
		{"http://[::1]:3000/*", "http://[::1]:3000/*"},
		{"http://127.0.0.1:8080/users/12", "http://127.0.0.1:8080/users/12"},
		{"  https://ernie.localhost/*  ", "https://ernie.localhost/*"},
	}
	for _, c := range cases {
		p, err := Parse(c.in)
		if err != nil {
			t.Errorf("Parse(%q): %v", c.in, err)
			continue
		}
		if p.String() != c.want {
			t.Errorf("Parse(%q) = %q, want %q", c.in, p.String(), c.want)
		}
	}
}

func TestParseRefuses(t *testing.T) {
	cases := []struct{ in, why string }{
		{"", "empty"},
		{"ernie.localhost", "scheme"},
		{"ftp://localhost/*", "scheme"},
		{"file:///*", "scheme"},
		{"chrome-extension://abc/*", "scheme"},
		{"<all_urls>", "all_urls"},
		{"http://*foo.localhost/*", "wildcard"},
		{"http://local*host/*", "wildcard"},
		{"http://*.*.localhost/*", "wildcard"},
		{"http://*./*", "host"},
		{"http:///*", "host"},
		{"http://user@localhost/*", "host"},
		{"http://localhost:/*", "port"},
		{"http://localhost:3a/*", "port"},
		{"http://localhost:65536/*", "port"},
		{"http://localhost:0/*", "port"},
		{"http://localhost:3000*/*", "port"},
		{"http://localhost/a#b", "#"},
		{"http://local host/*", "host"},
	}
	for _, c := range cases {
		if p, err := Parse(c.in); err == nil {
			t.Errorf("Parse(%q) = %q, want an error (%s)", c.in, p, c.why)
		}
	}
}

func TestParseErrorSaysWhatIsWrong(t *testing.T) {
	_, err := Parse("ernie.localhost")
	if err == nil || !strings.Contains(err.Error(), `"ernie.localhost"`) ||
		!strings.Contains(err.Error(), "https://ernie.localhost/*") {
		t.Fatalf("error %v should quote the input and show an example", err)
	}
}

// TestMatch runs the cases shared with extension/lib/match.js
// (test/fixtures/match-cases.json): both must agree on every one.
func TestMatch(t *testing.T) {
	raw, err := os.ReadFile("../../test/fixtures/match-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Pattern, URL string
		Want         bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases {
		p, err := Parse(c.Pattern)
		if err != nil {
			t.Fatalf("Parse(%q): %v", c.Pattern, err)
		}
		if got := p.Match(c.URL); got != c.Want {
			t.Errorf("%q.Match(%q) = %v, want %v", c.Pattern, c.URL, got, c.Want)
		}
	}
}

func TestOverlaps(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"https://ernie.localhost/*", "https://ernie.localhost/*", true},
		{"https://ernie.localhost/*", "https://ernie.localhost/admin/*", true},
		{"https://ernie.localhost/admin/*", "https://ernie.localhost/users/*", false},
		{"https://ernie.localhost/*", "https://bert.localhost/*", false},
		{"https://ernie.localhost/*", "http://ernie.localhost/*", false},
		{"*://ernie.localhost/*", "http://ernie.localhost/*", true},
		{"*://ernie.localhost/*", "https://ernie.localhost/x", true},
		// Hosts.
		{"https://*.bert.localhost/*", "https://bert.localhost/*", true},
		{"https://*.bert.localhost/*", "https://admin.bert.localhost/*", true},
		{"https://*.bert.localhost/*", "https://*.admin.bert.localhost/*", true},
		{"https://*.bert.localhost/*", "https://*.ernie.localhost/*", false},
		{"https://*.localhost/*", "https://*.bert.localhost/*", true},
		{"https://*.bert.localhost/*", "https://xbert.localhost/*", false},
		{"https://*/*", "https://ernie.localhost/admin", true},
		// Ports.
		{"http://localhost:3000/*", "http://localhost:5173/*", false},
		{"http://localhost:3000/*", "http://localhost/*", true},
		{"http://localhost:3000/*", "http://localhost:3000/admin/*", true},
		{"http://*.localhost:3000/*", "http://localhost:5173/*", false},
		// Paths: is there any string both globs match?
		{"http://localhost/a*", "http://localhost/*b", true},
		{"http://localhost/a*c", "http://localhost/ab*", true},
		{"http://localhost/a*c", "http://localhost/*d", false},
		{"http://localhost/users/12", "http://localhost/users/*", true},
		{"http://localhost/users/12", "http://localhost/users/13", false},
		{"http://localhost/users/12", "http://localhost/users/12", true},
		{"http://localhost/*/edit", "http://localhost/users/*", true},
		{"http://localhost/*/edit", "http://localhost/*/show", false},
		{"http://localhost/a*b*c", "http://localhost/*x*", true},
		{"http://localhost/ab", "http://localhost/a*b*", true},
		{"http://localhost/ab", "http://localhost/a*bb", false},
	}
	for _, c := range cases {
		a, err := Parse(c.a)
		if err != nil {
			t.Fatalf("Parse(%q): %v", c.a, err)
		}
		b, err := Parse(c.b)
		if err != nil {
			t.Fatalf("Parse(%q): %v", c.b, err)
		}
		if got := a.Overlaps(b); got != c.want {
			t.Errorf("%q overlaps %q = %v, want %v", c.a, c.b, got, c.want)
		}
		if got := b.Overlaps(a); got != c.want {
			t.Errorf("%q overlaps %q = %v, want %v (reversed)", c.b, c.a, got, c.want)
		}
	}
}
