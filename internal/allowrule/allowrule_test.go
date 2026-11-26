package allowrule

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type place struct {
	t         *testing.T
	home, dir string
	env       map[string]string
}

func newPlace(t *testing.T) *place {
	root := t.TempDir()
	p := &place{t: t, home: filepath.Join(root, "home"), dir: filepath.Join(root, "home", "dev", "app"), env: map[string]string{}}
	os.MkdirAll(p.dir, 0o700)
	return p
}

func (p *place) write(path, body string) {
	p.t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		p.t.Fatal(err)
	}
}

func (p *place) present() bool {
	return Present(func(k string) string { return p.env[k] }, p.home, p.dir)
}

func allow(rules ...string) string {
	s := `{"permissions":{"allow":[`
	for i, r := range rules {
		if i > 0 {
			s += ","
		}
		s += `"` + r + `"`
	}
	return s + `]}}`
}

func TestNoSettingsMeansNoRule(t *testing.T) {
	if newPlace(t).present() {
		t.Fatal("present with no settings files")
	}
}

func TestTheUserSettingsFileGivesTheRule(t *testing.T) {
	p := newPlace(t)
	p.write(filepath.Join(p.home, ".claude", "settings.json"), allow("Bash(tweak *)"))
	if !p.present() {
		t.Fatal("not present")
	}
}

// CLAUDE_CONFIG_DIR moves the user settings: ~/.claude is then not read.
func TestClaudeConfigDirMovesTheUserSettings(t *testing.T) {
	p := newPlace(t)
	p.env["CLAUDE_CONFIG_DIR"] = filepath.Join(p.home, "elsewhere")
	p.write(filepath.Join(p.home, ".claude", "settings.json"), allow("Bash(tweak *)"))
	if p.present() {
		t.Fatal("read ~/.claude with CLAUDE_CONFIG_DIR set")
	}
	p.write(filepath.Join(p.home, "elsewhere", "settings.json"), allow("Bash(tweak *)"))
	if !p.present() {
		t.Fatal("CLAUDE_CONFIG_DIR's settings.json not read")
	}
}

// The shared project file and the local file are read from the session's
// folder, and their lists merge with the user's.
func TestTheProjectAndLocalFilesGiveTheRule(t *testing.T) {
	for _, name := range []string{"settings.json", "settings.local.json"} {
		p := newPlace(t)
		p.write(filepath.Join(p.home, ".claude", "settings.json"), allow("Bash(npm *)"))
		p.write(filepath.Join(p.dir, ".claude", name), allow("Bash(tweak *)"))
		if !p.present() {
			t.Errorf("%s not read", name)
		}
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// In a git repo, Claude Code keeps the local file at the repo root, and for
// a worktree at the main checkout's root. The shared file is read from the
// session's folder only.
func TestInAGitRepoTheLocalFileIsAtTheRoot(t *testing.T) {
	p := newPlace(t)
	git(t, p.dir, "init", "-q")
	sub := filepath.Join(p.dir, "web")
	os.MkdirAll(sub, 0o700)

	p.write(filepath.Join(p.dir, ".claude", "settings.json"), allow("Bash(tweak *)"))
	if Present(func(string) string { return "" }, p.home, sub) {
		t.Error("the shared file was read from the repo root")
	}
	p.write(filepath.Join(p.dir, ".claude", "settings.local.json"), allow("Bash(tweak *)"))
	if !Present(func(string) string { return "" }, p.home, sub) {
		t.Error("the local file at the repo root not read from a subfolder")
	}

	git(t, p.dir, "commit", "-q", "--allow-empty", "-m", "start")
	wt := filepath.Join(p.home, "dev", "app-wt")
	git(t, p.dir, "worktree", "add", "-q", wt)
	if !Present(func(string) string { return "" }, p.home, filepath.Join(wt)) {
		t.Error("a worktree didn't read the main checkout's local file")
	}
}

// The permissions docs: `Bash(tweak:*)` is the same as `Bash(tweak *)`, and
// `Bash(*)` is the same as `Bash`, which allows every command.
func TestRulesThatCoverEveryTweakCommand(t *testing.T) {
	for rule, want := range map[string]bool{
		"Bash(tweak *)":       true,
		"Bash(tweak:*)":       true,
		"Bash":                true,
		"Bash(*)":             true,
		"Bash(tweak claim *)": false,
		"Bash(tweak)":         false,
		"Bash(tweaks *)":      false,
		"Bash(npm *)":         false,
		"Monitor":             false,
		"bash(tweak *)":       false,
	} {
		p := newPlace(t)
		p.write(filepath.Join(p.home, ".claude", "settings.json"), allow("Bash(npm test)", rule))
		if got := p.present(); got != want {
			t.Errorf("%s: present = %v, want %v", rule, got, want)
		}
	}
}

// A deny or ask list doesn't count as allowing, and a broken file is skipped.
func TestOnlyTheAllowListOfAWellFormedFileCounts(t *testing.T) {
	for name, body := range map[string]string{
		"deny":          `{"permissions":{"deny":["Bash(tweak *)"]}}`,
		"ask":           `{"permissions":{"ask":["Bash(tweak *)"]}}`,
		"top level":     `{"allow":["Bash(tweak *)"]}`,
		"trailing ,":    `{"permissions":{"allow":["Bash(tweak *)",]}}`,
		"allow string":  `{"permissions":{"allow":"Bash(tweak *)"}}`,
		"empty":         ``,
		"not an object": `["Bash(tweak *)"]`,
	} {
		p := newPlace(t)
		p.write(filepath.Join(p.home, ".claude", "settings.json"), body)
		if p.present() {
			t.Errorf("%s: present", name)
		}
	}
	p := newPlace(t)
	p.write(filepath.Join(p.home, ".claude", "settings.json"), `{"permissions":{"allow":[3,null,"Bash(tweak *)"]}}`)
	if !p.present() {
		t.Error("a non-string entry hid the rule after it")
	}
}

// Settings are only read: a file's bytes and modification time stay, and no
// file or folder is created where there was none.
func TestSettingsAreNeverWritten(t *testing.T) {
	p := newPlace(t)
	git(t, p.dir, "init", "-q")
	user := filepath.Join(p.home, ".claude", "settings.json")
	p.write(user, `{"permissions":{"allow":["Bash(npm *)"]}, "theme": "dark"}`)
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	os.Chtimes(user, old, old)
	before, _ := os.ReadFile(user)

	if p.present() {
		t.Fatal("present")
	}
	after, _ := os.ReadFile(user)
	info, _ := os.Stat(user)
	if string(after) != string(before) || !info.ModTime().Equal(old) {
		t.Errorf("the user settings changed: %q, %v", after, info.ModTime())
	}
	if _, err := os.Stat(filepath.Join(p.dir, ".claude")); !os.IsNotExist(err) {
		t.Errorf("the project's .claude folder was created: %v", err)
	}
}
