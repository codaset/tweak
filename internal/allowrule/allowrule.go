// Package allowrule tells whether Claude Code's settings allow `tweak`
// commands without a prompt: the allow rule `Bash(tweak *)` that `tweak claim`
// warns about (design.md § Claude's side). It only reads settings files.
package allowrule

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Rule is the allow rule the /tweak skill offers to add.
const Rule = "Bash(tweak *)"

// Present reports whether any settings file Claude Code reads for a session
// in dir allows every `tweak` command. home is the user's home folder.
func Present(getenv func(string) string, home, dir string) bool {
	for _, f := range files(getenv, home, dir) {
		for _, r := range allowList(f) {
			if covers(r) {
				return true
			}
		}
	}
	return false
}

// files lists the settings files whose permissions.allow lists Claude Code
// merges (code.claude.com/docs/en/settings): the user's, the shared project
// file in the session's folder, and the local file, which in a git repo lives
// at the root (a worktree's is the main checkout's). Claude Code also still
// reads a local file left in the session's folder by versions before 2.1.211.
// Managed settings, --settings and workspace trust aren't checked.
func files(getenv func(string) string, home, dir string) []string {
	user := filepath.Join(home, ".claude")
	if d := getenv("CLAUDE_CONFIG_DIR"); d != "" {
		user = d
	}
	fs := []string{
		filepath.Join(user, "settings.json"),
		filepath.Join(dir, ".claude", "settings.json"),
		filepath.Join(dir, ".claude", "settings.local.json"),
	}
	if root := mainCheckout(dir); root != "" {
		fs = append(fs, filepath.Join(root, ".claude", "settings.local.json"))
	}
	return fs
}

// mainCheckout is the root of the git repo holding dir, the main checkout's
// for a worktree, or "" outside a repo.
func mainCheckout(dir string) string {
	cmd := exec.Command("git", "rev-parse", "--path-format=absolute", "--git-common-dir")
	cmd.Dir = dir
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	common := strings.TrimSpace(string(out))
	if filepath.Base(common) != ".git" {
		return "" // a bare repo, or a git folder kept elsewhere
	}
	return filepath.Dir(common)
}

// allowList is a file's permissions.allow. A missing, unreadable or malformed
// file has none, as Claude Code skips a broken settings file.
func allowList(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s struct {
		Permissions struct {
			Allow []json.RawMessage `json:"allow"`
		} `json:"permissions"`
	}
	if json.Unmarshal(b, &s) != nil {
		return nil
	}
	var rules []string
	for _, raw := range s.Permissions.Allow {
		var r string
		if json.Unmarshal(raw, &r) == nil {
			rules = append(rules, r)
		}
	}
	return rules
}

// covers reports whether an allow rule matches every `tweak` command: the
// rule itself, its `:*` spelling, or a rule allowing every Bash command.
// Other wildcards aren't matched; the warning then asks for the plain rule.
func covers(rule string) bool {
	switch rule {
	case Rule, "Bash(tweak:*)", "Bash", "Bash(*)":
		return true
	}
	return false
}
