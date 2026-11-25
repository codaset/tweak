package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fixture copies testdata/fixture, a module whose dependencies are local
// replacements, so go list runs offline and writes nothing into the repo.
func fixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS(filepath.Join("testdata", "fixture"))); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOWORK", "off")
	t.Setenv("GOFLAGS", "-mod=mod")
	t.Setenv("GOPROXY", "off")
	return dir
}

func goroot(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func section(t *testing.T, notices, heading string) string {
	t.Helper()
	_, after, ok := strings.Cut(notices, "\n"+heading+"\n")
	if !ok {
		t.Fatalf("no %q section in:\n%s", heading, notices)
	}
	// The section runs to the next "## " heading outside a code fence
	// (licence files can be Markdown with headings of their own).
	fence := ""
	end := 0
	for line := range strings.SplitAfterSeq(after, "\n") {
		switch {
		case fence == "" && strings.HasPrefix(line, "## "):
			return after[:end]
		case fence == "" && strings.HasPrefix(line, "```"):
			fence = line[:strings.LastIndex(line, "`")+1]
		case fence != "" && strings.TrimSpace(line) == fence:
			fence = ""
		}
		end += len(line)
	}
	return after
}

func TestNoticesCoverEveryModuleCompiledForAnyTarget(t *testing.T) {
	dir := fixture(t)
	notices, err := generate(options{Dir: dir, Package: "./cmd/ok", Version: "1.4.0", Targets: defaultTargets})
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(notices, "Codaset Tweak 1.4.0") {
		t.Errorf("notices don't name the release:\n%s", notices[:200])
	}
	if strings.Contains(notices, "example.com/app") {
		t.Error("the main module is credited as a dependency")
	}

	mit := section(t, notices, "## example.com/mitdep v1.2.0")
	for _, want := range []string{
		"Licence: MIT",
		"Built into: all targets",
		readText(t, "mit-strftime"),
		// A notice in the folder of a compiled package comes too.
		"### sub/NOTICE",
		"This sub-package includes code from Example Upstream",
	} {
		if !strings.Contains(mit, want) {
			t.Errorf("example.com/mitdep section lacks %q:\n%s", want, mit)
		}
	}
	if strings.Contains(mit, "source, not a notice") {
		t.Error("a Go source file named license.go was taken for a licence file")
	}
	if strings.Contains(mit, "Not compiled into anything") {
		t.Error("a licence file from a package that isn't compiled was included")
	}

	win := section(t, notices, "## example.com/windep v0.3.0")
	for _, want := range []string{"Licence: BSD-3-Clause", "Built into: windows/amd64\n", readText(t, "bsd3-libc")} {
		if !strings.Contains(win, want) {
			t.Errorf("example.com/windep section lacks %q:\n%s", want, win)
		}
	}

	std := section(t, notices, "## Go standard library "+runtime.Version())
	golicence, err := os.ReadFile(filepath.Join(goroot(t), "LICENSE"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Licence: BSD-3-Clause", string(golicence), "### PATENTS"} {
		if !strings.Contains(std, want) {
			t.Errorf("standard library section lacks %q", want)
		}
	}
}

func TestAMissingOrDisallowedLicenceFails(t *testing.T) {
	dir := fixture(t)
	_, err := generate(options{Dir: dir, Package: "./cmd/bad", Version: "1.4.0", Targets: defaultTargets})
	if err == nil {
		t.Fatal("generate succeeded; want it to refuse both modules")
	}
	for _, want := range []string{
		"example.com/bare v1.0.0: no licence file (LICENSE, LICENCE or COPYING)",
		"example.com/gpldep v1.0.0: COPYING isn't MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or ISC",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q:\n%v", want, err)
		}
	}
}

// The same generation the release and CI run, against Tweak itself.
func TestNoticesForTweak(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"-C", "../..", "-version", "0.9.0"}, &out); err != nil {
		t.Fatal(err)
	}
	notices := out.String()
	sqlite := section(t, notices, "## modernc.org/sqlite "+moduleVersion(t, "modernc.org/sqlite"))
	if !strings.Contains(sqlite, "Licence: BSD-3-Clause") {
		t.Errorf("modernc.org/sqlite isn't credited as BSD-3-Clause:\n%.400s", sqlite)
	}
	// musl's MIT notice reaches the binary through modernc.org/libc.
	libc := section(t, notices, "## modernc.org/libc "+moduleVersion(t, "modernc.org/libc"))
	if !strings.Contains(libc, "### LICENSE-3RD-PARTY.md") || !strings.Contains(libc, "Rich Felker") {
		t.Error("modernc.org/libc's third-party notices (musl) are missing")
	}
	section(t, notices, "## Go standard library "+runtime.Version())
}

func moduleVersion(t *testing.T, path string) string {
	t.Helper()
	cmd := exec.Command("go", "list", "-m", "-f", "{{.Version}}", path)
	cmd.Dir = "../.."
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}
