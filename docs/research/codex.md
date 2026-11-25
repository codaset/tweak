# Codex: what supporting it would take

Research for [#18](https://github.com/codaset/tweak/issues/18). Researched 2026-11-25.

Versions: latest stable release is **0.172.0** (2026-11-24); installed and used for experiments:
**codex-cli 0.171.0** (released 2026-11-20); source read at openai/codex `main`, commit
`06f334aa4b05` (2026-11-25, workspace 0.174.0-alpha line).

Evidence labels: **source** = read in the openai/codex repository (paths under `codex-rs/`);
**docs** = OpenAI's published docs (developers.openai.com now 308-redirects to learn.chatgpt.com/docs);
**experiment** = run locally against codex-cli 0.171.0 in an isolated, empty `CODEX_HOME` (no
credentials, so no model calls succeeded; every turn ended in a 401, which does not matter here).

## Verdict

**Feasible, with a fallback.** Codex has a real equivalent of Monitor's wake, but it works the other way
round: the bridge pushes into the session, rather than the session running a watcher. A turn can be
started in a running, idle session from outside through the app server's `thread/queue/add`
(`codex queue --thread <id> --message <text>`). Everything else Tweak needs has a counterpart. The
caveats: the wake API is flagged experimental, it needs the session to be attached to the shared local
app-server daemon (the default in 0.171.0), and the Codex desktop app was not verified.

## Findings

1. **An outside process can start a turn in a running idle session.** (experiment, source)
   - Codex CLI 0.171.0 has `codex queue --thread <uuid-or-name> --message <text>`: "Queue a message for
     an existing session". It calls the experimental app-server method `thread/queue/add`
     (`tui/src/session_queue_commands.rs`, `app-server/src/request_processors/thread_queue_processor.rs`).
   - The queue extension stores the message durably (SQLite, `~/.codex/queue_1.sqlite`) and, if the
     thread is loaded in that server, immediately calls `emit_thread_idle_lifecycle_if_idle`, which
     dispatches the head of the queue with `start_turn_if_idle` (`ext/queue/src/service.rs`,
     `enqueue_with_metadata`, `wake_if_loaded`, `dispatch_if_idle`). If the thread is busy, the message
     waits and is dispatched when the turn ends (`on_thread_idle`). That is the same "queued while busy,
     handled when idle" behaviour the design wants for Claude.
   - Experiment: daemon started with `codex app-server daemon start`; client A created a thread and
     stayed connected (as a TUI would); `codex queue --thread <id> --message "tweak work 1"` exited 0
     ("Queued message ... for thread ...") and within a few milliseconds client A received
     `thread/queue/changed`, `thread/status/changed` (active), `turn/started`, and `item/started`
     with a `userMessage` whose text was `tweak work 1`. The turn then failed with 401 only because the
     test home had no login.
   - The queued message becomes a normal user message in the session (turn trigger `queue`). It is not a
     "tool notification" like Monitor's; it will look like the developer typed it.

2. **App Server `turn/start` also works from a second client, without resuming.** (experiment, docs)
   - Experiment: client B opened its own connection to the daemon's control socket, listed
     `thread/loaded/list` (saw client A's thread), called `turn/start` on it with no `thread/resume`,
     and got `turn/started` back. Client A, the original subscriber, received `turn/started`, the user
     message items and the errors. So a subscribed UI sees turns another client starts.
   - Docs: `turn/start` "add user input ... and begin Codex generation"; `turn/steer` "append user input
     to the active in-flight turn" (fails if no turn is active, emits no new `turn/started`).
     `thread/queue/add` is the better fit because it covers both idle and busy states in one call.
   - The queue methods are marked `#[experimental("thread/queue/add")]` (source,
     `app-server-protocol/src/protocol/common.rs`); a raw client must send `capabilities.experimentalApi:
     true` in `initialize`. The `codex queue` CLI does this for you. The docs also call the WebSocket
     transport "experimental and unsupported", and the whole `app-server` subcommand is `[experimental]`
     in `--help`. Expect churn.

3. **The session must live on the shared daemon.** (source, experiment)
   - The TUI picks its backend in `tui/src/lib.rs` (`app_server_target_for_launch`): the shared local
     daemon on the default control socket when one exists, else an embedded in-process server. Since
     feature `daemon_auto_start` is `stable`, default `true` (`features/src/lib.rs`), a plain `codex`
     auto-starts and attaches to the daemon (`tui/src/startup_orchestration.rs`: not when `--no-daemon`,
     an explicit `--remote`, or a remote workspace).
   - The control socket is `$CODEX_HOME/app-server-control/app-server-control.sock` (unix socket
     speaking WebSocket; experiment). Mind the macOS 104-byte socket path limit for custom homes.
   - Transports offered: `stdio://` (default for `codex app-server`), `unix://[PATH]`, `ws://IP:PORT`
     (docs: "experimental and unsupported"; non-loopback listeners are unauthenticated by default).
   - `codex queue` refuses to use an embedded server while a daemon is running ("cannot queue through an
     embedded app server while a local app-server daemon is running ... use --remote").
   - **Fallback for sessions not on the daemon** (`--no-daemon`, `-c` overrides that force embedded):
     the queue extension also polls SQLite every 10 seconds for messages written by another process
     (`watch_external_messages`, source). So `codex queue` should still reach an embedded session within
     about 10 seconds. Source only; not run, because it needs a live interactive TUI.

4. **Session ID: `CODEX_THREAD_ID` is real and matches the hook's `session_id`, but its documentation
   is thin.** (source, docs)
   - Source: `protocol/src/shell_environment.rs` defines `CODEX_THREAD_ID_ENV_VAR` and injects it into
     every shell command the agent runs, "even when `include_only` is set"; `core/src/exec_env.rs` has a
     test suite for it. The official TypeScript SDK README (`sdk/typescript/README.md`) uses
     `process.env.CODEX_THREAD_ID` to resume a thread. The hook input's `session_id` is a `ThreadId`
     (`hooks/src/events/pre_tool_use.rs`), the same type and value space, so the hook and the CLI can
     share one key.
   - It is not on the hooks or app-server doc pages I read, so "official" rests on source and the SDK
     README. The thread ID is the same string `codex queue --thread` takes (UUID, v7).
   - Not verified: whether a subagent's shell sees its own thread ID or the root's. Tweak's undo already
     keys on one `session_id`; check before relying on it.

5. **Capturing an edit before it happens works through `PreToolUse` on `apply_patch`.** (docs, source)
   - Docs: events include `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`,
     `UserPromptSubmit` and others. The matcher is a regex on `tool_name` and aliases; for `apply_patch`
     it also matches `Edit` and `Write` (source: `hooks/src/engine/dispatcher.rs` tests
     `apply_patch|Write|Edit`). So the existing matcher `^(Edit|Write|NotebookEdit)$` carries over
     nearly unchanged.
   - Input on stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`,
     `tool_name`, `tool_use_id`, `tool_input`, `permission_mode`.
   - For `apply_patch`, `tool_input` is `{ "command": "<the whole patch text>" }`
     (`core/src/tools/handlers/apply_patch.rs`, `pre_tool_use_payload`). It carries no file path field, so
     the hook must parse the `*** Add/Update/Delete File:` headers (and `*** Move to:`) out of the patch
     to know which files to snapshot. This is the main extra work compared with Claude's `file_path`.
   - Shell edits (`sed -i`, redirects) show up as `Bash`/`exec_command`, not `apply_patch`. They are the
     "unrecorded files" the git check already catches.
   - Hooks run with a 600 s default timeout (docs); set a short `timeout` to match the 2-second rule.
     Docs warn tool hooks are "a useful guardrail, not a complete enforcement boundary" and some tool
     paths opt out of the hook path. `PreToolUse` cannot yet return `ask` or `continue: false`.
   - **Trust step:** docs: "Non-managed hooks must be reviewed and trusted before they run." Trust is
     tied to a hash of each hook, a new or changed hook is "marked for review and skipped until
     trusted", reviewed in the CLI with `/hooks`. `--dangerously-bypass-hook-trust` skips it for one run
     only. So the first install needs a manual `/hooks` approval, and every change to the hook command
     re-prompts. Keep the hook command a fixed `tweak hook pre-edit` so its hash is stable across
     releases.
   - Hook locations: `$CODEX_HOME/hooks.json`, `<repo>/.codex/hooks.json` (trusted projects only),
     `/etc/codex/hooks.json`, or inline `[hooks]` in `config.toml`. Plugins can ship
     `hooks/hooks.json`, which also needs review; `CLAUDE_PLUGIN_ROOT` is set for compatibility.

6. **Packaging: skills, yes; custom slash commands, no (use a skill).** (docs, source)
   - Skills are directories with a `SKILL.md` (`name` and `description` required). Locations:
     `.agents/skills` from the working directory up to the repo root, `$HOME/.agents/skills`,
     `/etc/codex/skills`, and bundled system skills. Invoke explicitly with `$tweak` (or `/skills` to
     pick), or implicitly when the description matches. Optional `agents/openai.yaml` sets
     `policy.allow_implicit_invocation` (default true), UI metadata and tool dependencies.
   - The docs I read do not document custom prompts or custom slash commands (the `/` list is built-in
     commands only), so there is no `/tweak`. The Claude skill's `/tweak` becomes `$tweak`.
   - Plugins bundle skills, hooks, MCP servers and assets, installed with `codex plugin add` from a
     marketplace (`codex plugin --help`; manifest at `.codex-plugin/plugin.json`, source
     `core-plugins`). That is the route to ship skill and hook together. I did not read the plugin
     manifest schema in full.
   - Codex has no Monitor-style tool in what I found. It does not need one for delivery (finding 1), but
     the skill cannot rely on a long-running watcher feeding it lines.

7. **No-prompt `tweak` commands: an exec-policy `prefix_rule` does it, including network.** (docs,
   experiment)
   - Defaults: sandbox `workspace-write` ("Auto"), network off ("By default, the agent runs with network
     access turned off"); loopback is blocked by default on the proxy path (`allow_local_binding =
     false`). Approval policies `on-request`, `never`, `granular`; `untrusted` is gone.
   - Rules: `prefix_rule(pattern=["tweak"], decision="allow")` in `~/.codex/rules/*.rules`. Docs: an
     `allow` rule "run[s] the command outside the sandbox without prompting", which also lifts the
     network restriction, so `tweak` reaches `127.0.0.1` without enabling network for everything else.
     Project rules in `<repo>/.codex/rules/` apply only when the project is trusted. Rules are marked
     experimental.
   - Experiment: `codex execpolicy check --rules t.rules -- tweak watch --json` returned
     `decision: allow` with the matched prefix `["tweak"]`. Whether a given sandboxed run really
     reaches loopback with the rule in place was not run end to end (needs a model call).
   - Alternatives if the rule is not wanted: `[sandbox_workspace_write] network_access = true` (broad), or
     a permission profile with `network.enabled = true`.
   - The wake path needs none of this: the bridge runs `codex queue` itself, outside the agent.

## What Tweak would need (outline)

- Bridge: after `$tweak` registers the session (`CODEX_THREAD_ID`), deliver each event line by running
  `codex queue --thread <id> --message "<pointer line>"` (or the `thread/queue/add` JSON-RPC call over
  the control socket). Delivery is push, so no watcher and no 30-minute re-arm. Keep the line short; it
  is a user message in the transcript.
- `tweak hook pre-edit`: accept Codex's JSON, parse the patch for file paths, same marker-file logic.
- A Codex skill (`$tweak`) plus a one-time setup: the `prefix_rule`, the hook entry, and the `/hooks`
  trust step.
- Status "Queued" vs "Working" can come from `thread/queue/list` and `thread/status/changed` if the bridge
  holds a control-socket connection.

## Could not verify

- The Codex desktop app (ChatGPT.app) as a target: it runs its own app-server; whether a thread there is
  reachable through `~/.codex/app-server-control/app-server-control.sock` was not tested, and the socket
  did not exist on this machine while the app was open.
- A real interactive TUI receiving a queued turn (I used a second protocol client as the subscriber; the
  TUI consumes the same notifications, `tui/src/app/app_server_event_targets.rs`, but I did not run it).
- The embedded-server 10-second SQLite poll (source only).
- End-to-end loopback access under the sandbox with the allow rule (needs a model call, and I did not
  copy credentials into the experiment home).
- `CODEX_THREAD_ID` inside subagents; whether any release already changes `thread/queue/*` stability
  (shallow clone, no history).

## Sources

- openai/codex: `codex-rs/ext/queue/src/service.rs`, `codex-rs/cli/src/queue_cmd.rs`,
  `codex-rs/tui/src/session_queue_commands.rs`, `codex-rs/tui/src/lib.rs`,
  `codex-rs/tui/src/startup_orchestration.rs`, `codex-rs/features/src/lib.rs`,
  `codex-rs/app-server-protocol/src/protocol/common.rs`, `codex-rs/protocol/src/shell_environment.rs`,
  `codex-rs/hooks/src/events/pre_tool_use.rs`, `codex-rs/core/src/tools/handlers/apply_patch.rs`,
  `sdk/typescript/README.md`.
- Docs: developers.openai.com/codex/{app-server, hooks, skills, rules, agent-approvals-security}
  (served from learn.chatgpt.com/docs).
- Releases: `gh release list -R openai/codex` (0.172.0 Latest, 2026-11-24).
