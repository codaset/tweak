// The runner's fixture handling, without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture, skipReason, startFixture } from "./fixture.js";
import { alive, sleep } from "./util.js";

// A throwaway fixture whose start command is a node script.
function fakeFixture(script, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tweak-fake-fixture-"));
  writeFileSync(join(dir, "app.mjs"), script);
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ start: [process.execPath, "app.mjs", "{port}"], ready: "/ready", ...extra }));
  writeFileSync(join(dir, "expected.json"), "[]");
  return loadFixture(dir);
}

const SERVER = `
import http from "node:http";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
// A grandchild in the same process group, which must go when the app stops.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync("pids", JSON.stringify([process.pid, child.pid]));
http.createServer((req, res) => res.end(req.url)).listen(Number(process.argv[2]), "127.0.0.1");
`;

test("a fixture runs from a copy on a free port, and stopping it ends its whole process group", async () => {
  const fixture = fakeFixture(SERVER);
  const app = await startFixture(fixture);
  assert.notEqual(app.folder, fixture.dir);
  assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/ready`)).text(), "/ready");
  assert.equal(app.url("/x"), `http://localhost:${app.port}/x`);
  const pids = JSON.parse(readFileSync(join(app.folder, "pids"), "utf8"));
  assert.ok(!existsSync(join(fixture.dir, "pids")), "the fixture itself is untouched");
  await app.stop();
  for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(50);
  assert.deepEqual(pids.map(alive), [false, false]);
  assert.ok(!existsSync(app.folder));
});

test("stopping a fixture kills a child that ignores SIGTERM, even after its parent has gone", async () => {
  const fixture = fakeFixture(`
import http from "node:http";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync("pids", JSON.stringify([process.pid, child.pid]));
http.createServer((req, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");
`);
  const app = await startFixture(fixture);
  const pids = JSON.parse(readFileSync(join(app.folder, "pids"), "utf8"));
  await app.stop({ grace: 500 });
  for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(50);
  assert.deepEqual(pids.map(alive), [false, false]);
});

for (const [bound, family] of [["127.0.0.1", "IPv4"], ["::1", "IPv6"]]) {
  test(`a server bound to ${family} loopback only is ready on localhost`, async () => {
    const fixture = fakeFixture(`
import http from "node:http";
http.createServer((req, res) => res.end("ok")).listen(Number(process.argv[2]), ${JSON.stringify(bound)});
`);
    const app = await startFixture(fixture, { readyTimeout: 5000 });
    try {
      assert.equal(app.url("/"), `http://localhost:${app.port}/`);
    } finally {
      await app.stop();
    }
  });
}

test("node_modules is linked into the copy, not copied", async () => {
  const fixture = fakeFixture(SERVER);
  mkdirSync(join(fixture.dir, "node_modules/dep"), { recursive: true });
  writeFileSync(join(fixture.dir, "node_modules/dep/index.js"), "");
  const app = await startFixture(fixture);
  try {
    assert.ok(existsSync(join(app.folder, "node_modules/dep/index.js")));
    writeFileSync(join(fixture.dir, "node_modules/dep/later.js"), "");
    assert.ok(existsSync(join(app.folder, "node_modules/dep/later.js")));
  } finally {
    await app.stop();
  }
});

test("a fixture that never gets ready fails with its last 50 lines", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
  const fixture = fakeFixture(`console.log(${JSON.stringify(lines.join("\n"))}); setInterval(() => {}, 1000);`);
  await assert.rejects(startFixture(fixture, { readyTimeout: 1500 }), (err) => {
    assert.match(err.message, /wasn't ready at \/ready within 1.5 s/);
    assert.ok(err.message.endsWith(lines.slice(-50).join("\n")));
    assert.ok(!err.message.includes("line 30\n"));
    return true;
  });
});

test("a fixture that exits before it's ready fails at once, with its output", async () => {
  const fixture = fakeFixture(`console.error("boom: no such gem"); process.exit(3);`);
  const started = Date.now();
  await assert.rejects(startFixture(fixture), /exited \(3\) before it was ready[\s\S]*boom: no such gem/);
  assert.ok(Date.now() - started < 10_000);
});

test("every fixture has its config, its cases, its test file and a Dependabot entry", () => {
  const root = join(import.meta.dirname, "../../..");
  const dependabot = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
  const names = readdirSync(join(root, "fixtures"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(names.includes("static"));
  for (const name of names) {
    const fixture = loadFixture(name);
    assert.ok(Array.isArray(fixture.start) && fixture.start.some((a) => a.includes("{port}")), `${name}: start has a {port}`);
    assert.ok(fixture.ready.startsWith("/"), `${name}: ready is a path`);
    for (const c of fixture.cases) assert.ok(c.name && c.pick && Array.isArray(c.locations) && Array.isArray(c.clues), `${name}: case ${c.name} is complete`);
    assert.ok(existsSync(join(root, `test/e2e/${name}.test.js`)), `${name}: test/e2e/${name}.test.js`);
    assert.match(dependabot, new RegExp(`directory: /fixtures/${name}\\n[\\s\\S]*?groups:\\n\\s+${name}:`), `${name}: a grouped Dependabot entry`);
  }
});

test("a missing toolchain skips the fixture locally and fails it in CI", () => {
  const fixture = fakeFixture("", { needs: ["ruby-that-isnt-installed"] });
  assert.match(skipReason(fixture, { ci: false }), /needs ruby-that-isnt-installed, which isn't on PATH: skipped/);
  assert.throws(() => skipReason(fixture, { ci: true }), /CI must have every fixture's toolchain/);
  assert.equal(skipReason(fakeFixture("", { needs: ["node"] }), { ci: true, path: join(process.execPath, "..") }), null);
});
