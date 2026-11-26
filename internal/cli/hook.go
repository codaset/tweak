package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/config"
)

// The hooks Claude Code runs (docs/design.md, "Capture"): tweak hook
// pre-edit, the PreToolUse hook on Edit, Write and NotebookEdit. A hook
// prints nothing and exits 0 whatever happens, within hookDeadline: exit 2
// would block the edit, and any output would reach Claude. It never starts
// a bridge.

// hookDeadline is how long a hook may take before it gives up: well inside
// the 2-second timeout hooks.json gives it, leaving the launcher its start.
const hookDeadline = time.Second

var hooks = map[string]func(Env, time.Time){
	"pre-edit": preEdit,
}

// runHook runs tweak hook <name> and always returns 0. An unknown hook
// does nothing, so a newer hooks.json can't break an older binary's edits.
func runHook(args []string, env Env) int {
	if len(args) != 1 || hooks[args[0]] == nil {
		return 0
	}
	deadline := time.Now().Add(hookDeadline)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		defer func() { recover() }()
		hooks[args[0]](env, deadline)
	}()
	select {
	case <-finished:
	case <-time.After(time.Until(deadline)):
	}
	return 0
}

// hookInput is the part of Claude Code's PreToolUse JSON the hook reads.
// Edit and Write name the file in tool_input.file_path; NotebookEdit's own
// input names it notebook_path (docs/design.md, "Capture").
type hookInput struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	ToolInput struct {
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
	} `json:"tool_input"`
}

// preEdit tells the bridge which file is about to be edited, if this
// session is capturing: with no marker file it stops at once, without
// contacting the bridge. It waits for the bridge's answer, since the edit
// runs as soon as the hook exits and the before copy must be saved first.
func preEdit(env Env, deadline time.Time) {
	cfg, err := config.Resolve(env.Getenv, env.Home)
	if err != nil || env.Stdin == nil {
		return
	}
	var in hookInput
	if json.NewDecoder(env.Stdin).Decode(&in) != nil || in.SessionID == "" {
		return
	}
	if _, err := os.Stat(cfg.Marker(in.SessionID)); err != nil {
		return
	}
	path := in.ToolInput.FilePath
	if path == "" {
		path = in.ToolInput.NotebookPath
	}
	if path == "" {
		return
	}
	if !filepath.IsAbs(path) {
		base := in.Cwd
		if base == "" {
			base = env.Dir
		}
		path = filepath.Join(base, path)
	}
	f, err := bridge.ReadBridgeFile(cfg.StateDir)
	if err != nil {
		return // no bridge: the edit goes unrecorded
	}
	cl := &client{port: f.Port, session: in.SessionID, http: &http.Client{Timeout: time.Until(deadline)}}
	cl.call("POST", "/edits/before", map[string]string{"path": path}, nil)
}
