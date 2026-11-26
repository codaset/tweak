// A pin's number is 11px text on its status colour: each tone's on-colour
// must reach WCAG's 4.5:1 against it, in light and in dark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../extension/content/overlay.js", import.meta.url), "utf8");
const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
const themes = { light: tokens(light), dark: { ...tokens(light), ...tokens(dark.split("\n    }\n")[0]) } };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Text in the card's conversation, on what it sits on: the question's
// label and text in its tinted box, the reason's label, and muted text.
const TEXT = [
  ["question-text", "question-surface"],
  ["text", "question-surface"],
  ["tone-ended", "bg"],
  ["muted", "bg"],
];
for (const [theme, t] of Object.entries(themes)) {
  for (const [fg, bg] of TEXT) {
    test(`${theme}: --${fg} text on --${bg} has 4.5:1 contrast`, () => {
      assert.ok(t[fg] && t[bg], `--${fg} and --${bg} must be defined`);
      const ratio = contrast(t[bg], t[fg]);
      assert.ok(ratio >= 4.5, `${t[fg]} on ${t[bg]} is ${ratio.toFixed(2)}:1`);
    });
  }
}

for (const [theme, t] of Object.entries(themes)) {
  for (const tone of ["sent", "working", "question", "done", "ended"]) {
    test(`${theme}: a ${tone} pin's number has 4.5:1 contrast`, () => {
      const bg = t[`tone-${tone}`];
      const fg = t[`on-${tone}`];
      assert.ok(bg && fg, `--tone-${tone} and --on-${tone} must be defined`);
      const ratio = contrast(bg, fg);
      assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    });
  }
}
