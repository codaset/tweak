// Fixture apps (design.md § The runner): copy one to a temporary folder,
// start it on a free port in its own process group, and wait until it's
// ready.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { alive, sleep } from "./util.js";

export const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
export const LIVE_PORT = 47391; // the developer's own bridge: never used here
const LINKED = ["node_modules", "vendor"]; // a fixture's installed dependencies

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

// Starts the fixture and resolves once its ready path answers 200 on
// `host`, the host the app is opened on. The returned app has folder, port,
// host, bootMs, url(path), output() and stop().
export async function startFixture(fixture, { readyTimeout = 60_000, host = "localhost" } = {}) {
  const folder = mkdtempSync(join(tmpdir(), `tweak-e2e-${fixture.name}-`));
  // Round trips edit files, so the app runs from a copy. Installed
  // dependencies (node_modules, and vendor/ for gems) are linked, not
  // copied, and may not exist (static has none).
  const linked = new Set(LINKED.map((name) => join(fixture.dir, name)));
  cpSync(fixture.dir, folder, { recursive: true, filter: (src) => basename(src) !== "node_modules" && !linked.has(src) });
  for (const name of LINKED) {
    if (existsSync(join(fixture.dir, name))) symlinkSync(join(fixture.dir, name), join(folder, name));
  }

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
    host,
    url: (path = "/") => `http://${host}:${port}${path}`,
    output: (n = 50) => lines.slice(-n).join("\n"),
    // The whole group: a start command's own children go too. Any member
    // still there after the grace period, the leader gone or not, is killed.
    async stop({ grace = 5000 } = {}) {
      const signal = (sig) => {
        try {
          process.kill(-proc.pid, sig);
        } catch {}
      };
      signal("SIGTERM");
      const end = Date.now() + grace;
      while (alive(-proc.pid) && Date.now() < end) await sleep(50);
      signal("SIGKILL");
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
    if (await ready(host, port, fixture.ready)) break;
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

// Polled on the host the app is opened on. localhost counts as ready on
// either loopback address, as Chrome tries both, so a server bound to only
// 127.0.0.1 or only ::1 (Vite's localhost can be either) is ready.
async function ready(host, port, path) {
  const addresses = host === "localhost" ? ["127.0.0.1", "[::1]"] : [host];
  const answers = await Promise.all(
    addresses.map((a) => fetch(`http://${a}:${port}${path}`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status === 200, () => false)),
  );
  return answers.includes(true);
}
