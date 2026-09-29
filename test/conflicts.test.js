import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { createEngine } from "../src/background/engine.js";
import { createLearner } from "../src/background/learner.js";
import { createCommands } from "../src/background/messages.js";
import { createProxy } from "../src/background/proxy.js";
import { createResolver } from "../src/background/resolve.js";
import { Store } from "../src/background/store.js";
import { sharedRoutes } from "../src/core/routes.js";
import { conflictText, entryLevel, entryText } from "../src/ui/log/entries.js";
import { FakeArea, FakeBrowser } from "./fakes.js";
import { PSL, dnrDecision, loadPac, vmChecker } from "./support.js";

const TAB = 3;

// The hosts each root holds but may not use, as the viewer sees them.
const conflictsOf = (state) => {
  const found = [];
  for (const [root, { records }] of Object.entries(sharedRoutes(state, PSL))) {
    for (const [host, { verdict }] of Object.entries(records)) if (verdict === "conflict") found.push({ root, host });
  }
  return found.sort((a, b) => (a.root + a.host < b.root + b.host ? -1 : 1));
};

const userPacOf = (proxies) =>
  [
    "function FindProxyForURL(url, host) {",
    ...Object.entries(proxies).map(([root, proxy]) => `  if (root(host, ${JSON.stringify(root)})) return ${JSON.stringify(proxy)};`),
    '  return "DIRECT";',
    "}",
  ].join("\n");

const userPac = (facebook, instagram) => userPacOf({ "facebook.com": facebook, "instagram.com": instagram });

async function setup(text) {
  const store = new Store(new FakeArea(), new FakeArea());
  await store.load(PSL);
  const browser = new FakeBrowser();
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session: new FakeArea() });
  const checker = vmChecker();
  const log = { on: true, entries: [], add(kind, fields = {}) { this.entries.push({ kind, ...fields }); } };
  let time = 1000;
  const learner = createLearner({ store, engine, session: new FakeArea(), tabs: { query: async () => [] }, now: () => time++, log });
  const commands = createCommands({ store, engine, checker, learner, log, now: () => time++ });
  const resolver = createResolver({ store, engine, checker, log, setTimer: () => undefined });
  assert.equal((await commands.dispatch({ type: "saveUserPac", text })).ok, true);
  await learner.restore();
  return { store, browser, learner, commands, resolver, log };
}

const settled = async (learner, resolver) => {
  for (let i = 0; i < 50 && (learner.running || learner.writing || resolver.running); i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

let requestId = 0;
const visit = (learner, url, tabId = TAB) => {
  learner.onRequest({ type: "main_frame", tabId, url, documentLifecycle: "active" });
  learner.onCommitted({ tabId, frameId: 0, url, documentLifecycle: "active" });
};
const load = (learner, url, { tabId = TAB, initiator } = {}) =>
  learner.onRequest({ requestId: String(++requestId), type: "image", tabId, url, initiator, documentLifecycle: "active", timeStamp: 1 });

// Everything settles, the background proxy check included.
const idle = async (learner, resolver) => {
  await settled(learner, resolver);
  await resolver.schedule();
  await settled(learner, resolver);
};

// instagram.com learns two fbcdn.net hosts (one record, fbcdn.net, and the site is instagram.com's), then a
// facebook.com page asks for a third one and learns the same record.
async function shared(text) {
  const setupResult = await setup(text);
  const { learner, resolver } = setupResult;
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://static.fbcdn.net/a.png", { initiator: "https://www.instagram.com" });
  load(learner, "https://video.fbcdn.net/b.mp4", { initiator: "https://www.instagram.com" });
  await idle(learner, resolver);
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://scontent.fbcdn.net/c.jpg", { initiator: "https://www.facebook.com" });
  await idle(learner, resolver);
  return setupResult;
}

// The facebook.com page loads again after learning: the blocked host is a conflict now, not a new host.
const reloadFacebook = (learner) => {
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://scontent.fbcdn.net/c.jpg", { initiator: "https://www.facebook.com" });
};

const allowed = (browser, host, top, initiator = `https://www.${top}`, type = "script") =>
  dnrDecision(browser.allRules(), { host, top, initiator: initiator === null ? null : new URL(initiator).hostname, type }) === "allow";

const route = (browser, host) => loadPac(browser.pac()).FindProxyForURL(`https://${host}/`, host);

test("a host another root learned is learned again as the same record, and the site keeps its owner", async () => {
  const { store, learner } = await shared(userPac("PROXY fb:1", "PROXY fb:1"));
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), ["fbcdn.net"]);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["fbcdn.net"]);
  assert.equal(store.state.sites["fbcdn.net"], "instagram.com");
  assert.equal(learner.newHosts(TAB), 1);
  assert.deepEqual(learner.conflicts(TAB), []);
});

test("roots on the same proxy share a site: both may load it, through that proxy", async () => {
  const { store, browser, learner, resolver, log } = await shared(userPac("PROXY fb:1", "PROXY fb:1"));
  assert.deepEqual(store.state.proxies, {
    "facebook.com": { host: "www.facebook.com", answer: "PROXY fb:1" },
    "instagram.com": { host: "www.instagram.com", answer: "PROXY fb:1" },
  });
  assert.equal(route(browser, "scontent.fbcdn.net"), "PROXY fb:1");
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com"), true);
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://scontent.fbcdn.net/c.jpg", { initiator: "https://www.instagram.com" });
  await settled(learner, resolver);
  assert.deepEqual(learner.conflicts(TAB), []);
  assert.deepEqual(conflictsOf(store.state), []);
  const checked = log.entries.find(({ kind }) => kind === "proxiesChecked");
  assert.match(entryText(checked), /^Proxies checked: /);
});

test("roots on different proxies: the site stays with its owner and is blocked for the other root", async () => {
  const { store, browser, learner, log } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal(route(browser, "scontent.fbcdn.net"), "PROXY ig:1");
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com"), false);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com", null), false);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "example.org", "https://www.facebook.com"), false);
  assert.deepEqual(conflictsOf(store.state), [{ root: "facebook.com", host: "fbcdn.net" }]);
  assert.equal(learner.newHosts(TAB), 1);
  reloadFacebook(learner);
  assert.deepEqual(learner.conflicts(TAB), [{ host: "fbcdn.net", request: "scontent.fbcdn.net", root: "facebook.com", owner: "instagram.com" }]);
  assert.equal(learner.newHosts(TAB), 0);
  const logged = log.entries.filter(({ kind }) => kind === "conflict");
  assert.deepEqual(logged, [{ kind: "conflict", host: "fbcdn.net", request: "scontent.fbcdn.net", root: "facebook.com", owner: "instagram.com", proxy: "PROXY fb:1", ownerProxy: "PROXY ig:1", tabId: TAB }]);
  assert.equal(entryLevel(logged[0]), "error");
  assert.equal(
    entryText(logged[0]),
    "Proxy conflict: scontent.fbcdn.net (fbcdn.net) goes through the proxy of instagram.com (PROXY ig:1), whose site it is; facebook.com uses PROXY fb:1, so it is blocked for facebook.com · tab 3",
  );
});

test("the popup reports the conflicts of the tab with both proxies", async () => {
  const { commands, learner } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  reloadFacebook(learner);
  const state = await commands.dispatch({ type: "getTabState", tabId: TAB });
  assert.deepEqual(state.conflicts, [{ host: "fbcdn.net", request: "scontent.fbcdn.net", site: "fbcdn.net", root: "facebook.com", owner: "instagram.com", proxy: "PROXY fb:1", ownerProxy: "PROXY ig:1" }]);
  assert.match(conflictText(state.conflicts[0]), /blocked for facebook\.com/);
});

test("a root whose proxy is not checked yet keeps another root's site blocked until the check runs", async () => {
  const { store, browser, learner, resolver } = await setup(userPac("PROXY fb:1", "PROXY fb:1"));
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://static.fbcdn.net/a.png", { initiator: "https://www.instagram.com" });
  await settled(learner, resolver);
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://static.fbcdn.net/c.jpg", { initiator: "https://www.facebook.com" });
  await settled(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), ["static.fbcdn.net"]);
  assert.equal(allowed(browser, "static.fbcdn.net", "instagram.com"), true);
  assert.equal(allowed(browser, "static.fbcdn.net", "facebook.com"), false);
  load(learner, "https://static.fbcdn.net/d.jpg", { initiator: "https://www.facebook.com" });
  assert.deepEqual([learner.conflicts(TAB), learner.incomplete(TAB)], [[], true]);
  await resolver.schedule();
  assert.equal(allowed(browser, "static.fbcdn.net", "facebook.com"), true);
  assert.equal(conflictsOf(store.state).length, 0);
});

test("a request belongs to the root of its page, and outside root pages to the root of its frame", async () => {
  const { browser } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com", "https://www.facebook.com"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com", "https://www.instagram.com"), false);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com", "https://embed.example.org"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "example.org", "https://www.instagram.com"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "example.org", "https://www.facebook.com"), false);
});

test("a frame of one root in another root's page never teaches the frame's root", async () => {
  const { store, learner, resolver } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://static.fbcdn.net/a.png", { initiator: "https://www.facebook.com" });
  await settled(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["static.fbcdn.net"]);
  assert.deepEqual(store.state.groups["facebook.com"].hosts, {});
});

test("the top frame's requests belong to their own page even before the tab's record catches up", async () => {
  const { store, learner, resolver } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.facebook.com/");
  learner.onRequest({ requestId: "race", type: "image", tabId: TAB, frameId: 0, url: "https://cdn.example.net/a.png", initiator: "https://www.instagram.com", documentLifecycle: "active", timeStamp: 1 });
  load(learner, "https://frame.example.org/b.png", { initiator: "https://www.instagram.com" });
  await settled(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["cdn.example.net"]);
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), ["frame.example.org"]);
});

test("the owner removing its record keeps the site while another root holds it", async () => {
  const { store, browser, commands } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal((await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "fbcdn.net" })).ok, true);
  assert.equal(store.state.sites["fbcdn.net"], "instagram.com");
  assert.equal(route(browser, "scontent.fbcdn.net"), "PROXY ig:1");
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com"), false);
  assert.equal((await commands.dispatch({ type: "removeHost", mask: "facebook.com", host: "fbcdn.net" })).ok, true);
  assert.equal(Object.hasOwn(store.state.sites, "fbcdn.net"), false);
});

test("a saved User PAC that puts both roots on one proxy resolves the conflict", async () => {
  const { store, browser, commands } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: userPac("PROXY ig:1", "PROXY ig:1") })).ok, true);
  assert.deepEqual(conflictsOf(store.state), []);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com"), true);
});

test("the viewer gets each root's proxy, the owner of its site and the hosts it takes from another root", async () => {
  const different = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.deepEqual(await different.commands.dispatch({ type: "getRoutes" }), {
    ok: true,
    roots: {
      "facebook.com": {
        proxy: "PROXY fb:1",
        root: { site: "facebook.com", owner: "facebook.com", verdict: "same", ownerProxy: "PROXY fb:1" },
        records: { "fbcdn.net": { site: "fbcdn.net", owner: "instagram.com", verdict: "conflict", ownerProxy: "PROXY ig:1" } },
        taken: {},
        blocks: {},
      },
      "instagram.com": {
        proxy: "PROXY ig:1",
        root: { site: "instagram.com", owner: "instagram.com", verdict: "same", ownerProxy: "PROXY ig:1" },
        records: { "fbcdn.net": { site: "fbcdn.net", owner: "instagram.com", verdict: "same", ownerProxy: "PROXY ig:1" } },
        taken: {},
        blocks: { "fbcdn.net": ["facebook.com"] },
      },
    },
  });
  const same = await shared(userPac("PROXY fb:1", "PROXY fb:1"));
  const { roots } = await same.commands.dispatch({ type: "getRoutes" });
  assert.deepEqual(roots["facebook.com"].records["fbcdn.net"], { site: "fbcdn.net", owner: "instagram.com", verdict: "same", ownerProxy: "PROXY fb:1" });
  assert.deepEqual(roots["instagram.com"].blocks, {});
});

test("Route here hands whole sites to the root, and every root keeps its records", async () => {
  const { store, browser, commands, learner, resolver } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://static.fbcdn.net/a.png", { initiator: "https://www.instagram.com" });
  load(learner, "https://img.cdn.net/b.png", { initiator: "https://www.instagram.com" });
  await idle(learner, resolver);
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://static.fbcdn.net/c.png", { initiator: "https://www.facebook.com" });
  load(learner, "https://img.cdn.net/d.png", { initiator: "https://www.facebook.com" });
  await idle(learner, resolver);
  assert.deepEqual(conflictsOf(store.state), [{ root: "facebook.com", host: "img.cdn.net" }, { root: "facebook.com", host: "static.fbcdn.net" }]);
  const hosts = ["static.fbcdn.net", "img.cdn.net"];
  assert.equal((await commands.dispatch({ type: "routeHere", mask: "facebook.com", hosts })).ok, true);
  for (const host of hosts) {
    assert.equal(Object.hasOwn(store.state.groups["instagram.com"].hosts, host), true);
    assert.equal(route(browser, host), "PROXY fb:1");
    assert.equal(allowed(browser, host, "facebook.com"), true);
    assert.equal(allowed(browser, host, "instagram.com"), false);
  }
  assert.equal(route(browser, "other.cdn.net"), "DIRECT");
  assert.deepEqual(conflictsOf(store.state), [{ root: "instagram.com", host: "img.cdn.net" }, { root: "instagram.com", host: "static.fbcdn.net" }]);
  const state = store.state;
  assert.deepEqual(await commands.dispatch({ type: "routeHere", mask: "facebook.com", hosts }), { ok: true, control: null });
  assert.equal(store.state, state);
  assert.equal((await commands.dispatch({ type: "routeHere", mask: "instagram.com", hosts: ["img.cdn.net"] })).ok, true);
  assert.equal(route(browser, "img.cdn.net"), "PROXY ig:1");
  assert.equal(route(browser, "static.fbcdn.net"), "PROXY fb:1");
  assert.match((await commands.dispatch({ type: "routeHere", mask: "instagram.com", hosts: ["nope.net"] })).error, /is not in group/);
  assert.match((await commands.dispatch({ type: "routeHere", mask: "instagram.com", hosts: [] })).error, /non-empty array/);
});

test("another root's domain is learned like any site: on another proxy it is a conflict, on the same one it is allowed", async () => {
  const { store, browser, learner, resolver, commands } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal(allowed(browser, "www.instagram.com", "facebook.com"), false);
  assert.equal(allowed(browser, "www.instagram.com", "instagram.com"), true);
  assert.equal(allowed(browser, "www.instagram.com", "example.org", "https://news.example.org"), true);
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://www.instagram.com/embed.js", { initiator: "https://www.facebook.com" });
  await idle(learner, resolver);
  // The record goes through the owner of instagram.com, so it is blocked for facebook.com: the next request says so.
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), ["www.instagram.com"]);
  load(learner, "https://www.instagram.com/embed2.js", { initiator: "https://www.facebook.com" });
  assert.deepEqual(learner.conflicts(TAB), [{ host: "www.instagram.com", request: "www.instagram.com", root: "facebook.com", owner: "instagram.com" }]);
  assert.equal(allowed(browser, "www.instagram.com", "facebook.com"), false);
  assert.equal(route(browser, "www.instagram.com"), "PROXY ig:1");
  // On the same proxy the domain is blocked until learned, like any site, and allowed after.
  const same = await setup(userPac("PROXY fb:1", "PROXY fb:1"));
  assert.equal(allowed(same.browser, "www.instagram.com", "facebook.com"), false);
  visit(same.learner, "https://www.facebook.com/");
  load(same.learner, "https://www.instagram.com/embed.js", { initiator: "https://www.facebook.com" });
  await idle(same.learner, same.resolver);
  assert.equal(same.learner.newHosts(TAB), 1);
  assert.equal(allowed(same.browser, "www.instagram.com", "facebook.com"), true);
  assert.equal(allowed(same.browser, "static.instagram.com", "facebook.com"), false);
  // Route here from facebook.com takes the whole instagram.com site: instagram.com's own pages are closed then.
  assert.equal((await commands.dispatch({ type: "routeHere", mask: "facebook.com", hosts: ["www.instagram.com"] })).ok, true);
  assert.equal(route(browser, "www.instagram.com"), "PROXY fb:1");
  assert.equal(allowed(browser, "www.instagram.com", "facebook.com"), true);
  assert.equal(allowed(browser, "www.instagram.com", "instagram.com"), false);
  assert.equal(allowed(browser, "www.instagram.com", null, null, "main_frame"), false);
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://www.instagram.com/app.js", { initiator: "https://www.instagram.com" });
  assert.deepEqual(learner.conflicts(TAB), [{ host: "instagram.com", request: "www.instagram.com", root: "instagram.com", owner: "facebook.com" }]);
  assert.equal((await commands.dispatch({ type: "routeHere", mask: "instagram.com", hosts: ["instagram.com"] })).ok, true);
  assert.equal(route(browser, "www.instagram.com"), "PROXY ig:1");
  assert.equal(allowed(browser, "www.instagram.com", null, null, "main_frame"), true);
  // Remove forgets the record: the next request is blocked and learned again.
  assert.equal((await commands.dispatch({ type: "removeHost", mask: "facebook.com", host: "www.instagram.com" })).ok, true);
  assert.deepEqual(store.state.groups["facebook.com"].hosts, {});
});

test("a root page closed by Route here shows the conflict in its tab, though the page never commits", async () => {
  const { store, learner, resolver, commands } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.facebook.com/");
  await idle(learner, resolver);
  assert.equal((await commands.dispatch({ type: "routeHere", mask: "instagram.com", hosts: ["facebook.com"] })).ok, true);
  // The owner lists the handed root's domain as a site of its own, blocked for that root; the popup counts it.
  const { roots } = await commands.dispatch({ type: "getRoutes" });
  assert.deepEqual(roots["instagram.com"].taken, { "facebook.com": { site: "facebook.com", owner: "instagram.com", verdict: "same", ownerProxy: "PROXY ig:1" } });
  assert.deepEqual(roots["instagram.com"].blocks, { "facebook.com": ["facebook.com"] });
  assert.deepEqual(roots["facebook.com"].taken, {});
  visit(learner, "https://www.instagram.com/", TAB + 2);
  assert.equal((await commands.dispatch({ type: "getTabState", tabId: TAB + 2 })).hostCount, 2);
  const tabId = TAB + 1;
  const details = { requestId: "closed", type: "main_frame", tabId, url: "https://www.facebook.com/", documentLifecycle: "active", timeStamp: 1 };
  learner.onRequest(details);
  learner.onError({ ...details, error: "net::ERR_BLOCKED_BY_CLIENT" });
  assert.equal(learner.tabHost(tabId), "www.facebook.com");
  assert.equal(learner.loading(tabId), false);
  assert.deepEqual(learner.conflicts(tabId), [{ host: "facebook.com", request: "www.facebook.com", root: "facebook.com", owner: "instagram.com" }]);
  const state = await commands.dispatch({ type: "getTabState", tabId });
  assert.equal(state.mask, "facebook.com");
  assert.deepEqual(state.conflicts.map(({ site, proxy, ownerProxy }) => ({ site, proxy, ownerProxy })), [{ site: "facebook.com", proxy: "PROXY fb:1", ownerProxy: "PROXY ig:1" }]);
  // The error page loads nothing; what the tab shows next without a commit (the New Tab Page after Back, with its Google
  // frames) is not facebook.com's page, and teaches facebook.com nothing.
  learner.onRequest({ requestId: "ntp", type: "script", tabId, frameId: 1, url: "https://www.gstatic.com/a.js", initiator: "https://ogs.example.org", documentLifecycle: "active", timeStamp: 2 });
  await settled(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), []);
  // Route here from the popup takes the site back, and the reload is a page of its own again.
  assert.equal((await commands.dispatch({ type: "routeHere", mask: "facebook.com", hosts: state.conflicts.map(({ host }) => host) })).ok, true);
  learner.onRequest({ ...details, requestId: "again" });
  learner.onCommitted({ tabId, frameId: 0, url: details.url, documentLifecycle: "active" });
  assert.deepEqual(learner.conflicts(tabId), []);
});

test("the log says which names aggregation took into a wider record", async () => {
  const { store, learner, resolver, log } = await setup(userPac("PROXY fb:1", "PROXY fb:1"));
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://www.facebook.com/a.js", { initiator: "https://www.instagram.com" });
  await idle(learner, resolver);
  assert.deepEqual(log.entries.filter(({ kind }) => kind === "aggregated"), []);
  load(learner, "https://www.xx.facebook.com/b.js", { initiator: "https://www.instagram.com" });
  await idle(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["facebook.com"]);
  const merged = log.entries.filter(({ kind }) => kind === "aggregated");
  assert.deepEqual(merged, [{ kind: "aggregated", host: "facebook.com", hosts: ["www.facebook.com", "www.xx.facebook.com"], root: "instagram.com" }]);
  assert.equal(entryText(merged[0]), "www.facebook.com, www.xx.facebook.com aggregated into facebook.com in instagram.com");
  assert.equal(entryLevel(merged[0]), "info");
});

test("a removed root hands its sites on: every group keeps its hosts, and each site goes to its first learner", async () => {
  const text = userPacOf({ "facebook.com": "PROXY fb:1", "instagram.com": "PROXY ig:1", "threads.com": "PROXY fb:1" });
  const { store, browser, learner, resolver, commands } = await setup(text);
  visit(learner, "https://www.threads.com/");
  load(learner, "https://a.cdn.net/1.png", { initiator: "https://www.threads.com" });
  await idle(learner, resolver);
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://a.cdn.net/2.png", { initiator: "https://www.facebook.com" });
  load(learner, "https://img.org/3.png", { initiator: "https://www.facebook.com" });
  load(learner, "https://static.threads.com/4.js", { initiator: "https://www.facebook.com" });
  await idle(learner, resolver);
  assert.equal(store.state.sites["cdn.net"], "threads.com");
  assert.equal(allowed(browser, "static.threads.com", "facebook.com"), true);
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: userPac("PROXY fb:1", "PROXY ig:1") })).ok, true);
  // facebook.com keeps a.cdn.net and static.threads.com, and their sites are its own now.
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts).sort(), ["a.cdn.net", "img.org", "static.threads.com"]);
  assert.deepEqual(store.state.sites, { "cdn.net": "facebook.com", "facebook.com": "facebook.com", "img.org": "facebook.com", "instagram.com": "instagram.com", "threads.com": "facebook.com" });
  for (const host of ["a.cdn.net", "static.threads.com"]) {
    assert.equal(allowed(browser, host, "facebook.com"), true);
    assert.equal(route(browser, host), "PROXY fb:1");
  }
  assert.equal(route(browser, "www.threads.com"), "DIRECT");
});

test("a new root takes its site back, and the roots that learned its hosts keep them", async () => {
  const { store, browser, learner, resolver, commands } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://static.threads.com/a.js", { initiator: "https://www.facebook.com" });
  await idle(learner, resolver);
  assert.equal(store.state.sites["threads.com"], "facebook.com");
  const text = userPacOf({ "facebook.com": "PROXY fb:1", "instagram.com": "PROXY ig:1", "threads.com": "PROXY ig:1" });
  assert.equal((await commands.dispatch({ type: "saveUserPac", text })).ok, true);
  assert.equal(store.state.sites["threads.com"], "threads.com");
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), ["static.threads.com"]);
  assert.equal(route(browser, "static.threads.com"), "PROXY ig:1");
  assert.equal(allowed(browser, "static.threads.com", "facebook.com"), false);
});

test("roots that overlap or share a site are refused when the User PAC is saved", async () => {
  const { commands } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  const overlap = await commands.dispatch({ type: "saveUserPac", text: userPacOf({ "instagram.com": "PROXY a:1", "www.instagram.com": "PROXY b:1" }) });
  assert.equal(overlap.ok, false);
  assert.deepEqual(overlap.errors, [{ line: 3, column: 18, message: 'root() mask "www.instagram.com" overlaps root() mask "instagram.com": one site can have one root' }]);
  const site = await commands.dispatch({ type: "saveUserPac", text: userPacOf({ "mail.google.com": "PROXY a:1", "docs.google.com": "PROXY a:1" }) });
  assert.deepEqual(site.errors.map(({ message }) => message), ['root() mask "docs.google.com" is in the same site as root() mask "mail.google.com" (google.com): one site can have one root']);
  const suffix = await commands.dispatch({ type: "saveUserPac", text: userPacOf({ "github.io": "PROXY a:1" }) });
  assert.deepEqual(suffix.errors.map(({ message }) => message), ['root() mask "github.io" is a public suffix, not a site']);
});

test("the viewer removes every host of one site from a group at once", async () => {
  const { store, learner, resolver, commands, log } = await setup(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://a.cdn.net/1.png", { initiator: "https://www.instagram.com" });
  load(learner, "https://b.other.cdn.net/2.png", { initiator: "https://www.instagram.com" });
  load(learner, "https://img.org/3.png", { initiator: "https://www.instagram.com" });
  await idle(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts).sort(), ["cdn.net", "img.org"]);
  assert.equal((await commands.dispatch({ type: "removeSite", mask: "instagram.com", site: "cdn.net" })).ok, true);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["img.org"]);
  assert.equal(Object.hasOwn(store.state.sites, "cdn.net"), false);
  assert.match((await commands.dispatch({ type: "removeSite", mask: "instagram.com", site: "cdn.net" })).error, /has no host/);
  assert.equal(entryText(log.entries.find(({ kind, command }) => kind === "command" && command === "removeSite")), "Site cdn.net removed from instagram.com");
});
