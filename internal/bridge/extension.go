package bridge

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/extfolder"
)

// The bridge's half of the extension's self-update (docs/design.md, "The
// extension updates itself"): it writes the embedded extension to the state
// folder, tells the extension which version that is, and remembers which
// version said hello, for tweak claim's warning.

var xyz = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// installExtension writes the embedded extension to the state folder's
// extension/ when that holds another version or nothing. An unstamped build
// ("dev") always rewrites it: its files change under one version number.
// A failure is logged, not fatal: claims work without the browser.
func (b *Bridge) installExtension() {
	src, err := fs.Sub(tweak.Extension, "extension")
	if err == nil {
		b.extensionVersion, err = extfolder.Version(src)
	}
	if err == nil {
		var wrote bool
		wrote, err = extfolder.Write(src, b.opts.Config.ExtensionDir(), b.opts.Version == "dev")
		if wrote {
			b.log.Printf("wrote extension %s to %s", b.extensionVersion, b.opts.Config.ExtensionDir())
		}
	}
	if err != nil {
		// Nothing new on disk: asking the extension to reload would only
		// strand it at its old version with the wrong warning.
		b.extensionVersion = ""
		b.log.Printf("couldn't write the extension folder: %v", err)
	}
}

// helloVersion is the version the hello reply carries: the extension this
// bridge wrote. A development bridge sends none, so an extension loaded from
// a repo checkout never tries to update itself.
func (b *Bridge) helloVersion() string {
	if b.opts.Development {
		return ""
	}
	return b.extensionVersion
}

// heardFrom records the version of the extension that said hello. Only an
// X.Y.Z version is kept: tweak claim prints it to the agent's session.
func (b *Bridge) heardFrom(extensionVersion string) {
	if !xyz.MatchString(extensionVersion) {
		extensionVersion = ""
	}
	b.heardMu.Lock()
	defer b.heardMu.Unlock()
	b.heard = extensionVersion
}

// claimWarnings are the lines tweak claim prints after claiming.
func (b *Bridge) claimWarnings() []string {
	b.heardMu.Lock()
	heard := b.heard
	b.heardMu.Unlock()
	var w []string
	// The extension reloaded and still isn't this version: Chrome loads a
	// copy from somewhere else. (Briefly true mid-update, too.)
	if want := b.helloVersion(); want != "" && heard != "" && heard != want {
		w = append(w, fmt.Sprintf("Chrome has Codaset Tweak %s loaded from another folder: remove it in chrome://extensions and load %s", heard, tilde(b.opts.Config.ExtensionDir())))
	}
	return w
}

// tilde writes a path under the home folder as ~/...
func tilde(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if rel, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.Join("~", rel)
	}
	return path
}
