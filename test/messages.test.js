import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { createEngine } from "../src/background/engine.js";
import { createCommands } from "../src/background/messages.js";
import { createProxy } from "../src/background/proxy.js";
import { Store } from "../src/background/store.js";
import { buildSystemPac } from "../src/core/build.js";
import { FakeArea, FakeBrowser, deferred } from "./fakes.js";
import { fixture, vmChecker, PSL } from "./support.js";

const OWNED = {
  levels: { proxy: "controlled_by_this_extension", prediction: "controlled_by_this_extension", webrtc: "controlled_by_this_extension" },
  incognitoLevels: null,
  controllable: true,
  armed: true,
};

const fakeLearner = () => ({
  hosts: new Map(),
  tabs: new Map(),
  load: new Map(),
  via: new Map(),
  broken: new Set(),
  incomplete(tabId) {
    return this.broken.has(tabId);
  },
  tabHost(tabId) {
    return this.tabs.get(tabId) ?? null;
  },
  newHosts(tabId) {
    return this.hosts.get(tabId) ?? 0;
  },
  loaded(tabId) {
    return this.load.get(tabId) ?? 0;
  },
  proxied(tabId) {
    return this.via.get(tabId) ?? 0;
  },
  loading() {
    return false;
  },
  pending() {
    return 0;
  },
});

async function setup(items = {}, { checker = vmChecker(), session = new FakeArea(), learner = fakeLearner() } = {}) {
  const area = new FakeArea(items);
  const store = new Store(area, new FakeArea());
  await store.load(PSL);
  area.calls.length = 0;
  const browser = new FakeBrowser();
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session: new FakeArea() });
  return { area, store, browser, checker, session, learner, commands: createCommands({ store, engine, checker, session, learner }) };
}

const TRAINED = {
  schemaVersion: 1,
  enabled: true,
  userPac: 'function FindProxyForURL(url, host) {\n  return root(host, "a.com") || root(host, "old.com") ? "PROXY p:1" : "DIRECT";\n}',
  analysis: { roots: ["a.com", "old.com"], deny: [], bypass: [] },
  appliedPac: "stale",
  "group:a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1, "px.ads.net": 2, "api.b.com": 3 } },
  "group:old.com": { rootHost: "old.com", hosts: { "x.old.net": 4 } },
  "seen:a.com": { "cdn.a.net": 10, "px.ads.net": 11 },
  "seen:old.com": { "x.old.net": 12 },
};

test("saveUserPac validates, stores, builds and applies", async () => {
  const { area, browser, commands } = await setup();
  const text = fixture("user.pac");
  assert.deepEqual(await commands.dispatch({ type: "saveUserPac", text }), {
    ok: true,
    errors: [],
    analysis: { roots: ["instagram.com"], deny: ["*.google-analytics.com", "*.doubleclick.net"], bypass: [] },
    control: OWNED,
  });
  const expected = buildSystemPac(text, {
    "instagram.com": { rootHost: null, hosts: {} },
    "instagram.com": { rootHost: null, hosts: {} },
  }, PSL);
  assert.equal(area.items.userPac, text);
  assert.equal(area.items.appliedPac, expected);
  assert.deepEqual(area.items["group:instagram.com"], { rootHost: null, hosts: {} });
  assert.equal(browser.pac(), expected);
});

test("an invalid User PAC changes nothing", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  const before = structuredClone(area.items);
  area.calls.length = 0;
  browser.journal.clear();
  assert.deepEqual(await commands.dispatch({ type: "saveUserPac", text: "var root;\n" }), {
    ok: false,
    errors: [
      { line: 1, column: 1, message: "Missing top-level function FindProxyForURL" },
      { line: 1, column: 5, message: "Identifier root must not be declared" },
    ],
  });
  assert.deepEqual(area.items, before);
  assert.deepEqual(area.writes(), []);
  assert.deepEqual(browser.journal.entries, []);
});

test("saving a new User PAC cleans up groups and seen records", async () => {
  const { area, browser, commands } = await setup(TRAINED);
  const text = 'deny("*.ads.net");\nfunction FindProxyForURL(url, host) {\n  return root(host, "a.com") || root(host, "b.com") ? "PROXY p:2" : "DIRECT";\n}';
  assert.equal((await commands.dispatch({ type: "saveUserPac", text })).ok, true);
  assert.deepEqual(area.items["group:a.com"], { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } });
  assert.deepEqual(area.items["group:b.com"], { rootHost: null, hosts: {} });
  assert.deepEqual(area.items["seen:a.com"], { "cdn.a.net": 10 });
  assert.equal(Object.hasOwn(area.items, "group:old.com"), false);
  assert.equal(Object.hasOwn(area.items, "seen:old.com"), false);
  assert.match(browser.pac(), /"cdn\.a\.net": 1/);
  assert.doesNotMatch(browser.pac(), /ads\.net": 1|x\.old\.net|api\.b\.com/);
});

test("saving while disabled stores the PAC without touching the browser", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "setEnabled", enabled: false });
  browser.journal.clear();
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") })).ok, true);
  assert.deepEqual(browser.journal.names(), ["proxy.clear", "prediction.clear", "webrtc.clear"]);
  assert.deepEqual(browser.ruleIds(), []);
  assert.equal(typeof area.items.appliedPac, "string");
});

test("setEnabled toggles the proxy, privacy settings and rules", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  assert.deepEqual(await commands.dispatch({ type: "setEnabled", enabled: false }), {
    ok: true,
    control: { ...OWNED, armed: false, levels: { proxy: "controllable_by_this_extension", prediction: "controllable_by_this_extension", webrtc: "controllable_by_this_extension" } },
  });
  assert.equal(area.items.enabled, false);
  assert.equal(browser.pac(), null);
  assert.deepEqual(browser.ruleIds(), []);
  await commands.dispatch({ type: "setEnabled", enabled: true });
  assert.equal(browser.pac(), area.items.appliedPac);
  assert.notDeepEqual(browser.ruleIds(), []);
});

test("setEnabled without a User PAC keeps everything cleared", async () => {
  const { browser, commands } = await setup();
  assert.equal((await commands.dispatch({ type: "setEnabled", enabled: true })).ok, true);
  assert.deepEqual(browser.journal.names(), ["proxy.clear", "prediction.clear", "webrtc.clear"]);
});

test("removeHost and clearGroup rebuild the PAC", async () => {
  const { area, browser, commands } = await setup(TRAINED);
  await commands.dispatch({ type: "saveUserPac", text: TRAINED.userPac });
  assert.equal((await commands.dispatch({ type: "removeHost", mask: "a.com", host: "px.ads.net" })).ok, true);
  assert.deepEqual(area.items["group:a.com"].hosts, { "cdn.a.net": 1, "api.b.com": 3 });
  assert.deepEqual(area.items["seen:a.com"], { "cdn.a.net": 10 });
  assert.doesNotMatch(browser.pac(), /px\.ads\.net/);
  assert.equal((await commands.dispatch({ type: "clearGroup", mask: "a.com" })).ok, true);
  assert.deepEqual(area.items["group:a.com"], { rootHost: null, hosts: {} });
  assert.equal(Object.hasOwn(area.items, "seen:*.a.com"), false);
  assert.doesNotMatch(browser.pac(), /cdn\.a\.net/);
});

test("removeHost and clearGroup reject unknown targets", async () => {
  const { commands } = await setup(TRAINED);
  assert.deepEqual(await commands.dispatch({ type: "removeHost", mask: "nope.com", host: "x.net" }), { ok: false, error: 'Unknown group "nope.com"' });
  assert.deepEqual(await commands.dispatch({ type: "removeHost", mask: "a.com", host: "x.net" }), {
    ok: false,
    error: 'Host "x.net" is not in group "a.com"',
  });
  assert.deepEqual(await commands.dispatch({ type: "clearGroup", mask: 1 }), { ok: false, error: "mask must be a string" });
});

test("commands never overlap browser mutations", async () => {
  const { browser, commands } = await setup();
  browser.journal.gate = deferred();
  const pending = [
    commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") }),
    commands.dispatch({ type: "setEnabled", enabled: false }),
    commands.dispatch({ type: "setEnabled", enabled: true }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.journal.inFlight, 1);
  browser.journal.gate.resolve();
  await Promise.all(pending);
  assert.equal(browser.journal.maxInFlight, 1);
});

test("a failing browser call is reported and does not block later commands", async () => {
  const { area, browser, commands } = await setup();
  browser.journal.failures.set("proxy.set", new Error("Proxy settings unavailable"));
  assert.deepEqual(await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") }), {
    ok: false,
    error: "Proxy settings unavailable",
  });
  assert.deepEqual(Object.keys(area.items).sort(), ["enabled", "schemaVersion"]);
  assert.equal(browser.pac(), null);
  assert.deepEqual(browser.ruleIds(), []);
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") })).ok, true);
  assert.equal(browser.pac(), area.items.appliedPac);
});

test("malformed messages are rejected", async () => {
  const { area, browser, commands } = await setup();
  const cases = [
    [null, "Unknown command undefined"],
    ["saveUserPac", "Unknown command undefined"],
    [{ type: "nope" }, 'Unknown command "nope"'],
    [{ type: ["saveUserPac"] }, 'Unknown command ["saveUserPac"]'],
    [{ type: "toString" }, 'Unknown command "toString"'],
    [{ type: "saveUserPac", text: 1 }, "text must be a string"],
    [{ type: "setEnabled", enabled: "true" }, "enabled must be a boolean"],
    [{ type: "removeHost", mask: "a.com" }, "host must be a string"],
  ];
  for (const [message, error] of cases) {
    assert.deepEqual(await commands.dispatch(message), { ok: false, error }, JSON.stringify(message));
  }
  assert.deepEqual(area.writes(), []);
  assert.deepEqual(browser.journal.entries, []);
});

const BROKEN = [
  ["var p = list[0];\n" + fixture("user.pac"), { line: 1, column: 9, message: "User PAC failed to initialize: ReferenceError: list is not defined" }],
  [fixture("user.pac").replace("return PROXY;", 'return "DIRECT";'), { line: null, column: null, message: "User PAC returned no proxy for instagram.com" }],
  [fixture("user.pac").replace('return "DIRECT";', "while (true) {}"), { line: 8, column: 17, message: "User PAC exceeded the step budget (possible infinite loop)" }],
  [fixture("user.pac").replace("SOCKS5 10.1.4.1:9487", "SOCKS5 10.1.4.1:94870"), { line: null, column: null, message: "User PAC returned no proxy for instagram.com" }],
  [fixture("user.pac").replace("SOCKS5 10.1.4.1:9487", "PROXY user:pass@10.1.4.1:9487"), { line: null, column: null, message: "User PAC returned no proxy for instagram.com" }],
];

test("a User PAC that fails its trial run changes nothing", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  const before = structuredClone(area.items);
  const pac = browser.pac();
  browser.journal.clear();
  area.calls.length = 0;
  for (const [text, error] of BROKEN) {
    assert.deepEqual(await commands.dispatch({ type: "saveUserPac", text }), { ok: false, errors: [error] });
  }
  assert.deepEqual(area.items, before);
  assert.deepEqual(area.writes(), []);
  assert.deepEqual(browser.journal.entries, []);
  assert.equal(browser.pac(), pac);
});

test("the trial run sees the current groups and does not hold the queue", async () => {
  const gate = deferred();
  const inner = vmChecker();
  const checker = {
    requests: [],
    async run(request) {
      this.requests.push(request);
      await gate.promise;
      return inner.run(request);
    },
    cancel: async () => false,
  };
  const { commands, browser } = await setup(TRAINED, { checker });
  const saving = commands.dispatch({ type: "saveUserPac", text: TRAINED.userPac });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(checker.requests[0].hosts, ["a.com", "www.a.com", "old.com", "example.com"]);
  assert.equal((await commands.dispatch({ type: "setEnabled", enabled: false })).ok, true);
  assert.equal(browser.pac(), null);
  gate.resolve();
  assert.equal((await saving).ok, true);
});

test("a cancelled trial run reports it and changes nothing", async () => {
  const checker = { run: async () => ({ cancelled: true }), cancel: async () => true };
  const { area, commands } = await setup({}, { checker });
  assert.deepEqual(await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") }), { ok: false, error: "Check was cancelled" });
  assert.deepEqual(Object.keys(area.items).sort(), ["enabled", "schemaVersion"]);
  assert.deepEqual(await commands.dispatch({ type: "cancelCheck" }), { ok: true, cancelled: true });
});

test("successful configuration changes clear lastProxyError", async () => {
  const session = new FakeArea({ lastProxyError: { time: 1, error: "net::ERR_PAC_SCRIPT_FAILED", details: "line: 1: x", fatal: false } });
  const { commands } = await setup({}, { session });
  await commands.dispatch({ type: "saveUserPac", text: "var root;" });
  assert.equal(Object.hasOwn(session.items, "lastProxyError"), true);
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  assert.equal(Object.hasOwn(session.items, "lastProxyError"), false);
  session.items.lastProxyError = { time: 2 };
  await commands.dispatch({ type: "setEnabled", enabled: true });
  assert.equal(Object.hasOwn(session.items, "lastProxyError"), false);
});

test("safe mode keeps protection, pauses edits and is left by a valid save", async () => {
  const invalid = TRAINED.userPac.replace('"old.com"', '"Old.com"');
  const applied = buildSystemPac(TRAINED.userPac, {
    "a.com": TRAINED["group:a.com"],
    "old.com": TRAINED["group:old.com"],
  }, PSL);
  const { area, store, browser, commands } = await setup({ ...TRAINED, userPac: invalid, appliedPac: applied });
  assert.equal(store.state.userPacErrors.length, 1);
  assert.equal(store.state.appliedPac, applied);
  assert.equal((await commands.dispatch({ type: "setEnabled", enabled: true })).ok, true);
  assert.equal(browser.pac(), applied);
  assert.notDeepEqual(browser.ruleIds(), []);
  assert.deepEqual(await commands.dispatch({ type: "removeHost", mask: "a.com", host: "cdn.a.net" }), { ok: false, error: "User PAC must be fixed first" });
  assert.deepEqual(await commands.dispatch({ type: "clearGroup", mask: "a.com" }), { ok: false, error: "User PAC must be fixed first" });
  assert.equal((await commands.dispatch({ type: "exportState" })).backup.userPac, invalid);
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: TRAINED.userPac })).ok, true);
  assert.equal(Object.hasOwn(area.items, "userPacErrors"), false);
  assert.equal(store.state.userPacErrors, null);
});

test("export and import round-trip the configuration through the gate", async () => {
  const { commands } = await setup(TRAINED);
  await commands.dispatch({ type: "saveUserPac", text: TRAINED.userPac });
  const { ok, backup } = await commands.dispatch({ type: "exportState" });
  assert.equal(ok, true);
  const target = await setup();
  const imported = await target.commands.dispatch({ type: "importState", backup: JSON.parse(JSON.stringify(backup)) });
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.analysis, TRAINED.analysis);
  assert.deepEqual(target.area.items["group:a.com"], TRAINED["group:a.com"]);
  assert.equal(Object.hasOwn(target.area.items, "seen:*.a.com"), false);
  assert.equal(target.browser.pac(), target.area.items.appliedPac);
  assert.match(target.browser.pac(), /"api\.b\.com": 1/);
});

test("importState refuses bad backups without changing anything", async () => {
  const { area, browser, commands } = await setup();
  const good = { schemaVersion: 1, userPac: TRAINED.userPac, groups: { "a.com": { rootHost: "www.a.com", hosts: {} }, "old.com": { rootHost: null, hosts: {} } } };
  const cases = [
    [{ ...good, schemaVersion: 3 }, { ok: false, error: "Unsupported backup schema version 3" }],
    [{ ...good, groups: { "a.com": good.groups["a.com"] } }, { ok: false, error: 'Root "old.com" has no group' }],
    [{ ...good, userPac: "var root;" }, null],
    [{ ...good, userPac: good.userPac.replace('"PROXY p:1"', '"DIRECT"') }, { ok: false, errors: [{ line: null, column: null, message: "User PAC returned no proxy for a.com" }] }],
  ];
  for (const [backup, expected] of cases) {
    const result = await commands.dispatch({ type: "importState", backup });
    assert.equal(result.ok, false);
    if (expected !== null) assert.deepEqual(result, expected);
  }
  assert.deepEqual(await commands.dispatch({ type: "exportState" }), { ok: false, error: "No user PAC configured" });
  assert.deepEqual(area.writes(), []);
  assert.deepEqual(browser.journal.entries, []);
});

test("saving and importing aggregate groups before the trial run", async () => {
  const hosts = { "a.img.org": 1, "b.img.org": 2 };
  const { area, commands, checker } = await setup({ ...TRAINED, "group:a.com": { rootHost: "www.a.com", hosts }, "seen:a.com": {} });
  assert.deepEqual(area.items["group:a.com"].hosts, { "img.org": 1 });
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: TRAINED.userPac })).ok, true);
  assert.match(checker.requests.at(-1).code, /"img\.org": 1/);
  const target = await setup();
  const backup = { schemaVersion: 1, userPac: TRAINED.userPac, groups: { "a.com": { rootHost: "www.a.com", hosts }, "old.com": { rootHost: null, hosts: {} } } };
  assert.equal((await target.commands.dispatch({ type: "importState", backup })).ok, true);
  assert.deepEqual(target.area.items["group:a.com"].hosts, { "img.org": 1 });
});

test("a cancelled check answers with an error and changes nothing", async () => {
  const checker = { run: async () => ({ cancelled: true }), cancel: async () => true };
  const { commands, area } = await setup({}, { checker });
  const before = structuredClone(area.items);
  assert.deepEqual(await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") }), { ok: false, error: "Check was cancelled" });
  assert.deepEqual(area.items, before);
});

test("getTabState reports the root, its group and the new hosts of a tab", async () => {
  const { commands, learner } = await setup(TRAINED);
  learner.tabs.set(7, "www.a.com");
  learner.hosts.set(7, 2);
  learner.load.set(7, 9);
  learner.via.set(7, 5);
  learner.broken.add(7);
  assert.deepEqual(await commands.dispatch({ type: "getTabState", tabId: 7 }), {
    ok: true,
    mask: "a.com",
    rootHost: "www.a.com",
    hostCount: 3,
    loaded: 9,
    proxied: 5,
    newHosts: 2,
    incomplete: true,
  });
  learner.tabs.set(8, "example.org");
  assert.deepEqual(await commands.dispatch({ type: "getTabState", tabId: 8 }), { ok: true, mask: null, rootHost: null, hostCount: 0, loaded: 0, proxied: 0, newHosts: 0, incomplete: false });
  assert.deepEqual(await commands.dispatch({ type: "getTabState", tabId: 9 }), { ok: true, mask: null, rootHost: null, hostCount: 0, loaded: 0, proxied: 0, newHosts: 0, incomplete: false });
  assert.deepEqual(await commands.dispatch({ type: "getTabState", tabId: "7" }), { ok: false, error: "tabId must be an integer" });
});

test("getTabState works before a User PAC is saved", async () => {
  const { commands, learner } = await setup();
  learner.tabs.set(1, "www.a.com");
  assert.deepEqual(await commands.dispatch({ type: "getTabState", tabId: 1 }), { ok: true, mask: null, rootHost: null, hostCount: 0, loaded: 0, proxied: 0, newHosts: 0, incomplete: false });
});
