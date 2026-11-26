package bridge

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/version"
)

// A PNG's signature, then enough to look like one: the bridge checks only
// the signature.
var png = append([]byte("\x89PNG\r\n\x1a\n"), []byte("\x00\x00\x00\x0dIHDR")...)

var extension = map[string]string{"Origin": "chrome-extension://" + tweak.ExtensionID}

// put sends a screenshot the way the worker does: raw bytes, x-tweak and the
// protocol, from the extension's origin.
func (h *harness) put(path string, body []byte, header map[string]string) (*http.Response, []byte) {
	h.t.Helper()
	r, _ := http.NewRequest("PUT", fmt.Sprintf("http://127.0.0.1:%d%s", h.b.Port(), path), bytes.NewReader(body))
	r.Header.Set("x-tweak", "1")
	r.Header.Set("x-tweak-protocol", fmt.Sprint(version.Protocol))
	r.Header.Set("Content-Type", "image/png")
	for k, v := range header {
		r.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out bytes.Buffer
	out.ReadFrom(resp.Body)
	return resp, out.Bytes()
}

func created(t *testing.T) *harness {
	h, s := tracer(t)
	s.send(createMsg("r1", "https://ernie.localhost/", "make it green"))
	s.readUntil("result")
	return h
}

// The worker's upload lands beside the database, where the brief names it.
func TestAScreenshotIsStoredAndTheBriefNamesIt(t *testing.T) {
	h := created(t)
	resp, body := h.put("/tweaks/1/screenshot", png, extension)
	if resp.StatusCode != 204 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != extension["Origin"] {
		t.Fatalf("Access-Control-Allow-Origin %q", got)
	}
	shot := filepath.Join(h.cfg.StateDir, "screenshots", "1.png")
	if raw, err := os.ReadFile(shot); err != nil || !bytes.Equal(raw, png) {
		t.Fatalf("stored %q, %v", raw, err)
	}
	if info, _ := os.Stat(shot); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	if _, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"})); !strings.Contains(string(body), "Screenshot: "+shot+". View it") {
		t.Fatalf("brief:\n%s", body)
	}
}

func TestAScreenshotIsRefusedForNoTweakOrNoPNG(t *testing.T) {
	h := created(t)
	for name, c := range map[string]struct {
		path   string
		body   []byte
		status int
		code   string
	}{
		"no such tweak":  {"/tweaks/9/screenshot", png, 404, "no-tweak"},
		"not a number":   {"/tweaks/x/screenshot", png, 404, "no-tweak"},
		"not a PNG":      {"/tweaks/1/screenshot", []byte("GIF89a, not a png"), 400, "bad-request"},
		"empty":          {"/tweaks/1/screenshot", nil, 400, "bad-request"},
		"over the limit": {"/tweaks/1/screenshot", append(append([]byte{}, png...), make([]byte, maxScreenshot)...), 413, "too-large"},
	} {
		t.Run(name, func(t *testing.T) {
			resp, body := h.put(c.path, c.body, extension)
			if resp.StatusCode != c.status || !strings.Contains(string(body), `"error":"`+c.code+`"`) {
				t.Fatalf("status %d, want %d %s: %s", resp.StatusCode, c.status, c.code, body)
			}
			conforms(t, "error", body)
			// The worker reads refusals too, so they carry the CORS header.
			if resp.Header.Get("Access-Control-Allow-Origin") != extension["Origin"] {
				t.Fatal("refusal without Access-Control-Allow-Origin")
			}
		})
	}
	if _, err := os.Stat(filepath.Join(h.cfg.StateDir, "screenshots", "1.png")); !os.IsNotExist(err) {
		t.Fatalf("a refused upload left a file: %v", err)
	}
}

// Without a host grant for 127.0.0.1, the worker's PUT is preflighted. The
// bridge approves exactly that: this path, the extension's own origin.
func TestOnlyTheExtensionsScreenshotPreflightIsApproved(t *testing.T) {
	h := start(t)
	preflight := func(path, origin string) req {
		return req{method: "OPTIONS", path: path, header: map[string]string{
			"x-tweak": "", "x-tweak-protocol": "", "Origin": origin,
			"Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,x-tweak,x-tweak-protocol"}}
	}
	resp, body := h.do(preflight("/tweaks/1/screenshot", extension["Origin"]))
	if resp.StatusCode != 204 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	for k, want := range map[string]string{
		"Access-Control-Allow-Origin":  extension["Origin"],
		"Access-Control-Allow-Methods": "PUT",
		"Access-Control-Allow-Headers": "content-type, x-tweak, x-tweak-protocol",
		"Vary":                         "Origin",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("%s %q, want %q", k, got, want)
		}
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Error("credentials allowed")
	}

	for name, r := range map[string]req{
		"a web page's":               preflight("/tweaks/1/screenshot", "https://evil.example"),
		"another extension's":        preflight("/tweaks/1/screenshot", "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh"),
		"the extension's, elsewhere": preflight("/claims", extension["Origin"]),
		"the extension's, deeper":    preflight("/tweaks/1/screenshot/x", extension["Origin"]),
	} {
		t.Run(name, func(t *testing.T) {
			resp, body := h.do(r)
			refused(t, resp, body, 403, "forbidden")
		})
	}
	// A rebinding Host is refused before anything else.
	r := preflight("/tweaks/1/screenshot", extension["Origin"])
	r.host = fmt.Sprintf("evil.example:%d", h.b.Port())
	resp, body = h.do(r)
	refused(t, resp, body, 403, "forbidden")
}

// The PUT itself still needs x-tweak, like every request.
func TestAScreenshotStillNeedsXTweak(t *testing.T) {
	h := created(t)
	resp, body := h.put("/tweaks/1/screenshot", png, map[string]string{"Origin": extension["Origin"], "x-tweak": "no"})
	if resp.StatusCode != 403 || !strings.Contains(string(body), "forbidden") {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
}

// A create that says a screenshot follows makes a brief fetched before it
// lands wait for it, a while at most: Claude can pick a tweak up faster than
// the worker crops and uploads.
func TestTheBriefWaitsForAScreenshotThatsOnItsWay(t *testing.T) {
	h, s := tracer(t)
	m := createMsg("r1", "https://ernie.localhost/", "make it green")
	m["screenshot"] = true
	s.send(m)
	s.readUntil("result")

	briefs := make(chan string, 1)
	go func() {
		_, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
		briefs <- string(body)
	}()
	select {
	case b := <-briefs:
		t.Fatalf("the brief didn't wait:\n%s", b)
	case <-time.After(200 * time.Millisecond):
	}
	if resp, body := h.put("/tweaks/1/screenshot", png, extension); resp.StatusCode != 204 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	select {
	case b := <-briefs:
		if !strings.Contains(b, "Screenshot: "+filepath.Join(h.cfg.StateDir, "screenshots", "1.png")) {
			t.Fatalf("brief:\n%s", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the brief still waits after the upload")
	}
}

func TestAScreenshotThatNeverComesIsWaitedForOnlyAWhile(t *testing.T) {
	h, s := tracer(t, func(o *Options) { o.ScreenshotWait = 300 * time.Millisecond })
	m := createMsg("r1", "https://ernie.localhost/", "make it green")
	m["screenshot"] = true
	s.send(m)
	s.readUntil("result")
	started := time.Now()
	_, body := h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if took := time.Since(started); took < 200*time.Millisecond || took > 2*time.Second || !strings.Contains(string(body), "Screenshot: none (capture failed)") {
		t.Fatalf("after %v:\n%s", took, body)
	}
	// Once given up on, it isn't waited for again.
	started = time.Now()
	h.do(as("s1", req{method: "POST", path: "/tweaks/1/work"}))
	if took := time.Since(started); took > 200*time.Millisecond {
		t.Fatalf("waited again: %v", took)
	}

	// Without one on its way, there's nothing to wait for.
	s.send(createMsg("r2", "https://ernie.localhost/", "and this"))
	s.readUntil("result")
	started = time.Now()
	h.do(as("s1", req{method: "POST", path: "/tweaks/2/work"}))
	if took := time.Since(started); took > 200*time.Millisecond {
		t.Fatalf("waited for nothing: %v", took)
	}
}
