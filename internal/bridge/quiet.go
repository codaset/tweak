package bridge

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/codaset/tweak/internal/store"
)

// When the session goes quiet (docs/design.md): the bridge's two signals
// about a session. The fast one is whether its watcher's long-poll is
// connected: after UnwatchedAfter without one, every command from a session
// with claims warns noWatcher. The slow one is the claim lapse: no check-in
// for LapseAfter, and its claims lapse, its capture ends as at done, and
// its open tweaks wait for whichever session claims their pages next. A
// lapsed claim comes back at the session's next check-in within RestoreFor,
// unless another session has claimed an overlapping pattern since.
//
// A session ending (tweak hook session-end) releases everything at once;
// with no bridge running, the hook leaves released/<session> for the next
// bridge to act on when it starts.

// noWatcher is the warning a command prints when its session's watcher has
// been gone for UnwatchedAfter.
const noWatcher = "no watcher running: start a Monitor with tweak watch"

// watching records a watcher's long-poll starting (on) or ending. A held
// long-poll is a check-in for its whole length, so one ending checks in
// again.
func (b *Bridge) watching(session string, on bool) {
	b.watchMu.Lock()
	if on {
		b.polls[session]++
	} else {
		b.polls[session]--
		if b.polls[session] <= 0 {
			delete(b.polls, session)
		}
	}
	b.polled[session] = b.opts.Clock()
	b.watchMu.Unlock()
	if !on {
		b.checkedIn(session)
	}
}

// checkedIn checks the session in, logging a failure.
func (b *Bridge) checkedIn(session string) {
	if _, err := b.store.CheckIn(session); err != nil {
		b.log.Printf("check-in %s: %v", session, err)
	}
}

// listening says whether the session's watcher has a long-poll open now.
func (b *Bridge) listening(session string) bool {
	b.watchMu.Lock()
	defer b.watchMu.Unlock()
	return b.polls[session] > 0
}

// unwatched says whether a session holding claims has had no watcher for
// UnwatchedAfter: since its last long-poll, its newest claim, or the bridge
// starting, whichever is latest.
func (b *Bridge) unwatched(session string) bool {
	b.watchMu.Lock()
	since, open := b.polled[session], b.polls[session] > 0
	b.watchMu.Unlock()
	if open {
		return false
	}
	if b.upSince.After(since) {
		since = b.upSince
	}
	newest, held, err := b.store.NewestClaim(session)
	if err != nil || !held {
		return false
	}
	if newest.After(since) {
		since = newest
	}
	return b.opts.Clock().Sub(since) >= b.opts.UnwatchedAfter
}

// returning is a session's check-in: it brings back its lapsed claims, and
// their capture, and returns the claim lost lines it hasn't heard yet.
func (b *Bridge) returning(session string) []string {
	// A return can restart a capture, so it's serialised with a lapse's
	// teardown, which must not end the capture it restored. Most check-ins
	// have nothing to restore, and take no lock: the edit hook's post never
	// waits here. A lapse just after this look waits for the next check-in.
	if lapsed, err := b.store.HasLapsed(session); err != nil || !lapsed {
		b.checkedIn(session)
		return nil
	}
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	r, err := b.store.Return(session, b.opts.RestoreFor)
	if err != nil {
		b.log.Printf("check-in %s: %v", session, err)
		return nil
	}
	for _, c := range r.Restored {
		b.log.Printf("claim %s restored to %s", c.Pattern, session)
	}
	if r.Capturing != 0 {
		if err := b.mark(session, r.Capturing); err != nil {
			b.log.Printf("tweak %d: capture marker: %v", r.Capturing, err)
		}
	}
	var lost []string
	for _, c := range r.Lost {
		lost = append(lost, b.store.LostLine(c))
	}
	return lost
}

// watchLapses lapses the claims of sessions that stopped checking in, and
// forgets lapsed claims kept for RestoreFor.
func (b *Bridge) watchLapses() {
	defer b.loops.Done()
	t := time.NewTicker(b.opts.LapseCheck)
	defer t.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-b.closing.Done():
			return
		case <-t.C:
		}
		b.lapse()
	}
}

func (b *Bridge) lapse() {
	if err := b.store.MarkUp(); err != nil {
		b.log.Print(err)
	}
	if b.browsers.Load() > 0 {
		b.sawExtension() // so a crash leaves a recent "last seen"
	}
	if err := b.store.Expire(b.opts.RestoreFor); err != nil {
		b.log.Print(err)
	}
	b.tellListening()
	stale, err := b.store.Stale(b.opts.LapseAfter)
	if err != nil {
		b.log.Print(err)
		return
	}
	for _, session := range stale {
		if b.listening(session) {
			continue
		}
		lapsed, err := b.store.Lapse(session, b.opts.LapseAfter)
		if err != nil {
			b.log.Printf("lapse %s: %v", session, err)
			continue
		}
		if len(lapsed) == 0 {
			continue // it checked in meanwhile
		}
		for _, c := range lapsed {
			b.log.Printf("claim %s lapsed: %s stopped checking in", c.Pattern, session)
		}
		// As at done, so a crashed session can't leave its edit hook recording.
		if err := b.endLapsedCapture(session); err != nil {
			b.log.Printf("lapse %s: ending capture: %v", session, err)
		}
	}
}

// endSession is POST /sessions/end: tweak hook session-end, on exit or
// /clear. It releases the session's claims, forgets its lapsed ones and
// ends its capture. It finishes even if the hook has given up waiting.
func (b *Bridge) endSession(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}
	if err := b.end(id); err != nil {
		b.internal(w, err)
		return
	}
	w.WriteHeader(204)
}

func (b *Bridge) end(session string) error {
	if err := b.store.EndSession(session); err != nil {
		return err
	}
	b.log.Printf("session %s ended", session)
	return b.endCapture(session)
}

// endReleased acts on the released/ markers the session-end hook left while
// no bridge was running: each names its session inside, and goes once acted on.
func (b *Bridge) endReleased() {
	dir := b.opts.Config.ReleasedDir()
	files, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, f := range files {
		path := filepath.Join(dir, f.Name())
		if strings.HasPrefix(f.Name(), ".") {
			os.Remove(path) // a hook cut off before its rename: never a whole marker
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if session := strings.TrimSpace(string(raw)); session != "" {
			if err := b.end(session); err != nil && !errors.Is(err, store.ErrNoSession) {
				b.log.Printf("released %s: %v", session, err)
				continue
			}
		}
		os.Remove(path)
	}
}

// endLapsedCapture ends a lapsed session's capture, unless the session has
// checked in since and its capturing tweak is back with it: then the
// capture carries on. The check and the end are one step under captureMu, which a return
// also takes.
func (b *Bridge) endLapsedCapture(session string) error {
	// Back means the session has claims again (a lapse leaves it none) and
	// the capturing tweak is its own: a resolved tweak, such as a withdrawn
	// one, never left it, and one handed to another session isn't back.
	return b.endCaptureUnless(session, func(c store.Capture) (bool, error) {
		_, back, err := b.store.NewestClaim(session)
		if err != nil || !back {
			return false, err
		}
		tw, err := b.store.Tweak(c.Tweak)
		return err == nil && tw.Session == session, err
	})
}

// tellListening logs claim-listening for each claimed session whose watcher
// went for UnwatchedAfter, or came back, since it was last told.
func (b *Bridge) tellListening() {
	sessions, err := b.store.ClaimedSessions()
	if err != nil {
		b.log.Print(err)
		return
	}
	held := map[string]bool{}
	for _, s := range sessions {
		held[s] = true
		now := !b.unwatched(s)
		was, known := b.told[s]
		if !known {
			was = true // a claim is made listening
		}
		if now != was {
			if err := b.store.LogListening(s); err != nil {
				b.log.Print(err)
				continue
			}
		}
		b.told[s] = now
	}
	for s := range b.told {
		if !held[s] {
			delete(b.told, s)
		}
	}
}
