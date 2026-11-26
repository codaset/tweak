package bridge

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/codaset/tweak/internal/store"
)

// Withdraw, Resolve and retention (docs/design.md, "When the session goes
// quiet", "Storage"): the card's Withdraw takes back an open tweak, its
// Resolve clears away a finished one, and a week after either the tweak,
// its change and its screenshot are deleted.

// withdraw is a withdraw message {ref, number}: the card's Withdraw. The
// tweak's tweak-withdrawn event is its session's withdrawn line.
func (b *Bridge) withdraw(in againIn) resultOut {
	return b.byNumber(in, "withdraw needs the tweak's number", b.store.Withdraw)
}

// resolve is a resolve message {ref, number}: the card's Resolve.
func (b *Bridge) resolve(in againIn) resultOut {
	return b.byNumber(in, "resolve needs the tweak's number", b.store.Resolve)
}

func (b *Bridge) byNumber(in againIn, missing string, do func(int64) (store.Tweak, error)) resultOut {
	out := resultOut{Type: "result", Ref: in.Ref}
	if in.Number < 1 {
		out.Error, out.Message = "bad-request", missing
		return out
	}
	tw, err := do(in.Number)
	if err != nil {
		_, out.Error, out.Message = b.refusalOf(in.Number, err)
		return out
	}
	out.Number = tw.Number
	return out
}

// errWithdrawn is tweak work on a tweak the developer withdrew: Claude is
// told to skip it, and no capture starts.
type errWithdrawn struct{ n int64 }

func (e errWithdrawn) Error() string { return fmt.Sprintf("tweak %d: withdrawn, skip it", e.n) }

// skipWithdrawn refuses tweak work on the session's withdrawn tweak n,
// ending its capture if it's still capturing: Claude has been told to stop.
func (b *Bridge) skipWithdrawn(session string, n int64) error {
	tw, err := b.store.Tweak(n)
	if err != nil || tw.Session != session || tw.Status != store.StatusWithdrawn {
		return nil
	}
	g := b.prepare(session, n) // git first, outside the lock
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	b.endWithdrawnCapture(session, n, g)
	return errWithdrawn{n}
}

// endWithdrawnCapture ends the session's capture if, under captureMu, it's
// still of withdrawn tweak n, and only then: a capture another work has
// switched to since is left alone.
func (b *Bridge) endWithdrawnCapture(session string, n int64, g *gitEnd) {
	end, err := b.ending(session, n, g)
	if err == nil && end != nil {
		_, err = b.store.EndCapture(session, *end)
		if err == nil {
			b.unmark(session)
		}
	}
	if err != nil {
		b.log.Printf("tweak %d: ending the capture of a withdrawn tweak: %v", n, err)
	}
}

// deleteAt is when a resolved tweak is deleted, as the side panel shows it.
func (b *Bridge) deleteAt(resolved time.Time) string {
	return stamp(resolved.Add(b.opts.KeepResolved))
}

// watchExpire deletes the tweaks resolved more than KeepResolved ago, with
// their changes and screenshots, every ExpireCheck, and once at start.
func (b *Bridge) watchExpire() {
	defer b.loops.Done()
	t := time.NewTicker(b.opts.ExpireCheck)
	defer t.Stop()
	for {
		b.expire()
		select {
		case <-b.stop:
			return
		case <-b.closing.Done():
			return
		case <-t.C:
		}
	}
}

func (b *Bridge) expire() {
	b.undoMu.Lock() // never mid-undo
	defer b.undoMu.Unlock()
	gone, err := b.store.DeleteResolved(b.opts.KeepResolved)
	if err != nil {
		b.log.Print(err)
	}
	for _, n := range gone {
		if err := os.Remove(b.screenshotPath(n)); err != nil && !errors.Is(err, os.ErrNotExist) {
			b.log.Printf("tweak %d: its screenshot: %v", n, err)
		}
		b.log.Printf("tweak %d deleted: resolved %s ago", n, b.opts.KeepResolved)
	}
}
