package bridge

import (
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/codaset/tweak/internal/version"
)

// keptBinaries is how many version folders under bin/ a starting bridge
// keeps: old sessions' launchers still run the previous one until
// /reload-plugins, and a failed handover starts it again.
const keptBinaries = 2

// staleDownload is how long a launcher's temporary download may go
// unwritten before a starting bridge deletes it as left behind.
const staleDownload = time.Hour

// pruneBinaries keeps the newest version folders under bin/, and this
// bridge's own, and deletes the rest and any launcher download left behind
// in the kept ones (docs/design.md, "Old binaries"). A folder whose name
// isn't a version is left alone. Failures are ignored (Windows can't delete
// a running .exe): the next start tries again.
func (b *Bridge) pruneBinaries() {
	dir := filepath.Join(b.opts.Config.StateDir, "bin")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var versions []string
	for _, e := range entries {
		if _, ok := version.Parse(e.Name()); ok && e.IsDir() {
			versions = append(versions, e.Name())
		}
	}
	slices.SortFunc(versions, func(a, c string) int {
		switch {
		case version.Older(c, a):
			return -1 // newest first
		case version.Older(a, c):
			return 1
		}
		return 0
	})
	for i, v := range versions {
		folder := filepath.Join(dir, v)
		if i >= keptBinaries && v != b.opts.Version {
			os.RemoveAll(folder)
			continue
		}
		downloads, _ := filepath.Glob(filepath.Join(folder, ".tweak.*.download"))
		for _, d := range downloads {
			if info, err := os.Stat(d); err == nil && time.Since(info.ModTime()) >= staleDownload {
				os.Remove(d)
			}
		}
	}
}
