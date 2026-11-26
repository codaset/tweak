// Package launcher tests the plugin's POSIX launcher, plugins/codaset/bin/tweak,
// end to end: a local HTTP server stands in for the GitHub Release, and each
// test gets its own HOME and TWEAK_STATE_DIR, so nothing touches
// ~/.local/state/codaset-tweak. Every case runs under sh and, when installed,
// dash.
package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var launcherSrc = filepath.Join("..", "..", "plugins", "codaset", "bin", "tweak")

// fakeBinary stands in for a release binary: a script the launcher can exec.
const fakeBinary = "#!/bin/sh\necho \"fake tweak: $*\"\n"

func version(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile(launcherSrc)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^VERSION=(\d+\.\d+\.\d+)$`).FindSubmatch(src)
	if m == nil {
		t.Fatal("launcher has no VERSION=X.Y.Z line")
	}
	return string(m[1])
}

func hostTarget(t *testing.T) string {
	t.Helper()
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64", "darwin/amd64", "linux/amd64", "linux/arm64":
		return runtime.GOOS + "-" + runtime.GOARCH
	}
	t.Skipf("the POSIX launcher has no build for %s/%s", runtime.GOOS, runtime.GOARCH)
	return ""
}

func shells(t *testing.T) []string {
	t.Helper()
	var found []string
	for _, sh := range []string{"sh", "dash"} {
		if path, err := exec.LookPath(sh); err == nil {
			found = append(found, path)
		}
	}
	if len(found) == 0 {
		t.Skip("no sh")
	}
	return found
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// release serves one version's binaries like a GitHub Release does, at
// /v<version>/<name>, and counts the downloads.
type release struct {
	srv       *httptest.Server
	files     map[string][]byte
	downloads atomic.Int32
	// gate, when set, holds every response after its first bytes until it closes.
	gate chan struct{}
}

func newRelease(t *testing.T, files map[string][]byte) *release {
	t.Helper()
	r := &release{files: files}
	ver := version(t)
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		name, ok := strings.CutPrefix(req.URL.Path, "/v"+ver+"/")
		body, found := r.files[name]
		if !ok || !found {
			http.NotFound(w, req)
			return
		}
		r.downloads.Add(1)
		if r.gate != nil {
			w.Header().Set("Content-Length", fmt.Sprint(len(body)))
			w.Write(body[:1])
			w.(http.Flusher).Flush()
			<-r.gate
			w.Write(body[1:])
			return
		}
		w.Write(body)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

// hold makes every download stall after its first byte until the returned
// func is called (or the test ends, so the server can close).
func (r *release) hold(t *testing.T) func() {
	r.gate = make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(r.gate) }) }
	t.Cleanup(finish)
	return finish
}

// install lays out a plugin bin/ folder (the launcher plus checksums.txt) and
// an isolated home, and returns them.
type install struct {
	bin, home, state string
	env              []string
}

func newInstall(t *testing.T, checksums string, downloadURL string) *install {
	t.Helper()
	root := t.TempDir()
	in := &install{
		bin:   filepath.Join(root, "plugin", "bin"),
		home:  filepath.Join(root, "home"),
		state: filepath.Join(root, "state"),
	}
	for _, dir := range []string{in.bin, in.home} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	src, err := os.ReadFile(launcherSrc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(in.bin, "tweak"), src, 0o755); err != nil {
		t.Fatal(err)
	}
	if checksums != "" {
		if err := os.WriteFile(filepath.Join(in.bin, "checksums.txt"), []byte(checksums), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	in.env = []string{
		"HOME=" + in.home,
		"TWEAK_STATE_DIR=" + in.state,
		"TWEAK_TEST_DOWNLOAD_URL=" + downloadURL,
		"PATH=" + os.Getenv("PATH"),
	}
	return in
}

func (in *install) kept(t *testing.T) string {
	return filepath.Join(in.state, "bin", version(t), "tweak")
}

// fakeUname puts a uname that reports the given system and machine first on PATH.
func (in *install) fakeUname(t *testing.T, system, machine string) {
	t.Helper()
	dir := filepath.Join(filepath.Dir(in.bin), "fakebin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in -s) echo %s ;; -m) echo %s ;; *) echo %s ;; esac\n", system, machine, system)
	if err := os.WriteFile(filepath.Join(dir, "uname"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	in.env = append(in.env, "PATH="+dir+":"+os.Getenv("PATH"))
}

type result struct {
	code           int
	stdout, stderr string
}

func (in *install) run(t *testing.T, shell string, env []string, args ...string) result {
	t.Helper()
	cmd := exec.Command(shell, append([]string{filepath.Join(in.bin, "tweak")}, args...)...)
	cmd.Env = append(append([]string{}, in.env...), env...)
	var out, errOut strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return result{code, out.String(), errOut.String()}
}

func failure(t *testing.T, reason string) string {
	return fmt.Sprintf("couldn't download tweak %s (%s): check your connection and run the command again\n", version(t), reason)
}

func stateFiles(t *testing.T, in *install) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(in.kept(t)))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestFirstRunDownloadsChecksAndRunsTheBinary(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			bin := []byte(fakeBinary)
			rel := newRelease(t, map[string][]byte{"tweak-" + target: bin})
			in := newInstall(t, sum(bin)+"  tweak-"+target+"\n", rel.srv.URL)

			res := in.run(t, shell, nil, "claim", "localhost:3000")
			if res.code != 0 || res.stdout != "fake tweak: claim localhost:3000\n" || res.stderr != "" {
				t.Fatalf("got %+v", res)
			}
			info, err := os.Stat(in.kept(t))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm()&0o111 == 0 {
				t.Fatalf("kept binary isn't executable: %v", info.Mode())
			}
			if got := stateFiles(t, in); len(got) != 1 {
				t.Fatalf("version folder holds %v, want only tweak", got)
			}
		})
	}
}

func TestKeptBinaryRunsWithoutTheNetwork(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			bin := []byte(fakeBinary)
			rel := newRelease(t, map[string][]byte{"tweak-" + target: bin})
			in := newInstall(t, sum(bin)+"  tweak-"+target+"\n", rel.srv.URL)
			if res := in.run(t, shell, nil, "version"); res.code != 0 {
				t.Fatalf("first run: %+v", res)
			}
			rel.srv.Close()

			res := in.run(t, shell, nil, "watch", "--json")
			if res.code != 0 || res.stdout != "fake tweak: watch --json\n" || res.stderr != "" {
				t.Fatalf("got %+v", res)
			}
			if n := rel.downloads.Load(); n != 1 {
				t.Fatalf("%d downloads, want 1", n)
			}
		})
	}
}

// A hook before the first download exits 0 at once, silent, with no
// download (nothing can be capturing yet); once the binary is kept, hooks
// run it like any other command.
func TestAHookBeforeTheFirstDownloadDoesNothing(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			bin := []byte(fakeBinary)
			rel := newRelease(t, map[string][]byte{"tweak-" + target: bin})
			in := newInstall(t, sum(bin)+"  tweak-"+target+"\n", rel.srv.URL)
			if res := in.run(t, shell, nil, "hook", "pre-edit"); res.code != 0 || res.stdout != "" || res.stderr != "" {
				t.Fatalf("got %+v", res)
			}
			if n := rel.downloads.Load(); n != 0 {
				t.Fatalf("a hook downloaded the binary (%d downloads)", n)
			}
			in.run(t, shell, nil, "version")
			if res := in.run(t, shell, nil, "hook", "pre-edit"); res.stdout != "fake tweak: hook pre-edit\n" {
				t.Fatalf("with the binary kept: %+v", res)
			}
		})
	}
}

func TestChecksumMismatchDeletesTheDownload(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			rel := newRelease(t, map[string][]byte{"tweak-" + target: []byte(fakeBinary + "# tampered\n")})
			in := newInstall(t, sum([]byte(fakeBinary))+"  tweak-"+target+"\n", rel.srv.URL)

			res := in.run(t, shell, nil, "version")
			want := failure(t, "checksum mismatch for tweak-"+target+", download deleted")
			if res.code != 1 || res.stdout != "" || res.stderr != want {
				t.Fatalf("got %+v\nwant stderr %q", res, want)
			}
			if got := stateFiles(t, in); len(got) != 0 {
				t.Fatalf("version folder still holds %v", got)
			}
		})
	}
}

func TestDownloadFailureIsOneLine(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			rel := newRelease(t, map[string][]byte{})
			in := newInstall(t, sum([]byte(fakeBinary))+"  tweak-"+target+"\n", rel.srv.URL)

			res := in.run(t, shell, nil, "version")
			url := rel.srv.URL + "/v" + version(t) + "/tweak-" + target
			line := regexp.MustCompile(`^couldn't download tweak ` + regexp.QuoteMeta(version(t)) +
				` \([^\n]*404[^\n]* for ` + regexp.QuoteMeta(url) + `\): check your connection and run the command again\n$`)
			if res.code != 1 || res.stdout != "" || !line.MatchString(res.stderr) {
				t.Fatalf("got %+v", res)
			}
			if got := stateFiles(t, in); len(got) != 0 {
				t.Fatalf("version folder still holds %v", got)
			}
		})
	}
}

func TestMissingChecksumFailsWithoutDownloading(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			rel := newRelease(t, map[string][]byte{"tweak-" + target: []byte(fakeBinary)})
			// Only a name that merely contains the target's: an exact match is required.
			in := newInstall(t, sum([]byte(fakeBinary))+"  tweak-"+target+".exe\n", rel.srv.URL)

			res := in.run(t, shell, nil, "version")
			want := failure(t, "no checksum for tweak-"+target+" in "+in.bin+"/checksums.txt")
			if res.code != 1 || res.stderr != want {
				t.Fatalf("got %+v\nwant stderr %q", res, want)
			}
			if rel.downloads.Load() != 0 {
				t.Fatal("downloaded without a checksum to check it against")
			}
		})
	}
}

func TestPicksTheBinaryForTheMachine(t *testing.T) {
	cases := []struct{ system, machine, target string }{
		{"Darwin", "arm64", "darwin-arm64"},
		{"Darwin", "x86_64", "darwin-amd64"},
		{"Linux", "x86_64", "linux-amd64"},
		{"Linux", "aarch64", "linux-arm64"},
	}
	for _, shell := range shells(t) {
		for _, c := range cases {
			t.Run(filepath.Base(shell)+"/"+c.target, func(t *testing.T) {
				bin := []byte(fakeBinary)
				rel := newRelease(t, map[string][]byte{"tweak-" + c.target: bin})
				in := newInstall(t, sum(bin)+"  tweak-"+c.target+"\n", rel.srv.URL)
				in.fakeUname(t, c.system, c.machine)
				if res := in.run(t, shell, nil, "version"); res.code != 0 || res.stdout != "fake tweak: version\n" {
					t.Fatalf("got %+v", res)
				}
			})
		}
	}
}

func TestUnwritableStateFolderIsOneLine(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			bin := []byte(fakeBinary)
			rel := newRelease(t, map[string][]byte{"tweak-" + target: bin})
			in := newInstall(t, sum(bin)+"  tweak-"+target+"\n", rel.srv.URL)
			// The state folder is a regular file, so nothing can be made inside it.
			if err := os.WriteFile(in.state, nil, 0o644); err != nil {
				t.Fatal(err)
			}
			res := in.run(t, shell, nil, "version")
			if want := failure(t, "can't create "+filepath.Dir(in.kept(t))); res.code != 1 || res.stderr != want {
				t.Fatalf("got %+v\nwant stderr %q", res, want)
			}
		})
	}
}

func TestNoBuildForThisMachine(t *testing.T) {
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			rel := newRelease(t, map[string][]byte{})
			in := newInstall(t, "", rel.srv.URL)
			in.fakeUname(t, "FreeBSD", "riscv64")
			res := in.run(t, shell, nil, "version")
			if want := failure(t, "no build for FreeBSD riscv64"); res.code != 1 || res.stderr != want {
				t.Fatalf("got %+v\nwant stderr %q", res, want)
			}
		})
	}
}

// The binary appears at its kept path only once it is complete and checked:
// while the download is in flight, only a temporary file exists.
func TestDownloadIsRenamedIntoPlace(t *testing.T) {
	target := hostTarget(t)
	shell := shells(t)[0]
	bin := []byte(fakeBinary)
	rel := newRelease(t, map[string][]byte{"tweak-" + target: bin})
	finish := rel.hold(t)
	in := newInstall(t, sum(bin)+"  tweak-"+target+"\n", rel.srv.URL)

	done := make(chan result, 1)
	go func() { done <- in.run(t, shell, nil, "version") }()
	waitFor(t, func() bool { return rel.downloads.Load() == 1 && len(stateFiles(t, in)) == 1 })
	if _, err := os.Stat(in.kept(t)); !os.IsNotExist(err) {
		t.Fatalf("kept path exists mid-download: %v", err)
	}
	if got := stateFiles(t, in); !strings.HasPrefix(got[0], ".tweak.") {
		t.Fatalf("mid-download the version folder holds %v, want one temporary file", got)
	}
	finish()
	if res := <-done; res.code != 0 || res.stdout != "fake tweak: version\n" {
		t.Fatalf("got %+v", res)
	}
	if got := stateFiles(t, in); len(got) != 1 || got[0] != "tweak" {
		t.Fatalf("version folder holds %v, want only tweak", got)
	}
}

func TestTwoLaunchersAtOnce(t *testing.T) {
	target := hostTarget(t)
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			bin := []byte(fakeBinary)
			rel := newRelease(t, map[string][]byte{"tweak-" + target: bin})
			finish := rel.hold(t)
			in := newInstall(t, sum(bin)+"  tweak-"+target+"\n", rel.srv.URL)

			const n = 2
			results := make(chan result, n)
			for i := range n {
				go func() { results <- in.run(t, shell, nil, "run", fmt.Sprint(i)) }()
			}
			// Both are mid-download before either finishes.
			waitFor(t, func() bool { return rel.downloads.Load() == n })
			finish()
			for range n {
				if res := <-results; res.code != 0 || !strings.HasPrefix(res.stdout, "fake tweak: run ") || res.stderr != "" {
					t.Fatalf("got %+v", res)
				}
			}
			if got := stateFiles(t, in); len(got) != 1 || got[0] != "tweak" {
				t.Fatalf("version folder holds %v, want only tweak", got)
			}
		})
	}
}

func TestTweakBinRunsALocalBuildWithoutDownloading(t *testing.T) {
	for _, shell := range shells(t) {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			rel := newRelease(t, map[string][]byte{})
			in := newInstall(t, "", rel.srv.URL)
			local := filepath.Join(in.home, "local-tweak")
			if err := os.WriteFile(local, []byte("#!/bin/sh\necho \"local build: $*\"\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			res := in.run(t, shell, []string{"TWEAK_BIN=" + local}, "version")
			if res.code != 0 || res.stdout != "local build: version\n" || rel.downloads.Load() != 0 {
				t.Fatalf("got %+v", res)
			}
			if got := stateFiles(t, in); len(got) != 0 {
				t.Fatalf("version folder holds %v", got)
			}
		})
	}
}

func TestLauncherIsPlainPOSIXSh(t *testing.T) {
	shellcheck, err := exec.LookPath("shellcheck")
	if err != nil {
		t.Skip("shellcheck not installed")
	}
	if out, err := exec.Command(shellcheck, "-s", "sh", launcherSrc).CombinedOutput(); err != nil {
		t.Fatalf("shellcheck: %v\n%s", err, out)
	}
}

// waitFor polls a condition the test can't be told about, such as a file the
// launcher creates, for up to 10 seconds.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
