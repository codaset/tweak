# Claude Code plugins: skill names, binaries, hooks, permissions

Research for wayfinder ticket codaset/tweak#4. Researched 2026-11-25 against the Claude Code docs at
code.claude.com and the installed binary 2.1.332.

Status tags: **[verified-doc]** stated in the official docs; **[verified-local]** seen in an installed
plugin or in the 2.1.332 binary; **[inferred]** follows from the sources but no source states it, so
test before relying on it.

## Answer

1. **Bare `/tweak`: documented, not yet run.** A plugin skill is `/codaset:tweak`. The docs say the bare name also invokes it "unless another command already uses that name" (the docs' example sets `name:`; set `name: tweak` explicitly). On a clash the other command wins the bare name, and `/codaset:tweak` always works. A same-named personal, project or enterprise skill does not replace the plugin skill; both load. [verified-doc]
2. **Binaries:** files in the plugin's `bin/` are on the PATH of the Bash tool's shell while the plugin is enabled, after the user's own PATH entries, so `tweak` runs as a bare command. They are not documented to be on the PATH of hooks, so hooks should use `"${CLAUDE_PLUGIN_ROOT}/bin/tweak"`. Whether Monitor commands see that PATH is not documented. [verified-doc / unverified for Monitor]
3. **Hooks:** a `hooks/hooks.json` in the plugin (wrapped in a top-level `"hooks"` key) registers on plugin load and fires for every session, not only when the skill is used. A `PreToolUse` hook gets JSON on stdin including `session_id` and `tool_input.file_path`, and runs `${CLAUDE_PLUGIN_ROOT}` paths. [verified-doc]
4. **`allowed-tools`:** it pre-approves the listed tools for the one turn that invokes the skill, and clears at the next user message. Syntax is the permission-rule syntax, e.g. `allowed-tools: Bash(tweak *)`; the trailing ` *` also matches bare `tweak`. Monitor runs a command under the same rules as Bash, so `Bash(tweak *)` also covers `Monitor` running `tweak watch`. The grant does not outlive the turn, so a Monitor started in that turn is covered, but a re-arm in a later turn must come from a skill invocation or a settings allow rule. [verified-doc; "started in that turn stays approved" is inferred]
5. **Marketplace in the same repo:** put `.claude-plugin/marketplace.json` at the repo root with an entry whose `source` is a relative path (`./plugins/codaset`). Users run `/plugin marketplace add codaset/tweak` then `/plugin install codaset@<marketplace-name>`. A relative-path plugin is copied into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Updates arrive only when the computed version changes: set `version` in `plugin.json` and bump it, or omit it to track the commit SHA. Auto-update is off by default for third-party marketplaces. [verified-doc]
6. **Design risk found:** `${CLAUDE_PLUGIN_ROOT}` is a per-version cache directory that changes on every update, and the old one is deleted 14 days later. The design loads the Chrome extension unpacked from the plugin folder and runs a long-lived bridge; both would point at a directory that vanishes. Copy the extension (and, if the bridge outlives sessions, the binary) to `${CLAUDE_PLUGIN_DATA}`, which survives updates. [verified-doc: path and cleanup; the consequence is inferred]

## Details

### 1. Plugin layout and manifest

A plugin is a directory; the manifest is `.claude-plugin/plugin.json` and only `name` is required. Everything else (`skills/`, `hooks/`, `bin/`) sits at the plugin root, not inside `.claude-plugin/`. [verified-doc] https://code.claude.com/docs/en/plugins-reference ("Manifest file", "Standard layout")

Standard layout rows relevant here (same page): skills in `skills/<name>/SKILL.md`; hooks in `hooks/hooks.json`; monitors in `monitors/monitors.json`; executables in `bin/`. Arbitrary other folders (the extension, `dist/`) are allowed; they are just files in the plugin copy. Component paths in the manifest must start with `./`, must exist and must not escape the plugin root. [verified-doc]

`name` rules: kebab-case, no spaces, `@`, `:` or path separators. Names starting `claude-`, `anthropic-` etc. are reserved; `codaset` is fine. [verified-doc] same page, "`name`"

Version: `version` in `plugin.json` "pins the plugin to that version until you change it". [verified-doc]

Proposed layout:

```text
tweak/                              (repo root, also the marketplace root)
  .claude-plugin/marketplace.json
  plugins/codaset/
    .claude-plugin/plugin.json
    skills/tweak/SKILL.md
    hooks/hooks.json
    bin/tweak                       (launcher, chmod +x, committed with the exec bit)
    dist/tweak-darwin-arm64 ...     (5 Go binaries)
    extension/                      (Chrome extension folder)
```

Using `./plugins/codaset` rather than `./` keeps the Go source, docs and tests out of the cached copy (a relative-path plugin is copied whole into the cache). [verified-doc: "copies the plugin into cache/<marketplace>/<plugin>/<version>/", loading page "In-place and copied plugins"; the size benefit is inferred]

### 2. Skill names: `/codaset:tweak` and `/tweak`

Verbatim from https://code.claude.com/docs/en/skills ("How a skill gets its command name"):

- Table row: "`my-plugin/skills/review/SKILL.md` -> `/my-plugin:review`, or `/my-plugin:fancy` with `name: fancy`".
- "In a plugin skill, the frontmatter `name` replaces the directory name in the last segment of the command ... The bare `/fancy` also invokes the skill unless another command already uses that name."
- "If the `name` you write already starts with the plugin's own prefix, Claude Code doesn't add the prefix again on v2.1.246 or later."

Clash rules ("Resolve skills that share a name" table): "A plugin skill and a skill at any of the locations above | Both load, because plugin skills are namespaced as `/plugin-name:skill-name`". For personal/project/enterprise skills versus built-ins and bundled skills, "your skill replaces the built-in command". The docs do not give a rule for a plugin skill versus a built-in or bundled command beyond "unless another command already uses that name"; read that as the plugin skill losing the bare name, which is the safe direction. [verified-doc for the quotes; the reading is inferred]

Gaps to test on a real install (cheap, one session): (a) that bare `/tweak` appears and runs, with `name: tweak` set and also without it (the docs state the bare form only in the `name:` override paragraph); (b) what happens when `~/.claude/skills/tweak` exists (expect: the user's skill gets `/tweak`, the plugin one stays `/codaset:tweak`). The design.md "Before building" item "Confirm a plugin skill can be invoked as plain `/tweak`" is therefore documented but not run.

Recommendation: always write `/codaset:tweak` in warnings and docs as the reliable form; mention `/tweak` as the shortcut.

### 3. Shipping executables

Docs (https://code.claude.com/docs/en/plugins/components.md, "Executables"): "Files in `bin/` at the plugin root are on the `PATH` of the Bash tool's shell while the plugin is enabled, so Claude can run them as bare commands." "Plugin `bin/` directories come after the user's own `PATH` entries, so a plugin can't shadow `git`, `ls`, or another system command." Make it executable with `chmod +x`. [verified-doc]

Consequences for Tweak:

- The launcher in `bin/tweak` (a small POSIX shell script that picks `dist/tweak-<os>-<arch>` by `uname`) is what the skill and `allowed-tools` call: `tweak ...`. Windows has no `sh` guarantee for the Bash tool (docs mention Git Bash and PowerShell as the Windows shells; the PowerShell tool also finds `bin/` outside the sandbox only). A Windows launcher (`bin/tweak.cmd` or `.ps1`) needs a test; mark Windows untested as design.md already does. [verified-doc for shells; launcher advice inferred]
- A user's own `tweak` earlier on PATH wins over the plugin's. Low risk, but the skill could call `"${CLAUDE_PLUGIN_ROOT}/bin/tweak"` for certainty (see 5). [verified-doc ordering]
- Plugin PATH entries containing shell metacharacters are dropped: the 2.1.332 binary has the log "Dropping plugin bin path with shell metacharacters" with the character class `[:"'$\`\\\n\r]`. A normal cache path (`~/.claude/plugins/cache/...`) is fine; a home directory with such characters would silently break `tweak`. [verified-local, strings in /Users/joelmoss/.local/share/claude/versions/2.1.332]
- Newly installed `bin/` entries: the binary also logs "plugin bin/ PATH entries changed" and rebuilds the shell snapshot "on the next Bash exec" after a plugin refresh, so `/reload-plugins` or a new session is needed after install/update. [verified-local, same binary; the exact trigger is inferred]
- claude.ai and Cowork refuse a plugin with a top-level `bin/` ("claude.ai and Cowork don't install a plugin that has this directory"; org-sync rejects it). Tweak is a Claude Code (terminal) tool, so this is acceptable, but note the design cannot be distributed through claude.ai organization settings as-is. [verified-doc] https://code.claude.com/docs/en/plugins/components.md "Executables"; https://code.claude.com/docs/en/plugins/host-marketplace.md "Distribute through organization settings"
- Variables in Bash: "The variables aren't present in the environment of commands Claude runs through the Bash tool". `${CLAUDE_PLUGIN_ROOT}` is substituted only in skill/command/agent text, hook and monitor commands, and MCP/LSP configs. So `bin/` on PATH is the right way for the skill to call the binary; if the skill needs the explicit path, write `${CLAUDE_PLUGIN_ROOT}` in the SKILL.md body and Claude Code substitutes it inline. [verified-doc] https://code.claude.com/docs/en/plugins-reference "Where each variable resolves"
- Not verified: whether commands run by the Monitor tool inherit the same PATH as Bash. The tools reference says Monitor "uses the same permission rules as Bash" but says nothing about environment. Safest for `tweak watch`: have the skill start the Monitor with the substituted absolute launcher path, or test `Monitor` with a bare `tweak watch` once. [unverified]
- Executable bits and a large cache: marketplace plugins are copied to the cache; git preserves the exec bit but I found no doc statement that the copy preserves it. Test after install. 5 x ~8 MB binaries is far under any documented limit (the only limits found are for `archive`/URL sources, which a git-hosted relative-path plugin does not use). [inferred]

Also an alternative to a PATH launcher: `monitors/monitors.json` can declare a monitor the plugin starts itself (`when: "on-skill-invoke:tweak"`), with `${CLAUDE_PLUGIN_ROOT}` substitution. That is a different delivery model from the design's "the skill starts a Monitor running `tweak watch`": plugin monitors "don't start in non-interactive mode", can't use `${user_config.*}`, "don't stop if you disable the plugin mid-session", and cannot be restarted by the skill to re-arm. design.md's skill-started Monitor remains the simpler fit for 30-minute re-arming. [verified-doc] https://code.claude.com/docs/en/plugins/components.md "Monitors"; plugins-reference "monitors"

### 4. Hooks

Plugin hooks live in `hooks/hooks.json`, top-level `"hooks"` key, same shape as `settings.json`; a file with only the event map and no wrapper "fails to load". They merge with the user's and project's hooks. [verified-doc] plugins-reference "`hooks`"; hooks reference "Plugin scripts"

Registration timing: "A plugin's hooks don't wait for one of the plugin's skills or commands to be used. Claude Code registers them when a session loads the plugin, and they fire on their events from then on." [verified-doc] components.md "When plugin hooks fire". So `tweak hook pre-edit` runs before every edit in every session where the plugin is enabled, tweak active or not. It must be a fast no-op when this session has no tweak in progress (the hook gets `session_id`, so it can key on that). A hook that exits 0 with no output "has no decision to report". [verified-doc]

Alternative: hooks in skill frontmatter exist and are scoped to the skill's lifetime ("removed when you exit or leave the conversation with a command such as /clear or /resume"), but also "don't run before you or Claude invoke the skill". Plugin-level `hooks.json` plus a cheap no-op is more robust across compaction and /clear. [verified-doc] hooks reference "Hooks in skills and agents"

PreToolUse input (hooks reference "Hook input and output"): `session_id`, `cwd`, `transcript_path`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`. For `Edit`/`Write`, `tool_input` carries the file path (field names `file_path`; I did not see an `Edit` example in the pages read, so confirm the exact fields with a logging hook). [verified-doc for the envelope; Edit field names inferred]

Matcher: letters, digits, `_`, `-`, space, `,` and `|` are an exact list; anything else is a regex. Use `"matcher": "Edit|Write|MultiEdit|NotebookEdit"` (check which edit tool names exist in 2.1.332 from the tools reference). Bash `sed -i` edits are not seen, matching design.md's stated limit. [verified-doc]

Command form: run the launcher by absolute path. Exec form with `args` avoids quoting; shell form must quote the variable. Hook processes receive `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`. Default timeout is 600 s; a timed-out PreToolUse hook does not block the tool call, and exit 1 is a non-blocking error (only exit 2 blocks). The undo hook should therefore never block: always exit 0, even on failure, and log. [verified-doc]

Permission interplay: PreToolUse hook output cannot override deny/ask rules; exit-0 silence means the normal permission flow continues. The undo hook only snapshots, so it should return nothing. [verified-doc] https://code.claude.com/docs/en/permissions "Extend permissions with hooks"

Same-name caveat: if two enabled plugins share a manifest name, only one registers its `hooks.json` hooks. `codaset` should be unique to the repo. [verified-doc] loading page "Hooks when two enabled plugins share a name"

### 5. `allowed-tools` and Monitor

Frontmatter field (https://code.claude.com/docs/en/skills "Frontmatter" and "Pre-approve tools for a skill"): "Tools Claude can use without asking permission during the turn that invokes this skill. The grant clears when you send your next message. Accepts a space- or comma-separated string, or a YAML list." "It does not restrict which tools are available ... your permission settings still govern tools that are not listed. To pre-approve tools for the whole session ... add allow rules to those permission settings instead." [verified-doc]

Syntax: the permission-rule syntax. The skills page examples: `Bash(git add *) Bash(git commit *)`, `Bash(gh *)`, `Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)`. Rules from https://code.claude.com/docs/en/permissions "Bash":

- `*` is a wildcard; a trailing ` *` (space then star) "also matches the bare command", so `Bash(tweak *)` matches `tweak` and `tweak claim 5`, but not `tweakx`. `Bash(tweak:*)` is an equivalent legacy form.
- Compound commands: every subcommand must be allowed (`&&`, `||`, `;`, `|`, `&`, newlines are split). So the skill should run `tweak ...` as single commands, not piped or chained with other programs.
- Wrappers `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin` and a few safe env assignments are stripped before matching.
- Matching is on the command text as typed: `Bash(tweak *)` does not match `/abs/path/bin/tweak ...`. Choose one form and use it everywhere: either bare `tweak` (needs `bin/` on PATH) or the absolute `${CLAUDE_PLUGIN_ROOT}/bin/tweak *`. Docs show `${CLAUDE_SKILL_DIR}` substituted inside `allowed-tools`; that `${CLAUDE_PLUGIN_ROOT}` is substituted there too is [inferred] (the docs say it is substituted "anywhere in the Markdown body" of skill content; frontmatter not stated).

Monitor: tools reference, "Monitor tool": "When Monitor runs a command, it uses the same permission rules as Bash, so `allow` and `deny` patterns you have set for Bash apply here too." The tool-name table also lists `Bash(npm run *)` as applying to "Bash, Monitor". Therefore `allowed-tools: Bash(tweak *)` is the Bash-pattern rule that approves a Monitor running `tweak watch`. A `Monitor` allow rule exists too, but in auto mode "Claude Code sets aside allow rules that name `Monitor` itself", so use the Bash-pattern form. [verified-doc] https://code.claude.com/docs/en/tools-reference ("Monitor tool")

Because the grant lasts one turn, design.md's "a single `allowed-tools` rule covers it" holds for turns the skill invoked, but a re-arm after 30 minutes happens in a later turn when the grant is gone. Options: (a) re-invoke the skill on re-arm (grant re-applies, "invoking the skill again re-applies it"); (b) offer the user a one-time `permissions.allow` entry `Bash(tweak *)` in settings; (c) accept a prompt. Also the Monitor event that wakes an idle session starts a new turn without a user message; whether the skill's grant is still active in that turn is unknown. [verified-doc for one-turn semantics; (a)-(c) and the wake-turn question are inferred/untested]

Security notes: "Claude Code applies a project skill's `allowed-tools` even in a `-p` run in a folder you've never trusted" is about project skills; for plugin skills the trust step is installing the plugin. If an org sets `allowManagedPermissionRulesOnly`, `allowed-tools` in project and personal skills is ignored (the doc lists "other sources"; plugin inclusion not confirmed). [verified-doc / partly unverified]

### 6. Marketplace in the same repo, installs and updates

Marketplace file: `.claude-plugin/marketplace.json` at repo root, requires `name`, `owner`, `plugins`; each entry needs `name` and `source` (relative path from the marketplace root, starting `./`, no `..`). Entry `name` should equal the manifest `name` so `codaset@<marketplace>` works. [verified-doc] https://code.claude.com/docs/en/plugin-marketplaces ("Create a marketplace", "Rules for plugin entries"). Seen in a real marketplace on this machine: `/Users/joelmoss/.claude-swap-backup/sessions/1-joel_developwithstyle.com/plugins/marketplaces/harleytherapy/.claude-plugin/marketplace.json` uses `"source": "./plugins/gdpr-audit"`. [verified-local]

Add and install: `/plugin marketplace add codaset/tweak` (GitHub shorthand; `#<ref>` pins a branch/tag) then `/plugin install codaset@<marketplace-name>`; the shell forms are `claude plugin marketplace add` and `claude plugin install`. The marketplace `name` must be unique per user; pick something not likely to clash (e.g. `codaset`). Users need `git`; a private repo needs credentials already on the machine. [verified-doc] https://code.claude.com/docs/en/plugins/host-marketplace.md

Project-wide sharing: `claude plugin marketplace add codaset/tweak --scope project` writes `.claude/settings.json` so teammates register it (after trusting the folder). [verified-doc]

Update mechanics (https://code.claude.com/docs/en/plugins/loading.md "Versions and updates"): a new copy is made only when the computed version changes. Resolution order: `version` in `plugin.json`, then the marketplace entry, else for a relative path inside a git-hosted marketplace "the commit SHA of the installed directory". Choose one:

- pin `version` in `plugin.json` and bump on each release (users stay put until it changes; pushing commits without a bump does nothing), or
- omit `version` so every commit is an update (simplest for a young product; also means any push to the default branch ships).

Do not set `version` in both plugin.json and the entry (plugin.json silently wins, `validate` warns). The binaries and extension change together, so tying release to a `version` bump keeps the "extension older than plugin" warning in design.md meaningful. [verified-doc]

Auto-update: off by default for third-party marketplaces; the user enables it under `/plugin` > Marketplaces, or runs `/plugin marketplace update <name>` / `claude plugin update codaset@<name>`. When it runs: after the first message, a random delay up to 10 minutes. Updated hooks, MCP servers, LSP servers switch paths on `/reload-plugins`; monitors need a session restart. [verified-doc]

Cache and cleanup: `${CLAUDE_PLUGIN_ROOT}` is `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (here under the user's Claude config dir, e.g. `.../plugins/cache/claude-community/next-steps/1.0.0` [verified-local]). On update the previous version directory gets an `.orphaned_at` marker and is removed 14 days later. `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) "is kept across plugin updates" and deleted on uninstall. [verified-doc] loading page "Find plugins on disk", "Cleanup of previous versions"

Local dev: a marketplace added from a local path loads relative-path plugins in place, edits apply at next session or `/reload-plugins` with no version bump; `claude --plugin-dir <path>` loads one for a session. `claude plugin validate <dir>` checks both files (also `--strict`). [verified-doc]

### 7. Example files the plan needs

`plugins/codaset/.claude-plugin/plugin.json`:

```json
{
  "name": "codaset",
  "description": "Codaset Tweak: point at things in your running app in Chrome and have Claude Code change them.",
  "version": "0.1.0",
  "author": { "name": "Codaset" },
  "homepage": "https://github.com/codaset/tweak",
  "repository": "https://github.com/codaset/tweak",
  "license": "UNLICENSED"
}
```

(Omit `version` to track commits instead. `name` must equal the marketplace entry name.)

`.claude-plugin/marketplace.json` (repo root):

```json
{
  "name": "codaset",
  "owner": { "name": "Codaset" },
  "description": "Codaset plugins for Claude Code",
  "plugins": [
    {
      "name": "codaset",
      "source": "./plugins/codaset",
      "description": "Codaset Tweak"
    }
  ]
}
```

`plugins/codaset/hooks/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/tweak\" hook pre-edit",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

(Shell form with the variable in double quotes, per the docs; exec form `"command": "${CLAUDE_PLUGIN_ROOT}/bin/tweak", "args": ["hook","pre-edit"]` avoids quoting. Verify the tool-name list against 2.1.332's tools reference.)

`plugins/codaset/skills/tweak/SKILL.md` frontmatter:

```yaml
---
name: tweak
description: Open Codaset Tweak for this app: start the bridge, watch for tweaks from the Chrome extension, and act on each one. Use when the user wants to tweak their running app visually.
allowed-tools: Bash(tweak *)
---
```

Body starts the Monitor with `tweak watch` (Monitor is checked with the Bash rules, so `Bash(tweak *)` covers it). Optionally set `disable-model-invocation: true` so only the user starts a tweak session; that also keeps the skill description out of Claude's auto-trigger list (field documented, "prevents Claude from automatically loading this skill"). [verified-doc]

### 8. Sources

Official docs (fetched 2026-11-25):
- https://code.claude.com/docs/en/plugins-reference (manifest fields, env variables, layout, monitors, path rules)
- https://code.claude.com/docs/en/plugin-marketplaces (create a marketplace, entry rules, sources)
- https://code.claude.com/docs/en/plugins/components.md (skills, hooks, executables, monitors in plugins)
- https://code.claude.com/docs/en/plugins/loading.md (versions and updates, cache, name conflicts)
- https://code.claude.com/docs/en/plugins/host-marketplace.md (hosting, auto-update, release, org sync)
- https://code.claude.com/docs/en/skills (frontmatter, command names, collisions, `allowed-tools`)
- https://code.claude.com/docs/en/hooks (PreToolUse input, matchers, exit codes, plugin hooks.json; the pages were truncated before the "PreToolUse decision control" section, so `allow`/`ask` details come from the permissions page)
- https://code.claude.com/docs/en/permissions (Bash rule syntax, hooks and permission order)
- https://code.claude.com/docs/en/tools-reference (Monitor tool)

Local, read-only:
- Binary `/Users/joelmoss/.local/share/claude/versions/2.1.332`: strings for plugin bin PATH handling and `on-skill-invoke`.
- Installed plugins under `/Users/joelmoss/.claude-swap-backup/sessions/1-joel_developwithstyle.com/plugins/` (`installed_plugins.json`, `known_marketplaces.json`, `marketplaces/harleytherapy`, `marketplaces/claude-plugins-official`, `cache/claude-community/next-steps/1.0.0/hooks/hooks.json`). No installed plugin ships a `bin/` directory, so there is no local example of one. Example skills with `allowed-tools` in frontmatter: `marketplaces/harleytherapy/plugins/gdpr-audit/skills/status/SKILL.md`. Example plugin hooks using `${CLAUDE_PLUGIN_ROOT}`: `marketplaces/claude-plugins-official/plugins/security-guidance/hooks/hooks.json`.
- Nothing was installed, enabled or modified.

## Open questions and things to test

1. Does bare `/tweak` appear and run for a plugin skill, with and without `name: tweak`? (docs say yes)
2. Does the Monitor tool's shell see plugin `bin/` on PATH?
3. Is the exec bit kept in the cache copy of a git-hosted relative-path plugin?
4. Is the `allowed-tools` grant active in the turn a Monitor event starts in an idle session? (design.md's wake-up flow)
5. Is `${CLAUDE_PLUGIN_ROOT}` substituted inside `allowed-tools` frontmatter?
6. Exact `tool_input` field names for each edit tool seen by the PreToolUse hook.
