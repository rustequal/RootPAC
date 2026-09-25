import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeUserPac } from "../src/core/analyze.js";
import { buildSystemPac } from "../src/core/build.js";
import { PSL } from "./support.js";

const guide = readFileSync(new URL("../docs/USER-GUIDE.md", import.meta.url), "utf8");

function examples() {
  const blocks = [];
  const pattern = /```javascript\n([\s\S]*?)```/g;
  for (const match of guide.matchAll(pattern)) {
    if (match[1].includes("function FindProxyForURL")) blocks.push(match[1]);
  }
  return blocks;
}

test("the user guide contains a complete User PAC example", () => {
  assert.ok(examples().length > 0);
});

test("every User PAC example in the guide passes validation and builds", () => {
  for (const text of examples()) {
    const analysis = analyzeUserPac(text);
    assert.deepEqual(analysis.errors ?? null, null);
    assert.ok(analysis.roots.length > 0);
    const groups = Object.fromEntries(analysis.roots.map((mask) => [mask, { rootHost: null, hosts: {} }]));
    const pac = buildSystemPac(text, groups, PSL);
    assert.ok(pac.includes("function FindProxyForURL"));
    for (const mask of analysis.roots) assert.ok(pac.includes(JSON.stringify(mask)));
    for (const mask of analysis.bypass) assert.ok(pac.includes(JSON.stringify(mask)));
  }
});
