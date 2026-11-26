// Package capture is what undo capture reads from disk (docs/design.md,
// "Capture"): a file's contents as a before or after copy, whether a path is
// inside the project, and the git check, which records the working tree
// into a temporary index and later lists what changed since.
package capture

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// Canonical is path with its symlinks resolved, as far as it exists.
func Canonical(path string) string { return config.Canonical(path) }

// Within reports whether path is inside folder, once symlinks are resolved,
// and its path relative to folder if so.
func Within(folder, path string) (rel string, inside bool) {
	r, err := filepath.Rel(Canonical(folder), Canonical(path))
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

// SnapshotOf gives each path's contents as the snapshot t recorded them,
// keyed by path: absent when the snapshot has no such file. A path outside
// the repo (or with a newline in it), or any path with no snapshot, is
// left out: unknown.
func SnapshotOf(t Tree, paths []string) (map[string]File, error) {
	out := map[string]File{}
	if t.Hash == "" {
		return out, nil
	}
	var asked []string
	var input strings.Builder
	for _, p := range paths {
		rel, inside := Within(t.Repo, p)
		if !inside || strings.ContainsAny(rel, "\n\r") {
			continue
		}
		asked = append(asked, p)
		fmt.Fprintf(&input, "%s:%s\n", t.Hash, rel)
	}
	if len(asked) == 0 {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "cat-file", "--batch")
	cmd.Dir = t.Repo
	cmd.Env = cleanEnv()
	cmd.Stdin = strings.NewReader(input.String())
	raw, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git cat-file: %v", err)
	}
	r := bufio.NewReader(bytes.NewReader(raw))
	for _, p := range asked {
		head, err := r.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("git cat-file: short output")
		}
		fields := strings.Fields(head)
		if len(fields) == 3 && fields[1] == "blob" {
			size, _ := strconv.Atoi(fields[2])
			data := make([]byte, size)
			if _, err := io.ReadFull(r, data); err != nil {
				return nil, fmt.Errorf("git cat-file: short output")
			}
			r.ReadByte() // the newline after the contents
			out[p] = File{Text: size <= MaxText && isText(data), Data: data}
		} else {
			out[p] = File{Absent: true} // missing, or not a file
		}
	}
	return out, nil
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

func copyFile(from, to string) error {
	raw, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, raw, 0o600)
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
