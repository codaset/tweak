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
}

// connect finds the running bridge (bridge.json first, then the configured
// port) or starts one.
func (c *context) connect() (*client, error) {
	cl := &client{session: c.session, http: &http.Client{Timeout: 30 * time.Second}}
	if f, err := bridge.ReadBridgeFile(c.cfg.StateDir); err == nil && cl.ping(f.Port) {
		cl.port = f.Port
		return cl, nil
	}
	if cl.ping(c.cfg.Port) {
		cl.port = c.cfg.Port
		return cl, nil
	}
	port, err := c.startBridge()
	if err != nil {
		return nil, err
	}
	cl.port = port
	return cl, nil
}

// ping reports whether a bridge answers on port.
func (cl *client) ping(port int) bool {
	r, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/bridge", port), nil)
	r.Header.Set(bridge.HeaderTweak, "1")
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(r)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.Header.Get(bridge.HeaderVersion) != ""
}

// call sends one request and decodes the reply into out. A refusal becomes an
// error carrying the bridge's one-line message.
func (cl *client) call(method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	r, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", cl.port, path), rd)
	if err != nil {
		return err
	}
	r.Header.Set(bridge.HeaderTweak, "1")
	r.Header.Set(bridge.HeaderProtocol, strconv.Itoa(version.Protocol))
	if cl.session != "" {
		r.Header.Set(bridge.HeaderSession, cl.session)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, err := cl.http.Do(r)
	if err != nil {
		return fmt.Errorf("the bridge didn't answer: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e struct{ Message string }
		if json.Unmarshal(raw, &e) == nil && e.Message != "" {
			return errors.New(e.Message)
		}
		return fmt.Errorf("the bridge answered %s", resp.Status)
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
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
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		cmd.Wait()
		return 0, fmt.Errorf("the bridge didn't start within 10 seconds (log: %s)", c.cfg.Log())
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
