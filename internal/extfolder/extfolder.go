// Package extfolder writes the embedded extension to the folder Chrome loads
// it from, and keeps that folder at the binary's version (docs/design.md,
// "Installation and updates").
package extfolder

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Version is the version in an extension's manifest.json.
func Version(fsys fs.FS) (string, error) {
	raw, err := fs.ReadFile(fsys, "manifest.json")
	if err != nil {
		return "", err
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", fmt.Errorf("manifest.json: %w", err)
	}
	if m.Version == "" {
		return "", fmt.Errorf("manifest.json has no version")
	}
	return m.Version, nil
}

// Write puts the extension in src at dir, unless dir already holds the same
// version (force rewrites it anyway). The swap goes through dir.new, so
// Chrome never sees a half-written folder: the new copy is written beside
// it, the old folder is renamed aside, the new one renamed into place, and
// the old one deleted. It reports whether it wrote.
func Write(src fs.FS, dir string, force bool) (bool, error) {
	want, err := Version(src)
	if err != nil {
		return false, fmt.Errorf("the embedded extension: %w", err)
	}
	fresh, old := dir+".new", dir+".old"
	// Left by a start that died halfway.
	os.RemoveAll(fresh)
	os.RemoveAll(old)

	if !force {
		if have, err := Version(os.DirFS(dir)); err == nil && have == want {
			return false, nil
		}
	}
	if err := copyFS(src, fresh); err != nil {
		os.RemoveAll(fresh)
		return false, err
	}
	if err := os.Rename(dir, old); err != nil && !os.IsNotExist(err) {
		os.RemoveAll(fresh)
		return false, err
	}
	if err := os.Rename(fresh, dir); err != nil {
		os.Rename(old, dir) // put the old copy back
		os.RemoveAll(fresh)
		return false, err
	}
	os.RemoveAll(old)
	return true, nil
}

func copyFS(src fs.FS, to string) error {
	return fs.WalkDir(src, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(to, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		raw, err := fs.ReadFile(src, path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, raw, 0o600)
	})
}
