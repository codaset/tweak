package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codaset/tweak/internal/version"
)

// tweak version names the bridge only when one is running, and never
// starts one to answer.
func TestVersionPrintsEachPartsVersion(t *testing.T) {
	t.Parallel()
	s := newSandbox(t)
	folder := s.folder("ernie")
	r := s.tweak("", folder, "version")
	want := fmt.Sprintf("binary dev\nprotocol %d\nbridge not running\nextension not connected\n", version.Protocol)
	if r.code != 0 || r.stdout != want {
		t.Fatalf("exit %d, stdout %q, stderr %q; want %q", r.code, r.stdout, r.stderr, want)
	}
	if _, ok := s.bridgeFile(); ok {
		t.Fatal("tweak version started a bridge")
	}
	s.tweak("s1", folder, "claims") // starts one
	r = s.tweak("", folder, "version")
	want = fmt.Sprintf("binary dev\nprotocol %d\nbridge dev\nextension not connected\n", version.Protocol)
	if r.code != 0 || r.stdout != want {
		t.Fatalf("exit %d, stdout %q, stderr %q; want %q", r.code, r.stdout, r.stderr, want)
	}
}

// The release workflow stamps the version with -ldflags -X; this guards the
// variable path it uses.
func TestReleaseVersionIsSetWithLdflags(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("builds the binary")
	}
	bin := filepath.Join(t.TempDir(), "tweak")
	build := exec.Command("go", "build", "-trimpath",
		"-ldflags", "-X github.com/codaset/tweak/internal/version.Version=1.2.3",
		"-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	cmd := exec.Command(bin, "version")
	cmd.Env = newSandbox(t).env() // never the live bridge
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.HasPrefix(string(out), "binary 1.2.3\n") {
		t.Fatalf("got %q", out)
	}
}

func TestUnknownCommandFailsWithHint(t *testing.T) {
	t.Parallel()
	var out, errOut bytes.Buffer
	if code := run([]string{"nope"}, &out, &errOut); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), `unknown command "nope"`) {
		t.Fatalf("stderr %q", errOut.String())
	}
}
