package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/version"
)

// client talks to a running bridge as one session.
type client struct {
	port    int
	session string
	http    *http.Client
	warn    func(string) // prints the bridge's warnings; nil (a hook) prints nothing
}

// connect finds the running bridge, handing over from an older one, or
// starts one.
func (c *context) connect() (*client, error) {
	cl, err := c.running()
	if cl != nil || err != nil {
		return cl, err
	}
	return c.started()
}

// running finds the running bridge. One older than this binary is first
// replaced by this version's (handover.go), once per command, so a
// watcher kept on an older bridge after a failed handover doesn't try on
// every poll. With no bridge answering it returns nil, nil.
func (c *context) running() (*client, error) {
	cl, info, ok := c.find()
	if !ok {
		return nil, nil
	}
	if c.handedOver || !version.Older(info.Version, version.Version) {
		return cl, nil
	}
	c.handedOver = true
	return c.handover(cl, info)
}

// find looks for a running bridge: on bridge.json's port, then the
// configured one. info is what it says about itself in GET /bridge.
func (c *context) find() (cl *client, info bridge.Info, ok bool) {
	cl = c.newClient()
	if f, err := bridge.ReadBridgeFile(c.cfg.StateDir); err == nil {
		if info, ok = cl.ping(f.Port); ok {
			cl.port = f.Port
			return cl, info, true
		}
	}
	if info, ok = cl.ping(c.cfg.Port); ok {
		cl.port = c.cfg.Port
		return cl, info, true
	}
	return nil, info, false
}

// started starts a bridge and returns a client for it.
func (c *context) started() (*client, error) {
	start := c.start
	if start == nil {
		start = c.startBridge
	}
	port, err := start()
	if err != nil {
		return nil, err
	}
	cl := c.newClient()
	cl.port = port
	return cl, nil
}

func (c *context) newClient() *client {
	return &client{session: c.session, http: &http.Client{Timeout: 30 * time.Second}, warn: c.warn}
}

// ping reports whether a bridge answers on port, and what it says about
// itself. Its version is the x-tweak-version header, which every bridge
// sends.
func (cl *client) ping(port int) (bridge.Info, bool) {
	var info bridge.Info
	r, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/bridge", port), nil)
	r.Header.Set(bridge.HeaderTweak, "1")
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(r)
	if err != nil {
		return info, false
	}
	defer resp.Body.Close()
	json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&info)
	info.Version = resp.Header.Get(bridge.HeaderVersion)
	return info, info.Version != ""
}

// refusal is the bridge saying no: its one-line message, as-is, and the
// HTTP status. Any other error from a call means the bridge didn't answer.
type refusal struct {
	message  string
	status   int
	code     string   // the error code, such as protocol
	patterns []string // with protocol: the session's claims
	version  string   // the refusing bridge's x-tweak-version
}

func (r *refusal) Error() string { return r.message }

// call sends one request and decodes the reply into out. A refusal becomes an
// error carrying the bridge's one-line message.
func (cl *client) call(method, path string, body, out any) error {
	return cl.callWithin(0, method, path, body, out)
}

// callWithin is call with its own timeout (0: the client's), for long-polls.
func (cl *client) callWithin(timeout time.Duration, method, path string, body, out any) error {
	raw, err := cl.send(timeout, method, path, body)
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// text sends a request whose reply is text, such as the brief.
func (cl *client) text(method, path string) (string, error) {
	raw, err := cl.send(0, method, path, nil)
	return string(raw), err
}

func (cl *client) send(timeout time.Duration, method, path string, body any) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	r, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", cl.port, path), rd)
	if err != nil {
		return nil, err
	}
	r.Header.Set(bridge.HeaderTweak, "1")
	r.Header.Set(bridge.HeaderProtocol, strconv.Itoa(version.Protocol))
	if cl.session != "" {
		r.Header.Set(bridge.HeaderSession, cl.session)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	hc := cl.http
	if timeout > 0 {
		hc = &http.Client{Timeout: timeout}
	}
	resp, err := hc.Do(r)
	if err != nil {
		return nil, fmt.Errorf("the bridge didn't answer: %v", err)
	}
	defer resp.Body.Close()
	if cl.warn != nil {
		for _, w := range resp.Header.Values(bridge.HeaderWarning) {
			cl.warn(w)
		}
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("the bridge didn't answer: %v", err)
	}
	if resp.StatusCode >= 300 {
		ref := &refusal{message: fmt.Sprintf("the bridge answered %s", resp.Status), status: resp.StatusCode, version: resp.Header.Get(bridge.HeaderVersion)}
		var e struct {
			Error, Message string
			Patterns       []string
		}
		if json.Unmarshal(raw, &e) == nil && e.Message != "" {
			ref.message, ref.code, ref.patterns = e.Message, e.Error, e.Patterns
		}
		return nil, ref
	}
	return raw, nil
}

// Lines a bridge started by the CLI writes as the first line on stdout.
const (
	envStartedByCLI = "TWEAK_STARTED_BY_CLI"
	lineListening   = "listening on 127.0.0.1:"
	lineAlready     = "already running"
)

// startBridge starts `tweak bridge` detached from this process and its
// session, with its output going to bridge.log, and waits for its first line:
// the port it listens on, "already running" (another CLI won the race), or
// the reason it couldn't start.
func (c *context) startBridge() (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, fmt.Errorf("couldn't start the bridge: %v", err)
	}
	return c.startBinary(exe, 10*time.Second)
}

// startBinary is startBridge with another binary, such as a previous
// version's, giving it within to say how its start went.
func (c *context) startBinary(exe string, within time.Duration) (int, error) {
	if err := os.MkdirAll(c.cfg.StateDir, 0o700); err != nil {
		return 0, fmt.Errorf("couldn't start the bridge: %v", err)
	}
	logFile, err := os.OpenFile(c.cfg.Log(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, fmt.Errorf("couldn't start the bridge: %v", err)
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "bridge")
	cmd.Env = append(os.Environ(), envStartedByCLI+"=1")
	cmd.Dir = c.cfg.StateDir
	cmd.Stderr = logFile
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, fmt.Errorf("couldn't start the bridge: %v", err)
	}
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("couldn't start the bridge: %v (log: %s)", err, c.cfg.Log())
	}

	first := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		first <- strings.TrimSpace(line)
	}()
	var line string
	select {
	case line = <-first:
	case <-time.After(within):
		cmd.Process.Kill()
		cmd.Wait()
		return 0, fmt.Errorf("the bridge didn't start within %s (log: %s)", seconds(within), c.cfg.Log())
	}

	switch {
	case strings.HasPrefix(line, lineListening):
		port, err := strconv.Atoi(strings.TrimPrefix(line, lineListening))
		if err != nil {
			return 0, fmt.Errorf("the bridge said %q (log: %s)", line, c.cfg.Log())
		}
		cmd.Process.Release()
		return port, nil
	case line == lineAlready:
		cmd.Wait()
		return c.cfg.Port, nil
	default:
		cmd.Wait()
		if line == "" {
			return 0, fmt.Errorf("the bridge exited as it started (log: %s)", c.cfg.Log())
		}
		if strings.Contains(line, "set TWEAK_PORT") {
			return 0, errors.New(line)
		}
		return 0, fmt.Errorf("couldn't start the bridge: %s (log: %s)", line, c.cfg.Log())
	}
}
