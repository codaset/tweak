// scripts/release.js, the release workflow's steps: check the version, write
// checksums.txt, and stamp the version into the repo. Each test runs the
// script in a temporary copy of the files it touches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repo, "scripts/release.js");
const stamped = [
  "plugins/codaset/.claude-plugin/plugin.json",
  "extension/manifest.json",
  "plugins/codaset/bin/tweak",
  "plugins/codaset/bin/tweak.cmd",
];

function copyOfRepo() {
  const root = mkdtempSync(join(tmpdir(), "tweak-release-"));
  for (const file of [...stamped, ".claude-plugin/marketplace.json", "LICENSE", "plugins/codaset/LICENSE", "scripts/check-consistency.js"]) {
    cpSync(join(repo, file), join(root, file));
  }
  return root;
}

function release(root, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

const current = JSON.parse(readFileSync(join(repo, "plugins/codaset/.claude-plugin/plugin.json"), "utf8")).version;
const next = current.replace(/\d+$/, (z) => String(Number(z) + 1));

test("check accepts a version above the current one", () => {
  const res = release(copyOfRepo(), "check", next);
  assert.equal(res.status, 0, res.stderr);
});

test("check refuses anything that isn't a higher X.Y.Z", () => {
  const root = copyOfRepo();
  for (const bad of ["", "v1.2.3", "1.2", "1.2.3-beta", "01.2.3", current, "0.0.1"]) {
    const res = release(root, "check", bad);
    assert.equal(res.status, 1, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.stderr, /version/);
  }
});

test("checksums writes the SHA-256 of each binary, in sha256sum's format", () => {
  const dist = mkdtempSync(join(tmpdir(), "tweak-dist-"));
  writeFileSync(join(dist, "tweak-linux-amd64"), "abc");
  writeFileSync(join(dist, "tweak-darwin-arm64"), "");
  writeFileSync(join(dist, "tweak-windows-amd64.exe"), "x");
  const root = copyOfRepo();
  const res = release(root, "checksums", dist);
  assert.equal(res.status, 0, res.stderr);
  // Known SHA-256 values of "", "abc" and "x".
  const want =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  tweak-darwin-arm64\n" +
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  tweak-linux-amd64\n" +
    "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  tweak-windows-amd64.exe\n";
  assert.equal(readFileSync(join(dist, "checksums.txt"), "utf8"), want);
  // The plugin ships the same file beside the launcher.
  assert.equal(readFileSync(join(root, "plugins/codaset/bin/checksums.txt"), "utf8"), want);
  // The launcher's own check agrees, where sha256sum or shasum is installed.
  const tool = ["sha256sum", "shasum"].find((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);
  if (tool) {
    const args = tool === "shasum" ? ["-a", "256", "-c", "checksums.txt"] : ["-c", "checksums.txt"];
    execFileSync(tool, args, { cwd: dist });
  }
});

test("checksums refuses a folder with no binaries", () => {
  const res = release(copyOfRepo(), "checksums", mkdtempSync(join(tmpdir(), "tweak-dist-")));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no tweak-\* binaries/);
});

test("stamp writes the version everywhere it lives", () => {
  const root = copyOfRepo();
  const before = Object.fromEntries(stamped.map((f) => [f, readFileSync(join(root, f), "utf8")]));

  const res = release(root, "stamp", "4.5.6");
  assert.equal(res.status, 0, res.stderr);

  assert.equal(JSON.parse(readFileSync(join(root, stamped[0]), "utf8")).version, "4.5.6");
  assert.equal(JSON.parse(readFileSync(join(root, stamped[1]), "utf8")).version, "4.5.6");
  assert.match(readFileSync(join(root, stamped[2]), "utf8"), /^VERSION=4\.5\.6$/m);
  assert.match(readFileSync(join(root, stamped[3]), "utf8"), /^set "VERSION=4\.5\.6"\r?$/m);
  // Only the version changes: formatting, the manifest's manifest_version and the rest stay.
  for (const f of stamped) {
    const after = readFileSync(join(root, f), "utf8");
    assert.equal(after.replaceAll("4.5.6", current), before[f], `${f} changed beyond its version`);
  }
  assert.ok(statSync(join(root, stamped[2])).mode & 0o111, "launcher lost its exec bit");
  // The consistency job agrees with the result.
  execFileSync(process.execPath, [join(root, "scripts/check-consistency.js")]);
});

test("stamp refuses a file whose version it can't find exactly once", () => {
  const root = copyOfRepo();
  const launcher = join(root, "plugins/codaset/bin/tweak");
  writeFileSync(launcher, readFileSync(launcher, "utf8").replace(/^VERSION=/m, "VERSION_="));
  const res = release(root, "stamp", "4.5.6");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /plugins\/codaset\/bin\/tweak/);
  // Nothing was half-stamped.
  assert.equal(JSON.parse(readFileSync(join(root, stamped[0]), "utf8")).version, current);
});

test("stamp refuses an invalid version", () => {
  const res = release(copyOfRepo(), "stamp", "1.2");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /version/);
});
