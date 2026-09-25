import { test } from "node:test";
import { PSL } from "./support.js";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, Store, diffState } from "../src/background/store.js";
import { buildSystemPac } from "../src/core/build.js";
import { FakeArea, deferred } from "./fakes.js";

const USER_PAC = 'function FindProxyForURL(url, host) {\n  return root(host, "a.com") ? "PROXY p:1" : "DIRECT";\n}';
const ANALYSIS = { roots: ["a.com"], deny: [], bypass: [] };
const GROUP = { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } };
const APPLIED = buildSystemPac(USER_PAC, { "a.com": GROUP }, PSL);

function stored(extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    userPac: USER_PAC,
    analysis: ANALYSIS,
    appliedPac: APPLIED,
    "group:a.com": GROUP,
    "seen:a.com": { "cdn.a.net": 5 },
    ...extra,
  };
}

test("first load writes the schema and defaults", async () => {
  const area = new FakeArea();
  const store = new Store(area, new FakeArea());
  const state = await store.load(PSL);
  assert.deepEqual(state, { enabled: true, userPac: null, analysis: null, appliedPac: null, userPacErrors: null, groups: {}, seen: {} });
  assert.deepEqual(area.items, { schemaVersion: SCHEMA_VERSION, enabled: true });
});

test("load decodes per-group keys without rewriting anything", async () => {
  const area = new FakeArea(stored());
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.deepEqual(state.groups, { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } } });
  assert.deepEqual(state.seen, { "a.com": { "cdn.a.net": 5 } });
  assert.equal(state.userPac, USER_PAC);
  assert.deepEqual(area.writes(), []);
});

test("load repairs groups left behind by an interrupted commit", async () => {
  const area = new FakeArea(stored({ "group:old.com": { rootHost: null, hosts: {} }, "seen:old.com": { "x.old.net": 1 } }));
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.deepEqual(Object.keys(state.groups), ["a.com"]);
  assert.deepEqual(area.writes(), [["remove", ["group:old.com", "seen:old.com"]]]);
  assert.equal(Object.hasOwn(area.items, "group:old.com"), false);
});

test("load rebuilds a stale System PAC and refreshes the analysis", async () => {
  const area = new FakeArea(stored({ appliedPac: "old template", analysis: { roots: ["a.com", "gone.com"], deny: [], bypass: [] } }));
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.equal(state.appliedPac, APPLIED);
  assert.deepEqual(state.analysis, ANALYSIS);
  assert.deepEqual(area.writes(), [["set", ["analysis", "appliedPac"]]]);
});

test("a worker restart in the same browser session trusts a verified store and skips the rebuild", async () => {
  const area = new FakeArea(stored({ appliedPac: "old template" }));
  const session = new FakeArea();
  await new Store(area, session).load(PSL);
  assert.equal(session.items.stateVerified, true);
  area.items.appliedPac = "written by this version";
  area.calls.length = 0;
  const state = await new Store(area, session).load(PSL);
  assert.equal(state.appliedPac, "written by this version");
  assert.deepEqual(area.writes(), []);
  assert.equal((await new Store(area, new FakeArea()).load(PSL)).appliedPac, APPLIED);
});

test("an interrupted commit leaves the store unverified, so the next start rebuilds it", async () => {
  const area = new FakeArea(stored());
  const session = new FakeArea();
  const store = new Store(area, session);
  await store.load(PSL);
  area.set = async () => {
    throw new Error("quota");
  };
  await assert.rejects(store.commit({ ...store.state, groups: { "a.com": { ...GROUP, hosts: { "cdn.a.net": 1, "img.b.net": 2 } } } }), /quota/);
  assert.equal(session.items.stateVerified, false);
  delete area.set;
  area.items["group:old.com"] = { rootHost: null, hosts: {} };
  const state = await new Store(area, session).load(PSL);
  assert.deepEqual(Object.keys(state.groups), ["a.com"]);
  assert.equal(session.items.stateVerified, true);
});

test("a failed removal keeps the store unverified until a later commit removes the keys", async () => {
  const area = new FakeArea(stored());
  const session = new FakeArea();
  const store = new Store(area, session);
  await store.load(PSL);
  const remove = area.remove;
  area.remove = async () => {
    throw new Error("busy");
  };
  await store.commit({ ...store.state, seen: {} });
  assert.equal(session.items.stateVerified, false);
  area.remove = remove;
  await store.commit(store.state);
  assert.equal(Object.hasOwn(area.items, "seen:a.com"), false);
  assert.equal(session.items.stateVerified, true);
});

test("a stored User PAC that no longer validates keeps the last applied configuration in safe mode", async () => {
  const invalid = USER_PAC.replace('"a.com"', '"insta*.com"');
  const items = stored({ userPac: invalid, appliedPac: "last applied" });
  const area = new FakeArea(items);
  const state = await new Store(area, new FakeArea()).load(PSL);
  const errors = [{ line: 2, column: 21, message: 'root() mask must be a domain: "insta*.com"' }];
  assert.deepEqual(state, {
    enabled: true,
    userPac: invalid,
    analysis: ANALYSIS,
    appliedPac: "last applied",
    userPacErrors: errors,
    groups: { "a.com": GROUP },
    seen: { "a.com": { "cdn.a.net": 5 } },
  });
  assert.deepEqual(area.items, { ...items, userPacErrors: errors });
  area.calls.length = 0;
  await new Store(area, new FakeArea()).load(PSL);
  assert.deepEqual(area.writes(), []);
});

test("a valid stored User PAC leaves safe mode on load", async () => {
  const area = new FakeArea(stored({ userPacErrors: [{ line: 1, column: 1, message: "old" }] }));
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.equal(state.userPacErrors, null);
  assert.equal(Object.hasOwn(area.items, "userPacErrors"), false);
});

test("stored userPacErrors require a User PAC", async () => {
  await assert.rejects(new Store(new FakeArea({ schemaVersion: SCHEMA_VERSION, enabled: true, userPacErrors: [] }), new FakeArea()).load(PSL), /userPacErrors are inconsistent/);
});

test("load creates missing groups for known roots", async () => {
  const items = stored();
  delete items["group:a.com"];
  delete items["seen:a.com"];
  const area = new FakeArea(items);
  await new Store(area, new FakeArea()).load(PSL);
  assert.deepEqual(area.items["group:a.com"], { rootHost: null, hosts: {} });
});

test("load fails fast on unknown schema or corrupt state", async () => {
  await assert.rejects(new Store(new FakeArea({ schemaVersion: 2 }), new FakeArea()).load(PSL), /Unsupported storage schema version 2/);
  await assert.rejects(new Store(new FakeArea({ enabled: true }), new FakeArea()).load(PSL), /Unsupported storage schema version undefined/);
  await assert.rejects(new Store(new FakeArea(stored({ stray: 1 })), new FakeArea()).load(PSL), /Unknown storage key "stray"/);
  await assert.rejects(new Store(new FakeArea(stored({ enabled: "yes" })), new FakeArea()).load(PSL), /not a boolean/);
  await assert.rejects(new Store(new FakeArea(stored({ appliedPac: undefined, analysis: null })), new FakeArea()).load(PSL), /inconsistent/);
});

test("state is unavailable before load", () => {
  assert.throws(() => new Store(new FakeArea(), new FakeArea()).state, /not loaded/);
});

test("commit touches only changed keys", async () => {
  const area = new FakeArea(stored({ "group:b.com": { rootHost: null, hosts: {} } }));
  const store = new Store(area, new FakeArea());
  const state = await store.load(PSL);
  area.calls.length = 0;
  const groups = { ...state.groups, "b.com": { rootHost: "b.com", hosts: { "x.b.net": 7 } } };
  await store.commit({ ...state, groups });
  assert.deepEqual(area.writes(), [["set", ["group:b.com"]]]);
  area.calls.length = 0;
  await store.commit({ ...store.state, groups: { "b.com": groups["b.com"] }, seen: {} });
  assert.deepEqual(area.writes(), [["remove", ["group:a.com", "seen:a.com"]]]);
  area.calls.length = 0;
  await store.commit({ ...store.state });
  assert.deepEqual(area.writes(), []);
});

test("diffState removes nulled scalars", () => {
  const prev = { enabled: true, userPac: "a", analysis: ANALYSIS, appliedPac: "p", userPacErrors: null, groups: {}, seen: {} };
  const next = { ...prev, userPac: null, analysis: null, appliedPac: null, enabled: false };
  assert.deepEqual(diffState(prev, next), { set: { enabled: false }, remove: ["userPac", "analysis", "appliedPac"] });
});

test("run executes tasks one at a time in order and survives failures", async () => {
  const store = new Store(new FakeArea(), new FakeArea());
  await store.load(PSL);
  const order = [];
  const gate = deferred();
  const first = store.run(async () => {
    order.push("first:start");
    await gate.promise;
    order.push("first:end");
    return 1;
  });
  const second = store.run(async () => {
    order.push("second");
    throw new Error("boom");
  });
  const third = store.run(async (state) => {
    order.push("third");
    return state.enabled;
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  gate.resolve();
  assert.equal(await first, 1);
  await assert.rejects(second, /boom/);
  assert.equal(await third, true);
  assert.deepEqual(order, ["first:start", "first:end", "second", "third"]);
});

test("run passes the latest committed state", async () => {
  const store = new Store(new FakeArea(), new FakeArea());
  await store.load(PSL);
  const a = store.run((state) => store.commit({ ...state, enabled: false }));
  const b = store.run((state) => state.enabled);
  await a;
  assert.equal(await b, false);
});

test("load aggregates already learned hosts and rebuilds a smaller System PAC", async () => {
  const hosts = { "rr1---sn-a.googlevideo.com": 3, "rr2---sn-b.googlevideo.com": 2, "rr3---sn-c.googlevideo.com": 4, "cdn.a.net": 1 };
  const area = new FakeArea(stored({ "group:a.com": { rootHost: "www.a.com", hosts }, "seen:a.com": { "rr1---sn-a.googlevideo.com": 9, "cdn.a.net": 5 } }));
  const before = buildSystemPac(USER_PAC, { "a.com": { rootHost: "www.a.com", hosts } }, PSL);
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.deepEqual(state.groups["a.com"].hosts, { "cdn.a.net": 1, "googlevideo.com": 2 });
  assert.deepEqual(state.seen, { "a.com": { "cdn.a.net": 5, "googlevideo.com": 9 } });
  assert.equal(area.items.appliedPac, buildSystemPac(USER_PAC, state.groups, PSL));
  assert.ok(area.items.appliedPac.length < before.length);
});

test("load requires the public suffix list", async () => {
  await assert.rejects(new Store(new FakeArea(), new FakeArea()).load(), /needs the public suffix list/);
  assert.throws(() => new Store(new FakeArea(), new FakeArea()).psl, /not loaded/);
});

test("a stored analysis from before bypass() reads as having no bypass masks", async () => {
  const invalid = USER_PAC.replace('"a.com"', '"insta*.com"');
  const area = new FakeArea(stored({ userPac: invalid, analysis: { roots: ["a.com"], deny: [] } }));
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.deepEqual(state.analysis, { roots: ["a.com"], deny: [], bypass: [] });
  assert.deepEqual(area.items.analysis, { roots: ["a.com"], deny: [] });
});

test("a failed removal keeps the committed state and is retried by the next commit", async () => {
  const area = new FakeArea(stored({ "group:b.com": { rootHost: null, hosts: {} } }));
  const store = new Store(area, new FakeArea());
  await store.load(PSL);
  let failures = 1;
  const remove = area.remove.bind(area);
  area.remove = async (keys) => {
    if (failures-- > 0) throw new Error("storage busy");
    return remove(keys);
  };
  const next = { ...store.state, seen: {} };
  await store.commit(next);
  assert.equal(store.state, next);
  await store.commit({ ...next, enabled: false });
  assert.equal(Object.hasOwn(area.items, "seen:a.com"), false);
});

test("malformed stored values fail fast", async () => {
  const cases = [
    { "group:a.com": { rootHost: null, hosts: [] } },
    { "group:a.com": { rootHost: 1, hosts: {} } },
    { "group:a.com": { rootHost: null, hosts: { "cdn.a.net": -1 } } },
    { "seen:a.com": { "cdn.a.net": 1.5 } },
    { analysis: { roots: "a.com", deny: [], bypass: [] } },
    { appliedPac: 5 },
  ];
  for (const extra of cases) {
    await assert.rejects(new Store(new FakeArea(stored(extra)), new FakeArea()).load(PSL), /malformed|not a string/, JSON.stringify(extra));
  }
});
