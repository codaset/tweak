package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Handing over to a newer bridge (docs/design.md, "Installation and
// updates"), with real release builds of two versions of this code, each
// kept in the sandbox's bin/<version>/ as the launcher keeps them.

const oldVersion, newVersion = "1.0.0", "1.1.0"

var (
	releasesOnce sync.Once
	releases     map[string]string // build name: path
	releasesErr  error
)

// release is a build stamped with a version: "1.0.0", "1.1.0", or
// "1.1.0-exit" and "1.1.0-hang", whose bridge exits at once or never
// answers (cli.testBridge, which only a test build sets).
func release(t *testing.T, name string) string {
	t.Helper()
	if testing.Short() {
		t.Skip("builds release binaries")
	}
	releasesOnce.Do(func() {
		builds := map[string]string{
			oldVersion:           "",
			newVersion:           "",
			newVersion + "-exit": "exit",
			newVersion + "-hang": "hang",
		}
		releases = map[string]string{}
		var mu sync.Mutex
		var wg sync.WaitGroup
		for name, broken := range builds {
			wg.Go(func() {
				v, _, _ := strings.Cut(name, "-")
				flags := "-X github.com/codaset/tweak/internal/version.Version=" + v
				if broken != "" {
					flags += " -X github.com/codaset/tweak/internal/cli.testBridge=" + broken
				}
				bin := filepath.Join(filepath.Dir(tweakBin), "release-"+name, "tweak")
				out, err := exec.Command("go", "build", "-ldflags", flags, "-o", bin, ".").CombinedOutput()
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					releasesErr = fmt.Errorf("build %s: %v\n%s", name, err, out)
				}
				releases[name] = bin
			})
		}
		wg.Wait()
	})
	if releasesErr != nil {
		t.Fatal(releasesErr)
	}
	return releases[name]
}

// install keeps a build in the sandbox's bin/<version>/tweak, as the
// launcher does, and returns its path there.
func (s *sandbox) install(name string) string {
	s.t.Helper()
	v, _, _ := strings.Cut(name, "-")
	raw, err := os.ReadFile(release(s.t, name))
	if err != nil {
		s.t.Fatal(err)
	}
	dest := filepath.Join(s.state, "bin", v, "tweak")
	os.MkdirAll(filepath.Dir(dest), 0o700)
	if err := os.WriteFile(dest, raw, 0o700); err != nil {
		s.t.Fatal(err)
	}
	return dest
}

// releaseSandbox runs installed release builds, without TWEAK_BIN.
func releaseSandbox(t *testing.T) *sandbox {
	s := newSandbox(t)
	s.installed = true
	return s
}

// running reports whether a process is still alive.
func running(pid int) bool {
	p, err := os.FindProcess(pid)
	return err == nil && p.Signal(syscall.Signal(0)) == nil
}

// gone waits for a bridge's process to exit.
func gone(t *testing.T, pid int) {
	t.Helper()
	for range 50 {
		if !running(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("bridge %d is still running", pid)
}

// bridgeIs checks bridge.json names a running bridge of version v.
func (s *sandbox) bridgeIs(v string) bridgeFile {
	s.t.Helper()
	f, ok := s.bridgeFile()
	if !ok || f.Version != v || !running(f.PID) {
		s.t.Fatalf("bridge.json %+v (ok %v), want a running %s", f, ok, v)
	}
	return f
}

// claimed is `tweak claims`'s line for the sandbox's one claim.
func claimed(folder string) string {
	return fmt.Sprintf("https://ernie.localhost/*  session s1 in %s\n", folder)
}

// A command finding a bridge older than itself shuts it down, starts its
// own and carries on: the claims are still there, and nothing is said.
func TestANewerCommandHandsOverFromAnOlderBridge(t *testing.T) {
	s := releaseSandbox(t)
	ernie := s.folder("ernie")
	s.bin = s.install(oldVersion)
	if r := s.tweak("s1", ernie, "claim", "https://ernie.localhost"); r.code != 0 {
		t.Fatalf("claim: %d %s", r.code, r.stderr)
	}
	old := s.bridgeIs(oldVersion)

	s.bin = s.install(newVersion)
	r := s.tweak("s1", ernie, "claims")
	if r.code != 0 || r.stdout != claimed(ernie) || r.stderr != "" {
		t.Fatalf("exit %d, stdout %q, stderr %q", r.code, r.stdout, r.stderr)
	}
	gone(t, old.PID)
	s.bridgeIs(newVersion)

	// An older command leaves a newer bridge be.
	now := s.bridgeIs(newVersion)
	s.bin = filepath.Join(s.state, "bin", oldVersion, "tweak")
	if r := s.tweak("s1", ernie, "claims"); r.code != 0 || r.stdout != claimed(ernie) {
		t.Fatalf("old claims: %d %q %q", r.code, r.stdout, r.stderr)
	}
	if f := s.bridgeIs(newVersion); f.PID != now.PID {
		t.Fatalf("the newer bridge was replaced: %d, then %d", now.PID, f.PID)
	}
}

// A new bridge that can't start (it exits at once, or doesn't answer
// within 5 seconds) is rolled back: the previous version starts again, the
// command says so and carries on against it, and the next command tries
// again.
func TestAHandoverThatFailsKeepsTheOldBridge(t *testing.T) {
	for _, c := range []struct{ build, why string }{
		{newVersion + "-exit", "the bridge exited as it started"},
		{newVersion + "-hang", "the bridge didn't start within 5 seconds"},
	} {
		t.Run(c.build, func(t *testing.T) {
			s := releaseSandbox(t)
			ernie := s.folder("ernie")
			s.bin = s.install(oldVersion)
			s.tweak("s1", ernie, "claim", "https://ernie.localhost")
			old := s.bridgeIs(oldVersion)

			s.bin = s.install(c.build)
			want := fmt.Sprintf("couldn't start bridge %s (%s (log: %s)); kept %s running\n", newVersion, c.why, filepath.Join(s.state, "bridge.log"), oldVersion)
			for range 2 {
				r := s.tweak("s1", ernie, "claims")
				if r.code != 0 || r.stdout != claimed(ernie) || r.stderr != want {
					t.Fatalf("exit %d, stdout %q, stderr %q\nwant stderr %q", r.code, r.stdout, r.stderr, want)
				}
				if f := s.bridgeIs(oldVersion); f.PID == old.PID {
					t.Fatal("the old bridge was never stopped")
				}
			}
			gone(t, old.PID)
		})
	}
}

// When the previous version won't start again either, the command fails
// with both errors, naming the database backup.
func TestAHandoverWithNoBridgeToKeepFailsWithBothErrors(t *testing.T) {
	s := releaseSandbox(t)
	ernie := s.folder("ernie")
	s.bin = s.install(oldVersion)
	s.tweak("s1", ernie, "claim", "https://ernie.localhost")
	old := s.bridgeIs(oldVersion)
	// The old binary is gone, and an earlier migration left a backup.
	os.RemoveAll(filepath.Join(s.state, "bin", oldVersion))
	backup := filepath.Join(s.state, "tweak.db.bak-0.9.0")
	os.WriteFile(backup, nil, 0o600)

	s.bin = s.install(newVersion + "-exit")
	r := s.tweak("s1", ernie, "claims")
	log := filepath.Join(s.state, "bridge.log")
	want := fmt.Sprintf("couldn't start bridge %s (the bridge exited as it started (log: %s)), nor %s again (couldn't start the bridge: ", newVersion, log, oldVersion)
	if r.code != 1 || !strings.HasPrefix(r.stderr, want) || !strings.HasSuffix(r.stderr, "; the database backup is "+backup+"\n") {
		t.Fatalf("exit %d, stderr %q\nwant it to start %q and name %s", r.code, r.stderr, want, backup)
	}
	gone(t, old.PID)
}

// Two sessions upgrading at once race on the port: the losing bridge exits
// quietly, and both commands carry on against the one that won.
func TestTwoCommandsHandingOverAtOnceShareTheWinner(t *testing.T) {
	s := releaseSandbox(t)
	ernie := s.folder("ernie")
	s.bin = s.install(oldVersion)
	s.tweak("s1", ernie, "claim", "https://ernie.localhost")
	old := s.bridgeIs(oldVersion)

	s.bin = s.install(newVersion)
	results := make([]result, 3)
	var wg sync.WaitGroup
	for i := range results {
		wg.Go(func() { results[i] = s.tweak("s1", ernie, "claims") })
	}
	wg.Wait()
	for _, r := range results {
		if r.code != 0 || r.stdout != claimed(ernie) || r.stderr != "" {
			t.Fatalf("exit %d, stdout %q, stderr %q", r.code, r.stdout, r.stderr)
		}
	}
	gone(t, old.PID)
	winner := s.bridgeIs(newVersion)
	time.Sleep(time.Second)
	if f := s.bridgeIs(newVersion); f.PID != winner.PID {
		t.Fatalf("the winner changed: %d, then %d", winner.PID, f.PID)
	}
}
