package capture

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
)

func write(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadTellsTextFromAbsentAndUnrecordable(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.css"), ".a { color: red }\n")
	write(t, filepath.Join(dir, "empty.txt"), "")
	write(t, filepath.Join(dir, "latin1.txt"), "caf\xe9\n")
	write(t, filepath.Join(dir, "logo.png"), "\x89PNG\r\n\x1a\n\x00\x00")
	write(t, filepath.Join(dir, "big.txt"), strings.Repeat("x", MaxText+1))
	write(t, filepath.Join(dir, "limit.txt"), strings.Repeat("x", MaxText))
	if err := syscall.Mkfifo(filepath.Join(dir, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		want File
	}{
		{"a.css", File{Text: true, Data: []byte(".a { color: red }\n")}},
		{"empty.txt", File{Text: true, Data: []byte{}}},
		{"latin1.txt", File{Text: true, Data: []byte("caf\xe9\n")}},
		{"missing.txt", File{Absent: true}},
		{"logo.png", File{}},
		{"big.txt", File{}},
		{"pipe", File{}}, // never opened, so the bridge can't hang on it
		{".", File{}},    // a folder
	}
	for _, c := range cases {
		got := Read(filepath.Join(dir, c.name))
		if got.Text != c.want.Text || got.Absent != c.want.Absent || !bytes.Equal(got.Data, c.want.Data) {
			t.Errorf("%s: got %+v", c.name, got)
		}
	}
	if got := Read(filepath.Join(dir, "limit.txt")); !got.Text || len(got.Data) != MaxText {
		t.Errorf("a file of exactly 2 MB is text: %v, %d", got.Text, len(got.Data))
	}
}

func TestWithinSeesThroughSymlinks(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(real, "src", "a.rb"), "")
	for _, c := range []struct {
		folder, path, rel string
		inside            bool
	}{
		{link, filepath.Join(real, "src", "a.rb"), "src/a.rb", true},
		{real, filepath.Join(link, "src", "a.rb"), "src/a.rb", true},
		{link, filepath.Join(link, "src", "new.rb"), "src/new.rb", true}, // not created yet
		{real, filepath.Join(filepath.Dir(real), "other", "b.rb"), "", false},
		{real, real + "-sibling/c.rb", "", false},
	} {
		rel, inside := Within(c.folder, c.path)
		if rel != c.rel || inside != c.inside {
			t.Errorf("Within(%s, %s) = %q, %v", c.folder, c.path, rel, inside)
		}
	}
}

// git runs git in dir, failing the test on an error.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(cleanEnv(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func needGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
}

// repo is a git repo with a commit, a staged change, an unstaged change
// and an untracked file: everything the developer's staging area can hold.
func repo(t *testing.T) string {
	needGit(t)
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	write(t, filepath.Join(dir, "app.css"), "a\n")
	write(t, filepath.Join(dir, "staged.rb"), "one\n")
	write(t, filepath.Join(dir, "unstaged.rb"), "one\n")
	write(t, filepath.Join(dir, ".gitignore"), "log/\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "first")
	write(t, filepath.Join(dir, "staged.rb"), "two\n")
	git(t, dir, "add", "staged.rb")
	write(t, filepath.Join(dir, "unstaged.rb"), "two\n")
	write(t, filepath.Join(dir, "untracked.rb"), "new\n")
	return dir
}

func indexState(t *testing.T, dir string) string {
	raw, err := os.ReadFile(filepath.Join(dir, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	// --no-optional-locks: status itself mustn't refresh the index.
	return string(raw) + "\n--\n" + git(t, dir, "--no-optional-locks", "status", "--porcelain")
}

func TestTheGitCheckNeverTouchesTheRepositorysIndex(t *testing.T) {
	dir := repo(t)
	before := indexState(t, dir)

	base, err := Snapshot(filepath.Join(dir), t.TempDir())
	if err != nil || base.Hash == "" {
		t.Fatalf("snapshot %+v, %v", base, err)
	}
	write(t, filepath.Join(dir, "app.css"), "b\n")
	if _, err := Changed(base, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "app.css"), "a\n")

	if after := indexState(t, dir); after != before {
		t.Fatalf("the index or the staging area changed:\n%s\nnow\n%s", before, after)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "index.lock")); !os.IsNotExist(err) {
		t.Fatalf("index.lock left behind: %v", err)
	}
}

func TestTheGitCheckListsWhatChangedSinceTheSnapshot(t *testing.T) {
	dir := repo(t)
	scratch := t.TempDir()
	// From a subfolder: the whole repo is checked.
	write(t, filepath.Join(dir, "web", "index.html"), "<p>\n")
	base, err := Snapshot(filepath.Join(dir, "web"), scratch)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "app.css"), "b\n")            // tracked, edited
	write(t, filepath.Join(dir, "untracked.rb"), "newer\n")   // untracked, edited
	write(t, filepath.Join(dir, "web", "fresh.js"), "x\n")    // created
	os.Remove(filepath.Join(dir, "unstaged.rb"))              // deleted
	write(t, filepath.Join(dir, "log", "dev.log"), "ignored") // ignored

	got, err := Changed(base, scratch)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	root := base.Repo
	want := []string{filepath.Join(root, "app.css"), filepath.Join(root, "unstaged.rb"), filepath.Join(root, "untracked.rb"), filepath.Join(root, "web", "fresh.js")}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("changed:\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if entries, _ := os.ReadDir(scratch); len(entries) != 0 {
		t.Fatalf("temporary indexes left behind: %v", entries)
	}
}

// Whether a before copy differs from the snapshot, as git sees it: through
// the repo's own filters, so a CRLF file under eol normalization matches;
// a file the snapshot lacks matches only an absent copy; outside the repo,
// unknown.
func TestABeforeCopyIsComparedAsGitSeesIt(t *testing.T) {
	dir := repo(t)
	write(t, filepath.Join(dir, ".gitattributes"), "*.txt text eol=crlf\n")
	write(t, filepath.Join(dir, "notes.txt"), "before\r\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "crlf")
	base, err := Snapshot(dir, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at := func(name string) string { return filepath.Join(base.Repo, name) }
	text := func(s string) File { return File{Text: true, Data: []byte(s)} }
	cases := []struct {
		name           string
		path           string
		copy           File
		differs, known bool
	}{
		{"unchanged", at("app.css"), text("a\n"), false, true},
		{"shell-edited", at("app.css"), text("sed\n"), true, true},
		{"crlf, normalized by git", at("notes.txt"), text("before\r\n"), false, true},
		{"untracked, in the snapshot too", at("untracked.rb"), text("new\n"), false, true},
		{"new, and new in the snapshot", at("web/new.js"), File{Absent: true}, false, true},
		{"created before the hook", at("web/new.js"), text("x\n"), true, true},
		{"deleted before the hook", at("app.css"), File{Absent: true}, true, true},
		{"outside the repo", filepath.Join(t.TempDir(), "x.css"), text("x"), false, false},
	}
	for _, c := range cases {
		differs, known := Differs(base, c.path, c.copy)
		if differs != c.differs || known != c.known {
			t.Errorf("%s: differs %v, known %v", c.name, differs, known)
		}
	}
	if _, known := Differs(Tree{}, at("app.css"), text("a\n")); known {
		t.Error("with no snapshot, nothing is known")
	}
}

// A state folder inside the repo (TWEAK_STATE_DIR may point there) holds
// the temporary indexes and the database: the check leaves it all out.
func TestAStateFolderInsideTheRepoIsLeftOut(t *testing.T) {
	dir := repo(t)
	state := filepath.Join(dir, "tweak-state")
	write(t, filepath.Join(state, "tweak.db"), "one")
	base, err := Snapshot(dir, state)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(state, "tweak.db"), "two")
	got, err := Changed(base, state)
	if err != nil || len(got) != 0 {
		t.Fatalf("changed %v, %v", got, err)
	}
}

func TestTheGitCheckWorksInARepoWithNoCommitsOrIndex(t *testing.T) {
	needGit(t)
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	write(t, filepath.Join(dir, "a.txt"), "a\n")
	base, err := Snapshot(dir, t.TempDir())
	if err != nil || base.Hash == "" {
		t.Fatalf("%+v %v", base, err)
	}
	write(t, filepath.Join(dir, "a.txt"), "b\n")
	got, err := Changed(base, t.TempDir())
	if err != nil || len(got) != 1 || filepath.Base(got[0]) != "a.txt" {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "index")); !os.IsNotExist(err) {
		t.Fatal("the check created the repo's index")
	}
}

func TestOutsideAGitRepoTheCheckIsSkipped(t *testing.T) {
	needGit(t)
	dir := t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))
	base, err := Snapshot(dir, t.TempDir())
	if err != nil || base.Hash != "" {
		t.Fatalf("got %+v, %v", base, err)
	}
	if got, err := Changed(base, t.TempDir()); err != nil || got != nil {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestAnInheritedGitEnvironmentIsIgnored(t *testing.T) {
	dir := repo(t)
	other := repo(t)
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_INDEX_FILE", filepath.Join(other, ".git", "index"))
	t.Setenv("GIT_WORK_TREE", other)
	base, err := Snapshot(dir, t.TempDir())
	if err != nil || Canonical(base.Repo) != Canonical(dir) {
		t.Fatalf("got %+v, %v", base, err)
	}
}
