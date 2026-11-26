// Package capture is what undo capture reads from disk (docs/design.md,
// "Capture"): a file's contents as a before or after copy, whether a path is
// inside the project, and the git check, which records the working tree
// into a temporary index and later lists what changed since.
package capture

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/codaset/tweak/internal/config"
)

// MaxText is the largest file recorded: anything bigger counts as unrecorded.
const MaxText = 2 << 20

// File is a file's contents as capture reads them: absent (it doesn't exist),
// text (Data holds it), or neither, when it can't be recorded (binary, over
// 2 MB, not a regular file, or unreadable).
type File struct {
	Absent bool
	Text   bool
	Data   []byte
}

// Read reads path as a before or after copy. Only a regular file is opened,
// so a FIFO or a device can't hang the bridge.
func Read(path string) File {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return File{Absent: true}
	}
	if err == nil && info.Mode()&fs.ModeSymlink != 0 {
		info, err = os.Stat(path)
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxText {
		return File{}
	}
	f, err := os.Open(path)
	if err != nil {
		return File{}
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxText+1))
	if err != nil || len(data) > MaxText || !isText(data) {
		return File{}
	}
	return File{Text: true, Data: data}
}

// isText is git's rule: a file with no NUL byte is text, whatever its
// encoding (a Latin-1 file is text too).
func isText(data []byte) bool {
	return bytes.IndexByte(data, 0) < 0
}

// Within reports whether path is inside folder, once symlinks are resolved,
// and its path relative to folder if so.
func Within(folder, path string) (rel string, inside bool) {
	r, err := filepath.Rel(config.Canonical(folder), config.Canonical(path))
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) || filepath.IsAbs(r) {
		return "", false
	}
	return filepath.ToSlash(r), true
}

// Tree is the working tree recorded by Snapshot: the repo's top folder and
// the tree's hash. A zero Tree means no git check (no repo, or no git).
type Tree struct {
	Repo string
	Hash string
}

// gitTimeout bounds each git command, so a stuck one can't hold capture up.
const gitTimeout = 20 * time.Second

// Snapshot records the working tree of the repo holding folder into a
// temporary index, seeded from a copy of the repo's own index, under
// scratch: GIT_INDEX_FILE, then git add -A and git write-tree. The repo's
// files and staging area are untouched; the blobs land in its object store,
// as git stash's would. Outside a repo, or without git, it returns a zero
// Tree and no error.
func Snapshot(folder, scratch string) (Tree, error) {
	top, err := gitOut(folder, nil, "rev-parse", "--show-toplevel")
	if err != nil {
		return Tree{}, nil // not a repo, or no git: the check is skipped
	}
	hash, err := writeTree(top, scratch)
	if err != nil {
		return Tree{}, err
	}
	return Tree{Repo: top, Hash: hash}, nil
}

// Changed lists, as absolute paths, the files that differ between the tree
// Snapshot recorded and the working tree now. A zero Tree lists nothing.
func Changed(base Tree, scratch string) ([]string, error) {
	if base.Hash == "" {
		return nil, nil
	}
	now, err := writeTree(base.Repo, scratch)
	if err != nil {
		return nil, err
	}
	out, err := gitOut(base.Repo, nil, "diff-tree", "-r", "-z", "--name-only", "--no-renames", base.Hash, now)
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, filepath.Join(base.Repo, filepath.FromSlash(p)))
		}
	}
	return paths, nil
}

// Differs reports whether a before copy differs from what the snapshot t
// had at path, as git sees it: the copy is hashed through the repo's own
// filters (eol normalization, clean filters), so a CRLF file stored as LF
// still matches. A file the snapshot lacks matches only an absent copy,
// unless git ignores it or it's in a nested repo (never snapshotted): then
// it's unknown, as it is
// outside the repo, with no snapshot, or if git fails.
func Differs(t Tree, path string, f File) (differs, known bool) {
	rel, inside := Within(t.Repo, path)
	if t.Hash == "" || !inside || strings.ContainsAny(rel, "\n\r") {
		return false, false
	}
	then, err := gitOut(t.Repo, nil, "rev-parse", "--verify", "--quiet", t.Hash+":"+rel)
	if err != nil {
		then = "" // not in the snapshot
	}
	if then == "" && !f.Absent {
		// An ignored file is never in a snapshot, nor is a file in a nested
		// repo (a submodule: the snapshot holds only its gitlink). Either
		// way its absence says nothing.
		if _, err := gitOut(t.Repo, nil, "check-ignore", "-q", "--", rel); err == nil {
			return false, false
		}
		dir := filepath.Dir(path)
		for _, err := os.Stat(dir); err != nil && dir != filepath.Dir(dir); _, err = os.Stat(dir) {
			dir = filepath.Dir(dir) // the nearest folder that exists
		}
		if top, err := gitOut(dir, nil, "rev-parse", "--show-toplevel"); err != nil || config.Canonical(top) != config.Canonical(t.Repo) {
			return false, false
		}
	}
	if f.Absent || then == "" {
		return f.Absent != (then == ""), true
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "hash-object", "--stdin", "--path="+rel)
	cmd.Dir = t.Repo
	cmd.Env = cleanEnv()
	cmd.Stdin = bytes.NewReader(f.Data)
	out, err := cmd.Output()
	if err != nil {
		return false, false
	}
	return strings.TrimSpace(string(out)) != then, true
}

// writeTree adds the whole working tree to a temporary index, a copy of the
// repo's, and writes it as a tree.
func writeTree(top, scratch string) (string, error) {
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(scratch, "git-index-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	index := filepath.Join(dir, "index")
	own, err := gitOut(top, nil, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return "", err
	}
	if err := copyFile(own, index); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err // a repo with no index yet starts from an empty one
	}
	env := []string{"GIT_INDEX_FILE=" + index}
	add := []string{"add", "-A"}
	// A state folder inside the repo (the temporary index, the database)
	// is never part of the working tree the check compares.
	if rel, inside := Within(top, scratch); inside && rel != "." {
		add = append(add, "--", ".", ":(exclude,literal)"+rel)
	}
	if _, err := gitOut(top, env, add...); err != nil {
		return "", err
	}
	return gitOut(top, env, "write-tree")
}

// copyFile copies the repo's index, keeping its modification time: git
// trusts an entry's cached stat only when the file is older than the index,
// so a copy stamped "now" would hide an edit made in the same clock tick as
// the index was written (racy git) and snapshot the old contents.
func copyFile(from, to string) error {
	info, err := os.Stat(from)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	if err := os.WriteFile(to, raw, 0o600); err != nil {
		return err
	}
	return os.Chtimes(to, info.ModTime(), info.ModTime())
}

// gitOut runs git in dir and returns its trimmed stdout. It runs with none
// of the caller's repo-choosing variables, and no fsmonitor daemon.
func gitOut(dir string, env []string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.fsmonitor=false", "-c", "core.quotepath=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(cleanEnv(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimRight(string(out), "\n"), nil
}

// cleanEnv is the environment without the variables that would point git
// at another repo, work tree or index.
func cleanEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		switch name, _, _ := strings.Cut(kv, "="); name {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX":
		default:
			out = append(out, kv)
		}
	}
	return out
}
