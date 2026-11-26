// The test copy of the extension (design.md § The runner).
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LIVE_PORT } from "./fixture.js";

export const EXTENSION = resolve(import.meta.dirname, "../../../extension");

// What the test copy adds to the worker: a test-only message that calls the
// handlers headless Chrome can't reach: the shortcuts'. `name` is the
// handler; the sender's tab is passed to it.
// Add each handler here as its ticket names it in worker.js.
const TEST_MESSAGE = `
// ---- Test copy only (test/e2e/harness/extension.js) ----
const e2eHandlers = { "side-panel": openSidePanel, "pick-mode": pickMode, pins: togglePins };
// How many captures the tabs hold, waiting for Send (design.md § Screenshot).
globalThis.e2eHeldCaptures = () => [...tabs].reduce((n, port) => n + port.shots.size, 0);
// How many retries the worker has scheduled since the bridge last answered:
// the socket closing schedules the first, each refused try one more.
globalThis.e2eRetries = () => bridge.attempt;
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "e2e:handler") return;
  const fail = (err) => reply({ ok: false, error: String(err?.message ?? err) });
  // Called at once, not after an await: the message's user gesture ends
  // with this listener.
  try {
    Promise.resolve(e2eHandlers[msg.name](sender.tab)).then(() => reply({ ok: true }), fail);
  } catch (err) {
    fail(err);
  }
  return true;
});
`;

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

// Copies extension/ into a temporary folder:
// - DEFAULT_PORT is the test bridge's, and no file may still name the live port;
// - http://localhost/* is a host permission, the pre-grant the prompt can't give headlessly;
//   with allUrls, so is <all_urls>, as after Allow access (screenshots need it);
// - the worker hears the test-only message;
// - the worker's reconnect backoff is a tenth of the real one (100, 200,
//   500 ms, then every second), so a test of the bridge going down and up
//   waits a fraction of a second, not up to 10 s, for the next try. The real
//   steps are unit-tested (test/extension/connection.test.js).
export const TEST_BACKOFF = [100, 200, 500, 1000];
export function testCopy({ bridgePort, source = EXTENSION, allUrls = false }) {
  if (bridgePort === LIVE_PORT) throw new Error(`refusing the live bridge's port ${LIVE_PORT}`);
  const dir = mkdtempSync(join(tmpdir(), "tweak-e2e-extension-"));
  cpSync(source, dir, { recursive: true });
  for (const file of walk(dir).filter((f) => f.endsWith(".js") || f.endsWith(".html"))) {
    let src = readFileSync(file, "utf8").replaceAll(`DEFAULT_PORT = ${LIVE_PORT}`, `DEFAULT_PORT = ${bridgePort}`);
    if (file.endsWith(".html")) src = src.replaceAll(`placeholder="${LIVE_PORT}"`, `placeholder="${bridgePort}"`);
    if (src.includes(String(LIVE_PORT))) throw new Error(`${file.slice(dir.length + 1)} still names port ${LIVE_PORT}: teach testCopy to patch it`);
    writeFileSync(file, src);
  }

  const backoffFile = join(dir, "lib", "backoff.js");
  const backoff = readFileSync(backoffFile, "utf8");
  const steps = /const STEPS = \[[\d, ]+\];/;
  if (!steps.test(backoff)) throw new Error("lib/backoff.js has no STEPS line: teach testCopy to patch it");
  writeFileSync(backoffFile, backoff.replace(steps, `const STEPS = ${JSON.stringify(TEST_BACKOFF).replaceAll(",", ", ")};`));

  const manifestFile = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), "http://localhost/*", ...(allUrls ? ["<all_urls>"] : [])])];
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const workerFile = join(dir, manifest.background.service_worker);
  const worker = readFileSync(workerFile, "utf8");
  for (const name of ["openSidePanel", "pickMode", "togglePins"]) {
    if (!new RegExp(`function ${name}\\b`).test(worker)) throw new Error(`worker.js has no ${name}: update the test message in testCopy`);
  }
  if (!/const tabs = new Set\(\)/.test(worker) || !/port\.shots = /.test(worker)) throw new Error("worker.js has no tabs or port.shots: update the test message in testCopy");
  if (!/const bridge = \{\n\s+ws: null,\n\s+attempt: 0,/.test(worker)) throw new Error("worker.js has no bridge.attempt: update the test message in testCopy");
  writeFileSync(workerFile, worker + TEST_MESSAGE);
  return dir;
}
