// Package atomicfile writes a file that appears whole or not at all.
package atomicfile

import (
	"io/fs"
	"os"
	"path/filepath"
)

// rename is os.Rename; a test cuts it off.
var rename = os.Rename

// Write writes data to path with mode perm: to a temporary dot-file beside
// it first (which readers of a folder of markers skip), then renamed into
// place, replacing any file there. On failure path is as it was and the
// temporary file is gone. The folder must exist.
func Write(path string, data []byte, perm fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tweak-tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone once renamed
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return rename(tmp.Name(), path)
}
