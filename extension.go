// Package tweak embeds the Chrome extension, so the binary always carries the
// extension that matches it. The bridge writes these files out for Chrome to load.
package tweak

import "embed"

// Extension holds the files of the top-level extension/ folder.
//
//go:embed all:extension
var Extension embed.FS

// ExtensionID is the fixed ID Chrome derives from the manifest's pinned key.
// The bridge accepts a WebSocket only from chrome-extension://<ExtensionID>.
const ExtensionID = "meffcjbnfnkhnpinlbfkihgpbmnodcbl"
