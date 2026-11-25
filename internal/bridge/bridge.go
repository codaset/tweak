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
	"strconv"
	"sync"
	"sync/atomic"
	"time"

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
	Log                    io.Writer
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
}

// Info is bridge.json, and the body of GET /bridge.
type Info struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	PID      int    `json:"pid"`
	Port     int    `json:"port"`
}

// Start binds the port, opens the database and writes bridge.json. Serve runs it.
func Start(o Options) (*Bridge, error) {
	if o.IdleTimeout == 0 {
		o.IdleTimeout = 30 * time.Minute
	}
	if o.IdleCheck == 0 {
		o.IdleCheck = time.Minute
	}
	if o.Log == nil {
		o.Log = os.Stderr
	}
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", o.Config.Port))
	if err != nil {
		return nil, whyNotListening(o.Config.Port, err)
	}
	b := &Bridge{opts: o, listener: l, log: log.New(o.Log, "bridge: ", log.LstdFlags), stop: make(chan struct{})}
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
	// Time the bridge was down doesn't count toward a lapse.
	if err := b.store.CheckInAll(); err != nil {
		return fail(err)
	}
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

	var err error
	select {
	case <-b.stop:
	case err = <-served:
	}
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

func (b *Bridge) info() Info {
	return Info{Version: b.opts.Version, Protocol: version.Protocol, PID: os.Getpid(), Port: b.Port()}
}

func (b *Bridge) writeBridgeFile() error {
	raw, _ := json.MarshalIndent(b.info(), "", "  ")
	path := b.opts.Config.BridgeFile()
	tmp := path + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
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
