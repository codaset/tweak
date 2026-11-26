// A real development bridge, and the scripted stand-in for Claude that
// drives it through the tweak CLI (design.md § Round trips).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { freePort, sleep } from "./fixture.js";

// `npm run e2e` builds it here first.
export const BIN = process.env.TWEAK_E2E_BIN ?? resolve(import.meta.dirname, "../../../node_modules/.cache/codaset-tweak-e2e/tweak");

// What a development bridge's CLI runs with: TWEAK_BIN, its own port and
// state folder, and HOME inside that folder. None of it is inherited, so a
// test never reaches the live bridge or its sessions.
export async function devBridge() {
  if (!existsSync(BIN)) throw new Error(`no tweak binary at ${BIN}: run npm run e2e, which builds it`);
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "tweak-e2e-state-"));
  const env = { ...process.env, TWEAK_BIN: BIN, TWEAK_PORT: String(port), TWEAK_STATE_DIR: state, HOME: state };
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    port,
    state,
    env,
    // The bridge the CLI started, if it's running: POST /shutdown, then wait
    // for its PID to go.
    async stop() {
      const file = join(state, "bridge.json");
      if (existsSync(file)) {
        const { port: p, pid } = JSON.parse(readFileSync(file, "utf8"));
        await fetch(`http://127.0.0.1:${p}/shutdown`, { method: "POST", headers: { "x-tweak": "1" } }).catch(() => {});
        for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      rmSync(state, { recursive: true, force: true });
    },
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const run = promisify(execFile);

// The stand-in for Claude: a made-up session ID, working in the fixture copy.
export function standIn(bridge, { folder, session = `claude-stand-in-${process.pid}` }) {
  const env = { ...bridge.env, CLAUDE_CODE_SESSION_ID: session };
  const watchers = new Set();
  const tweak = async (...args) => (await run(BIN, args, { env, cwd: folder })).stdout;
  return {
    session,
    tweak,
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
