// Package version holds the binary's release version and the bridge protocol version.
package version

// Version is the release version, X.Y.Z. Release builds set it with
// -ldflags "-X github.com/codaset/tweak/internal/version.Version=X.Y.Z".
// Without it the version reads "dev".
var Version = "dev"

// Protocol is the bridge contract version. It changes only when the contract
// between the bridge, the CLI and the extension changes, never with Version.
const Protocol = 1
