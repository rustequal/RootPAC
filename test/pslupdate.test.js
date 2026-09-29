import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PSL_ALARM, PSL_PERIOD_MINUTES, createPslUpdater } from "../src/background/pslupdate.js";
import { PSL_KEYS, Store } from "../src/background/store.js";
import { PSL_URL } from "../src/core/pslsource.js";
import { FakeArea } from "./fakes.js";
import { PSL } from "./support.js";

const BUNDLED = readFileSync(new URL("../vendor/public_suffix_list.dat", import.meta.url), "utf8");
const BUNDLED_URL = "chrome-extension://id/vendor/public_suffix_list.dat";
const OLD = "2026-09-21_18-50-07_UTC";
const NEW = "2026-09-28_07-12-00_UTC";

// A newer release of the list, optionally with more public suffixes.
function release(version, extra = []) {
  const text = BUNDLED.replace(`// VERSION: ${OLD}`, `// VERSION: ${version}`);
  return text.replace("// ===END PRIVATE DOMAINS===", [...extra, "// ===END PRIVATE DOMAINS==="].join("\n"));
}

const userPac = (root) => `function FindProxyForURL(url, host) {\n  return root(host, "${root}") ? "PROXY p:1" : "DIRECT";\n}`;

function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => answer };
  };
  return { fetch, calls, answers };
}

class FakeAlarms {
  constructor(alarms = {}) {
    this.alarms = { ...alarms };
  }
  async get(name) {
    return this.alarms[name];
  }
  async create(name, info) {
    this.alarms[name] = { name, ...info };
  }
  async clear(name) {
    delete this.alarms[name];
  }
}

async function setup({ items = {}, server = release(NEW), alarms = new FakeAlarms(), time = 1_000_000, pac = null, failCommit = false } = {}) {
  const area = new FakeArea(items);
  const store = new Store(area, new FakeArea());
  const commits = [];
  const engine = {
    async commit(next) {
      if (failCommit) throw new Error("apply failed");
      commits.push(next);
      return store.commit(next);
    },
  };
  const web = fakeFetch({ [BUNDLED_URL]: BUNDLED, [PSL_URL]: server });
  const clock = { now: time };
  const updater = createPslUpdater({ store, engine, area, alarms, fetch: web.fetch, bundledUrl: BUNDLED_URL, now: () => clock.now });
  await store.load(await updater.select());
  if (pac !== null) {
    const { analyzeUserPac } = await import("../src/core/analyze.js");
    const { buildSystemPac } = await import("../src/core/build.js");
    const result = analyzeUserPac(pac, store.psl);
    const analysis = { roots: result.roots, deny: result.deny, bypass: result.bypass };
    const groups = Object.fromEntries(analysis.roots.map((root) => [root, { rootHost: null, hosts: {} }]));
    await store.commit({ ...store.state, userPac: pac, analysis, groups, appliedPac: buildSystemPac(pac, groups, store.psl, {}), sites: {} });
  }
  return { area, store, engine, commits, web, updater, alarms, clock };
}

test("the bundled list is used until a newer one is downloaded", async () => {
  const { updater, store } = await setup();
  assert.deepEqual(updater.installed, { version: OLD, commit: "728555a30ef4d40e42a82d5678e5fbad2ad17b26", source: "bundled" });
  assert.equal(updater.conflict, null);
  assert.equal(store.psl.isPublicSuffix("github.io"), true);
});

test("check reports what publicsuffix.org has and changes nothing", async () => {
  const { updater, area, commits } = await setup();
  const writes = area.writes().length;
  const result = await updater.check();
  assert.equal(result.ok, true);
  assert.equal(result.newer, true);
  assert.equal(result.available.version, NEW);
  assert.equal(result.installed.version, OLD);
  assert.equal(area.writes().length, writes);
  assert.equal(commits.length, 0);
});

test("a failed check says why", async () => {
  const { updater, web } = await setup();
  web.answers[PSL_URL] = new TypeError("Failed to fetch");
  assert.deepEqual(await updater.check(), { ok: false, installed: updater.installed, conflict: null, error: "Cannot reach publicsuffix.org: Failed to fetch" });
  delete web.answers[PSL_URL];
  assert.equal((await updater.check()).error, "publicsuffix.org answered HTTP 404");
  web.answers[PSL_URL] = BUNDLED.slice(0, 1000);
  assert.equal((await updater.check()).error, "Public suffix list is incomplete");
});

test("update installs a newer list, stores it and applies the state worked out with it", async () => {
  const { updater, store, area, commits } = await setup({ server: release(NEW, ["zone.example"]), pac: userPac("a.com") });
  const result = await updater.update();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "updated");
  assert.deepEqual(result.installed, { version: NEW, commit: "728555a30ef4d40e42a82d5678e5fbad2ad17b26", source: "downloaded" });
  assert.equal(commits.length, 1);
  assert.equal(store.psl.isPublicSuffix("zone.example"), true);
  assert.equal(area.items[PSL_KEYS.list].version, NEW);
  assert.equal(area.items[PSL_KEYS.list].text, release(NEW, ["zone.example"]));
  assert.equal((await updater.check()).newer, false);
});

test("the list on the server that is not newer is left alone", async () => {
  const { updater, commits, area } = await setup({ server: BUNDLED });
  const result = await updater.update();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "current");
  assert.equal(commits.length, 0);
  assert.equal(Object.hasOwn(area.items, PSL_KEYS.list), false);
});

test("a newer list the User PAC does not pass with is held back as the conflict until a User PAC that passes", async () => {
  const { updater, store, area, commits } = await setup({ server: release(NEW, ["zone.example"]), pac: userPac("zone.example") });
  const result = await updater.update();
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "conflict");
  assert.equal(commits.length, 0);
  assert.equal(store.psl.isPublicSuffix("zone.example"), false);
  assert.equal(updater.conflict.version, NEW);
  assert.match(updater.conflict.errors[0].message, /public suffix/);
  assert.deepEqual(area.items[PSL_KEYS.conflict], updater.conflict);
  assert.equal(updater.installed.version, OLD);

  await store.commit({ ...store.state, userPac: userPac("a.zone.example") });
  const retried = await updater.update();
  assert.equal(retried.outcome, "updated");
  assert.equal(updater.conflict, null);
  assert.equal(Object.hasOwn(area.items, PSL_KEYS.conflict), false);
});

test("a failed apply keeps the list in use", async () => {
  const { updater, store, area } = await setup({ server: release(NEW, ["zone.example"]), failCommit: true });
  const result = await updater.update();
  assert.equal(result.outcome, "error");
  assert.equal(result.error, "apply failed");
  assert.equal(store.psl.isPublicSuffix("zone.example"), false);
  assert.equal(updater.installed.version, OLD);
  assert.equal(Object.hasOwn(area.items, PSL_KEYS.list), false);
});

test("two updates at once download one after the other and install once", async () => {
  const { updater, commits, web } = await setup();
  const [first, second] = await Promise.all([updater.update(), updater.update()]);
  assert.equal(first.outcome, "updated");
  assert.equal(second.outcome, "current");
  assert.equal(commits.length, 1);
  assert.equal(web.calls.filter((url) => url === PSL_URL).length, 2);
});

test("at start the downloaded list is used while it is newer than the bundled one", async () => {
  const text = release(NEW, ["zone.example"]);
  const stored = { [PSL_KEYS.list]: { version: NEW, commit: null, text, installedAt: 5 } };
  const { updater, store } = await setup({ items: stored });
  assert.equal(updater.installed.source, "downloaded");
  assert.equal(store.psl.isPublicSuffix("zone.example"), true);

  const older = { [PSL_KEYS.list]: { version: "2026-01-01_00-00-00_UTC", commit: null, text: release("2026-01-01_00-00-00_UTC"), installedAt: 5 } };
  const bundled = await setup({ items: older });
  assert.equal(bundled.updater.installed.source, "bundled");
  assert.equal(Object.hasOwn(bundled.area.items, PSL_KEYS.list), false);

  const broken = { [PSL_KEYS.list]: { version: NEW, commit: null, text: text.slice(0, 5000), installedAt: 5 } };
  const fallback = await setup({ items: broken });
  assert.equal(fallback.updater.installed.source, "bundled");
});

test("a conflict with a list no newer than the installed one is dropped at start", async () => {
  const held = { [PSL_KEYS.conflict]: { version: OLD, commit: null, errors: [] } };
  const { updater, area } = await setup({ items: held });
  assert.equal(updater.conflict, null);
  assert.equal(Object.hasOwn(area.items, PSL_KEYS.conflict), false);
  const newer = { [PSL_KEYS.conflict]: { version: NEW, commit: null, errors: [] } };
  assert.equal((await setup({ items: newer })).updater.conflict.version, NEW);
});

test("the weekly alarm follows the switch and counts the week from the last weekly check", async () => {
  const week = PSL_PERIOD_MINUTES * 60_000;
  const { updater, alarms, area, clock } = await setup({ time: 10 * week });
  await updater.schedule();
  assert.equal(area.items[PSL_KEYS.checked], 10 * week);
  assert.deepEqual(alarms.alarms[PSL_ALARM], { name: PSL_ALARM, delayInMinutes: PSL_PERIOD_MINUTES, periodInMinutes: PSL_PERIOD_MINUTES });

  await area.set({ [PSL_KEYS.auto]: false });
  await updater.schedule();
  assert.equal(alarms.alarms[PSL_ALARM], undefined);

  clock.now = 12 * week;
  await area.set({ [PSL_KEYS.auto]: true });
  await updater.schedule();
  assert.equal(alarms.alarms[PSL_ALARM].delayInMinutes, 1);

  await updater.update({ weekly: true });
  assert.equal(area.items[PSL_KEYS.checked], 12 * week);
});

test("the public suffix list settings are not routing state, and loading the store does not read them", async () => {
  const items = { [PSL_KEYS.auto]: false, [PSL_KEYS.checked]: 1, [PSL_KEYS.conflict]: { version: NEW, commit: null, errors: [] }, [PSL_KEYS.list]: { version: NEW, commit: null, text: "x", installedAt: 1 } };
  const area = new FakeArea(items);
  const state = await new Store(area, new FakeArea()).load(PSL);
  assert.equal(state.enabled, true);
  assert.equal(area.items[PSL_KEYS.auto], false);
  const read = area.calls.filter(([op]) => op === "get").flatMap(([, keys]) => keys ?? ["everything"]);
  assert.deepEqual(read, []);

  const trained = new FakeArea({ ...items, schemaVersion: 1, enabled: false });
  await new Store(trained, new FakeArea({ stateVerified: true })).load(PSL);
  assert.deepEqual(trained.calls.filter(([op]) => op === "get").map(([, keys]) => keys), [["schemaVersion", "enabled"]]);
});
