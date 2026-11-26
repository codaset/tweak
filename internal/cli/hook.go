package cli

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/codaset/tweak/internal/atomicfile"
	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/config"
)

// The hooks Claude Code runs (docs/design.md, "Capture" and "Claims"):
// tweak hook pre-edit, the PreToolUse hook on Edit, Write and NotebookEdit,
// and tweak hook session-end, the SessionEnd hook (exit and /clear). A hook
// prints nothing and exits 0 whatever happens, within hookDeadline: exit 2
// would block the edit, and any output would reach Claude. It never starts
// a bridge.

// hookDeadline is how long a hook may take before it gives up: well inside
// what hooks.json gives it (5 seconds for pre-edit, 2 for session-end),
// leaving the launcher its start.
const hookDeadline = time.Second

// handoverWait is how much longer tweak hook pre-edit waits for a bridge
// while a handover is under way (docs/design.md, "Handing over to a newer
// bridge"), so an edit made then keeps its before copy. hooks.json gives
// it 5 seconds for this.
const handoverWait = 3 * time.Second

// handoverFresh is how old a handover file may be and still count as a
// handover under way: longer than one takes, so a file left by a command
// that died slows no edit for long.
const handoverFresh = 30 * time.Second

// handingOver reports whether a command is handing over to a newer bridge
// now: its handover file is there, and fresh.
func handingOver(env Env) bool {
	cfg, err := config.Resolve(env.Getenv, env.Home)
	if err != nil {
		return false
	}
	info, err := os.Stat(cfg.Handover())
	return err == nil && time.Since(info.ModTime()) < handoverFresh
}

var hooks = map[string]func(Env, time.Time){
	"pre-edit":    preEdit,
	"session-end": sessionEnd,
}

// runHook runs tweak hook <name> and always returns 0. An unknown hook
// does nothing, so a newer hooks.json can't break an older binary's edits.
func runHook(args []string, env Env) int {
	if len(args) != 1 || hooks[args[0]] == nil {
		return 0
	}
	budget := hookDeadline
	if args[0] == "pre-edit" && handingOver(env) {
		budget += handoverWait
	}
	deadline := time.Now().Add(budget)
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
	// No bridge, or none answering: the edit goes unrecorded. Mid-handover,
	// the hook tries again until the new bridge answers or the handover ends.
	for {
		if f, err := bridge.ReadBridgeFile(cfg.StateDir); err == nil {
			cl := &client{port: f.Port, session: in.SessionID, http: &http.Client{Timeout: min(time.Until(deadline), hookDeadline)}}
			var refused *refusal
			if err := cl.call("POST", "/edits/before", map[string]string{"path": path}, nil); err == nil || errors.As(err, &refused) {
				return
			}
		}
		if time.Until(deadline) < handoverPoll || !handingOver(env) {
			return
		}
		time.Sleep(handoverPoll)
	}
}

// sessionEnd releases the session's claims and ends its capture as it
// exits or is cleared. With no bridge to tell (or none answering in time),
// it leaves released/<session> for the next bridge to start to act on. It
// never starts a bridge.
func sessionEnd(env Env, deadline time.Time) {
	cfg, err := config.Resolve(env.Getenv, env.Home)
	if err != nil || env.Stdin == nil {
		return
	}
	var in struct {
		SessionID string `json:"session_id"`
	}
	if json.NewDecoder(env.Stdin).Decode(&in) != nil || in.SessionID == "" {
		return
	}
	if f, err := bridge.ReadBridgeFile(cfg.StateDir); err == nil {
		// Leave time to write the marker if the bridge doesn't answer.
		cl := &client{port: f.Port, session: in.SessionID, http: &http.Client{Timeout: time.Until(deadline) * 2 / 3}}
		if cl.call("POST", "/sessions/end", nil, nil) == nil {
			return
		}
	}
	writeWhole(cfg.Released(in.SessionID), in.SessionID+"\n")
}

// writeWhole writes a marker that appears whole or not at all, so the
// bridge never reads half of one.
func writeWhole(path, text string) {
	if os.MkdirAll(filepath.Dir(path), 0o700) == nil {
		atomicfile.Write(path, []byte(text), 0o600)
	}
}
