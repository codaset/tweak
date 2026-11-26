package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/config"
	"github.com/codaset/tweak/internal/version"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// A real bridge on a random port with a temporary state folder.
type harness struct {
	t    *testing.T
	b    *Bridge
	cfg  config.Config
	done chan error
}

func start(t *testing.T, opts ...func(*Options)) *harness {
	t.Helper()
	o := Options{Config: config.Config{Port: 0, StateDir: t.TempDir()}, Version: "1.2.3", Log: io.Discard}
	for _, f := range opts {
		f(&o)
	}
	b, err := Start(o)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, b: b, cfg: o.Config, done: make(chan error, 1)}
	h.cfg.Port = b.Port()
	go func() { h.done <- b.Serve() }()
	t.Cleanup(func() {
		b.Shutdown()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
			t.Error("bridge didn't stop")
		}
	})
	return h
}

type req struct {
	method, path string
	body         any
	header       map[string]string // "" deletes a default
	host         string
}

func (h *harness) do(r req) (*http.Response, []byte) {
	h.t.Helper()
	var body io.Reader
	if r.body != nil {
		raw, _ := json.Marshal(r.body)
		body = bytes.NewReader(raw)
	}
	hr, err := http.NewRequest(r.method, fmt.Sprintf("http://127.0.0.1:%d%s", h.b.Port(), r.path), body)
	if err != nil {
		h.t.Fatal(err)
	}
	hr.Header.Set("x-tweak", "1")
	hr.Header.Set("x-tweak-protocol", fmt.Sprint(version.Protocol))
	for k, v := range r.header {
		if v == "" {
			hr.Header.Del(k)
		} else {
			hr.Header.Set(k, v)
		}
	}
	if r.host != "" {
		hr.Host = r.host
	}
	resp, err := http.DefaultClient.Do(hr)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

// as sends a request as a session.
func as(session string, r req) req {
	if r.header == nil {
		r.header = map[string]string{}
	}
	r.header["x-tweak-session"] = session
	return r
}

// conforms checks a body against its contract schema.
func conforms(t *testing.T, schema string, body []byte) {
	t.Helper()
	s, err := jsonschema.NewCompiler().Compile(filepath.Join("..", "..", "schema", schema+".json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("not JSON: %s", body)
	}
	if err := s.Validate(v); err != nil {
		t.Fatalf("%s doesn't match schema %s: %v", body, schema, err)
	}
}

func refused(t *testing.T, resp *http.Response, body []byte, status int, code string) {
	t.Helper()
	if resp.StatusCode != status {
		t.Fatalf("status %d, want %d: %s", resp.StatusCode, status, body)
	}
	conforms(t, "error", body)
	var e struct{ Error string }
	json.Unmarshal(body, &e)
	if e.Error != code {
		t.Fatalf("error %q, want %q", e.Error, code)
	}
	for k := range resp.Header {
		if strings.HasPrefix(strings.ToLower(k), "access-control-") {
			t.Fatalf("CORS header %s sent", k)
		}
	}
}

func (h *harness) register(session, folder string) {
	h.t.Helper()
	resp, body := h.do(as(session, req{method: "POST", path: "/sessions", body: map[string]string{"agent": "claude-code", "folder": folder}}))
	if resp.StatusCode != 200 {
		h.t.Fatalf("register: %d %s", resp.StatusCode, body)
	}
}

func (h *harness) claim(session, pattern string) (*http.Response, []byte) {
	return h.do(as(session, req{method: "POST", path: "/claims", body: map[string]string{"pattern": pattern}}))
}

func TestBridgeFileNamesThePortPIDAndVersion(t *testing.T) {
	h := start(t)
	raw, err := os.ReadFile(h.cfg.BridgeFile())
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Port, PID int
		Version   string
	}
	json.Unmarshal(raw, &f)
	if f.Port != h.b.Port() || f.PID != os.Getpid() || f.Version != "1.2.3" {
		t.Fatalf("bridge.json %s", raw)
	}

	h.b.Shutdown()
	<-h.done
	h.done <- nil
	if _, err := os.Stat(h.cfg.BridgeFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("bridge.json left behind after shutdown")
	}
}

func TestListensOnLoopbackOnly(t *testing.T) {
	h := start(t)
	if addr := h.b.Addr(); !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Fatalf("listening on %s", addr)
	}
}

func TestBridgeInfo(t *testing.T) {
	h := start(t)
	resp, body := h.do(req{method: "GET", path: "/bridge"})
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	conforms(t, "bridge-info", body)
	if resp.Header.Get("x-tweak-version") != "1.2.3" {
		t.Fatalf("x-tweak-version %q", resp.Header.Get("x-tweak-version"))
	}
}

func TestSecurityRefusals(t *testing.T) {
	h := start(t)
	port := h.b.Port()
	cases := []struct {
		name string
		r    req
	}{
		{"web origin", req{method: "GET", path: "/claims", header: map[string]string{"Origin": "https://evil.example"}}},
		{"dev server origin", req{method: "GET", path: "/claims", header: map[string]string{"Origin": fmt.Sprintf("http://localhost:%d", port)}}},
		{"null origin", req{method: "GET", path: "/claims", header: map[string]string{"Origin": "null"}}},
		{"another extension", req{method: "GET", path: "/claims", header: map[string]string{"Origin": "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh"}}},
		{"our ID with a suffix", req{method: "GET", path: "/claims", header: map[string]string{"Origin": "chrome-extension://" + tweak.ExtensionID + "x"}}},
		{"no x-tweak header", req{method: "GET", path: "/claims", header: map[string]string{"x-tweak": ""}}},
		{"wrong x-tweak header", req{method: "GET", path: "/claims", header: map[string]string{"x-tweak": "yes"}}},
		{"preflight", req{method: "OPTIONS", path: "/claims", header: map[string]string{
			"x-tweak": "", "Origin": "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-tweak"}}},
		{"rebinding host", req{method: "GET", path: "/claims", host: fmt.Sprintf("evil.example:%d", port)}},
		{"host on another port", req{method: "GET", path: "/claims", host: fmt.Sprintf("127.0.0.1:%d", port+1)}},
		{"host without a port", req{method: "GET", path: "/claims", host: "localhost"}},
		{"bridge info with a web origin", req{method: "GET", path: "/bridge", header: map[string]string{"Origin": "https://evil.example"}}},
		{"shutdown without x-tweak", req{method: "POST", path: "/shutdown", header: map[string]string{"x-tweak": ""}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, body := h.do(c.r)
			refused(t, resp, body, 403, "forbidden")
			if resp.Header.Get("x-tweak-version") != "1.2.3" {
				t.Fatal("refusal without x-tweak-version")
			}
		})
	}
	// The bridge is still up after a refused shutdown.
	if resp, _ := h.do(req{method: "GET", path: "/bridge"}); resp.StatusCode != 200 {
		t.Fatal("bridge gone")
	}
}

func TestAcceptedOrigins(t *testing.T) {
	h := start(t)
	port := h.b.Port()
	for _, r := range []req{
		{method: "GET", path: "/claims"}, // the CLI: no Origin
		{method: "GET", path: "/claims", header: map[string]string{"Origin": "chrome-extension://" + tweak.ExtensionID}},
		{method: "GET", path: "/claims", host: fmt.Sprintf("localhost:%d", port)},
	} {
		if resp, body := h.do(r); resp.StatusCode != 200 {
			t.Errorf("%+v refused: %s", r, body)
		}
	}
}

func TestProtocolMismatchIsRefused(t *testing.T) {
	h := start(t)
	other := fmt.Sprint(version.Protocol + 1)
	resp, body := h.do(req{method: "GET", path: "/claims", header: map[string]string{"x-tweak-protocol": other}})
	refused(t, resp, body, 400, "protocol")
	var e struct{ Message string }
	json.Unmarshal(body, &e)
	want := fmt.Sprintf("tweak speaks protocol %s; the bridge speaks %d: update the plugin, then /reload-plugins", other, version.Protocol)
	if e.Message != want {
		t.Fatalf("message %q\nwant    %q", e.Message, want)
	}

	resp, body = h.do(req{method: "GET", path: "/claims", header: map[string]string{"x-tweak-protocol": ""}})
	refused(t, resp, body, 400, "protocol")

	// Finding and replacing a bridge works across protocols.
	if resp, _ := h.do(req{method: "GET", path: "/bridge", header: map[string]string{"x-tweak-protocol": other}}); resp.StatusCode != 200 {
		t.Fatal("GET /bridge should answer any protocol")
	}
}

// A session's watcher refused for its protocol is told the session's
// patterns, to claim again after /reload-plugins; the claims stay.
func TestAProtocolRefusalNamesTheSessionsClaims(t *testing.T) {
	h := start(t)
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	h.claim("s1", "http://localhost:3000")
	h.register("s2", "/dev/other")
	h.claim("s2", "https://other.localhost/*")

	other := fmt.Sprint(version.Protocol + 1)
	resp, body := h.do(as("s1", req{method: "GET", path: "/inbox", header: map[string]string{"x-tweak-protocol": other}}))
	refused(t, resp, body, 400, "protocol")
	var e struct{ Patterns []string }
	json.Unmarshal(body, &e)
	if want := []string{"https://ernie.localhost/*", "http://localhost:3000/*"}; fmt.Sprint(e.Patterns) != fmt.Sprint(want) {
		t.Fatalf("patterns %q, want %q", e.Patterns, want)
	}

	_, body = h.do(req{method: "GET", path: "/claims"})
	var claims struct{ Claims []any }
	json.Unmarshal(body, &claims)
	if len(claims.Claims) != 3 {
		t.Fatalf("claims after the refusal: %s", body)
	}
}

func TestEveryRequestChecksTheSessionIn(t *testing.T) {
	h := start(t)
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	checkIn := func() string {
		_, body := h.do(req{method: "GET", path: "/claims"})
		var r struct {
			Claims []struct{ Session struct{ LastCheckIn string } }
		}
		json.Unmarshal(body, &r)
		return r.Claims[0].Session.LastCheckIn
	}
	before := checkIn()
	time.Sleep(15 * time.Millisecond)
	h.do(as("s1", req{method: "GET", path: "/claims"}))
	if after := checkIn(); after <= before {
		t.Fatalf("check-in didn't move: %s -> %s", before, after)
	}
}

func TestRegisteringNeedsASessionIDAgentAndFolder(t *testing.T) {
	h := start(t)
	resp, body := h.do(req{method: "POST", path: "/sessions", body: map[string]string{"agent": "claude-code", "folder": "/x"}})
	refused(t, resp, body, 400, "no-session-id")
	resp, body = h.do(as("s1", req{method: "POST", path: "/sessions", body: map[string]string{"agent": "claude-code"}}))
	refused(t, resp, body, 400, "bad-request")
}

func TestClaimsOverHTTP(t *testing.T) {
	h := start(t)
	h.register("s1", "/dev/ernie")
	h.register("s2", "/dev/ernie-2")

	resp, body := h.claim("s1", "https://ernie.localhost")
	if resp.StatusCode != 201 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	conforms(t, "claim", body)
	if !bytes.Contains(body, []byte(`"pattern":"https://ernie.localhost/*"`)) {
		t.Fatalf("bare origin not widened: %s", body)
	}

	resp, body = h.claim("s2", "https://ernie.localhost/admin/*")
	refused(t, resp, body, 409, "overlap")
	if !bytes.Contains(body, []byte("claimed by the session in /dev/ernie (s1)")) {
		t.Fatalf("refusal doesn't name the holder: %s", body)
	}

	resp, body = h.claim("s2", "ernie.localhost")
	refused(t, resp, body, 400, "bad-pattern")
	resp, body = h.claim("nobody", "https://bert.localhost/*")
	refused(t, resp, body, 404, "no-session")
	resp, body = h.do(req{method: "POST", path: "/claims", body: map[string]string{"pattern": "https://bert.localhost/*"}})
	refused(t, resp, body, 400, "no-session-id")

	h.claim("s2", "https://bert.localhost/*")
	resp, body = h.do(req{method: "GET", path: "/claims"})
	conforms(t, "claims", body)
	if bytes.Count(body, []byte(`"pattern"`)) != 2 {
		t.Fatalf("claims %s", body)
	}

	resp, body = h.do(as("s1", req{method: "DELETE", path: "/claims?pattern=https://bert.localhost/*"}))
	refused(t, resp, body, 404, "not-claimed")
	resp, body = h.do(as("s1", req{method: "DELETE", path: "/claims?pattern=https%3A%2F%2Fernie.localhost"}))
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	conforms(t, "released", body)
	if string(body) != `{"released":["https://ernie.localhost/*"]}`+"\n" {
		t.Fatalf("released %s", body)
	}
	// An explicitly empty pattern (an empty shell variable) is a bad pattern,
	// never "release everything".
	resp, body = h.do(as("s2", req{method: "DELETE", path: "/claims?pattern="}))
	refused(t, resp, body, 400, "bad-pattern")
	resp, body = h.do(as("s2", req{method: "DELETE", path: "/claims"}))
	if string(body) != `{"released":["https://bert.localhost/*"]}`+"\n" {
		t.Fatalf("release all: %s", body)
	}
}

func TestShutdownOverHTTP(t *testing.T) {
	h := start(t)
	resp, _ := h.do(req{method: "POST", path: "/shutdown"})
	if resp.StatusCode != 202 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	select {
	case <-h.done:
		h.done <- nil
	case <-time.After(5 * time.Second):
		t.Fatal("still running")
	}
}

func idle(d time.Duration) func(*Options) {
	return func(o *Options) { o.IdleTimeout, o.IdleCheck = d, 10*time.Millisecond }
}

func TestQuitsWhenIdle(t *testing.T) {
	h := start(t, idle(150*time.Millisecond))
	select {
	case err := <-h.done:
		h.done <- err
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("didn't quit when idle")
	}
	if _, err := os.Stat(h.cfg.BridgeFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("bridge.json left behind")
	}
}

func TestStaysUpWhileAClaimIsHeld(t *testing.T) {
	// The claim is made over HTTP after the bridge starts, so the idle time
	// must comfortably outlast two requests on a slow -race runner.
	h := start(t, idle(time.Second))
	h.register("s1", "/dev/ernie")
	h.claim("s1", "https://ernie.localhost/*")
	select {
	case <-h.done:
		t.Fatal("quit with a claim held")
	case <-time.After(1500 * time.Millisecond):
	}
	h.do(as("s1", req{method: "DELETE", path: "/claims"}))
	select {
	case err := <-h.done:
		h.done <- err
	case <-time.After(3 * time.Second):
		t.Fatal("didn't quit once the claim was released")
	}
}

func TestStaysUpWhileABrowserIsConnected(t *testing.T) {
	h := start(t, idle(150*time.Millisecond))
	h.b.BrowserConnected()
	select {
	case <-h.done:
		t.Fatal("quit with a browser connected")
	case <-time.After(500 * time.Millisecond):
	}
	h.b.BrowserDisconnected()
	select {
	case err := <-h.done:
		h.done <- err
	case <-time.After(3 * time.Second):
		t.Fatal("didn't quit once the browser left")
	}
}

func TestPortInUseByAnotherProgram(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() { // a program that isn't a bridge
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"))
			c.Close()
		}
	}()
	port := l.Addr().(*net.TCPAddr).Port
	_, err = Start(Options{Config: config.Config{Port: port, StateDir: t.TempDir()}, Version: "1.2.3", Log: io.Discard})
	want := fmt.Sprintf("port %d is in use by another program: set TWEAK_PORT", port)
	if err == nil || err.Error() != want {
		t.Fatalf("got %v, want %q", err, want)
	}
}

func TestASecondBridgeOnThePortStepsAside(t *testing.T) {
	h := start(t)
	_, err := Start(Options{Config: config.Config{Port: h.b.Port(), StateDir: t.TempDir()}, Version: "1.2.3", Log: io.Discard})
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("got %v", err)
	}
}
