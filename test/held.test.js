import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPac } from "../src/core/build.js";
import { COVERING, EXACT, droppedRoutes, heldOf, heldRoutes, pacRoutes, routeCovers, sameHeld } from "../src/core/held.js";
import { parsePublicSuffixList } from "../src/core/psl.js";
import { PSL, loadPac } from "./support.js";

const userPac = (...roots) => `var PROXY = "PROXY 127.0.0.1:9";\nfunction FindProxyForURL(url, host) {\n  if (${roots.map((root) => `root(host, "${root}")`).join(" || ")}) return PROXY;\n  return "DIRECT";\n}`;

function state(roots, groups, extra = {}) {
  return {
    userPac: userPac(...roots),
    analysis: { roots, deny: [], bypass: [] },
    groups: Object.fromEntries(roots.map((root) => [root, { rootHost: `www.${root}`, hosts: groups[root] ?? {} }])),
    sites: null,
    held: null,
    ...extra,
  };
}

const names = (routes) => routes.map(({ mask, name, kind }) => `${mask} ${name} ${kind}`).sort();

test("the routes of a PAC are its roots and its records by the owner of their site, with their kind", () => {
  const routes = pacRoutes(state(["a.com"], { "a.com": { "cdn.a.net": 1, "github.io": 2 } }), PSL);
  assert.deepEqual(names(routes), ["a.com a.com 1", "a.com cdn.a.net 1", "a.com github.io 2"]);
  assert.deepEqual(pacRoutes({ userPac: null, analysis: null }, PSL), []);
  const held = pacRoutes(state(["a.com"], {}, { held: { "a.com": { "old.a.net": COVERING } } }), PSL);
  assert.deepEqual(names(held), ["a.com a.com 1", "a.com old.a.net 1"]);
});

test("a removed record is dropped, a record still covered is not", () => {
  const before = pacRoutes(state(["a.com"], { "a.com": { "x.cdn.net": 1, "y.cdn.net": 2, "img.b.org": 3 } }), PSL);
  const removed = droppedRoutes(before, state(["a.com"], { "a.com": { "x.cdn.net": 1, "y.cdn.net": 2 } }), PSL);
  assert.deepEqual(names(removed), ["a.com img.b.org 1"]);
  const widened = droppedRoutes(before, state(["a.com"], { "a.com": { "cdn.net": 1, "img.b.org": 3 } }), PSL);
  assert.deepEqual(widened, []);
});

test("a record a new public suffix list makes exact is dropped with the coverage it had", () => {
  const zoned = parsePublicSuffixList(`// ===BEGIN ICANN DOMAINS===\ncom\nnet\ntest\npz.test\n// ===END ICANN DOMAINS===\n`);
  const plain = parsePublicSuffixList(`// ===BEGIN ICANN DOMAINS===\ncom\nnet\ntest\n// ===END ICANN DOMAINS===\n`);
  const current = state(["a.com"], { "a.com": { "pz.test": 1 } });
  const before = pacRoutes(current, plain);
  assert.deepEqual(names(droppedRoutes(before, current, zoned)), ["a.com pz.test 1"]);
  assert.deepEqual(droppedRoutes(pacRoutes(current, zoned), current, plain), []);
});

test("a route that changes proxy is not dropped, a route of a root the User PAC no longer declares goes with it", () => {
  const two = state(["a.com", "b.com"], { "a.com": { "cdn.net": 1 }, "b.com": { "cdn.net": 2 } }, { sites: { "a.com": "a.com", "b.com": "b.com", "cdn.net": "a.com" } });
  const handed = { ...two, sites: { ...two.sites, "cdn.net": "b.com" } };
  assert.deepEqual(droppedRoutes(pacRoutes(two, PSL), handed, PSL), []);
  const alone = state(["b.com"], { "b.com": { "cdn.net": 2 } });
  assert.deepEqual(droppedRoutes(pacRoutes(two, PSL), alone, PSL), []);
  const kept = state(["a.com"], {});
  assert.deepEqual(names(droppedRoutes(pacRoutes(two, PSL), kept, PSL)), ["a.com cdn.net 1"]);
});

test("held routes keep the widest kind of a name and compare by content", () => {
  const held = heldOf([
    { mask: "a.com", name: "pz.test", kind: EXACT },
    { mask: "a.com", name: "pz.test", kind: COVERING },
    { mask: "b.com", name: "x.net", kind: EXACT },
  ]);
  assert.deepEqual(held, { "a.com": { "pz.test": COVERING }, "b.com": { "x.net": EXACT } });
  assert.deepEqual(names(heldRoutes(held)), ["a.com pz.test 1", "b.com x.net 2"]);
  assert.equal(heldOf([]), null);
  assert.ok(sameHeld({ "b.com": { "x.net": 2 }, "a.com": { "pz.test": 1 } }, held));
  assert.ok(sameHeld(null, undefined));
  assert.ok(!sameHeld(held, null));
  assert.ok(routeCovers({ name: "pz.test", kind: COVERING }, "u.a.pz.test"));
  assert.ok(!routeCovers({ name: "pz.test", kind: EXACT }, "u.a.pz.test"));
  assert.ok(routeCovers({ name: "pz.test", kind: EXACT }, "pz.test"));
});

test("the System PAC sends held routes to their root's proxy after every learned record", () => {
  const groups = { "a.com": { rootHost: "www.a.com", hosts: { "github.io": 1, "cdn.net": 2 } }, "b.com": { rootHost: "www.b.com", hosts: {} } };
  const held = { "a.com": { "github.io": COVERING, "old.net": COVERING }, "b.com": { "cdn.net": COVERING }, "gone.com": { "x.org": COVERING } };
  const text = buildSystemPac(userPac("a.com", "b.com").replace('return PROXY;', 'return host === "www.b.com" ? "PROXY 127.0.0.1:8" : PROXY;'), groups, PSL, undefined, held);
  const pac = loadPac(text);
  const route = (host) => pac.FindProxyForURL(`http://${host}/`, host);
  assert.equal(route("someone.github.io"), "PROXY 127.0.0.1:9");
  assert.equal(route("a.old.net"), "PROXY 127.0.0.1:9");
  assert.equal(route("cdn.net"), "PROXY 127.0.0.1:9");
  assert.equal(route("x.org"), "DIRECT");
  assert.equal(route("elsewhere.org"), "DIRECT");
  assert.match(text, /var __HELD = \[\n {2}HELD_a_com,\n {2}HELD_b_com\n\];/);
  assert.throws(() => buildSystemPac(userPac("a.com"), { "a.com": groups["a.com"] }, PSL, undefined, { "a.com": { "x.org": 3 } }), /invalid kind/);
  assert.throws(() => buildSystemPac(userPac("a.com"), { "a.com": groups["a.com"] }, PSL, undefined, { "a.com": { "bad name": 1 } }), /not a host name/);
});
