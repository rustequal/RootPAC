import { test } from "node:test";
import assert from "node:assert/strict";
import { SAME, handedRoots, normalizeAnswer, normalizeSites, releaseSites, routedGroups, routesOf, siteIn, siteOf, verdict } from "../src/core/routes.js";
import { PSL } from "./support.js";

test("a site is the registrable domain, and a public suffix is a site of its own", () => {
  assert.equal(siteOf("a.b.fbcdn.net", PSL), "fbcdn.net");
  assert.equal(siteOf("x.github.io", PSL), "x.github.io");
  assert.equal(siteOf("github.io", PSL), "github.io");
});

test("a name in a root's domain goes the way of the root: its site is the root's, whatever its registrable domain", () => {
  const roots = ["kawasaki.jp", "facebook.com"];
  assert.equal(siteOf("s3.a-b.github.kawasaki.jp", PSL), "a-b.github.kawasaki.jp");
  assert.equal(siteIn("s3.a-b.github.kawasaki.jp", roots, PSL), "kawasaki.jp");
  assert.equal(siteIn("static.xx.facebook.com", roots, PSL), "facebook.com");
  assert.equal(siteIn("a.cdn.net", roots, PSL), "cdn.net");
  // A record of another root's domain is allowed and routed only as that root is: here through kawasaki.jp, on another proxy.
  const groups = { "a.com": { rootHost: "a.com", hosts: { "s3.a-b.github.kawasaki.jp": 1 } }, "kawasaki.jp": { rootHost: null, hosts: {} }, "facebook.com": { rootHost: null, hosts: {} } };
  const sites = { "a.com": "a.com", "kawasaki.jp": "kawasaki.jp", "facebook.com": "facebook.com" };
  const answers = { "a.com": "PROXY a:1", "kawasaki.jp": "PROXY k:1", "facebook.com": "PROXY a:1" };
  const all = ["a.com", ...roots];
  assert.deepEqual(routesOf({ groups, sites }, all, answers, PSL).get("a.com"), { allow: ["a.com"], allowExact: [] });
  assert.equal(routedGroups(groups, sites, all, PSL).routed["kawasaki.jp"].hosts["s3.a-b.github.kawasaki.jp"], 1);
  // A root that handed its site over takes the records under its domain with it to the new owner.
  const handed = { ...sites, "kawasaki.jp": "facebook.com" };
  const { routed, pacRoots } = routedGroups(groups, handed, all, PSL);
  assert.deepEqual(pacRoots, ["a.com", "facebook.com"]);
  assert.deepEqual(Object.keys(routed["facebook.com"].hosts).sort(), ["kawasaki.jp", "s3.a-b.github.kawasaki.jp"]);
  assert.deepEqual(routesOf({ groups, sites: handed }, all, answers, PSL).get("a.com").allow, ["s3.a-b.github.kawasaki.jp", "a.com"]);
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

test("a removed root's sites go to the root that learned them first, and every group keeps its hosts", () => {
  const groups = { "a.com": { rootHost: "a.com", hosts: { "x.cdn.net": 4, "img.org": 2 } }, "b.com": { rootHost: "b.com", hosts: { "cdn.net": 3, "img.org": 3 } } };
  const sites = { "cdn.net": "gone.com", "img.org": "b.com", "old.net": "gone.com" };
  assert.deepEqual(releaseSites(sites, groups, ["a.com", "b.com"], PSL), { "cdn.net": "b.com", "img.org": "b.com" });
  const tie = { "a.com": groups["a.com"], "b.com": { rootHost: "b.com", hosts: { "cdn.net": 4 } } };
  assert.equal(releaseSites(sites, tie, ["a.com", "b.com"], PSL)["cdn.net"], "a.com");
  const kept = { "img.org": "b.com" };
  assert.equal(releaseSites(kept, groups, ["a.com", "b.com"], PSL), kept);
});

test("a root is closed only when a root of another site on another proxy routes its site", () => {
  const groups = { "a.com": { rootHost: null, hosts: {} }, "b.com": { rootHost: null, hosts: {} }, "www.a.com": { rootHost: null, hosts: {} } };
  const answers = { "a.com": "PROXY a:1", "b.com": "PROXY b:1", "www.a.com": "PROXY w:1" };
  assert.deepEqual(handedRoots({ groups, sites: { "a.com": "b.com", "b.com": "b.com" } }, ["a.com", "b.com"], answers, PSL), ["a.com"]);
  // A stored User PAC from an older version may put two roots in one site: the second is left to the first.
  assert.deepEqual(handedRoots({ groups, sites: { "a.com": "a.com", "b.com": "b.com" } }, ["a.com", "www.a.com", "b.com"], answers, PSL), []);
  assert.equal(verdict("a.com", "a.com", {}), SAME);
});
