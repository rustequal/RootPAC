import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/background/engine.js";
import { createCommands } from "../src/background/messages.js";
import { Store } from "../src/background/store.js";
import { buildSystemPac } from "../src/core/build.js";
import { RULE_IDS } from "../src/core/rules.js";
import { FakeArea, FakeBrowser } from "./fakes.js";
import { fixture, loadPac, vmChecker, PSL } from "./support.js";
import { createProxy } from "../src/background/proxy.js";
import { createDnr } from "../src/background/dnr.js";

async function setup() {
  const area = new FakeArea();
  const store = new Store(area, new FakeArea());
  await store.load(PSL);
  const browser = new FakeBrowser();
  const session = new FakeArea();
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session, now: () => 1000 });
  const commands = createCommands({ store, engine, checker: vmChecker(), session: new FakeArea(), learner: { tabHost: () => null, newHosts: () => 0 } });
  return { area, store, browser, engine, commands, session };
}

async function restartedEngine(area, browser) {
  const store = new Store(area, new FakeArea());
  await store.load(PSL);
  const session = new FakeArea();
  return { store, session, engine: createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session, now: () => 1000 }) };
}

const CLOSED = [RULE_IDS.block, RULE_IDS.deny, RULE_IDS.frame, RULE_IDS.reports, RULE_IDS.reportsFrame, RULE_IDS.embeds, RULE_IDS.rootRequests];
const OPEN = [...CLOSED.slice(0, 3), RULE_IDS.unlock, ...CLOSED.slice(3), RULE_IDS.roots];

function allowedHosts(rules) {
  return rules.filter(({ id }) => id >= RULE_IDS.hosts).flatMap(({ condition }) => condition.requestDomains);
}

function allowedRoots(rules) {
  return rules.filter(({ id }) => id === RULE_IDS.roots).flatMap(({ condition }) => condition.requestDomains);
}

function assertNoLeakWindow(browser) {
  for (const { pac, rules } of browser.snapshots) {
    const hosts = allowedHosts(rules);
    if (hosts.length === 0 && allowedRoots(rules).length === 0) continue;
    assert.notEqual(pac, null, "allow rules exist while no PAC is set");
    const context = loadPac(pac);
    for (const host of hosts) {
      assert.notEqual(context.FindProxyForURL(`https://${host}/`, host), "DIRECT", `${host} allowed but routed DIRECT`);
    }
  }
}

function learn(store, engine, host, mask = "instagram.com", rootHost = "www.instagram.com") {
  return store.run((state) => {
    const group = state.groups[mask];
    const groups = { ...state.groups, [mask]: { rootHost: group.rootHost ?? rootHost, hosts: { ...group.hosts, [host]: 1 } } };
    return engine.commit({ ...state, groups, appliedPac: buildSystemPac(state.userPac, groups, PSL) });
  });
}

test("first configuration blocks before it proxies and allows last", async () => {
  const { browser, commands, engine, session } = await setup();
  const result = await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  assert.equal(result.control.armed, true);
  assert.deepEqual(browser.journal.names(), ["dnr.update", "prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
  const [[, blocks], [, allows]] = browser.journal.entries.filter(([name]) => name.startsWith("dnr."));
  assert.deepEqual(blocks.addRules.map(({ id }) => id).sort((a, b) => a - b), CLOSED);
  assert.deepEqual(allows.addRules.map(({ id }) => id), [RULE_IDS.unlock, RULE_IDS.roots]);
  assert.deepEqual(browser.ruleIds(), OPEN);
  assert.deepEqual([...browser.sessionRules.keys()], [RULE_IDS.unlock, RULE_IDS.roots]);
  assert.equal(engine.armed, true);
  assert.deepEqual(session.items, { armed: true, openedAt: 1000 });
  assertNoLeakWindow(browser);
});

test("a learned host is proxied before it is allowed", async () => {
  const { browser, store, engine, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  browser.journal.clear();
  await learn(store, engine, "static.cdninstagram.com");
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
  assert.deepEqual(allowedHosts(browser.allRules()), ["static.cdninstagram.com"]);
  assertNoLeakWindow(browser);
});

test("a removed host loses its allowance before the PAC changes", async () => {
  const { browser, store, engine, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "static.cdninstagram.com");
  await learn(store, engine, "edge-chat.facebook.com");
  browser.journal.clear();
  await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "static.cdninstagram.com" });
  assert.deepEqual(browser.journal.names(), ["dnr.session", "prediction.set", "webrtc.set", "proxy.set"]);
  assert.deepEqual(allowedHosts(browser.allRules()), ["edge-chat.facebook.com"]);
  assertNoLeakWindow(browser);
});

test("aggregation keeps the covered hosts allowed while the PAC changes", async () => {
  const { browser, store, engine, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "a.cdn.net");
  await learn(store, engine, "b.cdn.net");
  browser.journal.clear();
  const first = browser.snapshots.length;
  await store.run((state) => {
    const groups = { ...state.groups, "instagram.com": { rootHost: "www.instagram.com", hosts: { "cdn.net": 1 } } };
    return engine.commit({ ...state, groups, appliedPac: buildSystemPac(state.userPac, groups, PSL) });
  });
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
  const during = browser.snapshots.slice(first, -1);
  assert.ok(during.length > 0);
  for (const { rules } of during) assert.deepEqual(allowedHosts(rules), ["a.cdn.net", "b.cdn.net"]);
  assert.deepEqual(allowedHosts(browser.allRules()), ["cdn.net"]);
  assertNoLeakWindow(browser);
});

test("disabling closes first, then clears the proxy, then removes every rule", async () => {
  const { browser, store, engine, commands, session } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "static.cdninstagram.com");
  browser.journal.clear();
  await commands.dispatch({ type: "setEnabled", enabled: false });
  assert.deepEqual(browser.journal.names(), ["dnr.session", "proxy.clear", "prediction.clear", "webrtc.clear", "dnr.update"]);
  assert.deepEqual(browser.ruleIds(), []);
  assert.equal(engine.armed, false);
  assert.deepEqual(session.items, { armed: false, openedAt: null });
  assertNoLeakWindow(browser);
});

test("a failed PAC apply never leaves an allowance ahead of the PAC", async () => {
  const { browser, store, engine, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  browser.journal.failures.set("proxy.set", new Error("settings unavailable"));
  const before = store.state;
  await assert.rejects(learn(store, engine, "static.cdninstagram.com"), /settings unavailable/);
  assert.equal(store.state, before);
  assert.deepEqual(allowedHosts(browser.allRules()), []);
  assert.equal(browser.pac(), before.appliedPac);
  await learn(store, engine, "edge-chat.facebook.com");
  assert.deepEqual(allowedHosts(browser.allRules()), ["edge-chat.facebook.com"]);
  assertNoLeakWindow(browser);
});

test("a restarted service worker accepts a matching installed state without touching the browser", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  const { engine, session } = await restartedEngine(area, browser);
  browser.journal.clear();
  const control = await engine.check();
  assert.equal(control.armed, true);
  assert.deepEqual(browser.journal.names(), []);
  assert.equal(engine.armed, true);
  assert.deepEqual(session.items, { armed: true, openedAt: 1000 });
  assert.deepEqual(browser.ruleIds(), OPEN);
});

test("after a browser restart the roots stay closed until the check re-arms them", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  browser.restart();
  assert.deepEqual(browser.ruleIds(), CLOSED);
  const { engine } = await restartedEngine(area, browser);
  browser.journal.clear();
  browser.snapshots.length = 0;
  await engine.check();
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
  assert.deepEqual(browser.ruleIds(), OPEN);
  assertNoLeakWindow(browser);
});

test("a stale PAC after an update is re-applied by the check", async () => {
  const { area, browser, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  browser.proxy.settings.value = { mode: "pac_script", pacScript: { data: "function FindProxyForURL() { return 'PROXY old:1'; }", mandatory: true } };
  const { engine, store } = await restartedEngine(area, browser);
  browser.journal.clear();
  await engine.check();
  assert.equal(browser.pac(), store.state.appliedPac);
  assert.deepEqual(browser.journal.names(), ["dnr.session", "prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
  assertNoLeakWindow(browser);
});

test("another extension taking over closes the roots at once and they reopen when it leaves", async () => {
  const { browser, store, engine, commands, session } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "static.cdninstagram.com");
  browser.takeOver();
  browser.journal.clear();
  const lost = await engine.recheck();
  assert.equal(lost.armed, false);
  assert.deepEqual(browser.journal.names(), ["dnr.session"]);
  assert.deepEqual(browser.ruleIds(), CLOSED);
  assert.equal(engine.armed, false);
  assert.deepEqual(session.items, { armed: false, openedAt: null });
  browser.journal.clear();
  await engine.recheck();
  assert.deepEqual(browser.journal.names(), []);
  browser.takeOver("controlled_by_this_extension");
  const back = await engine.recheck();
  assert.equal(back.armed, true);
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
  assert.deepEqual(allowedHosts(browser.allRules()), ["static.cdninstagram.com"]);
  browser.journal.clear();
  await engine.recheck();
  assert.deepEqual(browser.journal.names(), []);
  assertNoLeakWindow(browser);
});

test("a commit or a restart under foreign control installs only the blocks", async () => {
  const { area, browser, commands, engine } = await setup();
  browser.takeOver();
  const result = await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  assert.equal(result.ok, true);
  assert.equal(result.control.armed, false);
  assert.deepEqual(browser.ruleIds(), CLOSED);
  assert.equal(engine.armed, false);
  const restarted = await restartedEngine(area, browser);
  browser.journal.clear();
  await restarted.engine.check();
  assert.deepEqual(browser.ruleIds(), CLOSED);
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set"]);
  assert.deepEqual(restarted.session.items, { armed: false, openedAt: null });
  assertNoLeakWindow(browser);
});

test("changing roots never allows a host the PAC does not proxy yet", async () => {
  const { browser, store, engine, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "static.cdninstagram.com");
  const moved = fixture("user.pac").replace('root(host, "instagram.com")', 'root(host, "instagram.com") || root(host, "cdninstagram.com")');
  await commands.dispatch({ type: "saveUserPac", text: moved });
  assert.deepEqual(allowedHosts(browser.allRules()), []);
  assert.equal(browser.rules.get(RULE_IDS.block).condition.topDomains.join(), "cdninstagram.com,instagram.com");
  assert.equal(browser.rules.get(RULE_IDS.frame).condition.requestDomains.join(), "cdninstagram.com,instagram.com");
  assert.equal(browser.sessionRules.get(RULE_IDS.roots).condition.requestDomains.join(), "cdninstagram.com,instagram.com");
  assertNoLeakWindow(browser);
});

test("a failed commit rolls storage and browser back to the previous state", async () => {
  const { area, browser, store, engine, commands } = await setup();
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "static.cdninstagram.com");
  const items = structuredClone(area.items);
  const pac = browser.pac();
  const rules = browser.ruleIds();
  browser.journal.clear();
  browser.journal.failures.set("dnr.session", new Error("rule limit"));
  await assert.rejects(learn(store, engine, "edge-chat.facebook.com"), /rule limit/);
  assert.deepEqual(area.items, items);
  assert.equal(browser.pac(), pac);
  assert.deepEqual(browser.ruleIds(), rules);
  assert.deepEqual(allowedHosts(browser.allRules()), ["static.cdninstagram.com"]);
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set", "dnr.session", "prediction.set", "webrtc.set", "proxy.set"]);
  assertNoLeakWindow(browser);
});

test("a foreign incognito-only proxy closes the roots in every window and they reopen when it leaves", async () => {
  const { browser, store, engine, commands, session } = await setup();
  browser.incognitoAllowed = true;
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  await learn(store, engine, "static.cdninstagram.com");
  assert.equal(engine.armed, true);
  browser.proxy.settings.incognito = { level: "controlled_by_other_extensions", value: { mode: "direct" } };
  browser.journal.clear();
  const lost = await engine.recheck();
  assert.equal(lost.armed, false);
  assert.equal(lost.levels.proxy, "controlled_by_this_extension");
  assert.equal(lost.incognitoLevels.proxy, "controlled_by_other_extensions");
  assert.deepEqual(browser.ruleIds(), CLOSED);
  assert.deepEqual(session.items, { armed: false, openedAt: null });
  browser.proxy.settings.incognito = null;
  const back = await engine.recheck();
  assert.equal(back.armed, true);
  assert.deepEqual(allowedHosts(browser.allRules()), ["static.cdninstagram.com"]);
  assertNoLeakWindow(browser);
});
