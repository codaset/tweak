package bridge

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/codaset/tweak/internal/config"
)

func binFolders(t *testing.T, state string) []string {
	t.Helper()
	entries, _ := os.ReadDir(filepath.Join(state, "bin"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// A starting bridge keeps the two newest version folders under bin/ (by
// number: 1.10.0 is newer than 1.9.0), leaves anything that isn't a
// version, and clears launcher downloads left behind an hour ago or more.
func TestAStartingBridgeKeepsTheTwoNewestBinaries(t *testing.T) {
	t.Parallel()
	state := t.TempDir()
	for _, v := range []string{"1.2.0", "1.9.0", "1.10.0", "1.2.3", "notes"} {
		os.MkdirAll(filepath.Join(state, "bin", v), 0o700)
		os.WriteFile(filepath.Join(state, "bin", v, "tweak"), []byte("#!/bin/sh\n"), 0o700)
	}
	stale := filepath.Join(state, "bin", "1.10.0", ".tweak.123.download")
	fresh := filepath.Join(state, "bin", "1.10.0", ".tweak.456.download")
	os.WriteFile(stale, nil, 0o600)
	os.WriteFile(fresh, nil, 0o600)
	old := time.Now().Add(-2 * time.Hour)
	os.Chtimes(stale, old, old)

	start(t, func(o *Options) { o.Config = config.Config{StateDir: state}; o.Version = "1.10.0" })

	if got, want := binFolders(t, state), []string{"1.10.0", "1.9.0", "notes"}; !slices.Equal(got, want) {
		t.Fatalf("bin/ holds %v, want %v", got, want)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Error("the stale download is still there")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("a download in progress was deleted")
	}
}

// A bridge started again after a failed handover is older than the newest
// two: it keeps its own folder, the one it runs from, as well.
func TestAnOlderBridgeKeepsItsOwnBinary(t *testing.T) {
	t.Parallel()
	state := t.TempDir()
	for _, v := range []string{"1.2.0", "1.3.0", "1.4.0"} {
		os.MkdirAll(filepath.Join(state, "bin", v), 0o700)
	}
	start(t, func(o *Options) { o.Config = config.Config{StateDir: state}; o.Version = "1.2.0" })
	if got, want := binFolders(t, state), []string{"1.2.0", "1.3.0", "1.4.0"}; !slices.Equal(got, want) {
		t.Fatalf("bin/ holds %v, want %v", got, want)
	}
}

// Nothing to prune is no failure: no bin/ folder at all.
func TestABridgeStartsWithNoBinFolder(t *testing.T) {
	t.Parallel()
	h := start(t)
	if _, err := os.Stat(filepath.Join(h.cfg.StateDir, "bin")); err == nil {
		t.Fatal("bin/ was created")
	}
}
