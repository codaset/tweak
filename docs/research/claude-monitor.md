# Claude Code Monitor: limits and behaviour

Ticket: codaset/tweak#3. Researched against Claude Code 2.1.332 (the installed version) on 2026-11-25.

Evidence labels: **[verified]** = observed first-hand in an experiment on 2.1.332, or stated in the official docs. **[binary]** = read from the 2.1.332 binary's own source text (primary, but implementation, not a documented contract). **[inferred]** = reasoned from the above, not observed.

## Answer

1. **A full brief does not fit in one event line.** Each stdout line is cut at **500 characters** (`...(truncated)` appended), and one notification (all lines inside a 200 ms window) is cut at **3000 characters**. A 4 KB, 16 KB or 64 KB line all arrive truncated to 500 chars; 8 lines of ~450 chars arrived as 6 whole lines plus a half-line, and the rest were dropped. [verified, experiment; constants confirmed in binary] The design.md assumption that "the Monitor event carries the full brief" is wrong for briefs over ~500 chars. The event should be a pointer plus a short summary (for example `tweak <id>: <one-line summary>; read brief: tweak show <id>`), or the brief must be split into lines of at most 500 chars totalling under ~3000 per 200 ms burst, which a few-KB brief still exceeds.
2. **Rate limit:** a token bucket of 10 notifications refilling 1 per 2 s (sustained 0.5 notifications/s). Extra events are suppressed and replaced by a `[N events suppressed ...]` notice. The monitor is **killed** only after output has been suppressed continuously for more than **30 s** (`[Monitor stopped — too much output ...]`). Lines emitted within one 200 ms window count as one notification. A tweak watcher emitting one line per human-initiated tweak will never approach this. [binary + verified by experiment: killed ~30 s into suppression at 2.5 lines/s]
3. **Expiry:** every Monitor has a deadline: 5 min default, **30 min max** (`timeout_ms` above 1,800,000 is capped), 10 min max in a `-p` run. At the deadline the process is killed and Claude gets exactly one notice (`[Monitor expired after Xm with N events delivered]`, or `...no events delivered`). Nothing is re-armed automatically; Claude must call Monitor again. There is no persistent option (removed). [verified, docs + binary]
4. **Re-arm reliability:** the expiry notice is itself a notification that starts a turn in an idle session, so a skill instruction ("on `[Monitor expired`, call Monitor again with the same command") is the only mechanism; it relies on the model following the instruction, so it is probable, not guaranteed. Events that arrive between expiry and re-arm are lost unless `tweak watch` / the bridge inbox is durable and replays on reconnect. [inferred]
5. **Idle-turn behaviour in desktop app:** not documented anywhere I could find, and not testable from this CLI session. The docs only show that monitors appear in the desktop app's **Background tasks** pane and in VS Code. Terminal behaviour is already verified in the prototype (per ticket). Treat desktop as unverified. [not verified]
6. **Plans and surfaces:** the docs list Monitor as a built-in tool with no plan restriction. Constraints: Windows needs Git Bash; on Bedrock/Vertex/Foundry or with telemetry/nonessential traffic disabled it needs Claude Code 2.1.310+; subject to the same permission rules as Bash (a Monitor prompt appears unless an allow rule matches the command; in auto mode Monitor allow rules are ignored and the classifier reviews). [verified, docs]

## Details

### Event size and truncation

Source: binary 2.1.332 (`var j=500,H=3000,ke=200,V=1048576,be=64`; function `eis`, the line batcher) and experiment.

| Limit | Value | Behaviour |
|---|---|---|
| Per line | 500 chars | Longer lines are cut to 500 chars and `...(truncated)` is appended |
| Per notification (batch) | 3000 chars | Lines arriving within 200 ms are joined with newlines into one notification; the joined text is cut at 3000 chars with `...(truncated)` on a new line |
| Batch window | 200 ms | Matches the tool description: "Stdout lines within 200ms are batched into a single notification" |
| Partial-line buffer | 1 MiB | Beyond that, buffered data is discarded |
| WebSocket frame | 1 MiB | Larger frame ends the watch (`Dropped N-byte frame (exceeds ...); closing`); docs: "Messages larger than 1 MiB: the watch ends" |

Experiment (one Monitor, lines of `a` with markers, 2.1.332):

- 400-char line: arrived whole, end marker present.
- 4,096-char line: arrived cut at 500 chars + `...(truncated)`.
- 16,384 and 65,536-char lines: same, cut at 500.
- 8 lines of ~450 chars emitted back to back: B1-B6 arrived whole, B7 was cut mid-line at the 3000-char batch limit with `...(truncated)`, B8 was dropped entirely.

WebSocket text frames go through the same `onData` batcher as stdout in the binary, so the 500/3000 limits very likely apply to `ws` frames too. [inferred; not tested because the docs state loopback and private addresses are denied for `ws` watches]

### Rate limit and auto-stop

Source: binary function `krr` (the per-monitor output governor) and experiment.

- Token bucket: capacity 10, refill 1 token per 2000 ms. One token per notification (batch), not per line.
- When the bucket is empty, the batch is held back; a single `[N events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]` notice is queued instead.
- If suppression has run for more than 30 s (`edd=30000`) the watch is killed and Claude gets `[Monitor stopped — too much output (N events suppressed over Ns). Restart with a more selective source.]`. The suppression clock resets when the stream is quiet for more than 3 refill periods (6 s) or the bucket is full.
- The official tool description says only "Monitors that produce too many events are automatically stopped"; the numbers above come from the binary.
- Experiment: a loop emitting one line every 0.4 s. The first 12 notifications arrived (the 10-token burst plus refill), then roughly one notification per 2 s alternating with `[4 events suppressed ...]` notices, matching the bucket model. The monitor was then killed at t=~35 s, about 30 s after suppression began, with `[Monitor stopped — too much output (3 events suppressed over 30s). Restart with a more selective source.]` [verified]. A sustained rate above 0.5 notifications/s (one per 2 s) is therefore fatal after roughly 30 s; bursts of up to 10 are free.

### Expiry (30-minute cap)

- Docs (tools reference, Monitor tool): "Every watch Claude starts has a deadline: 5 minutes by default, at most 30 minutes, and at most 10 minutes in a non-interactive run given a single prompt with `-p`. At the deadline the watch ends. Claude gets one notice, so it can start the watch again if it's still needed."
- Changelog: "Changed Monitor watches to always have a deadline (at most 30 minutes; 10 in single-prompt `-p` runs) and notify Claude to re-arm, replacing the no-timeout `persistent` option."
- The Monitor tool schema in this session: `timeout_ms` default 300000, maximum 3600000 in the schema but "Deadlines above 1800000ms are capped to 1800000ms".
- Expiry notice text (binary): `[Monitor expired after <duration> with N event(s) delivered.]`, or with zero events `[Monitor expired after <duration> with no events delivered. ...widen the filter if silence was unexpected.]`; a 2.1.x changelog entry adds that stderr output is surfaced when a silent watch expires.
- Plugins can declare monitors that auto-start when the plugin is active (docs: plugins/components#monitors, tools reference). This is an alternative to the skill re-arm path and is worth a follow-up ticket; I did not test its lifetime or whether it re-arms after the 30-minute deadline.
- A script's final output and its exit arrive as one notification (changelog). When the monitor process exits, the watch ends (`[Monitor stopped]`), so `tweak watch` crashing is also a re-arm trigger.

### Idle sessions and surfaces

- Terminal: Monitor notifications are delivered as `task-notification` messages with priority `next`; the prototype already verified they start a turn when idle. [binary shows the queue; behaviour verified by ticket]
- Desktop app: docs only say background tasks (including monitors) show in the Background tasks pane. No statement about idle-turn start. Unverified.
- VS Code: changelog notes a fix for "the chat showing no notice when a background command, agent, workflow or monitor finished while Claude was idle", so completion notices are shown there; again nothing about starting a turn.
- Headless `-p`: the run waits for Monitor watches until they time out or the 10-minute cap.
- Idle-session lifecycle (tools docs, agent view): a running monitor counts as the session "working", so the process is kept alive instead of being stopped as idle.

### Availability

- Tools reference lists Monitor with permission required "Yes" and no plan or plan-tier note.
- Needs Git Bash on Windows; needs 2.1.310+ on third-party providers or with telemetry/non-essential traffic disabled (feature flags fetch).
- Subagents that start monitors own them: stopping the subagent stops the monitors.
- Hook note: `PreToolUse` hooks on `Bash` also run for Monitor commands. In this very session a `PreToolUse:Monitor` hook refused a bare `while true` poll loop; that is local config, not a Claude Code limit, but it shows a user hook can reject the skill's Monitor call. The skill's `tweak watch` should be a single command, not an inline polling loop.

## Implications for docs/design.md

- Line 188 ("The Monitor event carries the full brief") conflicts with the 500-char line / 3000-char batch caps. Either emit a short pointer line and let Claude fetch the brief (one extra step), or define a compact format that fits.
- Line 83 ("re-arms at most every 30 minutes") is correct.
- Expect lost-event risk in the gap between expiry and re-arm; the bridge inbox should hold events until a watcher reconnects.

## Sources

- Official docs, Tools reference, Monitor tool and WebSocket source: https://code.claude.com/docs/en/tools-reference#monitor-tool (fetched 2026-11-25)
- Official docs, headless mode: https://code.claude.com/docs/en/headless.md
- Official docs, changelog (via https://code.claude.com/docs/llms-full.txt)
- Monitor tool description as exposed to the agent in Claude Code 2.1.332 (timeouts, 200 ms batching, "automatically stopped")
- Binary `/Users/joelmoss/.local/share/claude/versions/2.1.332` (strings): constants `j=500,H=3000,ke=200,V=1048576`, bucket `tYe=10,nYe=2000`, `edd=30000`, message strings
- First-hand experiments, 2026-11-25, Claude Code 2.1.332
