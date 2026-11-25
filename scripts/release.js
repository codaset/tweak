// The release workflow's steps (docs/design.md, "Releasing"), run from the
// repo root:
//
//   node scripts/release.js check X.Y.Z               the version is X.Y.Z and above the current one
//   node scripts/release.js checksums <dist>          write checksums.txt for <dist>/tweak-*, there and in the plugin
//   node scripts/release.js stamp X.Y.Z               write X.Y.Z everywhere the version lives
//
// Versions are never edited by hand: only the release workflow runs stamp.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const versionPattern = "\\d+\\.\\d+\\.\\d+";

// Each file that carries the version, and the one line that holds it. Only the
// version is rewritten, so the files keep their formatting and line endings.
const stamps = {
  "plugins/codaset/.claude-plugin/plugin.json": new RegExp(`^(\\s*"version":\\s*")(${versionPattern})(")`, "gm"),
  "extension/manifest.json": new RegExp(`^(\\s*"version":\\s*")(${versionPattern})(")`, "gm"),
  "plugins/codaset/bin/tweak": new RegExp(`^(VERSION=)(${versionPattern})()$`, "gm"),
  "plugins/codaset/bin/tweak.cmd": new RegExp(`^(set "VERSION=)(${versionPattern})(")(?=\\r?$)`, "gm"),
};

class ReleaseError extends Error {}

function parseVersion(v) {
  // Chrome's manifest version takes only dot-separated integers: no prerelease
  // suffixes, and no leading zeros.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v ?? "")) {
    throw new ReleaseError(`version ${JSON.stringify(v)} isn't X.Y.Z`);
  }
  return v.split(".").map(Number);
}

function currentVersion() {
  return JSON.parse(readFileSync("plugins/codaset/.claude-plugin/plugin.json", "utf8")).version;
}

function check(version) {
  const next = parseVersion(version);
  const now = parseVersion(currentVersion());
  const cmp = next.map((n, i) => n - now[i]).find((d) => d !== 0) ?? 0;
  if (cmp <= 0) throw new ReleaseError(`version ${version} isn't above the current ${currentVersion()}`);
}

function checksums(dist) {
  const lines = readdirSync(dist)
    .filter((name) => name.startsWith("tweak-"))
    .sort()
    .map((name) => `${createHash("sha256").update(readFileSync(join(dist, name))).digest("hex")}  ${name}\n`);
  if (lines.length === 0) throw new ReleaseError(`no tweak-* binaries in ${dist}`);
  writeFileSync(join(dist, "checksums.txt"), lines.join(""));
  writeFileSync("plugins/codaset/bin/checksums.txt", lines.join(""));
}

function stamp(version) {
  parseVersion(version);
  // Work out every change before writing any, so a failure stamps nothing.
  const changed = Object.entries(stamps).map(([file, pattern]) => {
    const text = readFileSync(file, "utf8");
    const matches = text.match(pattern) ?? [];
    if (matches.length !== 1) {
      throw new ReleaseError(`${file}: found the version ${matches.length} times, want exactly once`);
    }
    return [file, text.replace(pattern, (_, before, _old, after) => `${before}${version}${after}`)];
  });
  for (const [file, text] of changed) writeFileSync(file, text);
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "check":
      check(args[0]);
      break;
    case "checksums":
      checksums(args[0]);
      break;
    case "stamp":
      stamp(args[0]);
      break;
    default:
      throw new ReleaseError("usage: node scripts/release.js check X.Y.Z | checksums <dist> | stamp X.Y.Z");
  }
} catch (err) {
  if (!(err instanceof ReleaseError) && err.code !== "ENOENT") throw err;
  console.error(err.message);
  process.exit(1);
}
