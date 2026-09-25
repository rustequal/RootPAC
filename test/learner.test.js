import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { createEngine } from "../src/background/engine.js";
import { createLearner } from "../src/background/learner.js";
import { createCommands } from "../src/background/messages.js";
import { createProxy } from "../src/background/proxy.js";
import { Store } from "../src/background/store.js";
import { RULE_IDS } from "../src/core/rules.js";
import { FakeArea, FakeBrowser, deferred } from "./fakes.js";
import { fixture, loadPac, vmChecker, PSL } from "./support.js";

const TAB = 7;
const NO_TABS = { query: async () => [] };

async function setup({ session = new FakeArea(), enabled = true } = {}) {
  const area = new FakeArea();
  const store = new Store(area, new FakeArea());
  await store.load(PSL);
  const browser = new FakeBrowser();
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session: new FakeArea() });
  const commands = createCommands({ store, engine, checker: vmChecker(), session: new FakeArea(), learner: { tabHost: () => null, newHosts: () => 0 } });
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  if (!enabled) await commands.dispatch({ type: "setEnabled", enabled: false });
  let time = 1000;
  const learner = createLearner({ store, engine, session, tabs: NO_TABS, now: () => time++ });
  await learner.restore();
  browser.journal.clear();
  area.calls.length = 0;
  return { area, store, browser, engine, commands, learner, session };
}

const settled = async (learner) => {
  for (let i = 0; i < 50 && (learner.running || learner.writing); i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const navigate = (learner, url, tabId = TAB, extra = {}) => {
  const documentLifecycle = extra.documentLifecycle ?? "active";
  learner.onRequest({ type: "main_frame", tabId, url, documentLifecycle, ...extra });
  learner.onCommitted({ tabId, frameId: 0, url, documentLifecycle });
};

const tabRecord = (fields) => ({ host: null, navigation: 0, newHosts: 0, loaded: [], proxied: [], loading: false, incomplete: false, ...fields });
const storedTabs = async (session) =>
  Object.fromEntries(Object.entries(await session.get(null)).flatMap(([key, value]) => (key.startsWith("tab:") ? [[key.slice(4), value]] : [])));
const storedTab = async (session, tabId) => (await storedTabs(session))[tabId];

let requestId = 0;
const request = (learner, url, extra = {}) => {
  const details = { requestId: String(++requestId), type: "script", tabId: TAB, url, documentLifecycle: "active", timeStamp: Date.now(), ...extra };
  learner.onRequest(details);
  return details;
};
const loads = (learner, url, extra) => learner.onResponse(request(learner, url, extra));
const blocks = (learner, url, extra) => learner.onError({ ...request(learner, url, extra), error: "net::ERR_BLOCKED_BY_CLIENT" });

function learned(area, mask = "instagram.com") {
  return area.items[`group:${mask}`];
}

test("hosts loaded by a root tab are learned, proxied and allowed", async () => {
  const { area, browser, learner } = await setup();
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://static.cdninstagram.com/rsrc.php/a.js");
  await settled(learner);
  assert.deepEqual(learned(area), { rootHost: "www.instagram.com", hosts: { "static.cdninstagram.com": 1000 } });
  assert.equal(loadPac(browser.pac()).FindProxyForURL("https://static.cdninstagram.com/", "static.cdninstagram.com"), "SOCKS5 10.1.4.1:9487");
  assert.deepEqual(browser.sessionRules.get(RULE_IDS.hosts).condition.requestDomains, ["static.cdninstagram.com"]);
  assert.deepEqual(browser.journal.names(), ["prediction.set", "webrtc.set", "proxy.set", "dnr.session"]);
});

test("the apex of the root domain learns into the root with itself as rootHost", async () => {
  const { area, learner } = await setup();
  navigate(learner, "https://instagram.com/");
  request(learner, "https://cdn.example.net/x");
  await settled(learner);
  assert.deepEqual(learned(area), { rootHost: "instagram.com", hosts: { "cdn.example.net": 1000 } });
});

test("a root embedded in another site learns by its initiator", async () => {
  const { area, learner } = await setup();
  navigate(learner, "https://news.example.org/");
  request(learner, "https://video.cdn.net/v", { initiator: "https://www.instagram.com" });
  request(learner, "https://ads.example.org/a", { initiator: "https://news.example.org" });
  await settled(learner);
  assert.deepEqual(learned(area), { rootHost: "www.instagram.com", hosts: { "video.cdn.net": 1000 } });
});

test("requests of the old document are not attributed to a root still being navigated to", async () => {
  const { area, learner } = await setup();
  navigate(learner, "https://news.example.org/");
  learner.onRequest({ type: "main_frame", tabId: TAB, url: "https://www.instagram.com/", documentLifecycle: "active" });
  request(learner, "https://late.example.org/x", { initiator: "https://news.example.org" });
  request(learner, "https://late2.example.org/x");
  await settled(learner);
  assert.deepEqual(learned(area).hosts, {});
});

test("requests outside root tabs are ignored", async () => {
  const { area, learner } = await setup();
  navigate(learner, "https://example.org/");
  request(learner, "https://cdn.example.net/x");
  request(learner, "https://cdn2.example.net/x", { tabId: 99 });
  navigate(learner, "https://www.instagram.com/", 8, { documentLifecycle: "prerender" });
  request(learner, "https://cdn3.example.net/x", { tabId: 8 });
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://cdn4.example.net/x", { documentLifecycle: "prerender" });
  request(learner, "https://cdn5.example.net/x", { documentLifecycle: "cached" });
  request(learner, "https://cdn6.example.net/x", { documentLifecycle: "pending_deletion" });
  await settled(learner);
  assert.deepEqual(learned(area).hosts, {});
});

test("service worker requests are attributed by their initiator", async () => {
  const { area, learner } = await setup();
  learner.onRequest({ type: "xmlhttprequest", tabId: -1, url: "https://sw.cdn.net/f", initiator: "https://www.instagram.com" });
  learner.onRequest({ type: "xmlhttprequest", tabId: -1, url: "https://sw2.cdn.net/f", initiator: "https://example.org" });
  learner.onRequest({ type: "xmlhttprequest", tabId: -1, url: "https://sw3.cdn.net/f", initiator: "null" });
  learner.onRequest({ type: "xmlhttprequest", tabId: -1, url: "https://sw4.cdn.net/f" });
  await settled(learner);
  assert.deepEqual(learned(area), { rootHost: "www.instagram.com", hosts: { "sw.cdn.net": 1000 } });
});

test("roots, deny, IP literals, plain names and covered subdomains are not learned", async () => {
  const { area, learner } = await setup();
  navigate(learner, "https://www.instagram.com/");
  for (const url of [
    "https://i.instagram.com/api",
    "https://instagram.com/",
    "https://www.google-analytics.com/g/collect",
    "https://stats.g.doubleclick.net/x",
    "https://157.240.1.35/",
    "https://[2a03:2880::1]/",
    "http://localhost:3000/",
    "data:text/plain,x",
  ]) {
    request(learner, url);
  }
  request(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  request(learner, "https://v2.static.cdninstagram.com/a.js");
  await settled(learner);
  assert.deepEqual(Object.keys(learned(area).hosts), ["static.cdninstagram.com"]);
});

test("nothing is learned while the proxy is disabled", async () => {
  const { area, learner } = await setup({ enabled: false });
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  assert.deepEqual(learned(area).hosts, {});
});

test("single-flight: one apply at a time and late hosts go in one next batch", async () => {
  const { area, browser, learner } = await setup();
  navigate(learner, "https://www.instagram.com/");
  browser.journal.gate = deferred();
  request(learner, "https://a.cdn-a.net/1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(learner.running, true);
  request(learner, "https://b.cdn-b.net/1");
  request(learner, "https://c.cdn-c.net/1");
  request(learner, "https://b.cdn-b.net/2");
  browser.journal.gate.resolve();
  await settled(learner);
  assert.equal(learner.running, false);
  assert.equal(browser.journal.maxInFlight, 1);
  assert.equal(browser.journal.names().filter((name) => name === "proxy.set").length, 2);
  assert.deepEqual(learned(area).hosts, { "a.cdn-a.net": 1000, "b.cdn-b.net": 1001, "c.cdn-c.net": 1001 });
  const pac = loadPac(browser.pac());
  for (const host of ["a.cdn-a.net", "b.cdn-b.net", "c.cdn-c.net"]) assert.notEqual(pac.FindProxyForURL(`https://${host}/`, host), "DIRECT");
});

test("a failing apply releases the loop and later hosts are still learned", async () => {
  const { area, browser, learner } = await setup();
  navigate(learner, "https://www.instagram.com/");
  browser.journal.failures.set("proxy.set", new Error("settings unavailable"));
  request(learner, "https://a.cdn-a.net/1");
  await settled(learner);
  assert.equal(learner.running, false);
  assert.deepEqual(browser.sessionRules.has(RULE_IDS.hosts), false);
  assert.deepEqual(learned(area).hosts, {});
  request(learner, "https://a.cdn-a.net/2");
  request(learner, "https://b.cdn-b.net/1");
  await settled(learner);
  assert.deepEqual(Object.keys(learned(area).hosts), ["a.cdn-a.net", "b.cdn-b.net"]);
  assert.deepEqual(browser.sessionRules.get(RULE_IDS.hosts).condition.requestDomains, ["a.cdn-a.net", "b.cdn-b.net"]);
});

test("lastSeen is written once per host per browser session without rebuilding the PAC", async () => {
  const session = new FakeArea();
  const { area, browser, learner, store, engine } = await setup({ session });
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  browser.journal.clear();
  area.calls.length = 0;
  request(learner, "https://static.cdninstagram.com/b.js", { tabId: 99, initiator: "https://example.org" });
  await settled(learner);
  assert.deepEqual(area.items["seen:instagram.com"], { "static.cdninstagram.com": 1001 });
  assert.deepEqual(area.writes(), [["set", ["seen:instagram.com"]]]);
  assert.deepEqual(browser.journal.entries, []);
  request(learner, "https://static.cdninstagram.com/c.js");
  await settled(learner);
  assert.deepEqual(area.writes(), [["set", ["seen:instagram.com"]]]);
  const restarted = createLearner({ store, engine, session, tabs: NO_TABS, now: () => 5000 });
  await restarted.restore();
  restarted.onRequest({ type: "script", tabId: TAB, url: "https://static.cdninstagram.com/d.js", documentLifecycle: "active" });
  await settled(restarted);
  assert.deepEqual(area.items["seen:instagram.com"], { "static.cdninstagram.com": 1001 });
});

test("tab state follows commits, replacement and removal and survives a restart", async () => {
  const session = new FakeArea();
  const { learner, store, engine } = await setup({ session });
  learner.onCommitted({ tabId: 3, frameId: 0, url: "https://www.instagram.com/p/1", documentLifecycle: "active" });
  learner.onCommitted({ tabId: 3, frameId: 5, url: "https://frame.example/", documentLifecycle: "active" });
  learner.onCommitted({ tabId: 4, frameId: 0, url: "https://example.org/", documentLifecycle: "prerender" });
  assert.equal(learner.tabHost(3), "www.instagram.com");
  assert.equal(learner.tabHost(4), null);
  learner.onReplaced(9, 3);
  assert.equal(learner.tabHost(3), null);
  assert.equal(learner.tabHost(9), "www.instagram.com");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.keys(await storedTabs(session)), ["9"]);
  assert.equal((await storedTab(session, 9)).host, "www.instagram.com");
  const restarted = createLearner({ store, engine, session, tabs: NO_TABS, now: Date.now });
  await restarted.restore();
  assert.equal(restarted.tabHost(9), "www.instagram.com");
  learner.onRemoved(9);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await storedTabs(session), {});
});

test("hosts whose root disappeared before the flush are dropped", async () => {
  const { area, browser, learner, commands } = await setup();
  navigate(learner, "https://www.instagram.com/");
  browser.journal.gate = deferred();
  const saving = commands.dispatch({ type: "saveUserPac", text: fixture("user.pac").replace('root(host, "instagram.com")', 'root(host, "other.com")') });
  request(learner, "https://late.cdn.net/1");
  browser.journal.gate.resolve();
  await saving;
  await settled(learner);
  assert.equal(Object.hasOwn(area.items, "group:instagram.com"), false);
  assert.deepEqual(area.items["group:other.com"].hosts, {});
});

test("nothing is learned in safe mode", async () => {
  const { area, browser, learner, store } = await setup();
  await store.run((state) => store.commit({ ...state, userPacErrors: [{ line: 1, column: 1, message: "invalid" }] }));
  browser.journal.clear();
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  assert.deepEqual(learned(area).hosts, {});
  assert.deepEqual(browser.journal.entries, []);
});


test("hosts sharing a registrable domain are aggregated and covered subdomains are not learned", async () => {
  const { area, browser, learner, session } = await setup();
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://rr1---sn-a.googlevideo.com/v");
  await settled(learner);
  assert.deepEqual(learned(area).hosts, { "rr1---sn-a.googlevideo.com": 1000 });
  request(learner, "https://rr2---sn-b.googlevideo.com/v");
  await settled(learner);
  assert.deepEqual(learned(area).hosts, { "googlevideo.com": 1000 });
  assert.deepEqual(browser.sessionRules.get(RULE_IDS.hosts).condition.requestDomains, ["googlevideo.com"]);
  browser.journal.clear();
  request(learner, "https://rr3---sn-c.googlevideo.com/v");
  await settled(learner);
  assert.deepEqual(learned(area).hosts, { "googlevideo.com": 1000 });
  assert.deepEqual(browser.journal.entries, []);
  assert.deepEqual(area.items["seen:instagram.com"], { "googlevideo.com": 1002 });
  assert.deepEqual((await session.get("seenThisSession")).seenThisSession, ["googlevideo.com"]);
});

const commit = (learner, tabId = TAB, url = "https://www.instagram.com/") =>
  learner.onCommitted({ tabId, frameId: 0, url, documentLifecycle: "active" });

test("a session write carries only the tabs that changed, and closing a tab removes its key", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  commit(learner, 1, "https://www.instagram.com/");
  commit(learner, 2, "https://example.org/");
  await settled(learner);
  session.calls.length = 0;
  commit(learner, 2, "https://example.org/next");
  await settled(learner);
  assert.deepEqual(session.writes(), [["set", ["tab:2"]]]);
  session.calls.length = 0;
  learner.onRemoved(1);
  await settled(learner);
  assert.deepEqual(session.writes(), [["remove", ["tab:1"]]]);
  assert.deepEqual(Object.keys(await storedTabs(session)), ["2"]);
});

test("new hosts are counted per tab and reset on every top-level navigation", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  commit(learner);
  request(learner, "https://static.cdninstagram.com/a.js");
  request(learner, "https://edge-chat.facebook.com/b.js");
  await settled(learner);
  assert.equal(learner.newHosts(TAB), 2);
  assert.equal((await storedTab(session, TAB)).newHosts, 2);
  commit(learner);
  assert.equal(learner.newHosts(TAB), 0);
  await settled(learner);
  assert.equal((await storedTab(session, TAB)).newHosts, 0);
  request(learner, "https://scontent-ams2-1.cdninstagram.com/c.jpg");
  await settled(learner);
  assert.equal(learner.newHosts(TAB), 1);
});

test("hosts attributed to no tab or to a navigation that already ended are not counted", async () => {
  const { learner, store } = await setup();
  commit(learner);
  learner.onRequest({ type: "xmlhttprequest", tabId: -1, url: "https://sw.cdn.net/f", initiator: "https://www.instagram.com", documentLifecycle: "active" });
  await settled(learner);
  assert.equal(learner.newHosts(TAB), 0);
  assert.equal(Object.hasOwn(store.state.groups["instagram.com"].hosts, "sw.cdn.net"), true);
  request(learner, "https://static.cdninstagram.com/a.js");
  commit(learner);
  await settled(learner);
  assert.equal(learner.newHosts(TAB), 0);
});

test("the counter follows a replaced tab and disappears with a closed one", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  commit(learner);
  request(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  learner.onReplaced(TAB + 1, TAB);
  assert.equal(learner.newHosts(TAB), 0);
  assert.equal(learner.newHosts(TAB + 1), 1);
  learner.onRemoved(TAB + 1);
  assert.equal(learner.newHosts(TAB + 1), 0);
  await settled(learner);
  assert.deepEqual(await storedTabs(session), {});
});

test("restore brings back tab hosts and counters", async () => {
  const session = new FakeArea({ [`tab:${TAB}`]: tabRecord({ host: "www.instagram.com", navigation: 2, newHosts: 3 }), seenThisSession: [] });
  const { learner } = await setup({ session });
  assert.equal(learner.tabHost(TAB), "www.instagram.com");
  assert.equal(learner.newHosts(TAB), 3);
});

test("hosts that actually load in the tab are counted, blocked ones are not", async () => {
  const session = new FakeArea();
  const { learner, store } = await setup({ session });
  commit(learner);
  blocks(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  assert.equal(learner.loaded(TAB), 0);
  assert.equal(learner.newHosts(TAB), 1);
  const pendingOutcome = request(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  assert.equal(learner.loaded(TAB), 0);
  learner.onResponse(pendingOutcome);
  loads(learner, "https://static.cdninstagram.com/b.js");
  blocks(learner, "https://cdn.doubleclick.net/pixel.gif");
  blocks(learner, "https://10.0.0.1/x.js");
  blocks(learner, "https://static.cdninstagram.com/c.js");
  await settled(learner);
  assert.equal(learner.loaded(TAB), 1);
  assert.equal(learner.incomplete(TAB), false);
  assert.deepEqual((await storedTab(session, TAB)).loaded, ["static.cdninstagram.com"]);
  assert.equal(store.state.groups["instagram.com"].hosts["cdn.doubleclick.net"], undefined);
  commit(learner);
  assert.equal(learner.loaded(TAB), 0);
  assert.equal(learner.newHosts(TAB), 0);
});

test("the page host and other hosts of the root mask are not counted", async () => {
  const { learner } = await setup();
  commit(learner);
  request(learner, "https://i.instagram.com/logo.png");
  await settled(learner);
  assert.equal(learner.loaded(TAB), 0);
  assert.equal(learner.proxied(TAB), 0);
  assert.equal(learner.newHosts(TAB), 0);
});

test("loaded hosts follow a replaced tab and are restored from the session", async () => {
  const session = new FakeArea({ [`tab:${TAB}`]: tabRecord({ host: "www.instagram.com", loaded: ["a.net", "b.net"] }), seenThisSession: [] });
  const { learner } = await setup({ session });
  assert.equal(learner.loaded(TAB), 2);
  learner.onReplaced(TAB + 1, TAB);
  assert.equal(learner.loaded(TAB), 0);
  assert.equal(learner.loaded(TAB + 1), 2);
  learner.onRemoved(TAB + 1);
  assert.equal(learner.loaded(TAB + 1), 0);
});

test("closing a tab clears every counter at once", async () => {
  const session = new FakeArea({
    [`tab:${TAB}`]: tabRecord({ host: "www.instagram.com", newHosts: 2, loaded: ["a.net"], proxied: ["a.net"], loading: true, incomplete: true }),
    seenThisSession: [],
  });
  const { learner } = await setup({ session });
  learner.onRemoved(TAB);
  await settled(learner);
  assert.deepEqual([learner.newHosts(TAB), learner.loaded(TAB), learner.proxied(TAB), learner.loading(TAB), learner.incomplete(TAB)], [0, 0, 0, false, false]);
  assert.deepEqual(await storedTabs(session), {});
});

test("a failing host is isolated and reported while the rest of its batch is learned", async () => {
  const { area, browser, learner, session } = await setup();
  navigate(learner, "https://www.instagram.com/");
  browser.journal.failures.set("dnr.session", ({ addRules }) =>
    addRules.some(({ condition }) => condition.requestDomains?.includes("bad.net")) ? new Error("Rule quota exceeded") : null,
  );
  request(learner, "https://good.net/1");
  request(learner, "https://bad.net/1");
  await settled(learner);
  assert.deepEqual(Object.keys(learned(area).hosts), ["good.net"]);
  assert.equal(session.items.lastLearnError.message, "Rule quota exceeded");
  browser.journal.failures.delete("dnr.session");
  request(learner, "https://fine.net/1");
  await settled(learner);
  assert.deepEqual(Object.keys(learned(area).hosts).sort(), ["fine.net", "good.net"]);
  assert.equal(Object.hasOwn(session.items, "lastLearnError"), false);
});

test("after an extension update the open tabs are read back from the browser", async () => {
  const { store, engine } = await setup();
  const session = new FakeArea();
  const tabs = { query: async () => [{ id: 3, url: "https://www.instagram.com/p/1" }, { id: 4 }] };
  const restarted = createLearner({ store, engine, session, tabs, now: () => 1 });
  await restarted.restore();
  assert.equal(restarted.tabHost(3), "www.instagram.com");
  assert.equal(restarted.tabHost(4), null);
  assert.deepEqual(await storedTabs(session), { 3: tabRecord({ host: "www.instagram.com" }) });
});

test("session writes are coalesced and tab changes are announced", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  const announced = [];
  learner.onTabChange((tabId) => announced.push(tabId));
  commit(learner);
  const before = session.calls.length;
  for (let i = 0; i < 20; i++) request(learner, `https://h${i}.cdninstagram.com/a.js`);
  await settled(learner);
  assert.ok(session.calls.length - before < 10);
  assert.ok(announced.length > 0 && announced.every((tabId) => tabId === TAB));
});

test("a tab counts as loading from the navigation until the page completes", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  assert.equal(learner.loading(TAB), false);
  learner.onRequest({ type: "main_frame", tabId: TAB, url: "https://www.instagram.com/", documentLifecycle: "active" });
  assert.equal(learner.loading(TAB), true);
  await settled(learner);
  assert.equal((await storedTab(session, TAB)).loading, true);
  commit(learner);
  assert.equal(learner.loading(TAB), true);
  learner.onCompleted(TAB, "https://old.example.com/");
  assert.equal(learner.loading(TAB), true);
  learner.onCompleted(TAB, "https://www.instagram.com/feed");
  assert.equal(learner.loading(TAB), false);
  commit(learner);
  learner.onRemoved(TAB);
  assert.equal(learner.loading(TAB), false);
});

test("hosts routed through the proxy are counted apart, and only in root tabs", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  commit(learner);
  blocks(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  loads(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  loads(learner, "https://example.org/widget.js", { tabId: TAB + 5 });
  await settled(learner);
  assert.equal(learner.loaded(TAB), 1);
  assert.equal(learner.proxied(TAB), 1);
  assert.deepEqual((await storedTab(session, TAB)).proxied, ["static.cdninstagram.com"]);
  assert.equal(learner.loaded(TAB + 5), 0);
  assert.equal(learner.proxied(TAB + 5), 0);

});

test("a request blocked before the protection opened marks the tab incomplete until the next navigation", async () => {
  const session = new FakeArea();
  const { learner, engine } = await setup({ session });
  commit(learner);
  blocks(learner, "https://static.cdninstagram.com/a.js");
  await settled(learner);
  assert.equal(engine.blockedBeforeOpen(0), true);
  blocks(learner, "https://static.cdninstagram.com/a.js", { timeStamp: 0 });
  blocks(learner, "https://i.instagram.com/api", { timeStamp: 0 });
  await settled(learner);
  assert.equal(learner.incomplete(TAB), true);
  assert.equal(learner.loaded(TAB), 0);
  assert.equal(learner.proxied(TAB), 0);
  assert.equal((await storedTab(session, TAB)).incomplete, true);
  commit(learner);
  assert.equal(learner.incomplete(TAB), false);
  blocks(learner, "https://cdn.doubleclick.net/pixel.gif", { timeStamp: 0 });
  blocks(learner, "https://unknown.example.net/x.js", { timeStamp: 0 });
  learner.onError({ ...request(learner, "https://static.cdninstagram.com/a.js", { timeStamp: 0 }), error: "net::ERR_FAILED" });
  await settled(learner);
  assert.equal(learner.incomplete(TAB), false);
});

test("a root document blocked before the protection opened makes the tab an incomplete root tab", async () => {
  const { learner } = await setup();
  navigate(learner, "https://example.org/");
  const details = { requestId: "main-1", type: "main_frame", tabId: TAB, url: "https://www.instagram.com/", documentLifecycle: "active", timeStamp: 0 };
  learner.onRequest(details);
  learner.onError({ ...details, error: "net::ERR_BLOCKED_BY_CLIENT" });
  await settled(learner);
  assert.equal(learner.tabHost(TAB), "www.instagram.com");
  assert.equal(learner.incomplete(TAB), true);
  const later = { ...details, requestId: "main-2", timeStamp: Date.now() + 1000 };
  learner.onRequest(later);
  learner.onError({ ...later, error: "net::ERR_BLOCKED_BY_CLIENT" });
  assert.equal(learner.incomplete(TAB), true);
});

test("the incomplete mark survives a service worker restart", async () => {
  const session = new FakeArea();
  const { learner, store, engine } = await setup({ session });
  commit(learner);
  blocks(learner, "https://i.instagram.com/api", { timeStamp: 0 });
  await settled(learner);
  const restarted = createLearner({ store, engine, session, tabs: NO_TABS, now: () => 1 });
  await restarted.restore();
  assert.equal(restarted.incomplete(TAB), true);
});

test("report endpoints named by the root are learned without counting as blocked hosts", async () => {
  const { learner, store } = await setup();
  const reportTo = { name: "Report-To", value: '{"group":"default","endpoints":[{"url":"https://reports.example.net/r"},{"url":"https://www.instagram.com/r"},{"url":"https://x.doubleclick.net/r"}]}' };
  const endpoints = { name: "Reporting-Endpoints", value: 'csp="https://csp.example.org/c"' };
  learner.onHeaders({ requestId: "h1", type: "main_frame", tabId: TAB, url: "https://www.instagram.com/", responseHeaders: [reportTo, endpoints] });
  await settled(learner);
  const hosts = Object.keys(store.state.groups["instagram.com"].hosts).sort();
  assert.deepEqual(hosts, ["csp.example.org", "reports.example.net"]);
  assert.equal(learner.newHosts(TAB), 0);
  commit(learner);
  learner.onHeaders({ requestId: "h2", type: "script", tabId: TAB, initiator: "https://www.instagram.com", url: "https://static.cdninstagram.com/a.js", responseHeaders: [{ name: "report-to", value: '{"endpoints":[{"url":"https://cdn-reports.example.com/"}]}' }] });
  learner.onHeaders({ requestId: "h3", type: "main_frame", tabId: TAB + 1, url: "https://example.org/", responseHeaders: [{ name: "Report-To", value: '{"endpoints":[{"url":"https://other.example.com/"}]}' }] });
  learner.onHeaders({ requestId: "h4", type: "script", tabId: TAB + 1, initiator: "https://example.org", url: "https://example.org/a.js", responseHeaders: [{ name: "Report-To", value: '{"endpoints":[{"url":"https://other2.example.com/"}]}' }] });
  await settled(learner);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts).sort(), ["cdn-reports.example.com", "csp.example.org", "reports.example.net"]);
  assert.equal(learner.newHosts(TAB), 0);
});

test("a replaced tab keeps its whole state, including the incomplete mark, and a closed one leaves nothing behind", async () => {
  const session = new FakeArea();
  const { learner } = await setup({ session });
  commit(learner);
  blocks(learner, "https://i.instagram.com/api", { timeStamp: 0 });
  await settled(learner);
  assert.equal(learner.incomplete(TAB), true);
  learner.onReplaced(TAB + 1, TAB);
  assert.deepEqual([learner.tabHost(TAB), learner.incomplete(TAB)], [null, false]);
  assert.deepEqual([learner.tabHost(TAB + 1), learner.incomplete(TAB + 1)], ["www.instagram.com", true]);
  await settled(learner);
  assert.deepEqual(Object.keys(await storedTabs(session)), [String(TAB + 1)]);
  learner.onRemoved(TAB + 1);
  await settled(learner);
  assert.equal(learner.incomplete(TAB + 1), false);
  assert.deepEqual(await storedTabs(session), {});
});

test("a host and its subdomain in one batch give one record, so one branch never widens a group", async () => {
  const { area, learner } = await setup();
  navigate(learner, "https://www.instagram.com/");
  request(learner, "https://first.example.org/a.js");
  request(learner, "https://img.cdn.e.com/a.png");
  request(learner, "https://cdn.e.com/b.js");
  request(learner, "https://x.localhost/c.js");
  await settled(learner);
  assert.deepEqual(Object.keys(learned(area).hosts).sort(), ["cdn.e.com", "first.example.org"]);
});
