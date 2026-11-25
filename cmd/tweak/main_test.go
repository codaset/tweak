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

func TestVersionPrintsBinaryAndProtocol(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
	want := fmt.Sprintf("binary dev\nprotocol %d\n", version.Protocol)
	if out.String() != want {
		t.Fatalf("got %q, want %q", out.String(), want)
	}
}

// The release workflow stamps the version with -ldflags -X; this guards the
// variable path it uses.
func TestReleaseVersionIsSetWithLdflags(t *testing.T) {
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
	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.HasPrefix(string(out), "binary 1.2.3\n") {
		t.Fatalf("got %q", out)
	}
}

func TestUnknownCommandFailsWithHint(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"nope"}, &out, &errOut); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), `unknown command "nope"`) {
		t.Fatalf("stderr %q", errOut.String())
	}
}
