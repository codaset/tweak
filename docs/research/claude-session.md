# Claude Code: session identity and hook inputs

Ticket: codaset/tweak#2. Researched 2026-11-25 against Claude Code 2.1.332 (installed binary) and the docs at code.claude.com.

Legend: **[V]** verified first-hand (read or ran it); **[D]** stated in the official docs, not run by me; **[I]** inferred.

## Answer

- **Yes, a Bash command or Monitor script learns its session ID from the environment variable `CLAUDE_CODE_SESSION_ID`.** It is set in Bash, PowerShell, hook-command and stdio MCP subprocesses. [V: printed in Bash and in a Monitor script; D: env-vars page]
- **A hook gets the same ID as `session_id` in its stdin JSON, and also as `CLAUDE_CODE_SESSION_ID` in its env.** The docs say the Bash variable "matches the `session_id` field in the hook JSON input". So watcher, CLI calls and hook can all key on one string. [D]
- **Caveat: the ID changes on `/clear`.** The env var in new Bash calls and hooks is updated, but a long-lived Monitor process keeps the value it was spawned with. Resume with an explicit ID gives the resumed ID; `--continue`/`--resume` without one may differ for MCP servers. The claim must be re-keyed (or the watcher re-armed) on `/clear`. [D for /clear update; I for the Monitor consequence, since a process env cannot change]
- **Subagents share the parent's ID.** My own Bash, running in a subagent, shows the parent session's ID. Hooks inside subagents carry the same `session_id` plus `agent_id`/`agent_type`, so a hook can tell main from subagent. [V for env; D for hook fields]
- **`PreToolUse` stdin for `Edit`: `session_id`, `cwd`, `transcript_path`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input {file_path (absolute), old_string, new_string, replace_all}`, `tool_use_id`.** `Write`: `tool_input {file_path, content}`. The hook receives no prior file contents, so it must read the file from disk itself. `NotebookEdit`: `notebook_path`, `cell_id`, `new_source`, `cell_type`, `edit_mode` (replace, insert, delete). **`MultiEdit` is not a current tool** in 2.1.332; the name survives only in permission-rule legacy handling. Hook the matcher `^(Edit|Write|NotebookEdit)$`. [D for Edit/Write; V for NotebookEdit field names via binary; the NotebookEdit hook stdin shape is I (docs list no schema)]
- **A hook can return information and block without any user prompt.** Exit 0 with no output changes nothing and shows nothing. `additionalContext` is added to Claude's context. `permissionDecision: "deny"` (or exit 2, stderr as reason) blocks, and Claude sees the reason; only `"ask"` bothers the user. [D]

## Details

### 1. Session ID in Bash and Monitor

- Env of my own Bash call (Claude Code 2.1.332) contained `CLAUDE_CODE_SESSION_ID=1e27352a-...`, plus `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_CODE_EXECPATH`, `CLAUDECODE=1`. [V: `env | grep -i claude`]
- A `Monitor` script printed the same `CLAUDE_CODE_SESSION_ID`. [V: ran `echo $CLAUDE_CODE_SESSION_ID` in Monitor; event returned the ID]
- Docs: "`CLAUDE_CODE_SESSION_ID` ... Set automatically to the current session ID in Bash and PowerShell tool subprocesses, hook command subprocesses, and stdio MCP server subprocesses. For Bash, PowerShell, and hooks this matches the `session_id` field in the hook JSON input and is updated on `/clear`. An MCP server subprocess retains the ID it was spawned with ..." Source: https://code.claude.com/docs/en/env-vars.md (row `CLAUDE_CODE_SESSION_ID`). [D]
- Binary: `CLAUDE_CODE_SESSION_ID:e.sessionId,CLAUDE_CODE_CHILD_SESSION:"1",...` is the env block injected into spawned processes. [V: `strings -a` on /Users/joelmoss/.local/share/claude/versions/2.1.332]
- Skills can also embed the ID: `${CLAUDE_SESSION_ID}` is substituted in skill content ("Useful for logging, creating session-specific files"). It is not substituted in some contexts (terminal/VS Code surfaces listed in the skills page note), so prefer the env var. Source: https://code.claude.com/docs/en/skills.md. [D]
- Not set in Bash: `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR`. [V] (`CLAUDE_ENV_FILE` is for SessionStart hooks to persist env into later Bash commands; `CLAUDE_PROJECT_DIR` is documented for hooks. Source: hooks page, "Persist environment variables" and env list. [D])
- Other IDs: `CLAUDE_CODE_BRIDGE_SESSION_ID` only when Remote Control is active; `CLAUDE_CODE_REMOTE_SESSION_ID` only in cloud sessions. Not useful here. [D]
- Hook common input also includes `prompt_id`, `scratchpad_dir` (v2.1.257+), `effort`. [D: https://code.claude.com/docs/en/hooks.md, "Common input fields"]

### 2. Hook stdin

Source for everything in this section: https://code.claude.com/docs/en/hooks.md, sections "PreToolUse input", "Hooks in subagents".

- Common fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; `agent_id` and `agent_type` when firing inside a subagent. [D]
- PreToolUse adds `tool_name`, `tool_input`, `tool_use_id`. [D]
- `tool_input.file_path` for Write/Edit/Read is always absolute; `~` and relative paths are expanded before hooks run. [D]
- Edit: `file_path`, `old_string`, `new_string`, `replace_all`. Write: `file_path`, `content`. [D]
- NotebookEdit: docs name the tool and its three edit modes (https://code.claude.com/docs/en/tools-reference.md#notebookedit-tool-behavior) but give no hook schema. The binary's tool schema has `notebook_path`, `cell_id`, `new_source`, `cell_type`, `edit_mode` (replace default, insert, delete). Hook `tool_input` is the tool's input, so expect these. [V for tool schema; I for hook shape]
- MultiEdit: absent from the tools reference table; appears in the binary only inside permission-rule mapping (`Write`/`NotebookEdit`/`MultiEdit` rules map to `Edit`). [V]
- Matcher: letters/digits/`_`/`-`/`,`/`|` are exact names, otherwise a JS regex tested unanchored, so `Edit` alone is exact but `Edit.*` also matches `NotebookEdit`. Use `Edit|Write|NotebookEdit`. [D]
- Bash edits are invisible to an Edit/Write hook. A `Bash` PreToolUse also fires for Monitor commands (v2.1.314+); `PostToolUse` can carry `tool_response.bashEditDiff` in some modes (public beta). Relevant if Claude changes files via `sed`. [D]
- Old and new content: Edit gives the strings; the full "before" content is on disk until the tool runs, so a PreToolUse hook can snapshot it. PostToolUse input has `tool_input` and `tool_response` (example for Write: `{filePath, type: "create"}`); I did not verify the Edit `tool_response` shape. [D / not verified]

### 3. Output and blocking

Source: hooks.md, "PreToolUse decision control".

- Exit 0, no stdout: the call continues through the normal permission flow; silence does not approve. [D]
- `hookSpecificOutput.permissionDecision`: `allow`, `deny`, `ask`, `defer`; `permissionDecisionReason` (shown to Claude on deny); `updatedInput` (replaces whole input); `additionalContext` (added to Claude's context beside the tool result). [D]
- Exit 2 blocks; stderr is the reason Claude sees. [D]
- A timed-out command hook does not block unless `onFailure: "block"`. [D]
- Precedence across hooks: deny > defer > ask > allow. [D]
- So a "save pre-edit content" hook should exit 0 with empty stdout (or only `additionalContext`), never `ask`.

### 4. How to observe real hook stdin (not done)

Add a throwaway `PreToolUse` command hook, matcher `Edit|Write|NotebookEdit`, running `cat >> "$TMPDIR/hook-stdin.jsonl"`, in a scratch project's `.claude/settings.local.json`, with `CLAUDE_CODE_SESSION_ID` appended too. Edit a scratch file and read the log; also run `/clear` and edit again to see the ID change. I did not do this because I was told not to touch hooks configuration. Alternatively `claude --debug` logs hook input. [I]

## Fit with docs/design.md

Nothing contradicted. Points that need design attention: (a) `/clear` changes the session ID; (b) subagent edits arrive with the parent's `session_id` and an `agent_id`, so the hook cannot tell the main thread from a subagent working on the tweak unless it checks `agent_id`; (c) the hook sees only the diff strings, not the file, so `tweak hook pre-edit` must read the file from disk (and race-free snapshotting is the hook's job); (d) edits via Bash bypass an Edit/Write matcher.
