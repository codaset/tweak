// The `consistency` CI job: one X.Y.Z version across the plugin, the extension
// and the launcher (docs/design.md, "Versions"), and matching licence copies.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const problems = [];

const versions = {
  "plugins/codaset/.claude-plugin/plugin.json": JSON.parse(read("plugins/codaset/.claude-plugin/plugin.json")).version,
  "extension/manifest.json": JSON.parse(read("extension/manifest.json")).version,
  "plugins/codaset/bin/tweak": read("plugins/codaset/bin/tweak").match(/^VERSION=(.*)$/m)?.[1],
  "plugins/codaset/bin/tweak.cmd": read("plugins/codaset/bin/tweak.cmd").match(/^set "VERSION=(.*)"\r?$/m)?.[1],
};

for (const [file, v] of Object.entries(versions)) {
  if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) problems.push(`${file}: version ${JSON.stringify(v)} isn't X.Y.Z`);
}
if (new Set(Object.values(versions)).size > 1) {
  problems.push(
    "versions differ:\n" + Object.entries(versions).map(([f, v]) => `  ${f}: ${v}`).join("\n"),
  );
}

const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
if (marketplace.plugins.some((p) => "version" in p)) {
  problems.push(".claude-plugin/marketplace.json: set the version only in plugin.json");
}

if (read("LICENSE") !== read("plugins/codaset/LICENSE")) {
  problems.push("plugins/codaset/LICENSE differs from LICENSE");
}

// The shipped skill is design.md's agreed text, byte for byte: the
// four-backtick markdown block under "### The /tweak skill".
const skill = read("docs/design.md").match(/^### The \/tweak skill\n[\s\S]*?^````markdown\n([\s\S]*?)^````$/m)?.[1];
if (skill === undefined) {
  problems.push("docs/design.md: no ````markdown block under ### The /tweak skill");
} else if (read("plugins/codaset/skills/tweak/SKILL.md") !== skill) {
  problems.push("plugins/codaset/skills/tweak/SKILL.md differs from the skill text in docs/design.md § The /tweak skill");
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`consistent: ${Object.values(versions)[0]}`);
