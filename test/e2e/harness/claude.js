// A real development bridge, and the scripted stand-in for Claude that
// drives it through the tweak CLI (design.md § Round trips).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { freePort } from "./fixture.js";
import { alive, sleep } from "./util.js";

// `npm run e2e` builds it here first.
export const BIN = process.env.TWEAK_E2E_BIN ?? resolve(import.meta.dirname, "../../../node_modules/.cache/codaset-tweak-e2e/tweak");

// What a development bridge's CLI runs with: TWEAK_BIN, its own port and
// state folder, and HOME and CLAUDE_CONFIG_DIR inside that folder. None of it
// is inherited, so a test never reaches the live bridge or its sessions, or
// reads the real Claude Code settings. The timing options are Go durations,
// such as "1s", each a test-only knob that only a development build reads:
// - againAfter: the bridge sends an unconfirmed tweak again after that
//   instead of 3 minutes (TWEAK_TEST_AGAIN_AFTER);
// - lapseAfter: a session's claims lapse after that without a check-in
//   instead of 10 minutes (TWEAK_TEST_LAPSE_AFTER);
// - unwatchedAfter: a session's commands warn "no watcher running" after
//   that without a watcher instead of 60 seconds (TWEAK_TEST_UNWATCHED_AFTER).
const knobs = { againAfter: "TWEAK_TEST_AGAIN_AFTER", lapseAfter: "TWEAK_TEST_LAPSE_AFTER", unwatchedAfter: "TWEAK_TEST_UNWATCHED_AFTER" };

export async function devBridge(options = {}) {
  if (!existsSync(BIN)) throw new Error(`no tweak binary at ${BIN}: run npm run e2e, which builds it`);
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "tweak-e2e-state-"));
  const env = { ...process.env, TWEAK_BIN: BIN, TWEAK_PORT: String(port), TWEAK_STATE_DIR: state, HOME: state, CLAUDE_CONFIG_DIR: join(state, "claude") };
  for (const [option, name] of Object.entries(knobs)) {
    delete env[name];
    if (options[option]) env[name] = options[option];
  }
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    port,
    state,
    env,
    // Stops the bridge the CLI started, if it's running, keeping its state
    // folder, so the next tweak command starts it again on the same
    // database: POST /shutdown, then wait for its PID to go. Any tweak
    // command starts a missing bridge, tweak watch included, so stop the
    // watcher first to keep it down.
    async shutdown() {
      const file = join(state, "bridge.json");
      if (!existsSync(file)) return;
      const { port: p, pid } = JSON.parse(readFileSync(file, "utf8"));
      await fetch(`http://127.0.0.1:${p}/shutdown`, { method: "POST", headers: { "x-tweak": "1" } }).catch(() => {});
      for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
      if (alive(pid)) process.kill(pid, "SIGKILL");
    },
    // The same, then the state folder goes.
    async stop() {
      await this.shutdown();
      rmSync(state, { recursive: true, force: true });
    },
  };
}

// Runs a command and resolves with its stdout (or, with `both`, its
// {stdout, stderr}); with `input`, that's its stdin. A non-zero exit
// rejects, with stderr in the message.
function run(args, { env, cwd, input, both }) {
  return new Promise((done, fail) => {
    const child = execFile(BIN, args, { env, cwd }, (err, stdout, stderr) => {
      if (err) fail(new Error(`tweak ${args.join(" ")} failed (${err.code}): ${stderr.trim() || err.message}`));
      else done(both ? { stdout, stderr } : stdout);
    });
    child.stdin.end(input ?? "");
  });
}

// The stand-in for Claude: a made-up session ID, working in the fixture copy.
export function standIn(bridge, { folder, session = `claude-stand-in-${process.pid}` }) {
  const env = { ...bridge.env, CLAUDE_CODE_SESSION_ID: session };
  const watchers = new Set();
  const tweak = (...args) => run(args, { env, cwd: folder });
  return {
    session,
    // tweak <args>, in the session's folder, as Claude's Bash tool runs it.
    tweak,
    // The same, with stdin: a `-` message, or a hook's JSON for
    // `tweak hook pre-edit` in the round trips.
    tweakWith: (input, ...args) => run(args, { env, cwd: folder, input }),
    // The same, resolving with {stdout, stderr}, for a command's warnings.
    tweakBoth: (...args) => run(args, { env, cwd: folder, both: true }),
    // A case's edit as Claude's Edit tool makes it: first the PreToolUse
    // hook, with the JSON Claude Code gives it on stdin, then the edit. The
    // hook says nothing, and is quick.
    async edit({ file, find, replace }) {
      const path = join(folder, file);
      const hookInput = {
        session_id: session,
        transcript_path: join(folder, ".transcript.jsonl"),
        cwd: folder,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: path, old_string: find, new_string: replace, replace_all: false },
        tool_use_id: "toolu_e2e",
      };
      const began = Date.now();
      const out = await run(["hook", "pre-edit"], { env, cwd: folder, input: JSON.stringify(hookInput) });
      if (out !== "") throw new Error(`tweak hook pre-edit printed ${JSON.stringify(out)}`);
      if (Date.now() - began > 2000) throw new Error(`tweak hook pre-edit took ${Date.now() - began} ms`);
      const before = readFileSync(path, "utf8");
      if (!before.includes(find)) throw new Error(`${file} has no ${JSON.stringify(find)} to replace`);
      writeFileSync(path, before.replace(find, replace));
    },
    // The SessionEnd hook, as Claude Code runs it on exit or /clear.
    async end(reason = "prompt_input_exit") {
      const input = JSON.stringify({ session_id: session, transcript_path: join(folder, ".transcript.jsonl"), cwd: folder, hook_event_name: "SessionEnd", reason });
      const out = await run(["hook", "session-end"], { env, cwd: folder, input });
      if (out !== "") throw new Error(`tweak hook session-end printed ${JSON.stringify(out)}`);
    },
    claim: (pattern) => tweak("claim", pattern),
    release: () => tweak("release"),
    work: (n) => tweak("work", String(n)),
    done: (n, message) => tweak("done", String(n), message),

    // tweak watch, as Claude's Monitor runs it.
    watch() {
      const proc = spawn(BIN, ["watch"], { env, cwd: folder, stdio: ["ignore", "pipe", "pipe"] });
      const lines = [];
      let stderr = "";
      const waiting = new Set();
      createInterface({ input: proc.stdout }).on("line", (line) => {
        lines.push(line);
        for (const w of waiting) w();
      });
      proc.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise((done) => proc.once("exit", (code) => done(code)));
      const watcher = {
        lines,
        exited,
        // The first line from `from` on that matches, as its match.
        async line(pattern, { from = 0, timeout = 15_000 } = {}) {
          const find = () => lines.slice(from).map((l) => l.match(pattern)).find(Boolean);
          const found = await new Promise((done) => {
            const finish = (m) => {
              clearTimeout(timer);
              waiting.delete(check);
              done(m);
            };
            const check = () => {
              const m = find();
              if (m) finish(m);
            };
            const timer = setTimeout(() => finish(null), timeout);
            waiting.add(check);
            check();
            exited.then(() => finish(find() ?? null));
          });
          if (!found) throw new Error(`tweak watch printed no line matching ${pattern} in ${timeout / 1000} s. It printed:\n${lines.join("\n")}\n${stderr}`);
          return found;
        },
        stop() {
          proc.kill();
          watchers.delete(watcher);
        },
      };
      watchers.add(watcher);
      return watcher;
    },

    // Answers the watcher's next `tweak <n> new` line with tweak work.
    async nextTweak(watcher, opts) {
      const [line, n] = await watcher.line(/^tweak (\d+) new: .*/, opts);
      return { number: Number(n), line, brief: await this.work(n) };
    },

    stop() {
      for (const w of watchers) w.stop();
    },
  };
}
