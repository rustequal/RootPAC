import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { createEngine } from "../src/background/engine.js";
import { createCommands } from "../src/background/messages.js";
import { createProxy } from "../src/background/proxy.js";
import { Store, refresh } from "../src/background/store.js";
import { createTraffic } from "../src/background/traffic.js";
import { systemPacOf } from "../src/core/build.js";
import { parsePublicSuffixList } from "../src/core/psl.js";
import { FakeArea, FakeBrowser } from "./fakes.js";
import { PSL, fixture, loadPac, vmChecker } from "./support.js";

const PROXY = "SOCKS5 10.1.4.1:9487";

// A store, an engine that counts requests on their way and the commands, with the reference User PAC and one learned
// record; `release` is what main.js does when a held route drains.
async function setup() {
  const area = new FakeArea();
  const store = new Store(area, new FakeArea());
  await store.load(PSL);
  const browser = new FakeBrowser();
  let clock = 1000;
  let released = 0;
  const traffic = createTraffic({ onDrained: () => released++ });
  const engine = createEngine({ store, proxy: createProxy(browser), dnr: createDnr(browser.dnr), session: new FakeArea(), traffic, now: () => clock });
  const commands = createCommands({ store, engine, checker: vmChecker(), session: new FakeArea(), learner: { tabHost: () => null, newHosts: () => 0 } });
  assert.equal((await commands.dispatch({ type: "saveUserPac", text: fixture("user.pac") })).ok, true);
  await store.run((state) => {
    const groups = { "instagram.com": { rootHost: "www.instagram.com", hosts: { "cdn.example.net": 1 } } };
    const next = { ...state, groups, sites: { ...state.sites, "example.net": "instagram.com" } };
    return engine.commit({ ...next, appliedPac: systemPacOf(next, PSL) });
  });
  let id = 0;
  const request = (host, timeStamp) => {
    const requestId = String(++id);
    traffic.start({ requestId, url: `https://${host}/`, timeStamp });
    return (at) => traffic.end({ requestId, timeStamp: at });
  };
  const route = (host) => loadPac(store.state.appliedPac).FindProxyForURL(`https://${host}/`, host);
  const release = () => store.run((state) => engine.commit(state));
  return { store, engine, commands, browser, traffic, request, route, release, released: () => released, tick: (at) => (clock = at) };
}

test("a removed record stays in the PAC while a request to it is on its way, and leaves it once the request is done", async () => {
  const { store, commands, browser, request, route, release, released, tick } = await setup();
  const finish = request("img.cdn.example.net", 900);
  tick(1100);
  assert.equal((await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "cdn.example.net" })).ok, true);
  assert.deepEqual(store.state.held, { "instagram.com": { "cdn.example.net": 1 } });
  assert.deepEqual(store.state.groups["instagram.com"].hosts, {});
  assert.equal(route("img.cdn.example.net"), PROXY, "the request on its way still goes through the proxy");
  const allowed = [...browser.sessionRules.values()].flatMap(({ condition }) => condition.requestDomains ?? []);
  assert.ok(!allowed.includes("cdn.example.net"), "the rules no longer allow it: a new request is blocked");
  finish(1150);
  assert.equal(released(), 1);
  await release();
  assert.equal(store.state.held, null);
  assert.equal(route("img.cdn.example.net"), "DIRECT");
});

test("with no request on its way the route is still held until the event stream passes the change", async () => {
  const { store, commands, request, release, released, tick } = await setup();
  tick(1100);
  await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "cdn.example.net" });
  assert.notEqual(store.state.held, null);
  assert.equal(released(), 0);
  const late = request("unrelated.org", 1099);
  late(1101);
  assert.equal(released(), 1);
  await release();
  assert.equal(store.state.held, null);
});

test("a release commit keeps the routes that are still busy", async () => {
  const { store, commands, request, release, released, tick } = await setup();
  const busy = request("a.cdn.example.net", 900);
  tick(1100);
  await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "cdn.example.net" });
  const other = request("x.org", 1200);
  other(1201);
  assert.equal(released(), 0, "the removed record is still busy");
  busy(1300);
  assert.equal(released(), 1);
  await release();
  assert.equal(store.state.held, null);
});

test("a public suffix list that makes a record exact keeps its old coverage held", async () => {
  const { store, engine, request, route, tick } = await setup();
  const text = await import("node:fs").then(({ readFileSync }) => readFileSync(new URL("../vendor/public_suffix_list.dat", import.meta.url), "utf8"));
  const zoned = parsePublicSuffixList(text.replace("// ===END PRIVATE DOMAINS===", "cdn.example.net\n// ===END PRIVATE DOMAINS==="));
  request("u.cdn.example.net", 900);
  tick(1100);
  await store.run(async (state) => {
    const next = refresh(state, zoned);
    store.setPsl(zoned);
    return engine.commit(next);
  });
  assert.deepEqual(store.state.held, { "instagram.com": { "cdn.example.net": 1 } });
  assert.equal(route("u.cdn.example.net"), PROXY);
  assert.equal(route("cdn.example.net"), PROXY);
});

test("every PAC in force proxies each host the rules in force allowed while a request to it is on its way", async () => {
  const { commands, browser, request, release, tick } = await setup();
  const finish = request("cdn.example.net", 900);
  tick(1100);
  const from = browser.snapshots.length;
  await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "cdn.example.net" });
  const pacs = browser.snapshots.slice(from).map(({ pac }) => pac);
  for (const pac of pacs) assert.equal(loadPac(pac).FindProxyForURL("https://cdn.example.net/", "cdn.example.net"), PROXY);
  finish(1200);
  await release();
});

test("switching the proxy off drops the held routes; safe mode keeps them and never asks for a release", async () => {
  const { store, engine, commands, request, released, tick } = await setup();
  request("cdn.example.net", 900);
  tick(1100);
  await commands.dispatch({ type: "removeHost", mask: "instagram.com", host: "cdn.example.net" });
  assert.notEqual(store.state.held, null);
  await commands.dispatch({ type: "setEnabled", enabled: false });
  assert.equal(store.state.held, null);
  assert.doesNotMatch(store.state.appliedPac, /HELD_/);
  const late = request("x.org", 1200);
  late(1201);
  assert.equal(released(), 0);
  const held = { "instagram.com": { "old.example.org": 1 } };
  await store.run((state) => engine.commit({ ...state, enabled: true, userPacErrors: [{ line: 1, column: 1, message: "broken" }], held }));
  const again = request("y.org", 1300);
  again(1301);
  assert.deepEqual(store.state.held, held);
  assert.equal(released(), 0);
});
