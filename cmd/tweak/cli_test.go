package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The CLI tests run the built binary, which starts a real bridge on a random
// port with a temporary state folder and HOME: never the live one.

var tweakBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "tweak-cli-test")
	if err != nil {
		panic(err)
	}
	tweakBin = filepath.Join(dir, "tweak")
	if out, err := exec.Command("go", "build", "-o", tweakBin, ".").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type sandbox struct {
	t     *testing.T
	port  int
	state string
	home  string
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func newSandbox(t *testing.T) *sandbox {
	t.Helper()
	root := t.TempDir()
	s := &sandbox{t: t, port: freePort(t), state: filepath.Join(root, "state"), home: filepath.Join(root, "home")}
	os.MkdirAll(s.home, 0o700)
	t.Cleanup(s.stopBridge)
	return s
}

func (s *sandbox) env(extra ...string) []string {
	return append([]string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + s.home,
		"TWEAK_BIN=" + tweakBin,
		fmt.Sprintf("TWEAK_PORT=%d", s.port),
		"TWEAK_STATE_DIR=" + s.state,
	}, extra...)
}

type result struct {
	code           int
	stdout, stderr string
}

// tweak runs the binary as a session (or none, with "") in folder.
func (s *sandbox) tweak(session, folder string, args ...string) result {
	s.t.Helper()
	cmd := exec.Command(tweakBin, args...)
	cmd.Env = s.env()
	if session != "" {
		cmd.Env = append(cmd.Env, "CLAUDE_CODE_SESSION_ID="+session)
	}
	cmd.Dir = folder
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		cmd.Process.Kill()
		s.t.Fatalf("tweak %v hung (did the bridge keep its stdio?)", args)
	}
	return result{cmd.ProcessState.ExitCode(), out.String(), errOut.String()}
}

func (s *sandbox) folder(name string) string {
	d := filepath.Join(s.home, "dev", name)
	os.MkdirAll(d, 0o700)
	d, _ = filepath.EvalSymlinks(d)
	return d
}

type bridgeFile struct {
	Port, PID int
	Version   string
}

func (s *sandbox) bridgeFile() (bridgeFile, bool) {
	var f bridgeFile
	raw, err := os.ReadFile(filepath.Join(s.state, "bridge.json"))
	if err != nil {
		return f, false
	}
	return f, json.Unmarshal(raw, &f) == nil
}

// stopBridge shuts down the sandbox's bridge, by its own bridge.json only.
func (s *sandbox) stopBridge() {
	f, ok := s.bridgeFile()
	if !ok || f.Port != s.port {
		return
	}
	r, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/shutdown", f.Port), nil)
	r.Header.Set("x-tweak", "1")
	if resp, err := http.DefaultClient.Do(r); err == nil {
		resp.Body.Close()
	}
	for range 50 {
		if _, ok := s.bridgeFile(); !ok {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	if p, err := os.FindProcess(f.PID); err == nil {
		p.Kill()
	}
	s.t.Errorf("bridge %d didn't stop; killed it", f.PID)
}

func TestClaimStartsTheBridgeAndClaims(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	r := s.tweak("s1", ernie, "claim", "https://ernie.localhost")
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if r.stdout != "claimed https://ernie.localhost/*\nnow run tweak watch\n" {
		t.Fatalf("stdout %q", r.stdout)
	}
	f, ok := s.bridgeFile()
	if !ok || f.Port != s.port || f.Version != "dev" || f.PID == 0 {
		t.Fatalf("bridge.json %+v", f)
	}

	r = s.tweak("s1", ernie, "claims")
	want := fmt.Sprintf("https://ernie.localhost/*  session s1 in %s\n", ernie)
	if r.code != 0 || r.stdout != want {
		t.Fatalf("claims: %d %q, want %q", r.code, r.stdout, want)
	}
}

func TestAnOverlappingClaimIsRefusedWithItsHolder(t *testing.T) {
	s := newSandbox(t)
	ernie, ernie2 := s.folder("ernie"), s.folder("ernie-2")
	if r := s.tweak("s1", ernie, "claim", "https://ernie.localhost/*"); r.code != 0 {
		t.Fatalf("first claim: %s", r.stderr)
	}
	// --session stands in for CLAUDE_CODE_SESSION_ID.
	r := s.tweak("", ernie2, "claim", "--session", "s2", "https://ernie.localhost/admin/*")
	want := fmt.Sprintf("https://ernie.localhost/admin/* overlaps https://ernie.localhost/*, claimed by the session in %s (s1)\n", ernie)
	if r.code != 1 || r.stderr != want || r.stdout != "" {
		t.Fatalf("exit %d, stdout %q, stderr %q\nwant stderr %q", r.code, r.stdout, r.stderr, want)
	}
}

func TestReleaseOneOrAll(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	s.tweak("s1", ernie, "claim", "http://localhost:3000")

	r := s.tweak("s1", ernie, "release", "http://localhost:3000/*")
	if r.code != 0 || r.stdout != "released http://localhost:3000/*\n" {
		t.Fatalf("release one: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = s.tweak("s1", ernie, "release")
	if r.code != 0 || r.stdout != "released https://ernie.localhost/*\n" {
		t.Fatalf("release all: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = s.tweak("s1", ernie, "release")
	if r.code != 0 || r.stdout != "no claims to release\n" {
		t.Fatalf("release none: %d %q %q", r.code, r.stdout, r.stderr)
	}
	if r := s.tweak("s1", ernie, "claims"); r.stdout != "no claims\n" {
		t.Fatalf("claims %q", r.stdout)
	}
}

func TestAnyCommandStartsTheBridge(t *testing.T) {
	s := newSandbox(t)
	r := s.tweak("", s.folder("x"), "claims")
	if r.code != 0 || r.stdout != "no claims\n" {
		t.Fatalf("%d %q %q", r.code, r.stdout, r.stderr)
	}
	if _, ok := s.bridgeFile(); !ok {
		t.Fatal("no bridge started")
	}
}

func TestTwoCommandsStartingAtOnceShareOneBridge(t *testing.T) {
	s := newSandbox(t)
	var wg sync.WaitGroup
	results := make([]result, 3)
	for i := range results {
		wg.Go(func() { results[i] = s.tweak("", s.folder("x"), "claims") })
	}
	wg.Wait()
	for _, r := range results {
		if r.code != 0 || r.stdout != "no claims\n" {
			t.Fatalf("%d %q %q", r.code, r.stdout, r.stderr)
		}
	}
}

func TestPortInUseByAnotherProgram(t *testing.T) {
	s := newSandbox(t)
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.port))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	r := s.tweak("s1", s.folder("ernie"), "claim", "https://ernie.localhost/*")
	want := fmt.Sprintf("port %d is in use by another program: set TWEAK_PORT\n", s.port)
	if r.code != 1 || r.stderr != want {
		t.Fatalf("exit %d, stderr %q, want %q", r.code, r.stderr, want)
	}
}

func TestClaimNeedsASessionID(t *testing.T) {
	s := newSandbox(t)
	r := s.tweak("", s.folder("ernie"), "claim", "https://ernie.localhost/*")
	if r.code != 1 || !strings.Contains(r.stderr, "--session") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
}

func TestABadPatternSaysWhy(t *testing.T) {
	s := newSandbox(t)
	r := s.tweak("s1", s.folder("ernie"), "claim", "ernie.localhost")
	if r.code != 1 || !strings.Contains(r.stderr, "https://ernie.localhost/*") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
}

func TestDevelopmentBuildRefusesTheLiveStateFolder(t *testing.T) {
	s := newSandbox(t)
	cmd := exec.Command(tweakBin, "claims")
	// Our own port, but the default state folder (under a fake HOME).
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + s.home, "TWEAK_BIN=" + tweakBin, fmt.Sprintf("TWEAK_PORT=%d", s.port)}
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "TWEAK_BIN is set") || !strings.Contains(string(out), "TWEAK_STATE_DIR") {
		t.Fatalf("err %v, output %q", err, out)
	}
	if _, err := os.Stat(filepath.Join(s.home, ".local")); err == nil {
		t.Fatal("the default state folder was touched")
	}
}
