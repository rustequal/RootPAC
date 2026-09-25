import { test } from "node:test";
import assert from "node:assert/strict";
import { createBadge } from "../src/background/badge.js";

function fakes({ state = STATE, tabs: hosts = { 1: "www.a.com" }, newHosts = {}, load = { 1: 2 }, busy = [], waiting = {}, broken = [], failed = [], armed = true, failIcon = 0 } = {}) {
  const calls = [];
  const decoded = [];
  const runtime = { lastError: undefined };
  const failures = { icon: failIcon };
  const engine = { armed };
  const store = { state };
  const badge = createBadge({
    runtime,
    action: {
      setIcon: (details, done) => {
        runtime.lastError = failures.icon-- > 0 ? { message: `No tab with id: ${details.tabId}.` } : undefined;
        if (runtime.lastError === undefined) calls.push(["icon", details.tabId, details.imageData[16]]);
        done();
        runtime.lastError = undefined;
      },
      setBadgeText: async (details) => calls.push(["text", details.tabId, details.text]),
      setBadgeBackgroundColor: async ({ color }) => calls.push(["background", color]),
      setBadgeTextColor: async ({ color }) => calls.push(["color", color]),
    },
    tabs: { query: async () => Object.keys(hosts).map((id) => ({ id: Number(id) })) },
    engine,
    store,
    learner: {
      tabHost: (tabId) => hosts[tabId] ?? null,
      newHosts: (tabId) => newHosts[tabId] ?? 0,
      loaded: () => 0,
      proxied: (tabId) => load[tabId] ?? 0,
      loading: (tabId) => busy.includes(tabId),
      pending: (tabId) => waiting[tabId] ?? 0,
      incomplete: (tabId) => broken.includes(tabId),
      proxyError: (tabId) => (failed.includes(tabId) ? { error: "net::ERR_PROXY_CONNECTION_FAILED", count: 1 } : null),
    },
    decode: async (path) => {
      decoded.push(path);
      return path.slice("/icons/".length, -".png".length);
    },
  });
  return { badge, calls, decoded, hosts, load, engine, store };
}

const STATE = {
  enabled: true,
  analysis: { roots: ["a.com"], deny: [], bypass: [] },
  groups: { "a.com": { rootHost: "www.a.com", hosts: { "x.cdn.net": 1, "y.cdn.net": 2 } } },
  userPacErrors: null,
};

const SHARED_IDLE = [
  ["icon", undefined, "idle-16"],
  ["text", undefined, ""],
];

test("a root tab with nothing new is green and counts the hosts that went through the proxy", async () => {
  const { badge, calls } = fakes();
  await badge.start();
  assert.deepEqual(calls, [["background", "#e5484d"], ["color", "#ffffff"], ...SHARED_IDLE, ["icon", 1, "active-16"], ["text", 1, "2"]]);
});

test("new hosts in the tab turn the icon amber and keep the count", async () => {
  const { badge, calls } = fakes({ newHosts: { 1: 3 } });
  await badge.refresh();
  assert.deepEqual(calls.slice(2), [["icon", 1, "pending-16"], ["text", 1, "2"]]);
});

test("a proxy failure in the current load turns the icon amber with an exclamation mark instead of the count", async () => {
  const { badge, calls } = fakes({ failed: [1], busy: [1], newHosts: { 1: 3 } });
  await badge.refresh();
  assert.deepEqual(calls.slice(2), [["icon", 1, "pending-16"], ["text", 1, "!"]]);
  const off = fakes({ failed: [1], armed: false });
  await off.badge.refresh();
  assert.deepEqual(off.calls.slice(0, 2), [["icon", undefined, "off-16"], ["text", undefined, "!"]]);
});

test("a loading page is neutral until its verdict is known, so a new site never flashes green", async () => {
  const { badge, calls } = fakes({ busy: [1], load: { 1: 1 } });
  await badge.refresh();
  assert.deepEqual(calls.slice(2), [["text", 1, "1"]]);
});

test("hosts already blocked but not yet committed keep the icon amber", async () => {
  const { badge, calls } = fakes({ busy: [1], waiting: { 1: 2 } });
  await badge.refresh();
  assert.deepEqual(calls[2], ["icon", 1, "pending-16"]);
});

test("a tab outside any root shows the shared default and costs no per-tab call", async () => {
  const { badge, calls } = fakes({ tabs: { 7: "example.org", 8: "example.net" } });
  await badge.refresh();
  await badge.update(7, true);
  await badge.update(8, true);
  assert.deepEqual(calls, SHARED_IDLE);
});

test("the badge counts hosts proxied in the tab, capped at 99+", async () => {
  const { badge, calls } = fakes({ load: { 1: 120 } });
  await badge.refresh();
  assert.deepEqual(calls.at(-1), ["text", 1, "99+"]);
  const empty = fakes({ load: {} });
  await empty.badge.refresh();
  assert.deepEqual(empty.calls.slice(2), [["icon", 1, "active-16"]]);
});

test("a switched off proxy, safe mode or an unconfirmed control show the problem badge on every tab", async () => {
  for (const state of [{ ...STATE, enabled: false }, { ...STATE, analysis: null }, { ...STATE, userPacErrors: [{ line: 1, column: 1, message: "invalid" }] }]) {
    const { badge, calls } = fakes({ state, tabs: { 1: "www.a.com", 2: "example.org" } });
    await badge.refresh();
    assert.deepEqual(calls, [
      ["icon", undefined, "off-16"],
      ["text", undefined, "!"],
    ]);
  }
  const { badge, calls, engine } = fakes({ tabs: { 1: "www.a.com", 2: "example.org" } });
  await badge.refresh();
  calls.length = 0;
  engine.armed = false;
  await badge.refresh();
  assert.deepEqual(calls, [
    ["icon", undefined, "off-16"],
    ["text", undefined, "!"],
    ["icon", 1, "off-16"],
    ["text", 1, "!"],
  ]);
  calls.length = 0;
  engine.armed = true;
  await badge.refresh();
  assert.deepEqual(calls, [...SHARED_IDLE, ["icon", 1, "active-16"], ["text", 1, "2"]]);
});

test("icons are decoded once from absolute paths, because a service worker resolves relative ones against its own script", async () => {
  const { badge, decoded, load } = fakes();
  await badge.refresh();
  for (let count = 3; count < 10; count++) {
    load[1] = count;
    await badge.update(1);
  }
  assert.deepEqual(decoded.sort(), ["active", "idle", "off", "pending"].flatMap((name) => [`/icons/${name}-16.png`, `/icons/${name}-32.png`]).sort());
});

test("the icon and the text are written only when each of them changes", async () => {
  const { badge, calls, load } = fakes();
  await badge.refresh();
  calls.length = 0;
  load[1] = 3;
  await badge.update(1);
  await badge.update(1);
  assert.deepEqual(calls, [["text", 1, "3"]]);
});

test("a failing setIcon is retried on the next refresh", async () => {
  const { badge, calls } = fakes({ failIcon: 2 });
  await badge.refresh();
  await badge.refresh();
  assert.deepEqual(
    calls.filter(([kind]) => kind === "icon"),
    [
      ["icon", undefined, "idle-16"],
      ["icon", 1, "active-16"],
    ],
  );
});

test("a navigation rewrites a root tab, because Chrome may clear its own values", async () => {
  const { badge, calls } = fakes();
  await badge.refresh();
  calls.length = 0;
  await badge.update(1);
  assert.deepEqual(calls, []);
  await badge.update(1, true);
  assert.deepEqual(calls, [["icon", 1, "active-16"], ["text", 1, "2"]]);
});

test("a tab that leaves its root is set back to the default once, then costs nothing", async () => {
  const { badge, calls, hosts } = fakes();
  await badge.refresh();
  calls.length = 0;
  hosts[1] = "example.org";
  await badge.update(1, true);
  assert.deepEqual(calls, [["icon", 1, "idle-16"], ["text", 1, ""]]);
  calls.length = 0;
  await badge.update(1, true);
  await badge.update(1, true);
  assert.deepEqual(calls, []);
});

test("an unchanged tab is not written again and a closed tab is forgotten", async () => {
  const { badge, calls, hosts } = fakes();
  await badge.refresh();
  calls.length = 0;
  await badge.refresh();
  assert.deepEqual(calls, []);
  delete hosts[1];
  await badge.refresh();
  hosts[1] = "www.a.com";
  await badge.refresh();
  assert.deepEqual(calls, [["icon", 1, "active-16"], ["text", 1, "2"]]);
});
