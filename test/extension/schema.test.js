// The JavaScript side of the bridge contract tests: every example in
// schema/examples validates against its schema, and every invalid one is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");
const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
const jsonFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".json"));
const schemaName = (example) => example.split(".")[0];

const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemas = Object.fromEntries(
  jsonFiles(root).map((f) => [f.replace(/\.json$/, ""), ajv.compile(readJSON(join(root, f)))]),
);

for (const example of jsonFiles(join(root, "examples"))) {
  test(`${example} validates`, () => {
    const validate = schemas[schemaName(example)];
    assert.ok(validate, `no schema for ${example}`);
    assert.ok(validate(readJSON(join(root, "examples", example))), ajv.errorsText(validate.errors));
  });
}

for (const example of jsonFiles(join(root, "examples", "invalid"))) {
  test(`${example} is refused`, () => {
    const validate = schemas[schemaName(example)];
    assert.ok(validate, `no schema for ${example}`);
    assert.equal(validate(readJSON(join(root, "examples", "invalid", example))), false);
  });
}
