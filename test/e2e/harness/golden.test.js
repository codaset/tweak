// The golden-case matcher, against design.md's own example brief.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { briefProblems, whereToLook } from "./golden.js";

const design = readFileSync(resolve(import.meta.dirname, "../../../docs/design.md"), "utf8");
const EXAMPLE = design.match(/`````markdown\n([\s\S]*?)`````/)[1];

const element = { file: "app/javascript/components/UserForm.tsx", line: 84, role: "element", via: "react" };
const second = { file: "app/javascript/components/UserForm.tsx", line: 91, role: "element", via: "react" };
const template = { file: "app/views/admin/users/edit.html.erb", role: "component", via: "rails" };

test("the example brief lists four places to look", () => {
  assert.equal(whereToLook(EXAMPLE).length, 4);
  assert.deepEqual(whereToLook("# Tweak 1\n\n## Element 1: `a`\n"), []);
});

test("listed locations match the first ones under Where to look, in order", () => {
  assert.deepEqual(briefProblems(EXAMPLE, { locations: [element, second, template] }), []);
  assert.deepEqual(briefProblems(EXAMPLE, { locations: [second] }), [
    "location 1 should be `app/javascript/components/UserForm.tsx:91` (element, react), not: - `app/javascript/components/UserForm.tsx:84:7`: element 1 (React, exact)",
  ]);
});

test("a location's line, role and mapper all count", () => {
  assert.equal(briefProblems(EXAMPLE, { locations: [{ ...element, line: 8 }] }).length, 1, "line 8 isn't line 84");
  assert.equal(briefProblems(EXAMPLE, { locations: [{ ...element, line: undefined }] }).length, 1, "file only, but the brief has a line");
  assert.match(briefProblems(EXAMPLE, { locations: [{ ...element, via: "vue" }] })[0], /should say element and vue/);
  assert.match(briefProblems(EXAMPLE, { locations: [element, second, { ...template, role: "element" }] })[0], /location 3 should say element and rails/);
});

test("a CSS rule's line, its selector after the place, is a style location from the css mapper", () => {
  const rule = { file: "app/assets/stylesheets/buttons.css", line: 42, role: "style", via: "css" };
  assert.deepEqual(briefProblems(EXAMPLE, { locations: [element, second, template, rule] }), []);
  assert.match(briefProblems(EXAMPLE, { locations: [element, second, template, { ...rule, via: "proscenium" }] })[0], /should say style and proscenium/);
  assert.match(briefProblems(EXAMPLE, { locations: [{ ...element, role: "style", via: "css" }] })[0], /should say style and css/, "a React line isn't a rule");
});

test("more locations than the brief lists is a problem", () => {
  const five = [element, second, template, template, template];
  assert.match(briefProblems(EXAMPLE, { locations: five }).at(-1), /location 5, .* isn't listed: "Where to look" has 4/);
});

test("clues must all be present, quoting aside", () => {
  assert.deepEqual(briefProblems(EXAMPLE, { clues: ["data-testid=save-user", "class user-form__submit"] }), []);
  assert.deepEqual(briefProblems(EXAMPLE, { clues: ["data-testid=save"] }), ["clue data-testid=save is missing"], "a clue's prefix isn't the clue");
  assert.deepEqual(briefProblems(EXAMPLE, { clues: ["data-testid=delete-user"] }), ["clue data-testid=delete-user is missing"]);
});
