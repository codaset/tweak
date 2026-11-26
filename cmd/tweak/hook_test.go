package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// hookJSON is Claude Code's PreToolUse input for an edit tool, as the hooks
// reference documents it for Edit and Write. NotebookEdit's tool_input
// names the file notebook_path.
func hookJSON(session, cwd, tool string, input map[string]any) string {
	raw, _ := json.Marshal(map[string]any{
		"session_id":      session,
		"transcript_path": "/tmp/transcript.jsonl",
		"cwd":             cwd,
		"permission_mode": "default",
		"hook_event_name": "PreToolUse",
		"tool_name":       tool,
		"tool_input":      input,
		"tool_use_id":     "toolu_01",
	})
	return string(raw)
}

// subagent is hook input as a subagent's edit sends it: the parent's
// session_id, plus agent_id and agent_type.
func subagent(input string) string {
	var m map[string]any
	json.Unmarshal([]byte(input), &m)
	m["agent_id"], m["agent_type"] = "agent_7f3a", "general-purpose"
	raw, _ := json.Marshal(m)
	return string(raw)
}

// hook runs tweak hook pre-edit with stdin, checking the contract every
// time: exit 0, no output, well inside the 2-second timeout.
func (s *sandbox) hook(folder, stdin string, args ...string) {
	s.t.Helper()
	if len(args) == 0 {
		args = []string{"hook", "pre-edit"}
	}
	began := time.Now()
	r := s.tweakIn(strings.NewReader(stdin), "", folder, args...)
	if took := time.Since(began); took > 2*time.Second {
		s.t.Fatalf("tweak %v took %s", args, took)
	}
	if r.code != 0 || r.stdout != "" || r.stderr != "" {
		s.t.Fatalf("tweak %v with %q: exit %d, stdout %q, stderr %q", args, stdin, r.code, r.stdout, r.stderr)
	}
}

func TestTheEditHookRecordsBeforeCopiesWhileCapturing(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	n := ext.create("https://ernie.localhost/", "make it green")
	if r := s.tweak("s1", ernie, "work", fmt.Sprint(n)); r.code != 0 {
		t.Fatal(r.stderr)
	}

	css := filepath.Join(ernie, "app.css")
	os.WriteFile(css, []byte("red\n"), 0o644)
	s.hook(ernie, hookJSON("s1", ernie, "Edit", map[string]any{"file_path": css, "old_string": "red", "new_string": "green", "replace_all": false}))
	os.WriteFile(css, []byte("green\n"), 0o644)
	// A subagent's edit: the same session_id, with an agent_id. It counts.
	// Its path is relative, taken against cwd.
	s.hook(ernie, subagent(hookJSON("s1", ernie, "Write", map[string]any{"file_path": "new.rb", "content": "x"})))
	os.WriteFile(filepath.Join(ernie, "new.rb"), []byte("x"), 0o644)
	nb := filepath.Join(ernie, "nb.ipynb")
	os.WriteFile(nb, []byte(`{"cells": []}`), 0o644)
	s.hook(ernie, hookJSON("s1", ernie, "NotebookEdit", map[string]any{"notebook_path": nb, "cell_id": "c1", "new_source": "print(1)", "edit_mode": "replace"}))
	os.WriteFile(nb, []byte(`{"cells": [1]}`), 0o644)

	if r := s.tweak("s1", ernie, "done", fmt.Sprint(n), "made it green"); r.code != 0 {
		t.Fatal(r.stderr)
	}
	for {
		ev := ext.until("event")
		tw, _ := ev["tweak"].(map[string]any)
		if tw == nil || tw["status"] != "done" {
			continue
		}
		change, _ := tw["change"].(map[string]any)
		var got []string
		for _, f := range change["files"].([]any) {
			got = append(got, f.(map[string]any)["path"].(string))
		}
		if strings.Join(got, " ") != "app.css new.rb nb.ipynb" {
			t.Fatalf("change %v", change)
		}
		return
	}
}

// Without a marker the hook stops before contacting any bridge, and it never
// starts one. Whatever its input, it's silent and exits 0.
func TestTheEditHookIsAQuietNoOpOtherwise(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	edit := hookJSON("s1", ernie, "Edit", map[string]any{"file_path": filepath.Join(ernie, "a.css")})
	for _, stdin := range []string{"", "not json", "{}", `{"session_id": 3}`, edit} {
		s.hook(ernie, stdin)
	}
	s.hook(ernie, edit, "hook", "session-start") // a hook this binary doesn't know
	s.hook(ernie, edit, "hook")

	// A marker left behind with no bridge running: still nothing.
	marker := filepath.Join(s.state, "capturing", "s1")
	os.MkdirAll(filepath.Dir(marker), 0o700)
	os.WriteFile(marker, []byte("1\n"), 0o600)
	s.hook(ernie, edit)
	if _, ok := s.bridgeFile(); ok {
		t.Fatal("the hook started a bridge")
	}
}

// During a handover (the handover file there, the bridge restarting) the
// edit hook waits up to 3 seconds for the new bridge, so the edit keeps its
// before copy. A handover file left behind by a command that died is old,
// and the hook gives up in its usual time.
func TestTheEditHookWaitsForABridgeMidHandover(t *testing.T) {
	s := newSandbox(t)
	ernie := s.folder("ernie")
	s.tweak("s1", ernie, "claim", "https://ernie.localhost/*")
	ext := s.extension()
	n := ext.create("https://ernie.localhost/", "make it green")
	if r := s.tweak("s1", ernie, "work", fmt.Sprint(n)); r.code != 0 {
		t.Fatal(r.stderr)
	}
	css := filepath.Join(ernie, "app.css")
	os.WriteFile(css, []byte("red\n"), 0o644)
	edit := hookJSON("s1", ernie, "Edit", map[string]any{"file_path": css, "old_string": "red", "new_string": "green"})

	// A handover file from a command that died a minute ago: no wait.
	handover := filepath.Join(s.state, "handover")
	os.WriteFile(handover, []byte("1\n"), 0o600)
	old := time.Now().Add(-time.Minute)
	os.Chtimes(handover, old, old)
	ext.c.CloseNow()
	s.stopBridge()
	s.hook(ernie, edit)
	if _, ok := s.bridgeFile(); ok {
		t.Fatal("the hook started a bridge")
	}

	// A handover under way: the bridge is back a second later.
	os.WriteFile(handover, []byte("1\n"), 0o600)
	go func() {
		time.Sleep(time.Second)
		s.tweak("", ernie, "claims")
	}()
	began := time.Now()
	r := s.tweakIn(strings.NewReader(edit), "", ernie, "hook", "pre-edit")
	if took := time.Since(began); r.code != 0 || r.stdout != "" || r.stderr != "" || took > 4*time.Second || took < time.Second {
		t.Fatalf("exit %d, stdout %q, stderr %q, after %s", r.code, r.stdout, r.stderr, took)
	}
	os.Remove(handover)
	os.WriteFile(css, []byte("green\n"), 0o644)

	ext = s.extension()
	if r := s.tweak("s1", ernie, "done", fmt.Sprint(n), "made it green"); r.code != 0 {
		t.Fatal(r.stderr)
	}
	for {
		ev := ext.until("event")
		tw, _ := ev["tweak"].(map[string]any)
		if tw == nil || tw["status"] != "done" {
			continue
		}
		change, _ := tw["change"].(map[string]any)
		files, _ := change["files"].([]any)
		if len(files) != 1 || files[0].(map[string]any)["path"] != "app.css" {
			t.Fatalf("change %v", change)
		}
		return
	}
}

// A hook whose stdin never closes still exits in time.
func TestTheEditHookNeverHangs(t *testing.T) {
	s := newSandbox(t)
	cmd := exec.Command(tweakBin, "hook", "pre-edit")
	cmd.Env = s.env()
	stdin, _ := cmd.StdinPipe()
	defer stdin.Close()
	stdin.Write([]byte(`{"session_id": "s1", "tool_input": {`))
	began := time.Now()
	out, err := cmd.Output()
	if err != nil || len(out) != 0 || time.Since(began) > 2*time.Second {
		t.Fatalf("exit %v, stdout %q, after %s", err, out, time.Since(began))
	}
}
