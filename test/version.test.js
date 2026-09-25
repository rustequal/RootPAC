import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

test("package.json carries the extension version from manifest.json", () => {
  assert.equal(read("package.json").version, read("manifest.json").version);
});
