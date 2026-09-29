import { test } from "node:test";
import assert from "node:assert/strict";
import { SAME, handedRoots, normalizeAnswer, normalizeSites, releaseSites, siteOf, verdict } from "../src/core/routes.js";
import { PSL } from "./support.js";

test("a site is the registrable domain, and a public suffix is a site of its own", () => {
  assert.equal(siteOf("a.b.fbcdn.net", PSL), "fbcdn.net");
  assert.equal(siteOf("x.github.io", PSL), "x.github.io");
  assert.equal(siteOf("github.io", PSL), "github.io");
});

test("an answer is compared by its proxy items only", () => {
  assert.equal(normalizeAnswer("PROXY a:1; DIRECT"), "PROXY a:1");
  assert.equal(normalizeAnswer(" socks5 b:2 ;PROXY a:1"), "socks5 b:2; PROXY a:1");
  assert.equal(normalizeAnswer("DIRECT"), null);
  assert.equal(normalizeAnswer(null), null);
});

test("owners keep only roots and held sites, every root owns its site, and a new root takes it back", () => {
  const groups = { "a.com": { rootHost: "a.com", hosts: { "cdn.net": 1 } }, "b.com": { rootHost: null, hosts: {} } };
  const sites = { "a.com": "a.com", "b.com": "a.com", "cdn.net": "a.com", "gone.net": "a.com", "x.org": "old.com" };
  assert.deepEqual(normalizeSites(sites, groups, ["a.com", "b.com"], PSL), { "a.com": "a.com", "b.com": "a.com", "cdn.net": "a.com" });
  assert.deepEqual(normalizeSites(sites, groups, ["a.com", "b.com"], PSL, ["a.com"]), { "a.com": "a.com", "b.com": "b.com", "cdn.net": "a.com" });
  const kept = { "a.com": "a.com", "b.com": "b.com", "cdn.net": "a.com" };
  assert.equal(normalizeSites(kept, groups, ["a.com", "b.com"], PSL), kept);
});

test("a removed root's sites leave every group", () => {
  const groups = { "a.com": { rootHost: "a.com", hosts: { "x.cdn.net": 1, "img.org": 2 } }, "b.com": { rootHost: "b.com", hosts: { "img.org": 3 } } };
  const sites = { "cdn.net": "gone.com", "img.org": "b.com" };
  assert.deepEqual(releaseSites(groups, sites, ["a.com", "b.com"], PSL), { "a.com": { rootHost: "a.com", hosts: { "img.org": 2 } }, "b.com": groups["b.com"] });
  assert.equal(releaseSites(groups, { "img.org": "b.com" }, ["a.com", "b.com"], PSL), groups);
});

test("a root is closed only when a root of another site on another proxy routes its site", () => {
  const groups = { "a.com": { rootHost: null, hosts: {} }, "b.com": { rootHost: null, hosts: {} }, "www.a.com": { rootHost: null, hosts: {} } };
  const answers = { "a.com": "PROXY a:1", "b.com": "PROXY b:1", "www.a.com": "PROXY w:1" };
  assert.deepEqual(handedRoots({ groups, sites: { "a.com": "b.com", "b.com": "b.com" } }, ["a.com", "b.com"], answers, PSL), ["a.com"]);
  // A stored User PAC from an older version may put two roots in one site: the second is left to the first.
  assert.deepEqual(handedRoots({ groups, sites: { "a.com": "a.com", "b.com": "b.com" } }, ["a.com", "www.a.com", "b.com"], answers, PSL), []);
  assert.equal(verdict("a.com", "a.com", {}), SAME);
});
