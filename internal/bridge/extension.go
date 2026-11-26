package bridge

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

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

// helloFolder is where the hello reply's version is, for the side panel's
// "loaded from another folder" (TWEAK_STATE_DIR moves it).
func (b *Bridge) helloFolder() string {
	if b.helloVersion() == "" {
		return ""
	}
	return tilde(b.opts.Config.ExtensionDir())
}

// extensionAway is how long the extension must have been gone for its
// absence to be news: a worker restarting, a self-update reloading or a
// handover is back within seconds, and says nothing either way.
const extensionAway = 30 * time.Second

// extensionHello is an extension saying hello: it counts as a browser, is
// seen now, and, back after a while away (or for the first time), each
// session with claims hears it connected. While another is connected, it
// was seen a moment ago: at its hello, and at every sweep since. Its last
// seen is read before it counts as a browser, or a sweep in between would
// mark it seen now and the sessions wouldn't hear it.
func (b *Bridge) extensionHello(h helloIn) {
	seen, err := b.store.ExtensionSeen()
	if err != nil {
		b.log.Print(err)
	}
	b.browsers.Add(1)
	b.log.Printf("extension %s connected", h.Version)
	b.heardFrom(h.Version, h.ReloadedFor)
	b.heardAccess(h.Granted)
	b.sawExtension()
	if seen.IsZero() || b.opts.Clock().Sub(seen) >= extensionAway {
		if err := b.store.ExtensionConnected(); err != nil {
			b.log.Print(err)
		}
	}
}

// extensionGone is its socket closing.
func (b *Bridge) extensionGone() {
	b.sawExtension()
	b.browsers.Add(-1)
	b.log.Printf("extension disconnected")
}

func (b *Bridge) sawExtension() {
	if err := b.store.SawExtension(); err != nil {
		b.log.Print(err)
	}
}

// heardFrom records the version of the extension that said hello, and
// whether it has settled: it has reloaded itself for this bridge's version
// already, or is older code that doesn't say. One still to reload (a busy
// tab holds it back), or mid-reload, isn't loaded from another folder yet.
// Only an X.Y.Z version is kept: tweak claim prints it to the agent's session.
func (b *Bridge) heardFrom(extensionVersion string, reloadedFor *string) {
	if !xyz.MatchString(extensionVersion) {
		extensionVersion = ""
	}
	b.heardMu.Lock()
	defer b.heardMu.Unlock()
	b.heard = extensionVersion
	b.settled = reloadedFor == nil || *reloadedFor == b.helloVersion()
}

// heardAccess records whether the extension has site access, from its
// hello (nil: it doesn't say) or an access message.
func (b *Bridge) heardAccess(granted *bool) {
	b.heardMu.Lock()
	defer b.heardMu.Unlock()
	b.granted = granted
}

// noAccess is the warning while the extension has no site access: its
// content scripts don't inject, so ⌥-click does nothing until the side
// panel's Allow access is clicked.
const noAccess = "site access not granted: open the Codaset Tweak side panel and click Allow access, or ⌥-click won't work"

// claimWarnings are the lines tweak claim prints after claiming: the
// extension not connected (never, or not now), connected from another
// folder, or without site access.
func (b *Bridge) claimWarnings() []string {
	if b.browsers.Load() == 0 {
		seen, err := b.store.ExtensionSeen()
		switch {
		case err != nil:
			b.log.Print(err)
		case seen.IsZero():
			return []string{notInstalled(tilde(b.opts.Config.ExtensionDir()))}
		default:
			if away := b.opts.Clock().Sub(seen); away >= extensionAway {
				return []string{fmt.Sprintf("Chrome extension not connected (last seen %s ago): is Chrome open with Codaset Tweak enabled?", ago(away))}
			}
		}
		return nil
	}
	b.heardMu.Lock()
	heard, settled, granted := b.heard, b.settled, b.granted
	b.heardMu.Unlock()
	var w []string
	if granted != nil && !*granted {
		w = append(w, noAccess)
	}
	// The extension reloaded and still isn't this version: Chrome loads a
	// copy from somewhere else.
	if want := b.helloVersion(); want != "" && heard != "" && heard != want && settled {
		w = append(w, fmt.Sprintf("Chrome has Codaset Tweak %s loaded from another folder: remove it in chrome://extensions and load %s", heard, tilde(b.opts.Config.ExtensionDir())))
	}
	return w
}

// notInstalled is the first-install warning, with the steps. On macOS the
// folder picker hides dot-folders such as ~/.local.
func notInstalled(folder string) string {
	line := "extension not connected: to install it, open chrome://extensions, turn on Developer mode, click Load unpacked and choose " + folder
	parts := strings.Split(filepath.ToSlash(folder), "/")
	for i, p := range parts {
		if strings.HasPrefix(p, ".") && p != "." && p != ".." {
			line += fmt.Sprintf(" (on macOS the file picker hides %s: press ⌘⇧G and paste the path)", strings.Join(parts[:i+1], "/"))
			break
		}
	}
	return line
}

// ago is a time gone by, roughly: 45 s, 3 min, 2 h, 3 days.
func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d s", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d/time.Minute))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h", int(d/time.Hour))
	}
	return fmt.Sprintf("%d days", int(d/(24*time.Hour)))
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
