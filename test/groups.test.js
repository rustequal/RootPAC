import { PSL, fixture } from "./support.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptLegacyGroups, aggregateGroups, hostIndex, mergeGroups, mergeSeen, pruneSeen, reconcileGroups } from "../src/core/groups.js";

const group = (rootHost, hosts) => ({ rootHost, hosts });

test("new masks get empty groups and removed masks are dropped", () => {
  const kept = group("www.a.com", { "cdn.a.net": 1 });
  const next = reconcileGroups({ "a.com": kept, "old.com": group("old.com", { "x.old.net": 2 }) }, {
    roots: ["a.com", "b.com"],
    deny: [],
    bypass: [],
  });
  assert.deepEqual(Object.keys(next), ["a.com", "b.com"]);
  assert.equal(next["a.com"], kept);
  assert.deepEqual(next["b.com"], { rootHost: null, hosts: {} });
});

test("hosts matching a new deny mask are removed", () => {
  const next = reconcileGroups({ "a.com": group("www.a.com", { "cdn.a.net": 1, "px.ads.net": 2 }) }, {
    roots: ["a.com"],
    deny: ["*.ads.net"],
    bypass: [],
  });
  assert.deepEqual(next["a.com"], { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } });
});

test("hosts at or under a deny domain are removed", () => {
  const next = reconcileGroups({ "a.com": group("www.a.com", { "cdn.a.net": 1, "ads.net": 2, "x.y.net": 3 }) }, {
    roots: ["a.com"],
    deny: ["*.ads.net", "y.net"],
    bypass: [],
  });
  assert.deepEqual(next["a.com"], { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } });
});

test("hosts that became roots are removed and rootHost is kept", () => {
  const next = reconcileGroups({ "a.com": group("www.a.com", { "cdn.a.net": 1 }) }, {
    roots: ["a.com", "a.net"],
    deny: [],
    bypass: [],
  });
  assert.deepEqual(next["a.com"], { rootHost: "www.a.com", hosts: {} });
  assert.deepEqual(next["a.net"], { rootHost: null, hosts: {} });
});

test("legacy *.domain groups and their seen records move into the domain root", () => {
  const groups = { "*.a.com": group("www.a.com", { "cdn.a.net": 5, "x.b.net": 2 }), "a.com": group(null, { "x.b.net": 1 }), "c.com": group(null, {}) };
  const seen = { "*.a.com": { "cdn.a.net": 9, "x.b.net": 3 }, "a.com": { "x.b.net": 7 } };
  const adopted = adoptLegacyGroups(groups, seen, ["a.com", "c.com"]);
  assert.deepEqual(adopted.groups, { "a.com": group("www.a.com", { "cdn.a.net": 5, "x.b.net": 1 }), "c.com": group(null, {}) });
  assert.deepEqual(adopted.seen, { "a.com": { "cdn.a.net": 9, "x.b.net": 7 } });
  const untouched = adoptLegacyGroups({ "c.com": group(null, {}) }, {}, ["c.com"]);
  assert.deepEqual(untouched.groups, { "c.com": group(null, {}) });
});

test("unchanged groups keep identity and the input is not mutated", () => {
  const input = { "a.com": group("www.a.com", { "cdn.a.net": 1, "px.ads.net": 2 }) };
  const snapshot = structuredClone(input);
  reconcileGroups(input, { roots: ["a.com"], deny: ["*.ads.net"], bypass: [] });
  assert.deepEqual(input, snapshot);
});

test("no roots yields no groups", () => {
  assert.deepEqual(reconcileGroups({ "a.com": group(null, {}) }, { roots: [], deny: [], bypass: [] }), {});
});

test("pruneSeen follows the groups", () => {
  const groups = { "a.com": group("www.a.com", { "cdn.a.net": 1 }), "b.com": group(null, {}) };
  const same = { "cdn.a.net": 10 };
  assert.equal(pruneSeen({ "a.com": same }, groups)["a.com"], same);
  assert.deepEqual(pruneSeen({ "a.com": { "cdn.a.net": 10, "gone.a.net": 11 }, "old.com": { "x.old.net": 1 } }, groups), {
    "a.com": { "cdn.a.net": 10 },
  });
  assert.deepEqual(pruneSeen({ "b.com": { "x.b.net": 1 } }, groups), {});
});

test("hostIndex maps every learned host to its groups in mask order", () => {
  const index = hostIndex({ "c.com": group("c.com", { "cdn.a.net": 3 }), "a.com": group("www.a.com", { "cdn.a.net": 1, "img.a.net": 2 }), "b.com": group(null, {}) });
  assert.deepEqual([...index], [
    ["cdn.a.net", ["a.com", "c.com"]],
    ["img.a.net", ["a.com"]],
  ]);
});

test("mergeGroups adds hosts with their first-seen time and sets rootHost once", () => {
  const untouched = group(null, {});
  const groups = { "a.com": group(null, {}), "b.com": group("www.b.com", { "x.b.net": 1 }), "c.com": untouched };
  const batch = new Map([
    ["cdn.a.net", { mask: "a.com", rootHost: "www.a.com" }],
    ["img.a.net", { mask: "a.com", rootHost: "m.a.com" }],
    ["y.b.net", { mask: "b.com", rootHost: "m.b.com" }],
  ]);
  const snapshot = structuredClone(groups);
  const next = mergeGroups(groups, batch, 50);
  assert.deepEqual(next, {
    "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 50, "img.a.net": 50 } },
    "b.com": { rootHost: "www.b.com", hosts: { "x.b.net": 1, "y.b.net": 50 } },
    "c.com": untouched,
  });
  assert.equal(next["c.com"], untouched);
  assert.deepEqual(groups, snapshot);
});

test("mergeSeen records the latest observation per host", () => {
  const kept = { "z.c.net": 1 };
  const seen = { "a.com": { "cdn.a.net": 1 }, "c.com": kept };
  const next = mergeSeen(seen, [["cdn.a.net", ["a.com"]], ["img.a.net", ["a.com"]], ["y.b.net", ["b.com", "d.com"]]], 9);
  assert.deepEqual(next, { "a.com": { "cdn.a.net": 9, "img.a.net": 9 }, "c.com": kept, "b.com": { "y.b.net": 9 }, "d.com": { "y.b.net": 9 } });
  assert.deepEqual(seen["a.com"], { "cdn.a.net": 1 });
});

const AGG = { roots: ["a.com", "www.b.com"], deny: ["*.ads.net"], bypass: [] };
const agg = (groups, seen = {}, analysis = AGG) => aggregateGroups(groups, seen, analysis, PSL);
const one = (hosts, rootHost = "www.a.com") => ({ "a.com": { rootHost, hosts }, "www.b.com": { rootHost: null, hosts: {} } });

test("two hosts with one registrable domain collapse into it", () => {
  const { groups, seen } = agg(one({ "x.cdn.net": 5, "y.z.cdn.net": 3, "keep.other.org": 9 }), { "a.com": { "x.cdn.net": 7, "y.z.cdn.net": 8, "keep.other.org": 1 } });
  assert.deepEqual(groups["a.com"].hosts, { "keep.other.org": 9, "cdn.net": 3 });
  assert.deepEqual(seen, { "a.com": { "keep.other.org": 1, "cdn.net": 8 } });
});

test("a single host, a host equal to its domain and public suffix neighbours stay as they are", () => {
  const groups = one({ "x.cdn.net": 1, "cdn.org": 2, "a.bbc.co.uk": 3, "b.shop.co.uk": 4, "x.github.io": 5, "y.github.io": 6, "1.2.3.4": 7, "5.6.3.4": 8 });
  const result = agg(groups);
  assert.equal(result.groups, groups);
});

test("aggregation is refused when the domain matches or covers a root or deny domain", () => {
  const cases = [
    { roots: ["a.com", "cdn.net"], deny: [], bypass: [] },
    { roots: ["a.com", "*.cdn.net"], deny: [], bypass: [] },
    { roots: ["a.com", "www.cdn.net"], deny: [], bypass: [] },
    { roots: ["a.com"], deny: ["*.ads.cdn.net"], bypass: [] },
    { roots: ["a.com"], deny: ["cdn.net"], bypass: [] },
  ];
  for (const analysis of cases) {
    const groups = { "a.com": { rootHost: "www.a.com", hosts: { "x.cdn.net": 1, "y.cdn.net": 2 } } };
    for (const mask of analysis.roots.slice(1)) groups[mask] = { rootHost: null, hosts: {} };
    assert.equal(agg(groups, {}, analysis).groups, groups, JSON.stringify(analysis));
  }
});

test("hosts of other groups do not block aggregation inside a group", () => {
  const groups = {
    "a.com": { rootHost: "www.a.com", hosts: { "x.cdn.net": 1, "y.cdn.net": 2 } },
    "www.b.com": { rootHost: "www.b.com", hosts: { "z.cdn.net": 3 } },
  };
  const { groups: next } = agg(groups);
  assert.deepEqual(next["a.com"].hosts, { "cdn.net": 1 });
  assert.equal(next["www.b.com"], groups["www.b.com"]);
});

test("the same record may appear in several groups", () => {
  const groups = {
    "a.com": { rootHost: "www.a.com", hosts: { "x.cdn.net": 1, "y.cdn.net": 2 } },
    "www.b.com": { rootHost: "www.b.com", hosts: { "p.q.cdn.net": 5, "r.cdn.net": 3 } },
  };
  const seen = { "a.com": { "x.cdn.net": 7 }, "www.b.com": { "p.q.cdn.net": 9, "r.cdn.net": 4 } };
  const next = agg(groups, seen);
  assert.deepEqual(next.groups["a.com"].hosts, { "cdn.net": 1 });
  assert.deepEqual(next.groups["www.b.com"].hosts, { "cdn.net": 3 });
  assert.deepEqual(next.seen, { "a.com": { "cdn.net": 7 }, "www.b.com": { "cdn.net": 9 } });
});

test("a refused domain falls back to the widest allowed level", () => {
  const hosts = { "a.x.fna.cdn.net": 1, "b.y.fna.cdn.net": 2, "s.xx.cdn.net": 3, "t.xx.cdn.net": 4, "lone.cdn.net": 5 };
  const denied = { roots: ["a.com"], deny: ["*.ads.cdn.net"], bypass: [] };
  assert.deepEqual(agg({ "a.com": { rootHost: "www.a.com", hosts } }, {}, denied).groups["a.com"].hosts, { "fna.cdn.net": 1, "xx.cdn.net": 3, "lone.cdn.net": 5 });
  const { "lone.cdn.net": lone, ...rest } = hosts;
  const bypassed = { roots: ["a.com"], deny: [], bypass: ["lone.cdn.net"] };
  assert.deepEqual(agg({ "a.com": { rootHost: "www.a.com", hosts: rest } }, {}, bypassed).groups["a.com"].hosts, { "fna.cdn.net": 1, "xx.cdn.net": 3 });
  assert.equal(lone, 5);
  const rooted = { roots: ["a.com", "xx.cdn.net"], deny: [], bypass: [] };
  const withRoot = { "a.com": { rootHost: "www.a.com", hosts: { "a.x.fna.cdn.net": 1, "b.y.fna.cdn.net": 2, "m.cdn.net": 3 } }, "xx.cdn.net": { rootHost: null, hosts: {} } };
  assert.deepEqual(agg(withRoot, {}, rooted).groups["a.com"].hosts, { "fna.cdn.net": 1, "m.cdn.net": 3 });
});

test("the shared CDN groups from the customer state aggregate inside each root", () => {
  const { groups } = JSON.parse(fixture("shared-cdn-groups.json"));
  const analysis = { roots: ["facebook.com", "instagram.com", "threads.com"], deny: ["*.google-analytics.com", "*.doubleclick.net"], bypass: ["*.ru", "*.xn--p1ai"] };
  const first = aggregateGroups(groups, {}, analysis, PSL);
  assert.deepEqual(Object.keys(first.groups["instagram.com"].hosts).sort(), ["cdninstagram.com", "fbcdn.net"]);
  assert.equal(first.groups["instagram.com"].hosts["fbcdn.net"], 1790194698849);
  assert.equal(first.groups["instagram.com"].hosts["cdninstagram.com"], 1790194698520);
  assert.deepEqual(first.groups["facebook.com"].hosts, { "fbcdn.net": 1790194708272, "www.fbsbx.com": 1790194810509 });
  assert.equal(first.groups["threads.com"], groups["threads.com"]);
  const second = aggregateGroups(first.groups, first.seen, analysis, PSL);
  assert.equal(second.groups, first.groups);
});

test("aggregation is deterministic, idempotent and keeps unchanged objects", () => {
  const groups = one({ "b.cdn.net": 2, "a.cdn.net": 1, "c.img.org": 3, "d.img.org": 4 });
  const first = agg(groups);
  assert.deepEqual(first.groups["a.com"].hosts, { "cdn.net": 1, "img.org": 3 });
  assert.equal(first.groups["www.b.com"], groups["www.b.com"]);
  const second = agg(first.groups, first.seen);
  assert.equal(second.groups, first.groups);
  assert.equal(second.seen, first.seen);
});

const ROOT_ORG = { roots: ["root.org"], deny: [], bypass: [] };
const grouped = (hosts, analysis = ROOT_ORG) =>
  Object.keys(aggregateGroups({ "root.org": { rootHost: "root.org", hosts } }, {}, analysis, PSL).groups["root.org"].hosts).sort();

test("a nested record merges into its parent and is no ground for widening", () => {
  assert.deepEqual(grouped({ "cdn.e.com": 1, "img.cdn.e.com": 2 }), ["cdn.e.com"]);
  const deny = { roots: ["root.org"], deny: ["*.z.e.com"], bypass: [] };
  assert.deepEqual(grouped({ "c.w.a.e.com": 1, "w.a.e.com": 2 }, deny), ["w.a.e.com"]);
  assert.deepEqual(grouped({ "c.w.a.e.com": 1, "w.a.e.com": 2, "q.a.e.com": 3 }, deny), ["a.e.com"]);
  const { groups, seen } = aggregateGroups({ "root.org": { rootHost: "root.org", hosts: { "cdn.e.com": 5, "img.cdn.e.com": 2 } } }, { "root.org": { "img.cdn.e.com": 9, "cdn.e.com": 7 } }, ROOT_ORG, PSL);
  assert.deepEqual(groups["root.org"].hosts, { "cdn.e.com": 2 });
  assert.deepEqual(seen["root.org"], { "cdn.e.com": 9 });
});

test("aggregation widens to the registrable domain at most, never to a public suffix", () => {
  assert.deepEqual(grouped({ "a.x.co.uk": 1, "b.y.co.uk": 1 }), ["a.x.co.uk", "b.y.co.uk"]);
  assert.deepEqual(grouped({ "a.bbc.co.uk": 1, "b.bbc.co.uk": 1 }), ["bbc.co.uk"]);
  assert.deepEqual(grouped({ "a.github.io": 1, "b.github.io": 1 }), ["a.github.io", "b.github.io"]);
  assert.deepEqual(grouped({ "x.a.github.io": 1, "y.a.github.io": 1 }), ["a.github.io"]);
  assert.deepEqual(grouped({ "a.x.ck": 1, "b.y.ck": 1 }), ["a.x.ck", "b.y.ck"]);
  assert.deepEqual(grouped({ "p.a.www.ck": 1, "q.b.www.ck": 1 }), ["www.ck"]);
  assert.deepEqual(grouped({ "b1.s3.amazonaws.com": 1, "b2.s3.amazonaws.com": 1 }), ["b1.s3.amazonaws.com", "b2.s3.amazonaws.com"]);
});

test("an exact public suffix record absorbs nothing, is not counted and falls under a covering record", () => {
  assert.deepEqual(grouped({ "github.io": 1, "a.github.io": 2, "b.github.io": 3 }), ["a.github.io", "b.github.io", "github.io"]);
  assert.deepEqual(grouped({ "s3.amazonaws.com": 1, "x.amazonaws.com": 2, "y.amazonaws.com": 3 }), ["amazonaws.com"]);
});

test("aggregation is linear: 4000 hosts without a common parent take milliseconds", () => {
  const hosts = {};
  for (let i = 0; i < 4000; i++) hosts[`www.site${i}.com`] = i;
  const started = performance.now();
  assert.equal(grouped(hosts).length, 4000);
  assert.ok(performance.now() - started < 500);
});

test("cleanup drops localhost names and names outside the host grammar", () => {
  const groups = { "root.org": { rootHost: "root.org", hosts: { "x.localhost": 1, "a.1": 2, "cdn.net": 3 } } };
  assert.deepEqual(reconcileGroups(groups, ROOT_ORG)["root.org"].hosts, { "cdn.net": 3 });
});
