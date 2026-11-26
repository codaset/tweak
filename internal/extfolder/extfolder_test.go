package extfolder

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func extension(version, worker string) fstest.MapFS {
	return fstest.MapFS{
		"manifest.json":  {Data: []byte(`{"name": "Codaset Tweak", "version": "` + version + `"}`)},
		"worker.js":      {Data: []byte(worker)},
		"lib/claims.js":  {Data: []byte("export {};")},
		"panel/panel.js": {Data: []byte("// panel")},
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestWritesTheFolderWhenMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "extension")
	wrote, err := Write(extension("1.2.0", "// new"), dir, false)
	if err != nil || !wrote {
		t.Fatalf("Write = %v, %v; want written", wrote, err)
	}
	if got := read(t, filepath.Join(dir, "worker.js")); got != "// new" {
		t.Fatalf("worker.js = %q", got)
	}
	if got := read(t, filepath.Join(dir, "lib", "claims.js")); got != "export {};" {
		t.Fatalf("lib/claims.js = %q", got)
	}
}

func TestRewritesTheFolderWhenTheVersionDiffers(t *testing.T) {
	state := t.TempDir()
	dir := filepath.Join(state, "extension")
	Write(extension("1.1.0", "// old"), dir, false)
	os.WriteFile(filepath.Join(dir, "stray.js"), []byte("left from 1.1.0"), 0o600)

	wrote, err := Write(extension("1.2.0", "// new"), dir, false)
	if err != nil || !wrote {
		t.Fatalf("Write = %v, %v; want written", wrote, err)
	}
	if got := read(t, filepath.Join(dir, "worker.js")); got != "// new" {
		t.Fatalf("worker.js = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "stray.js")); !os.IsNotExist(err) {
		t.Fatal("a file from the old version survived")
	}
	// Only the folder itself is left beside the database: no .new or old copy.
	entries, _ := os.ReadDir(state)
	if len(entries) != 1 || entries[0].Name() != "extension" {
		t.Fatalf("state folder holds %v", entries)
	}
}

func TestLeavesTheFolderAloneAtTheSameVersion(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "extension")
	Write(extension("1.2.0", "// first"), dir, false)
	wrote, err := Write(extension("1.2.0", "// second"), dir, false)
	if err != nil || wrote {
		t.Fatalf("Write = %v, %v; want left alone", wrote, err)
	}
	if got := read(t, filepath.Join(dir, "worker.js")); got != "// first" {
		t.Fatalf("worker.js = %q", got)
	}
}

// An unstamped build carries files that change under one version number.
func TestAlwaysRewritesWhenForced(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "extension")
	Write(extension("1.2.0", "// first"), dir, false)
	if wrote, err := Write(extension("1.2.0", "// second"), dir, true); err != nil || !wrote {
		t.Fatalf("Write = %v, %v; want written", wrote, err)
	}
	if got := read(t, filepath.Join(dir, "worker.js")); got != "// second" {
		t.Fatalf("worker.js = %q", got)
	}
}

// A start that died halfway leaves extension.new and the set-aside copy.
func TestClearsWhatAnInterruptedWriteLeft(t *testing.T) {
	state := t.TempDir()
	dir := filepath.Join(state, "extension")
	Write(extension("1.1.0", "// old"), dir, false)
	for _, d := range []string{dir + ".new", dir + ".old"} {
		os.MkdirAll(d, 0o700)
		os.WriteFile(filepath.Join(d, "junk.js"), []byte("junk"), 0o600)
	}
	if _, err := Write(extension("1.2.0", "// new"), dir, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "junk.js")); !os.IsNotExist(err) {
		t.Fatal("the half-written folder's files were moved into place")
	}
	entries, _ := os.ReadDir(state)
	if len(entries) != 1 {
		t.Fatalf("state folder holds %v", entries)
	}
}

func TestVersionReadsTheManifest(t *testing.T) {
	v, err := Version(extension("3.4.5", ""))
	if err != nil || v != "3.4.5" {
		t.Fatalf("Version = %q, %v", v, err)
	}
	if _, err := Version(fstest.MapFS{}); err == nil {
		t.Fatal("no manifest should be an error")
	}
}
