// Package pattern parses claim patterns, which use Chrome's match pattern
// syntax, and decides exactly which URLs they match and whether two overlap.
//
// Checked against Chrome 158's scripting.registerContentScripts:
//   - a pattern without a port matches every port; with a port, only that one
//     (":*" is the same as no port, and Chrome stores it without one);
//   - "*.host" matches host itself and every subdomain;
//   - the path glob is matched against the path and query, never the hash;
//   - "*" is the only wildcard.
package pattern

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Pattern is a parsed, normalised claim pattern.
type Pattern struct {
	scheme     string // "http", "https" or "*" (either)
	host       string // lower case; "" with anyHost
	anyHost    bool   // host "*"
	subdomains bool   // "*." prefix: host and every subdomain
	port       int    // 0: any port
	path       string // glob, starts with "/"
}

const example = "https://ernie.localhost/*"

// Parse reads a claim pattern. A bare origin means the whole site ("/*").
// Schemes are limited to http, https and *, since claims are for dev servers.
func Parse(s string) (Pattern, error) {
	in := strings.TrimSpace(s)
	bad := func(why string) (Pattern, error) {
		return Pattern{}, fmt.Errorf("%q isn't a page pattern (%s): use one like %s", in, why, example)
	}
	if in == "" {
		return bad("it's empty")
	}
	if in == "<all_urls>" {
		return bad("a claim can't cover every site")
	}
	scheme, rest, ok := strings.Cut(in, "://")
	if !ok {
		return bad("no scheme")
	}
	var p Pattern
	p.scheme = strings.ToLower(scheme)
	switch p.scheme {
	case "http", "https", "*":
	default:
		return bad("the scheme must be http, https or *")
	}

	authority, path := rest, "/*"
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		authority, path = rest[:i], rest[i:]
		if path == "/" {
			path = "/*"
		}
	}
	if strings.Contains(path, "#") {
		return bad("a page can't be claimed by its #fragment")
	}
	p.path = path

	host, port := authority, ""
	if strings.HasPrefix(authority, "[") {
		end := strings.IndexByte(authority, ']')
		if end < 0 {
			return bad("unclosed [ in the host")
		}
		host = authority[:end+1]
		if tail := authority[end+1:]; tail != "" {
			if !strings.HasPrefix(tail, ":") {
				return bad("invalid host")
			}
			port = tail[1:]
			if port == "" {
				return bad("empty port")
			}
		}
	} else if i := strings.LastIndexByte(authority, ':'); i >= 0 {
		host, port = authority[:i], authority[i+1:]
		if port == "" {
			return bad("empty port")
		}
	}
	host = strings.ToLower(host)

	switch {
	case host == "*":
		p.anyHost = true
	case strings.HasPrefix(host, "*."):
		p.subdomains = true
		p.host = host[2:]
	default:
		p.host = host
	}
	if !p.anyHost {
		if p.host == "" {
			return bad("no host")
		}
		if strings.Contains(p.host, "*") {
			return bad("* may only start the host, as *.")
		}
		if strings.ContainsAny(p.host, "@/?#\\ %") {
			return bad("invalid host")
		}
	}

	if port != "" && port != "*" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strings.ContainsAny(port, "+-") {
			return bad("invalid port")
		}
		p.port = n
	}
	return p, nil
}

// String is the normalised pattern, in the form Chrome accepts as-is.
func (p Pattern) String() string {
	var b strings.Builder
	b.WriteString(p.scheme)
	b.WriteString("://")
	switch {
	case p.anyHost:
		b.WriteString("*")
	case p.subdomains:
		b.WriteString("*.")
		b.WriteString(p.host)
	default:
		b.WriteString(p.host)
	}
	if p.port != 0 {
		b.WriteString(":")
		b.WriteString(strconv.Itoa(p.port))
	}
	b.WriteString(p.path)
	return b.String()
}

// Match reports whether the URL is one of the pattern's pages.
func (p Pattern) Match(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	if p.scheme != "*" && p.scheme != scheme {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if !p.matchHost(host) {
		return false
	}
	if p.port != 0 {
		port := u.Port()
		if port == "" {
			port = map[string]string{"http": "80", "https": "443"}[scheme]
		}
		if n, err := strconv.Atoi(port); err != nil || n != p.port {
			return false
		}
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" || u.ForceQuery {
		path += "?" + u.RawQuery
	}
	return globMatch(p.path, path)
}

func (p Pattern) matchHost(host string) bool {
	switch {
	case p.anyHost:
		return true
	case p.subdomains:
		return host == p.host || strings.HasSuffix(host, "."+p.host)
	default:
		return host == p.host
	}
}

// Overlaps reports whether any URL matches both patterns. Scheme, host, port
// and path are independent parts of a URL, so the patterns overlap exactly
// when every part does.
func (p Pattern) Overlaps(q Pattern) bool {
	if p.scheme != "*" && q.scheme != "*" && p.scheme != q.scheme {
		return false
	}
	if p.port != 0 && q.port != 0 && p.port != q.port {
		return false
	}
	return hostsOverlap(p, q) && globsOverlap(p.path, q.path)
}

func hostsOverlap(p, q Pattern) bool {
	switch {
	case p.anyHost || q.anyHost:
		return true
	case p.subdomains && q.subdomains:
		return p.matchHost(q.host) || q.matchHost(p.host)
	case p.subdomains:
		return p.matchHost(q.host)
	case q.subdomains:
		return q.matchHost(p.host)
	default:
		return p.host == q.host
	}
}

// globMatch matches s against a glob where * matches any run of characters.
func globMatch(glob, s string) bool {
	// Classic two-pointer match with backtracking to the last *.
	g, i, star, mark := 0, 0, -1, 0
	for i < len(s) {
		switch {
		case g < len(glob) && glob[g] == '*':
			star, mark = g, i
			g++
		case g < len(glob) && glob[g] == s[i]:
			g++
			i++
		case star >= 0:
			g = star + 1
			mark++
			i = mark
		default:
			return false
		}
	}
	for g < len(glob) && glob[g] == '*' {
		g++
	}
	return g == len(glob)
}

// globsOverlap reports whether some string matches both globs: a search over
// pairs of positions, one in each glob, where a * may match nothing or eat a
// character the other side consumes.
func globsOverlap(a, b string) bool {
	type pos struct{ i, j int }
	seen := map[pos]bool{}
	stack := []pos{{0, 0}}
	for len(stack) > 0 {
		at := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[at] {
			continue
		}
		seen[at] = true
		i, j := at.i, at.j
		if i == len(a) && j == len(b) {
			return true
		}
		aStar := i < len(a) && a[i] == '*'
		bStar := j < len(b) && b[j] == '*'
		if aStar {
			stack = append(stack, pos{i + 1, j}) // a's * matches nothing more
		}
		if bStar {
			stack = append(stack, pos{i, j + 1})
		}
		switch {
		case i == len(a) || j == len(b):
			// One side is finished; only its trailing stars could help, handled above.
		case aStar && bStar:
			// Both eat the same character: no progress, nothing new.
		case aStar:
			stack = append(stack, pos{i, j + 1}) // a's * eats b's literal
		case bStar:
			stack = append(stack, pos{i + 1, j})
		case a[i] == b[j]:
			stack = append(stack, pos{i + 1, j + 1})
		}
	}
	return false
}
