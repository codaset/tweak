// Fixture apps (design.md § The runner): copy one to a temporary folder,
// start it on a free port in its own process group, and wait until it's
// ready.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

export const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
export const LIVE_PORT = 47391; // the developer's own bridge: never used here

// A free port: listen on port 0, read it, close. Never the live bridge's.
export async function freePort() {
  for (;;) {
    const port = await new Promise((done, fail) => {
      const s = createServer().once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => done(port));
      });
    });
    if (port !== LIVE_PORT) return port;
  }
}

// fixture.json, plus the expected cases and where the fixture lives.
export function loadFixture(dir) {
  dir = resolve(FIXTURES, dir);
  const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const config = read("fixture.json");
  return { name: basename(dir), dir, ...config, needs: config.needs ?? [], cases: read("expected.json") };
}

// The toolchains a fixture needs that aren't on PATH. Locally a fixture
// missing one is skipped with a message saying so; in CI it fails the run.
export function missingToolchains(fixture, path = process.env.PATH ?? "") {
  const found = (cmd) => path.split(delimiter).some((d) => d && existsSync(join(d, cmd)));
  return fixture.needs.filter((cmd) => !found(cmd));
}

export function skipReason(fixture, { ci = Boolean(process.env.CI), path } = {}) {
  const missing = missingToolchains(fixture, path);
  if (!missing.length) return null;
  const message = `${fixture.name} needs ${missing.join(", ")}, which isn't on PATH`;
  if (ci) throw new Error(`${message}: CI must have every fixture's toolchain`);
  return `${message}: skipped`;
}

// Starts the fixture and resolves once its ready path answers 200. The
// returned app has url(path), output() and stop().
export async function startFixture(fixture, { readyTimeout = 60_000, host = "localhost" } = {}) {
  const folder = mkdtempSync(join(tmpdir(), `tweak-e2e-${fixture.name}-`));
  // Round trips edit files, so the app runs from a copy. node_modules is
  // linked, not copied, and may not exist (static has no dependencies).
  cpSync(fixture.dir, folder, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
  if (existsSync(join(fixture.dir, "node_modules"))) symlinkSync(join(fixture.dir, "node_modules"), join(folder, "node_modules"));

  const port = await freePort();
  const [cmd, ...args] = fixture.start.map((a) => a.replaceAll("{port}", String(port)));
  const started = Date.now();
  const proc = spawn(cmd, args, { cwd: folder, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...fixture.env } });
  const lines = [];
  const keep = (chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    lines.splice(0, Math.max(0, lines.length - 200));
  };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  const exited = new Promise((done) => proc.once("exit", (code, signal) => done(signal ?? code)));

  const app = {
    folder,
    port,
    url: (path = "/") => `http://${host}:${port}${path}`,
    output: (n = 50) => lines.slice(-n).join("\n"),
    // The whole group: a start command's own children go too. Any member
    // still there after the grace period, the leader gone or not, is killed.
    async stop({ grace = 5000 } = {}) {
      signalGroup(proc.pid, "SIGTERM");
      const end = Date.now() + grace;
      while (signalGroup(proc.pid, 0) && Date.now() < end) await sleep(50);
      signalGroup(proc.pid, "SIGKILL");
      rmSync(folder, { recursive: true, force: true });
    },
  };

  const deadline = started + readyTimeout;
  let quit;
  exited.then((how) => (quit = how));
  for (;;) {
    if (quit !== undefined) {
      await app.stop();
      throw new Error(`${fixture.name} exited (${quit}) before it was ready. Its last 50 lines:\n${app.output()}`);
    }
    const status = await fetch(`http://127.0.0.1:${port}${fixture.ready}`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
    if (status === 200) break;
    if (Date.now() > deadline) {
      const output = app.output();
      await app.stop();
      throw new Error(`${fixture.name} wasn't ready at ${fixture.ready} within ${readyTimeout / 1000} s. Its last 50 lines:\n${output}`);
    }
    await sleep(100);
  }
  app.bootMs = Date.now() - started;
  return app;
}

// Signals a process group; false once no member is left.
function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export const sleep =(ms) => new Promise((r) => setTimeout(r, ms));
