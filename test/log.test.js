import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { createEngine } from "../src/background/engine.js";
import { createLearner } from "../src/background/learner.js";
import { createLog, LOG_SETTING } from "../src/background/log.js";
import { createCommands } from "../src/background/messages.js";
import { createProxy } from "../src/background/proxy.js";
import { Store } from "../src/background/store.js";
import { CATEGORIES, entryLevel, entryText, failuresByHost, pageNumbers, paginate } from "../src/ui/log/entries.js";
import { formatTime } from "../src/ui/shared/rpc.js";
import { FakeArea, FakeBrowser } from "./fakes.js";
import { fixture, vmChecker, PSL } from "./support.js";

const TAB = 7;

function memoryLog() {
  const sink = { batches: [], append: async (entries) => void sink.batches.push(entries) };
  const timers = [];
  const log = createLog({ sink, now: () => 42, setTimer: (callback) => timers.push(callback) });
  return { log, sink, timers, entries: () => sink.batches.flat() };
}

test("a disabled log records nothing and schedules no write", () => {
  const { log, timers, sink } = memoryLog();
  log.add("learned", { host: "a.example" });
  assert.equal(timers.length, 0);
  assert.deepEqual(sink.batches, []);
});

test("an enabled log batches entries into one write", async () => {
  const { log, timers, sink } = memoryLog();
  log.set(true);
  log.add("learned", { host: "a.example" });
  log.add("learned", { host: "b.example" });
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.deepEqual(sink.batches, [[{ time: 42, kind: "learned", host: "a.example" }, { time: 42, kind: "learned", host: "b.example" }]]);
  log.add("learned", { host: "c.example" });
  assert.equal(timers.length, 2);
});

test("a failing sink does not break logging", async () => {
  const timers = [];
  const log = createLog({ sink: { append: async () => Promise.reject(new Error("quota")) }, setTimer: (callback) => timers.push(callback) });
  log.set(true);
  log.add("learned", {});
  await timers[0]();
  log.add("learned", {});
  assert.equal(timers.length, 2);
});

test("the store keeps the log setting out of the routing state", async () => {
  const area = new FakeArea({ [LOG_SETTING]: true });
  const store = new Store(area, new FakeArea());
  const state = await store.load(PSL);
  assert.equal(Object.hasOwn(state, LOG_SETTING), false);
  assert.equal(area.items[LOG_SETTING], true);
  await new Store(area, new FakeArea()).load(PSL);
});

async function setup(log) {
  const store = new Store(new FakeArea(), new FakeArea());
  await store.load(PSL);
  const browser = new FakeBrowser();
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session: new FakeArea(), log });
  const commands = createCommands({ store, engine, checker: vmChecker(), learner: { tabHost: () => null }, log });
  await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") });
  let time = 1000;
  const learner = createLearner({ store, engine, session: new FakeArea(), tabs: { query: async () => [] }, now: () => time++, log });
  await learner.restore();
  return { learner, commands };
}

const settled = async (learner) => {
  for (let i = 0; i < 50 && (learner.running || learner.writing); i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

let requestId = 0;
const request = (learner, url, extra = {}) => {
  const details = { requestId: String(++requestId), type: "script", tabId: TAB, url, documentLifecycle: "active", timeStamp: 1, ...extra };
  learner.onRequest(details);
  return details;
};

test("the log records configuration, learning, skipped hosts and the host of a proxy failure", async () => {
  const { log, timers, entries } = memoryLog();
  log.set(true);
  const { learner } = await setup(log);
  const navigation = { type: "main_frame", tabId: TAB, url: "https://www.instagram.com/", documentLifecycle: "active", requestId: "main", timeStamp: 1 };
  learner.onRequest(navigation);
  learner.onCommitted({ tabId: TAB, frameId: 0, url: navigation.url, documentLifecycle: "active" });
  request(learner, "https://static.cdninstagram.com/a.js", { initiator: "https://www.instagram.com" });
  request(learner, "https://stats.g.doubleclick.net/x");
  request(learner, "https://stats.g.doubleclick.net/y");
  await settled(learner);
  learner.onError({ ...request(learner, "https://static.cdninstagram.com/b.js"), error: "net::ERR_SOCKS_CONNECTION_FAILED" });
  learner.onError({ ...request(learner, "https://other.example/", { tabId: 3 }), error: "net::ERR_SOCKS_CONNECTION_FAILED" });
  learner.onError({ ...request(learner, "https://i.instagram.com/api"), error: "net::ERR_ABORTED" });
  learner.onError({ ...request(learner, "https://i.instagram.com/api"), error: "net::ERR_CONNECTION_RESET" });
  learner.onProxyError({ error: "net::ERR_SOCKS_CONNECTION_FAILED", details: "", fatal: true });
  for (const flush of timers.splice(0)) await flush();
  const kinds = entries().map(({ kind }) => kind);
  assert.deepEqual(kinds, ["protection", "command", "navigation", "blocked", "skipped", "learned", "proxyFailure", "proxyFailure", "requestError", "proxyError"]);
  const [, , , blocked, skipped, learned, failure, untracked, requestError] = entries();
  assert.equal(blocked.host, "static.cdninstagram.com");
  assert.deepEqual([skipped.host, skipped.reason], ["stats.g.doubleclick.net", "deny"]);
  assert.deepEqual([learned.host, learned.root], ["static.cdninstagram.com", "instagram.com"]);
  assert.equal(failure.host, "static.cdninstagram.com");
  assert.equal(failure.tabHost, "www.instagram.com");
  assert.deepEqual([failure.route, failure.group, failure.entry], ["learned", "instagram.com", "static.cdninstagram.com"]);
  assert.deepEqual([untracked.host, untracked.route, untracked.tracked], ["other.example", "user PAC", false]);
  assert.deepEqual([requestError.error, requestError.route], ["net::ERR_CONNECTION_RESET", "root"]);
  assert.equal(
    entryText(failure),
    "net::ERR_SOCKS_CONNECTION_FAILED — static.cdninstagram.com [learned as static.cdninstagram.com in instagram.com] · script · tab 7 (www.instagram.com)",
  );
  assert.equal(entryLevel(failure), "error");
  assert.deepEqual(
    failuresByHost(entries()).map(({ host, count }) => [host, count]),
    [
      ["static.cdninstagram.com", 1],
      ["other.example", 1],
    ],
  );
});

test("with the log off nothing is recorded", async () => {
  const { log, timers } = memoryLog();
  const { learner } = await setup(log);
  request(learner, "https://static.cdninstagram.com/a.js");
  learner.onError({ ...request(learner, "https://x.example/"), error: "net::ERR_SOCKS_CONNECTION_FAILED" });
  await settled(learner);
  assert.equal(timers.length, 0);
});

test("proxy failures are grouped by host, most frequent first", () => {
  const failure = (host, time, error = "net::ERR_SOCKS_CONNECTION_FAILED") => ({ kind: "proxyFailure", host, time, error, route: "root", group: "a.com" });
  const rows = failuresByHost([failure("a.com", 1), failure("b.com", 2), failure("b.com", 3, "net::ERR_PROXY_CONNECTION_FAILED"), { kind: "learned", host: "a.com", time: 4 }]);
  assert.deepEqual(
    rows.map(({ host, count, first, last, route }) => ({ host, count, first, last, route })),
    [
      { host: "b.com", count: 2, first: 2, last: 3, route: "root a.com" },
      { host: "a.com", count: 1, first: 1, last: 1, route: "root a.com" },
    ],
  );
  assert.equal(rows[0].errors.size, 2);
});

test("times follow Chrome's own format", () => {
  const time = new Date(2026, 8, 26, 16, 22, 19, 7).getTime();
  assert.equal(formatTime(time), new Date(time).toLocaleString());
  assert.match(formatTime(time, { milliseconds: true }), /19[.,]007/);
});

test("a root page is logged when it commits, even without a main_frame request", async () => {
  const { log, timers, entries } = memoryLog();
  const { learner } = await setup(log);
  log.set(true);
  learner.onCommitted({ tabId: TAB, frameId: 0, url: "https://www.instagram.com/direct/#inbox", documentLifecycle: "active", transitionType: "typed" });
  learner.onCommitted({ tabId: TAB, frameId: 0, url: "https://example.com/", documentLifecycle: "active", transitionType: "link" });
  learner.onCommitted({ tabId: TAB, frameId: 0, url: "https://www.instagram.com/", documentLifecycle: "prerender" });
  for (const flush of timers.splice(0)) await flush();
  assert.deepEqual(entries(), [
    { time: 42, kind: "navigation", host: "www.instagram.com", root: "instagram.com", url: "https://www.instagram.com/direct/#inbox", tabId: TAB, transition: "typed" },
  ]);
  assert.equal(entryText(entries()[0]), "Root page www.instagram.com [instagram.com] · typed · tab 7");
});

test("public suffix list checks read as what happened to the list", () => {
  const entry = (fields) => ({ time: 1, kind: "psl", ...fields });
  assert.equal(entryText(entry({ trigger: "weekly", outcome: "updated", version: "2026-09-28_07-12-00_UTC", installed: "2026-09-28_07-12-00_UTC" })), "Weekly check: Public Suffix List updated to 2026-09-28 07:12:00 UTC");
  assert.equal(entryText(entry({ trigger: "manual", outcome: "current", version: null, installed: "2026-09-21_18-50-07_UTC" })), "Update: Public Suffix List 2026-09-21 18:50:07 UTC is the newest");
  assert.equal(entryText(entry({ trigger: "weekly", outcome: "error", message: "Cannot reach publicsuffix.org: Failed to fetch" })), "Weekly check: Public Suffix List update failed: Cannot reach publicsuffix.org: Failed to fetch");
  assert.equal(entryText(entry({ trigger: "weekly", outcome: "conflict", version: "2026-09-28_07-12-00_UTC" })), "Weekly check: Public Suffix List 2026-09-28 07:12:00 UTC is not installed, the saved User PAC does not pass with it");
  assert.equal(entryLevel(entry({ outcome: "conflict" })), "warn");
  assert.equal(entryLevel(entry({ outcome: "updated" })), "info");
});

test("held routes read as what the System PAC keeps and why it lets them go", () => {
  const held = { time: 1, kind: "routesHeld", routes: [{ name: "cdn.example.net", root: "instagram.com" }, { name: "github.io", root: "a.com", exact: true }] };
  assert.equal(entryText(held), "Routes held for requests already on their way: cdn.example.net [instagram.com], github.io (exact) [a.com] — the blocking rules are narrowed, the System PAC keeps these routes until the requests finish");
  const released = { time: 2, kind: "routesReleased", reason: "drained", routes: [{ name: "cdn.example.net", root: "instagram.com", after: 1830 }], held: [{ name: "github.io", root: "a.com", exact: true }] };
  assert.equal(entryText(released), "Routes released: cdn.example.net [instagram.com] after 1.8 s — the requests on their way finished, the System PAC is narrowed to the configuration; still held: github.io (exact) [a.com]");
  assert.equal(entryText({ ...released, reason: "restart", routes: [{ name: "x.net", root: "a.com" }], held: [] }), "Routes released: x.net [a.com] — the browser or RootPAC restarted, no request is on its way");
  assert.equal(entryText({ ...released, routes: [{ name: "x.net", root: "a.com", after: 40 }], held: [] }), "Routes released: x.net [a.com] after 40 ms — the requests on their way finished, the System PAC is narrowed to the configuration");
  assert.equal(entryText({ ...released, routes: [{ name: "x.net", root: "a.com", after: 40 }], count: 3, held: [{ name: "y.net", root: "a.com" }], heldCount: 25 }), "Routes released: x.net [a.com] after 40 ms and 2 more — the requests on their way finished, the System PAC is narrowed to the configuration; still held: y.net [a.com] and 24 more");
  assert.equal(entryLevel(held), "info");
  assert.ok(CATEGORIES.state.has("routesHeld") && CATEGORIES.state.has("routesReleased"));
});

test("the log is paged by 1000 events, a page out of range is the nearest one", () => {
  assert.deepEqual(paginate(0, 1, 1000), { pages: 1, page: 1, from: 0, to: 0 });
  assert.deepEqual(paginate(20000, 1, 1000), { pages: 20, page: 1, from: 0, to: 1000 });
  assert.deepEqual(paginate(20000, 20, 1000), { pages: 20, page: 20, from: 19000, to: 20000 });
  assert.deepEqual(paginate(2500, 3, 1000), { pages: 3, page: 3, from: 2000, to: 2500 });
  assert.deepEqual(paginate(2500, 7, 1000), { pages: 3, page: 3, from: 2000, to: 2500 });
  assert.deepEqual(paginate(2500, 0, 1000), { pages: 3, page: 1, from: 0, to: 1000 });
});

test("the pager shows the first, the last and the neighbours of the current page", () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageNumbers(1, 20), [1, 2, 3, null, 20]);
  assert.deepEqual(pageNumbers(10, 20), [1, null, 8, 9, 10, 11, 12, null, 20]);
  assert.deepEqual(pageNumbers(20, 20), [1, null, 18, 19, 20]);
  // A gap of one page shows that page.
  assert.deepEqual(pageNumbers(5, 20), [1, 2, 3, 4, 5, 6, 7, null, 20]);
  assert.deepEqual(pageNumbers(16, 20), [1, null, 14, 15, 16, 17, 18, 19, 20]);
});
