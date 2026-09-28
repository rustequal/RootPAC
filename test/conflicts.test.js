import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { createEngine } from "../src/background/engine.js";
import { createLearner } from "../src/background/learner.js";
import { createCommands } from "../src/background/messages.js";
import { createProxy } from "../src/background/proxy.js";
import { createResolver } from "../src/background/resolve.js";
import { Store } from "../src/background/store.js";
import { answersOf, routesOf } from "../src/core/routes.js";
import { conflictText, entryLevel, entryText } from "../src/ui/log/entries.js";
import { FakeArea, FakeBrowser } from "./fakes.js";
import { PSL, dnrDecision, loadPac, vmChecker } from "./support.js";

const TAB = 3;

// The records each root holds but may not use, with the root whose proxy carries them.
const conflictsOf = (state) => {
  const found = [];
  for (const [root, { deny, denyExact }] of routesOf(state.groups, answersOf(state), PSL)) {
    for (const host of [...deny, ...denyExact]) found.push({ root, host });
  }
  return found;
};

const userPac = (facebook, instagram) =>
  [
    `var FB = ${JSON.stringify(facebook)};`,
    `var IG = ${JSON.stringify(instagram)};`,
    "function FindProxyForURL(url, host) {",
    '  if (root(host, "facebook.com")) return FB;',
    '  if (root(host, "instagram.com")) return IG;',
    '  return "DIRECT";',
    "}",
  ].join("\n");

async function setup(text) {
  const store = new Store(new FakeArea(), new FakeArea());
  await store.load(PSL);
  const browser = new FakeBrowser();
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session: new FakeArea() });
  const checker = vmChecker();
  const log = { on: true, entries: [], add(kind, fields = {}) { this.entries.push({ kind, ...fields }); } };
  const learner = createLearner({ store, engine, session: new FakeArea(), tabs: { query: async () => [] }, now: () => 1000, log });
  const commands = createCommands({ store, engine, checker, learner, log });
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

// Learn fbcdn.net into facebook.com, then let an instagram.com page ask for it.
async function shared(text) {
  const setupResult = await setup(text);
  const { learner, resolver } = setupResult;
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://static.fbcdn.net/a.png", { initiator: "https://www.facebook.com" });
  load(learner, "https://video.fbcdn.net/b.mp4", { initiator: "https://www.facebook.com" });
  await settled(learner, resolver);
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://scontent.fbcdn.net/c.jpg", { initiator: "https://www.instagram.com" });
  await settled(learner, resolver);
  await resolver.schedule();
  await settled(learner, resolver);
  return setupResult;
}

const allowed = (browser, host, top, initiator = `https://www.${top}`) =>
  dnrDecision(browser.allRules(), { host, top, initiator: initiator === null ? null : new URL(initiator).hostname }) === "allow";

const route = (browser, host) => loadPac(browser.pac()).FindProxyForURL(`https://${host}/`, host);

test("a host another root learned is learned again by the root that needs it", async () => {
  const { store, learner } = await shared(userPac("PROXY fb:1", "PROXY fb:1"));
  assert.deepEqual(Object.keys(store.state.groups["facebook.com"].hosts), ["fbcdn.net"]);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["fbcdn.net"]);
  assert.equal(learner.newHosts(TAB), 1);
  assert.deepEqual(learner.conflicts(TAB), []);
});

test("roots on the same proxy share a host: both may load it, through that proxy", async () => {
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
  assert.equal(entryText(checked), "Proxies checked: facebook.com → PROXY fb:1, instagram.com → PROXY fb:1");
});

test("roots on different proxies: the host stays with the first root's proxy and is blocked for the other", async () => {
  const { store, browser, learner, log } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["fbcdn.net"]);
  assert.equal(route(browser, "scontent.fbcdn.net"), "PROXY fb:1");
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com"), false);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com", null), false);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "example.org", "https://www.instagram.com"), false);
  const conflict = { host: "fbcdn.net", root: "instagram.com", owner: "facebook.com", proxy: "PROXY ig:1", ownerProxy: "PROXY fb:1" };
  assert.deepEqual(conflictsOf(store.state), [{ root: "instagram.com", host: "fbcdn.net" }]);
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://scontent.fbcdn.net/c.jpg", { initiator: "https://www.instagram.com" });
  assert.deepEqual(learner.conflicts(TAB), [{ host: "fbcdn.net", root: "instagram.com", owner: "facebook.com" }]);
  assert.equal(learner.newHosts(TAB), 0);
  const logged = log.entries.filter(({ kind }) => kind === "conflict");
  assert.deepEqual(logged, [{ kind: "conflict", ...conflict, tabId: TAB }]);
  assert.equal(entryLevel(logged[0]), "error");
  assert.equal(
    entryText(logged[0]),
    "Proxy conflict: fbcdn.net is learned by instagram.com (PROXY ig:1) and facebook.com (PROXY fb:1); it goes through facebook.com's proxy, so it is blocked for instagram.com · tab 3",
  );
});

test("the popup reports the conflicts of the tab with both proxies", async () => {
  const { commands, learner } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://scontent.fbcdn.net/c.jpg", { initiator: "https://www.instagram.com" });
  const state = await commands.dispatch({ type: "getTabState", tabId: TAB });
  assert.deepEqual(state.conflicts, [{ host: "fbcdn.net", root: "instagram.com", owner: "facebook.com", proxy: "PROXY ig:1", ownerProxy: "PROXY fb:1" }]);
  assert.match(conflictText(state.conflicts[0]), /blocked for instagram\.com/);
});

test("a root whose proxy is not checked yet keeps a shared host blocked until the check runs", async () => {
  const { store, browser, learner, resolver } = await setup(userPac("PROXY fb:1", "PROXY fb:1"));
  visit(learner, "https://www.facebook.com/");
  load(learner, "https://static.fbcdn.net/a.png", { initiator: "https://www.facebook.com" });
  await settled(learner, resolver);
  visit(learner, "https://www.instagram.com/");
  load(learner, "https://static.fbcdn.net/c.jpg", { initiator: "https://www.instagram.com" });
  await settled(learner, resolver);
  assert.deepEqual(Object.keys(store.state.groups["instagram.com"].hosts), ["static.fbcdn.net"]);
  assert.equal(store.state.proxies, null);
  assert.equal(allowed(browser, "static.fbcdn.net", "instagram.com"), false);
  assert.equal(allowed(browser, "static.fbcdn.net", "facebook.com"), true);
  assert.equal(learner.newHosts(TAB), 1);
  load(learner, "https://static.fbcdn.net/d.jpg", { initiator: "https://www.instagram.com" });
  assert.deepEqual([learner.conflicts(TAB), learner.incomplete(TAB)], [[], true]);
  await resolver.schedule();
  assert.equal(allowed(browser, "static.fbcdn.net", "instagram.com"), true);
  assert.equal(conflictsOf(store.state).length, 0);
});

test("a frame of a root is its own context inside another root's page", async () => {
  const { browser } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com", "https://www.facebook.com"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com", "https://www.instagram.com"), false);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "facebook.com", "https://embed.example.org"), true);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com", "https://embed.example.org"), false);
});

test("a saved User PAC that moves a root to the other proxy resolves the conflict", async () => {
  const { store, browser, commands } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: userPac("PROXY fb:1", "PROXY fb:1") })).ok, true);
  assert.deepEqual(conflictsOf(store.state), []);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com"), true);
});

test("removing the host from the conflicting root lets it learn again", async () => {
  const { store, browser, commands } = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.equal((await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "fbcdn.net" })).ok, true);
  assert.deepEqual(conflictsOf(store.state), []);
  assert.equal(allowed(browser, "scontent.fbcdn.net", "instagram.com"), false);
});

test("the viewer gets each root's proxy and the records it takes from another root", async () => {
  const different = await shared(userPac("PROXY fb:1", "PROXY ig:1"));
  assert.deepEqual(await different.commands.dispatch({ type: "getRoutes" }), {
    ok: true,
    roots: {
      "facebook.com": { proxy: "PROXY fb:1", shared: [] },
      "instagram.com": { proxy: "PROXY ig:1", shared: [{ host: "fbcdn.net", owner: "facebook.com", verdict: "conflict", ownerProxy: "PROXY fb:1" }] },
    },
  });
  const same = await shared(userPac("PROXY fb:1", "PROXY fb:1"));
  const { roots } = await same.commands.dispatch({ type: "getRoutes" });
  assert.deepEqual(roots["instagram.com"].shared, [{ host: "fbcdn.net", owner: "facebook.com", verdict: "same", ownerProxy: "PROXY fb:1" }]);
});
