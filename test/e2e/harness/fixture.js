// Fixture apps (design.md § The runner): copy one to a temporary folder,
// start it on a free port in its own process group, and wait until it's
// ready.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { alive, sleep } from "./util.js";

export const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
export const LIVE_PORT = 47391; // the developer's own bridge: never used here
const LINKED = ["node_modules", "vendor"]; // a fixture's installed dependencies
// The file each start writes into the folder its fixture's server serves at
// the root (fixture.json's `public`), holding a token only that start knows.
const MARKER = "tweak-e2e-marker.txt";

// A free port: one no server holds on either loopback address. Listening on
// 127.0.0.1 alone isn't enough: a server on localhost can be on ::1, whose
// port the kernel will hand out again for 127.0.0.1, and a page opened on
// localhost could then reach either server. Never the live bridge's.
export async function freePort() {
  for (;;) {
    const port = await listenAndClose(0, "127.0.0.1");
    if (port !== LIVE_PORT && (await portFree(port))) return port;
  }
}

// Whether no server holds the port on 127.0.0.1 or ::1. A machine without
// IPv6 has no ::1 to hold it on.
export async function portFree(port) {
  for (const address of ["127.0.0.1", "::1"]) {
    try {
      await listenAndClose(port, address);
    } catch (error) {
      if (address === "::1" && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)) continue;
      return false;
    }
  }
  return true;
}

function listenAndClose(port, address) {
  return new Promise((done, fail) => {
    const s = createServer().once("error", fail);
    s.listen(port, address, () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
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

// Starts the fixture and resolves once it's ready on `host`, the host the
// app is opened on: its server serves this start's marker and answers 200
// on the ready path. A server that answers the marker with anything else is
// another app on the same port, e.g. another fixture that got the same port
// from freePort in the moment before either server listened. Then this
// start is stopped and the fixture starts again on a fresh port, `attempts`
// times in all, after which the start fails, naming the port. The returned
// app has folder, port, host, bootMs, url(path), output() and stop().
// `port` is the first attempt's port, for tests.
export async function startFixture(fixture, { attempts = 3, port, ...options } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(fixture, port ?? (await freePort()), options);
    } catch (error) {
      if (!(error instanceof PortTaken) || attempt >= attempts) throw error;
      port = undefined;
    }
  }
}

class PortTaken extends Error {}

// How many polls in a row must find another server before the port counts
// as taken, so an app that answers oddly for a moment as it boots isn't.
const FOREIGN_POLLS = 5;

async function startOnce(fixture, port, { readyTimeout = 60_000, host = "localhost" } = {}) {
  const folder = mkdtempSync(join(tmpdir(), `tweak-e2e-${fixture.name}-`));
  // Round trips edit files, so the app runs from a copy. Installed
  // dependencies (node_modules, and vendor/ for gems) are linked, not
  // copied, and may not exist (static has none).
  const linked = new Set(LINKED.map((name) => join(fixture.dir, name)));
  cpSync(fixture.dir, folder, { recursive: true, filter: (src) => basename(src) !== "node_modules" && !linked.has(src) });
  for (const name of LINKED) {
    if (existsSync(join(fixture.dir, name))) symlinkSync(join(fixture.dir, name), join(folder, name));
  }
  const token = randomUUID();
  mkdirSync(join(folder, fixture.public), { recursive: true });
  writeFileSync(join(folder, fixture.public, MARKER), token);

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
  const fail = async (Kind, message) => {
    const output = app.output();
    await app.stop();
    throw new Kind(`${message}. Its last 50 lines:\n${output}`);
  };

  const deadline = started + readyTimeout;
  let quit;
  exited.then((how) => (quit = how));
  for (let foreignPolls = 0; ; ) {
    const gone = quit !== undefined;
    const { ready, foreign } = await poll(host, port, fixture.ready, token);
    foreignPolls = foreign ? foreignPolls + 1 : 0;
    // A start command that quit because the port was taken counts as taken.
    if (foreign && (gone || foreignPolls >= FOREIGN_POLLS)) {
      await fail(PortTaken, `${fixture.name}: another server answers on port ${port} (on ${foreign}), not this start's app`);
    }
    if (gone) await fail(Error, `${fixture.name} exited (${quit}) before it was ready`);
    if (ready && !foreign) break;
    if (Date.now() > deadline) await fail(Error, `${fixture.name} wasn't ready at ${fixture.ready} within ${readyTimeout / 1000} s`);
    await sleep(100);
  }
  app.bootMs = Date.now() - started;
  return app;
}

// Polled on the host the app is opened on. localhost means both loopback
// addresses, as Chrome tries both: the app is ready when one of them serves
// this start's marker and answers 200 on the ready path, so a server bound
// to only 127.0.0.1 or only ::1 is ready. `foreign` names any address that
// answers the marker with something else: another server.
async function poll(host, port, path, token) {
  const addresses = host === "localhost" ? ["127.0.0.1", "[::1]"] : [host];
  const get = (p) => fetch(`http://${p}`, { signal: AbortSignal.timeout(2000) });
  const states = await Promise.all(
    addresses.map(async (a) => {
      let ours;
      try {
        const r = await get(`${a}:${port}/${MARKER}`);
        ours = r.status === 200 && (await r.text()) === token;
      } catch {
        return "down"; // nothing listening there, or not answering yet
      }
      if (!ours) return "foreign";
      return (await get(`${a}:${port}${path}`).then((r) => r.status === 200, () => false)) ? "ready" : "starting";
    }),
  );
  const foreign = addresses.filter((_, i) => states[i] === "foreign");
  return { ready: states.includes("ready"), foreign: foreign.join(", ") };
}
