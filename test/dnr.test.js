import { test } from "node:test";
import assert from "node:assert/strict";
import { createDnr } from "../src/background/dnr.js";
import { FakeBrowser } from "./fakes.js";

const rule = (id, domains) => ({ id, priority: 1, action: { type: "block" }, condition: { requestDomains: domains } });
const rules = (dynamic, session = []) => ({ dynamic, session });

test("the first replace reads both rule sets and drops only what differs", async () => {
  const browser = new FakeBrowser();
  browser.rules.set(7, rule(7, ["old.net"]));
  browser.rules.set(1, rule(1, ["a.net"]));
  browser.sessionRules.set(9, rule(9, ["stale.net"]));
  await createDnr(browser.dnr).replace(rules([rule(1, ["a.net"])], [rule(5, ["s.net"])]));
  assert.deepEqual(browser.journal.entries, [
    ["dnr.update", { removeRuleIds: [7], addRules: [] }],
    ["dnr.session", { removeRuleIds: [9], addRules: [rule(5, ["s.net"])] }],
  ]);
  assert.deepEqual(browser.ruleIds(), [1, 5]);
});

test("later replaces send only the difference of each set in one atomic update", async () => {
  const browser = new FakeBrowser();
  const dnr = createDnr(browser.dnr);
  await dnr.replace(rules([rule(1, ["a.net"]), rule(2, ["b.net"]), rule(3, ["c.net"])], [rule(10, ["x.net"])]));
  browser.journal.clear();
  assert.equal(await dnr.replace(rules([rule(1, ["a.net"]), rule(2, ["b2.net"]), rule(4, ["d.net"])], [rule(10, ["x.net"])])), true);
  assert.deepEqual(browser.journal.entries, [["dnr.update", { removeRuleIds: [2, 3], addRules: [rule(2, ["b2.net"]), rule(4, ["d.net"])] }]]);
  assert.equal(await dnr.replace(rules([rule(1, ["a.net"]), rule(2, ["b2.net"]), rule(4, ["d.net"])], [rule(10, ["x.net"])])), false);
  assert.equal(browser.journal.entries.length, 1);
});

test("a failed update leaves the known state untouched", async () => {
  const browser = new FakeBrowser();
  const dnr = createDnr(browser.dnr);
  await dnr.replace(rules([rule(1, ["a.net"])]));
  browser.journal.failures.set("dnr.update", new Error("quota"));
  await assert.rejects(dnr.replace(rules([rule(2, ["b.net"])])), /quota/);
  await dnr.replace(rules([rule(2, ["b.net"])]));
  assert.deepEqual(browser.ruleIds(), [2]);
});

test("matches compares the installed rules key-order-insensitively and reloads them", async () => {
  const browser = new FakeBrowser();
  const dnr = createDnr(browser.dnr);
  const expected = rules([rule(1, ["a.net"])], [rule(5, ["s.net"])]);
  await dnr.replace(expected);
  browser.rules.set(1, { condition: { requestDomains: ["a.net"] }, action: { type: "block" }, priority: 1, id: 1 });
  assert.equal(await dnr.matches(expected), true);
  browser.restart();
  assert.equal(await dnr.matches(expected), false);
  browser.journal.clear();
  await dnr.replace(expected);
  assert.deepEqual(browser.journal.entries, [["dnr.session", { removeRuleIds: [], addRules: [rule(5, ["s.net"])] }]]);
});

test("documented defaults returned by Chrome do not count as a difference", async () => {
  const expected = { dynamic: [{ id: 1, priority: 1, action: { type: "block" }, condition: { requestDomains: ["a.com"] } }], session: [{ id: 3000, priority: 2, action: { type: "allow" }, condition: { regexFilter: "^x$" } }] };
  const read = (dynamic, session) => ({
    getDynamicRules: async () => dynamic,
    getSessionRules: async () => session,
    updateDynamicRules: async () => assert.fail("no write expected"),
    updateSessionRules: async () => assert.fail("no write expected"),
  });
  const explicit = read([{ id: 1, action: { type: "block" }, condition: { requestDomains: ["a.com"], isUrlFilterCaseSensitive: false } }], [{ id: 3000, priority: 2, action: { type: "allow" }, condition: { regexFilter: "^x$", isUrlFilterCaseSensitive: false } }]);
  const dnr = createDnr(explicit);
  assert.equal(await dnr.matches(expected), true);
  assert.equal(await dnr.replace(expected), false);
  const differs = async (dynamic, session) => !(await createDnr(read(dynamic, session)).matches(expected));
  assert.equal(await differs([{ id: 1, priority: 2, action: { type: "block" }, condition: { requestDomains: ["a.com"] } }], expected.session), true);
  assert.equal(await differs(expected.dynamic, [{ id: 3000, priority: 2, action: { type: "allow" }, condition: { regexFilter: "^x$", isUrlFilterCaseSensitive: true } }]), true);
  assert.equal(await differs([{ ...expected.dynamic[0], condition: { requestDomains: ["a.com"], domainType: "thirdParty" } }], expected.session), true);
});
