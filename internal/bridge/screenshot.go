package bridge

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/codaset/tweak/internal/atomicfile"
	"github.com/codaset/tweak/internal/store"
)

// maxScreenshot caps an upload. The worker's PNG is at most 1600px on its
// longest side, which stays well under this.
const maxScreenshot = 16 << 20

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// screenshotRoute is the one path the extension's worker reaches with a
// CORS request: PUT /tweaks/:n/screenshot.
var screenshotRoute = regexp.MustCompile(`^/tweaks/[^/]+/screenshot$`)

// extensionCORS approves the worker's screenshot upload (docs/design.md,
// "Security"). Without a host grant for 127.0.0.1 the worker's PUT is a
// CORS request, so its preflight is answered, and its replies carry the
// header, for the extension's exact origin on this path only. A web page
// can't send that Origin, and every other request is still refused one.
// It reports whether it answered the request (a preflight) itself.
func extensionCORS(w http.ResponseWriter, r *http.Request, origin string) bool {
	if origin != extensionOrigin || !screenshotRoute.MatchString(r.URL.Path) {
		return false
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", extensionOrigin)
	h.Set("Vary", "Origin")
	if r.Method != http.MethodOptions {
		return false
	}
	h.Set("Access-Control-Allow-Methods", "PUT")
	h.Set("Access-Control-Allow-Headers", "content-type, x-tweak, x-tweak-protocol")
	w.WriteHeader(http.StatusNoContent)
	return true
}

// putScreenshot is PUT /tweaks/:n/screenshot: the worker's PNG of what the
// tweak points at, stored beside the database, where the brief names it.
// The bridge only stores the file.
func (b *Bridge) putScreenshot(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err != nil || n < 1 {
		refuse(w, 404, "no-tweak", noTweak(r.PathValue("n")))
		return
	}
	if _, err := b.store.Tweak(n); errors.Is(err, store.ErrNoTweak) {
		refuse(w, 404, "no-tweak", noTweak(r.PathValue("n")))
		return
	} else if err != nil {
		b.internal(w, err)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxScreenshot))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		refuse(w, 413, "too-large", fmt.Sprintf("a screenshot is at most %d MiB", maxScreenshot>>20))
		return
	case err != nil:
		refuse(w, 400, "bad-request", "couldn't read the screenshot: "+err.Error())
		return
	case !bytes.HasPrefix(raw, pngSignature):
		refuse(w, 400, "bad-request", "a screenshot must be a PNG")
		return
	}
	if err := writeAtomically(b.screenshotPath(n), raw); err != nil {
		b.internal(w, err)
		return
	}
	b.screenshotSettled(n)
	w.WriteHeader(http.StatusNoContent)
}

// expectScreenshot notes that tweak n's screenshot is on its way, so a brief
// fetched before it lands waits for it (awaitScreenshot), for
// ScreenshotWait after the create at most. Kept in memory only: a bridge
// that restarts meanwhile just doesn't wait.
func (b *Bridge) expectScreenshot(n int64) {
	b.shotsMu.Lock()
	defer b.shotsMu.Unlock()
	if b.shots == nil {
		b.shots = map[int64]chan struct{}{}
	}
	b.shots[n] = make(chan struct{})
	time.AfterFunc(b.opts.ScreenshotWait, func() { b.screenshotSettled(n) })
}

// screenshotSettled ends the wait for tweak n's screenshot: stored, or
// given up on.
func (b *Bridge) screenshotSettled(n int64) {
	b.shotsMu.Lock()
	defer b.shotsMu.Unlock()
	if ch, ok := b.shots[n]; ok {
		close(ch)
		delete(b.shots, n)
	}
}

// awaitScreenshot waits while tweak n's screenshot is on its way.
func (b *Bridge) awaitScreenshot(ctx context.Context, n int64) {
	b.shotsMu.Lock()
	ch := b.shots[n]
	b.shotsMu.Unlock()
	if ch == nil {
		return
	}
	select {
	case <-ch:
	case <-ctx.Done():
	case <-b.closing.Done():
	}
}

// writeAtomically writes a file private to the user through a temporary
// file beside it, so a reader never sees half of one.
func writeAtomically(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0o600)
}
