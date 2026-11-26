// Package version holds the binary's release version and the bridge protocol version.
package version

import (
	"strconv"
	"strings"
)

// Version is the release version, X.Y.Z. Release builds set it with
// -ldflags "-X github.com/codaset/tweak/internal/version.Version=X.Y.Z".
// Without it the version reads "dev".
var Version = "dev"

// Protocol is the bridge contract version. It changes only when the contract
// between the bridge, the CLI and the extension changes, never with Version.
const Protocol = 1

// Parse reads a release version, X.Y.Z, as its three numbers. A development
// build ("dev") or anything else isn't one.
func Parse(v string) (n [3]int, ok bool) {
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return n, false
	}
	for i, p := range parts {
		x, err := strconv.Atoi(p)
		if err != nil || x < 0 || strconv.Itoa(x) != p {
			return n, false
		}
		n[i] = x
	}
	return n, true
}

// Older reports whether release a is older than release b. With either not
// a release version (a development build) it is false, so a development
// build never hands over to, or is replaced by, another.
func Older(a, b string) bool {
	x, okA := Parse(a)
	y, okB := Parse(b)
	if !okA || !okB {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return false
}
