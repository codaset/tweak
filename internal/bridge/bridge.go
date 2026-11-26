// Package bridge is the local Tweak service: an HTTP server on 127.0.0.1 over
// the store, holding sessions and claims for the CLI and the extension.
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/codaset/tweak/internal/atomicfile"
	"github.com/codaset/tweak/internal/capture"
	"github.com/codaset/tweak/internal/config"
	"github.com/codaset/tweak/internal/store"
	"github.com/codaset/tweak/internal/version"
)

// Options configure a bridge.
type Options struct {
	Config  config.Config // Port 0 takes a free port (tests)
	Version string        // the Tweak version, for bridge.json and x-tweak-version
	// IdleTimeout is how long the bridge stays up with no claims and no
	// browser connected (30 minutes when zero); IdleCheck is how often it looks.
	IdleTimeout, IdleCheck time.Duration
	// SocketIdle is how long an extension socket may stay silent before the
	// bridge drops it (60 seconds when zero: three missed keepalives).
	SocketIdle time.Duration
	// Development is a TWEAK_BIN build: its hello reply carries no version,
	// so the extension never updates itself from it.
	Development bool
	// InboxWait is how long GET /inbox holds a long-poll with nothing to
	// send (25 seconds when zero, inside the CLI's request timeout).
	InboxWait time.Duration
	// AgainAfter is how long a delivered tweak waits for Claude to confirm
	// it before it is sent again (3 minutes when zero; see docs/design.md,
	// "No lost tweaks"); AgainCheck is how often the bridge looks (every
	// 5 seconds, or a tenth of AgainAfter when that is shorter).
	AgainAfter, AgainCheck time.Duration
	// ScreenshotWait is how long after a create that says a screenshot
	// follows a brief waits for it (5 seconds when zero).
	ScreenshotWait time.Duration
	// LapseAfter is how long a session may go without checking in before
	// its claims lapse (10 minutes when zero), RestoreFor how long a lapsed
	// claim is kept to come back (24 hours), and LapseCheck how often the
	// bridge looks (every 10 seconds, or a tenth of LapseAfter when that is
	// shorter). UnwatchedAfter is how long a session with claims may have
	// no watcher before its commands warn (60 seconds). See docs/design.md,
	// "When the session goes quiet".
	LapseAfter, RestoreFor, LapseCheck, UnwatchedAfter time.Duration
	// KeepResolved is how long a resolved tweak is kept, with its change and
	// screenshot (7 days when zero; see docs/design.md, "Storage");
	// DeleteResolvedCheck is how often the bridge looks (hourly, or a tenth of
	// KeepResolved when that is shorter).
	KeepResolved, DeleteResolvedCheck time.Duration
	// Clock is the bridge's time, and its store's (time.Now when nil).
	Clock func() time.Time
	Log   io.Writer
}

// ErrAlreadyRunning means another bridge holds the port: the caller should
// exit quietly and use it.
var ErrAlreadyRunning = errors.New("a bridge is already running on this port")

// Bridge is a started bridge.
type Bridge struct {
	opts     Options
	listener net.Listener
	server   *http.Server
	store    *store.Store
	log      *log.Logger
	browsers atomic.Int64
	stop     chan struct{}
	stopOnce sync.Once

	// closing ends every extension socket on shutdown; sockets counts them.
	closing     context.Context
	stopSockets context.CancelFunc
	sockets     sync.WaitGroup
	loops       sync.WaitGroup // the background loops that use the store
	captureMu   sync.Mutex     // undo capture: see capture.go
	undoMu      sync.Mutex     // one undo at a time: see undo.go
	// gitSnapshot and gitChanged are the git check (capture.Snapshot and
	// capture.Changed); tests slow them down.
	gitSnapshot func(folder, scratch string) (capture.Tree, error)
	gitChanged  func(base capture.Tree, scratch string) ([]string, error)
	// storeCheckIn is the store's CheckIn; tests sweep just before it.
	storeCheckIn func(session string) (bool, error)
	changeMu     sync.Mutex
	change       chan struct{} // closed and replaced on each event-log change

	extensionVersion string     // the embedded extension's version
	heardMu          sync.Mutex // guards heard, settled and granted
	heard            string     // the version of the extension that last said hello
	settled          bool       // and whether it has finished updating itself (extension.go)
	granted          *bool      // and whether it has site access; nil when it doesn't say

	shotsMu sync.Mutex
	shots   map[int64]chan struct{} // screenshots on their way: closed when stored or given up on
	// The watchers' long-polls (quiet.go): how many each session has open,
	// and when its last one started or ended. upSince is when this bridge
	// started, before which no watcher counts as missing.
	watchMu sync.Mutex
	polls   map[string]int
	polled  map[string]time.Time
	upSince time.Time
	told    map[string]bool // whether each claimed session was last said to be listening (the sweep's)
}

// Info is bridge.json, and the body of GET /bridge.
type Info struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	PID      int    `json:"pid"`
	Port     int    `json:"port"`
	// Extension is the version of the extension connected now, from its
	// hello, for tweak version; none in bridge.json.
	Extension string `json:"extension,omitempty"`
}

// Start binds the port, opens the database and writes bridge.json. Serve runs it.
func Start(o Options) (*Bridge, error) {
	if o.IdleTimeout == 0 {
		o.IdleTimeout = 30 * time.Minute
	}
	if o.IdleCheck == 0 {
		o.IdleCheck = time.Minute
	}
	if o.SocketIdle == 0 {
		o.SocketIdle = time.Minute
	}
	if o.InboxWait == 0 {
		o.InboxWait = 25 * time.Second
	}
	if o.AgainAfter == 0 {
		o.AgainAfter = 3 * time.Minute
	}
	if o.AgainCheck == 0 {
		o.AgainCheck = min(5*time.Second, o.AgainAfter/10)
	}
	if o.LapseAfter == 0 {
		o.LapseAfter = 10 * time.Minute
	}
	if o.RestoreFor == 0 {
		o.RestoreFor = 24 * time.Hour
	}
	if o.LapseCheck == 0 {
		o.LapseCheck = min(10*time.Second, o.LapseAfter/10)
	}
	if o.UnwatchedAfter == 0 {
		o.UnwatchedAfter = time.Minute
	}
	if o.KeepResolved == 0 {
		o.KeepResolved = 7 * 24 * time.Hour
	}
	if o.DeleteResolvedCheck == 0 {
		o.DeleteResolvedCheck = min(time.Hour, o.KeepResolved/10)
	}
	if o.Clock == nil {
		o.Clock = time.Now
	}
	if o.ScreenshotWait == 0 {
		o.ScreenshotWait = 5 * time.Second
	}
	if o.Log == nil {
		o.Log = os.Stderr
	}
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", o.Config.Port))
	if err != nil {
		return nil, whyNotListening(o.Config.Port, err)
	}
	b := &Bridge{opts: o, listener: l, log: log.New(o.Log, "bridge: ", log.LstdFlags), stop: make(chan struct{}), change: make(chan struct{}),
		polls: map[string]int{}, polled: map[string]time.Time{}, upSince: o.Clock(), told: map[string]bool{}}
	b.closing, b.stopSockets = context.WithCancel(context.Background())
	b.gitSnapshot, b.gitChanged = capture.Snapshot, capture.Changed
	b.opts.Config.Port = l.Addr().(*net.TCPAddr).Port

	fail := func(err error) (*Bridge, error) {
		l.Close()
		if b.store != nil {
			b.store.Close()
		}
		return nil, err
	}
	if err := os.MkdirAll(o.Config.StateDir, 0o700); err != nil {
		return fail(fmt.Errorf("can't create the state folder: %w", err))
	}
	if b.store, err = store.Open(o.Config.Database(), o.Version); err != nil {
		return fail(err)
	}
	b.store.SetClock(o.Clock)
	b.storeCheckIn = b.store.CheckIn
	if home, err := os.UserHomeDir(); err == nil {
		b.store.SetHome(home) // lines show folders from ~
	}
	// Every commit that writes to the event log wakes the sockets.
	b.store.OnEvent(b.notify)
	// A capture outlives a restart; a crashed bridge's stale markers don't.
	if err := b.syncMarkers(); err != nil {
		return fail(fmt.Errorf("can't write the capture markers: %w", err))
	}
	// Time the bridge was down doesn't count toward a lapse.
	// Nor toward a lapsed claim's 24 hours.
	if err := b.store.Resume(); err != nil {
		return fail(err)
	}
	if err := b.store.CheckInAll(); err != nil {
		return fail(err)
	}
	// Sessions that ended while no bridge ran.
	b.endReleased()
	// Before bridge.json, so no extension says hello before its folder is written.
	b.installExtension()
	// Old versions' binaries, now that this one has started.
	b.pruneBinaries()
	if err := b.writeBridgeFile(); err != nil {
		return fail(fmt.Errorf("can't write %s: %w", o.Config.BridgeFile(), err))
	}
	b.server = &http.Server{Handler: b.routes(), ReadHeaderTimeout: 10 * time.Second}
	return b, nil
}

// whyNotListening turns a failed bind into one line: another bridge (step
// aside), another program (say so), or the error itself.
func whyNotListening(port int, err error) error {
	client := &http.Client{Timeout: 5 * time.Second}
	r, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/bridge", port), nil) // the winner may still be migrating
	r.Header.Set("x-tweak", "1")
	if resp, herr := client.Do(r); herr == nil {
		resp.Body.Close()
		if resp.Header.Get("x-tweak-version") != "" {
			return ErrAlreadyRunning
		}
		return fmt.Errorf("port %d is in use by another program: set TWEAK_PORT", port)
	}
	if c, derr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second); derr == nil {
		c.Close()
		return fmt.Errorf("port %d is in use by another program: set TWEAK_PORT", port)
	}
	return fmt.Errorf("can't listen on 127.0.0.1:%d: %v", port, err)
}

// Port is the port the bridge listens on.
func (b *Bridge) Port() int { return b.opts.Config.Port }

// Addr is the address the bridge listens on.
func (b *Bridge) Addr() string { return b.listener.Addr().String() }

// BrowserConnected and BrowserDisconnected count extension connections,
// which keep the bridge from quitting idle.
func (b *Bridge) BrowserConnected()    { b.browsers.Add(1) }
func (b *Bridge) BrowserDisconnected() { b.browsers.Add(-1) }

// Serve answers requests until Shutdown, POST /shutdown, or idling out; then
// it finishes requests in flight, closes the database and removes bridge.json.
func (b *Bridge) Serve() error {
	served := make(chan error, 1)
	go func() { served <- b.server.Serve(b.listener) }()
	go b.watchIdle()
	b.loops.Add(3)
	go b.watchAgain()
	go b.watchLapses()
	go b.watchDeleteResolved()

	var err error
	select {
	case <-b.stop:
	case err = <-served:
	}
	// Hijacked connections outlive server.Shutdown: close the sockets
	// ("restarting") and wait for their handlers before the store goes.
	b.stopSockets()
	b.sockets.Wait()
	b.loops.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b.server.Shutdown(ctx)
	b.removeBridgeFile()
	b.store.Close()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// Shutdown asks Serve to stop.
func (b *Bridge) Shutdown() { b.stopOnce.Do(func() { close(b.stop) }) }

// Stopping reports whether Shutdown has been asked for.
func (b *Bridge) Stopping() bool {
	select {
	case <-b.stop:
		return true
	default:
		return false
	}
}

func (b *Bridge) watchIdle() {
	busy := time.Now()
	t := time.NewTicker(b.opts.IdleCheck)
	defer t.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-t.C:
		}
		n, err := b.store.ClaimCount()
		if err != nil || n > 0 || b.browsers.Load() > 0 {
			busy = time.Now()
			continue
		}
		if time.Since(busy) >= b.opts.IdleTimeout {
			b.log.Printf("no claims and no browser for %s: quitting", b.opts.IdleTimeout)
			b.Shutdown()
			return
		}
	}
}

// watchAgain sends again, as again: lines, the delivered tweaks Claude
// hasn't confirmed within AgainAfter (docs/design.md, "No lost tweaks").
func (b *Bridge) watchAgain() {
	defer b.loops.Done()
	t := time.NewTicker(b.opts.AgainCheck)
	defer t.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-b.closing.Done(): // Serve is ending: it waits for this loop
			return
		case <-t.C:
		}
		resent, err := b.store.Resend(b.opts.AgainAfter)
		if err != nil {
			b.log.Print(err)
		}
		for _, tw := range resent {
			b.log.Printf("tweak %d sent again (%d of %d): not picked up", tw.Number, tw.Resends, store.MaxResends)
		}
	}
}

func (b *Bridge) info() Info {
	return Info{Version: b.opts.Version, Protocol: version.Protocol, PID: os.Getpid(), Port: b.Port()}
}

// liveInfo is info with the connected extension's version, for GET /bridge.
func (b *Bridge) liveInfo() Info {
	i := b.info()
	if b.browsers.Load() > 0 {
		b.heardMu.Lock()
		i.Extension = b.heard
		b.heardMu.Unlock()
	}
	return i
}

func (b *Bridge) writeBridgeFile() error {
	raw, _ := json.MarshalIndent(b.info(), "", "  ")
	return atomicfile.Write(b.opts.Config.BridgeFile(), append(raw, '\n'), 0o600)
}

// removeBridgeFile removes bridge.json only if it is still this bridge's.
func (b *Bridge) removeBridgeFile() {
	path := b.opts.Config.BridgeFile()
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var f Info
	if json.Unmarshal(raw, &f) == nil && f.PID == os.Getpid() && f.Port == b.Port() {
		os.Remove(path)
	}
}

// ReadBridgeFile reads bridge.json from a state folder.
func ReadBridgeFile(stateDir string) (Info, error) {
	var f Info
	raw, err := os.ReadFile(filepath.Join(stateDir, "bridge.json"))
	if err != nil {
		return f, err
	}
	return f, json.Unmarshal(raw, &f)
}
