import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDomain } from "../src/core/hosts.js";
import { HOSTS_PER_RULE, RULE_IDS, buildRules, closedPolicy, intersectPolicies, maskRegex, policyOf } from "../src/core/rules.js";
import { PSL } from "./support.js";

const ANALYSIS = { roots: ["instagram.com"], deny: ["*.doubleclick.net"], bypass: [] };
const GROUPS = {
  "instagram.com": { rootHost: "www.instagram.com", hosts: { "static.cdninstagram.com": 1, "edge-chat.facebook.com": 2 } },
};

const REMOVED = ["nel", "report-to", "reporting-endpoints"].map((header) => ({ header, operation: "remove" }));

function regex(mask) {
  return new RegExp(maskRegex(mask), "i");
}

test("policyOf is null while disabled or unconfigured", () => {
  assert.equal(policyOf({ enabled: false, analysis: ANALYSIS, groups: GROUPS }, PSL), null);
  assert.equal(policyOf({ enabled: true, analysis: null, groups: {} }, PSL), null);
  assert.deepEqual(policyOf({ enabled: true, analysis: ANALYSIS, groups: GROUPS }, PSL), {
    blockRoots: ["instagram.com"],
    allowRoots: ["instagram.com"],
    deny: ["*.doubleclick.net"],
    bypass: [],
    hosts: ["static.cdninstagram.com", "edge-chat.facebook.com"],
    exact: [],
  });
});

test("intersectPolicies blocks the union and allows only the intersection", () => {
  const a = { blockRoots: ["a.com", "b.com"], allowRoots: ["a.com", "b.com"], deny: ["x.net"], bypass: ["*.ru", "a.org"], hosts: ["h1.net", "h2.net"], exact: [] };
  const b = { blockRoots: ["b.com", "c.com"], allowRoots: ["b.com", "c.com"], deny: ["y.net"], bypass: ["*.ru"], hosts: ["h2.net", "h3.net"], exact: [] };
  assert.deepEqual(intersectPolicies(a, b), {
    blockRoots: ["a.com", "b.com", "c.com"],
    allowRoots: ["b.com"],
    deny: ["x.net", "y.net"],
    bypass: ["*.ru"],
    hosts: ["h2.net"],
    exact: [],
  });
  assert.deepEqual(intersectPolicies(null, b), { blockRoots: b.blockRoots, allowRoots: [], deny: b.deny, bypass: [], hosts: [], exact: [] });
  assert.deepEqual(intersectPolicies(a, null), { blockRoots: a.blockRoots, allowRoots: [], deny: a.deny, bypass: [], hosts: [], exact: [] });
  assert.equal(intersectPolicies(null, null), null);
  assert.deepEqual(closedPolicy(a), intersectPolicies(a, null));
  assert.equal(closedPolicy(null), null);
});

test("intersectPolicies keeps a learned host both policies proxy, so aggregation never blocks it", () => {
  const base = { blockRoots: ["a.com"], allowRoots: ["a.com"], deny: [], bypass: [], exact: [] };
  const split = { ...base, hosts: ["a.cdn.net", "b.cdn.net", "other.net"] };
  const merged = { ...base, hosts: ["cdn.net", "other.net"] };
  assert.deepEqual(intersectPolicies(split, merged).hosts, ["a.cdn.net", "b.cdn.net", "other.net"]);
  assert.deepEqual(intersectPolicies(merged, split).hosts, ["other.net", "a.cdn.net", "b.cdn.net"]);
  assert.deepEqual(intersectPolicies({ ...base, hosts: ["x.cdn.net"] }, { ...base, hosts: ["cdn.net"] }).hosts, ["x.cdn.net"]);
  assert.deepEqual(intersectPolicies({ ...base, hosts: ["cdn.net"] }, { ...base, hosts: ["x.cdn.net"] }).hosts, ["x.cdn.net"]);
  assert.deepEqual(intersectPolicies({ ...base, hosts: ["cdn.net"] }, { ...base, hosts: ["cdn.org"] }).hosts, []);
});

test("maskDomain and maskRegex match exactly what shExpMatch matches", () => {
  assert.equal(maskDomain("*.instagram.com"), "instagram.com");
  assert.equal(maskDomain("instagram.com"), "instagram.com");
  const wildcard = regex("*.instagram.com");
  for (const url of ["https://www.instagram.com/", "wss://a.b.instagram.com:443/x", "http://i.instagram.com/?q=1"]) assert.match(url, wildcard, url);
  for (const url of ["https://instagram.com/", "https://www.instagram.com.evil.org/", "https://evil.org/?u=https://www.instagram.com/", "https://winstagram.com/"]) {
    assert.doesNotMatch(url, wildcard, url);
  }
  const exact = regex("instagram.com");
  assert.match("https://instagram.com/", exact);
  assert.match("https://instagram.com:8443/p", exact);
  for (const url of ["https://www.instagram.com/", "https://instagram.company/", "https://instagram.com.evil.org/"]) assert.doesNotMatch(url, exact, url);
});

test("buildRules keeps blocks dynamic and every allowance in session rules", () => {
  const rules = buildRules(policyOf({ enabled: true, analysis: ANALYSIS, groups: GROUPS }, PSL));
  assert.deepEqual(rules.dynamic, [
    {
      id: RULE_IDS.block,
      priority: 1,
      action: { type: "block" },
      condition: { topDomains: ["instagram.com"], excludedResourceTypes: ["main_frame"] },
    },
    {
      id: RULE_IDS.deny,
      priority: 3,
      action: { type: "block" },
      condition: { topDomains: ["instagram.com"], requestDomains: ["doubleclick.net"], excludedResourceTypes: ["main_frame"] },
    },
    {
      id: RULE_IDS.frame,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains: ["instagram.com"], resourceTypes: ["main_frame"] },
    },
    {
      id: RULE_IDS.rootRequests,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains: ["instagram.com"] },
    },
    {
      id: RULE_IDS.embeds,
      priority: 1,
      action: { type: "block" },
      condition: { initiatorDomains: ["instagram.com"], excludedResourceTypes: ["main_frame"] },
    },
    {
      id: RULE_IDS.reports,
      priority: 3,
      action: { type: "modifyHeaders", responseHeaders: REMOVED },
      condition: { topDomains: ["instagram.com"], excludedResourceTypes: ["main_frame"] },
    },
    {
      id: RULE_IDS.reportsFrame,
      priority: 3,
      action: { type: "modifyHeaders", responseHeaders: REMOVED },
      condition: { requestDomains: ["instagram.com"], resourceTypes: ["main_frame"] },
    },
  ]);
  assert.deepEqual(rules.session, [
    { id: RULE_IDS.unlock, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["instagram.com"], resourceTypes: ["main_frame"] } },
    { id: RULE_IDS.roots, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["instagram.com"] } },
    {
      id: RULE_IDS.hosts,
      priority: 2,
      action: { type: "allow" },
      condition: { requestDomains: ["edge-chat.facebook.com", "static.cdninstagram.com"] },
    },
  ]);
});

test("buildRules is empty without a policy or roots and omits empty parts", () => {
  const empty = { dynamic: [], session: [] };
  assert.deepEqual(buildRules(null), empty);
  assert.deepEqual(buildRules({ blockRoots: [], allowRoots: [], deny: [], bypass: [], hosts: [] }), empty);
  const closed = buildRules(closedPolicy(policyOf({ enabled: true, analysis: ANALYSIS, groups: GROUPS }, PSL)));
  assert.deepEqual(closed.dynamic.map(({ id }) => id), [RULE_IDS.block, RULE_IDS.deny, RULE_IDS.frame, RULE_IDS.rootRequests, RULE_IDS.embeds, RULE_IDS.reports, RULE_IDS.reportsFrame]);
  assert.deepEqual(closed.session, []);
});

test("learned hosts are chunked into deterministic allow rules", () => {
  const hosts = Array.from({ length: HOSTS_PER_RULE * 2 + 5 }, (_, i) => `h${String(i).padStart(5, "0")}.cdn.net`);
  const policy = { blockRoots: ["a.com"], allowRoots: ["a.com"], deny: [], bypass: [], hosts: [...hosts].reverse() };
  const chunks = buildRules(policy).session.filter(({ id }) => id >= RULE_IDS.hosts);
  assert.deepEqual(chunks.map(({ id }) => id), [RULE_IDS.hosts, RULE_IDS.hosts + 1, RULE_IDS.hosts + 2]);
  assert.deepEqual(chunks.flatMap(({ condition }) => condition.requestDomains), hosts);
  assert.deepEqual(buildRules(policy), buildRules({ ...policy, hosts }));
});

test("requests to a root from any context are blocked until the root allowance lifts them", () => {
  const policy = policyOf({ enabled: true, analysis: { roots: ["instagram.com", "youtube.com"], deny: [], bypass: [] }, groups: {} }, PSL);
  const closed = buildRules(closedPolicy(policy));
  const block = closed.dynamic.find(({ id }) => id === RULE_IDS.rootRequests);
  assert.deepEqual(block, { id: RULE_IDS.rootRequests, priority: 1, action: { type: "block" }, condition: { requestDomains: ["instagram.com", "youtube.com"] } });
  assert.equal(closed.session.some(({ id }) => id === RULE_IDS.roots), false);
  const open = buildRules(policy);
  const allow = open.session.find(({ id }) => id === RULE_IDS.roots);
  assert.deepEqual(allow.condition, block.condition);
  assert.ok(allow.priority > block.priority);
  assert.deepEqual(open.dynamic.find(({ id }) => id === RULE_IDS.rootRequests), block);
});

test("a record learned in several groups becomes one DNR domain", () => {
  const policy = policyOf({
    enabled: true,
    analysis: { roots: ["a.com", "b.com"], deny: [], bypass: [] },
    groups: { "a.com": { rootHost: "www.a.com", hosts: { "cdn.net": 1 } }, "b.com": { rootHost: "www.b.com", hosts: { "cdn.net": 2, "img.org": 3 } } },
  }, PSL);
  assert.deepEqual([...policy.hosts].sort(), ["cdn.net", "img.org"]);
  const hosts = buildRules(policy).session.filter(({ id }) => id >= RULE_IDS.hosts);
  assert.deepEqual(hosts.flatMap(({ condition }) => condition.requestDomains), ["cdn.net", "img.org"]);
});

test("exact public suffix records are allowed by an exact regular expression and share the regex budget", () => {
  const groups = { "instagram.com": { rootHost: "www.instagram.com", hosts: { "github.io": 1, "cdn.net": 2 } } };
  const policy = policyOf({ enabled: true, analysis: ANALYSIS, groups }, PSL);
  assert.deepEqual([policy.hosts, policy.exact], [["cdn.net"], ["github.io"]]);
  const { session } = buildRules(policy);
  assert.deepEqual(session.find((rule) => rule.id === RULE_IDS.exact).condition, { regexFilter: "^[a-z]+://github\\.io\\.?(?::[0-9]+)?/" });
  assert.deepEqual(session.find((rule) => rule.id === RULE_IDS.hosts).condition.requestDomains, ["cdn.net"]);
  const other = { ...policy, hosts: ["cdn.net"], exact: [] };
  assert.deepEqual(intersectPolicies(policy, other).exact, []);
  assert.deepEqual(intersectPolicies(policy, { ...policy, hosts: ["io"] }).exact, ["github.io"]);
  const full = { ...policy, bypass: Array.from({ length: 1000 }, (_, i) => `b${i}.org`) };
  assert.throws(() => buildRules(full), /At most 1000 bypass masks and public suffix hosts/);
});
