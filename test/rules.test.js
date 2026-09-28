import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDomain } from "../src/core/hosts.js";
import { HOSTS_PER_RULE, RULES_PER_ROOT, RULE_IDS, buildRules, closedPolicy, intersectPolicies, maskRegex, policyOf } from "../src/core/rules.js";
import { PSL } from "./support.js";

const ANALYSIS = { roots: ["instagram.com"], deny: ["*.doubleclick.net"], bypass: [] };
const GROUPS = {
  "instagram.com": { rootHost: "www.instagram.com", hosts: { "static.cdninstagram.com": 1, "edge-chat.facebook.com": 2 } },
};

const REMOVED = ["nel", "report-to", "reporting-endpoints"].map((header) => ({ header, operation: "remove" }));

function regex(mask) {
  return new RegExp(maskRegex(mask), "i");
}

const context = (root, fields = {}) => ({ root, domain: root, shadows: [], allow: [], deny: [], allowExact: [], denyExact: [], ...fields });

test("policyOf is null while disabled or unconfigured", () => {
  assert.equal(policyOf({ enabled: false, analysis: ANALYSIS, groups: GROUPS }, PSL), null);
  assert.equal(policyOf({ enabled: true, analysis: null, groups: {} }, PSL), null);
  assert.deepEqual(policyOf({ enabled: true, analysis: ANALYSIS, groups: GROUPS }, PSL), {
    blockRoots: ["instagram.com"],
    allowRoots: ["instagram.com"],
    deny: ["*.doubleclick.net"],
    bypass: [],
    contexts: [context("instagram.com", { allow: ["edge-chat.facebook.com", "static.cdninstagram.com"] })],
  });
});

test("intersectPolicies blocks the union and allows only the intersection", () => {
  const a = { blockRoots: ["a.com", "b.com"], allowRoots: ["a.com", "b.com"], deny: ["x.net"], bypass: ["*.ru", "a.org"], contexts: [context("b.com", { allow: ["h1.net", "h2.net"] }), context("a.com", { allow: ["h9.net"] })] };
  const b = { blockRoots: ["b.com", "c.com"], allowRoots: ["b.com", "c.com"], deny: ["y.net"], bypass: ["*.ru"], contexts: [context("b.com", { allow: ["h2.net", "h3.net"] }), context("c.com", { allow: ["h9.net"] })] };
  assert.deepEqual(intersectPolicies(a, b), {
    blockRoots: ["a.com", "b.com", "c.com"],
    allowRoots: ["b.com"],
    deny: ["x.net", "y.net"],
    bypass: ["*.ru"],
    contexts: [context("b.com", { allow: ["h2.net"] })],
  });
  assert.deepEqual(intersectPolicies(null, b), { blockRoots: b.blockRoots, allowRoots: [], deny: b.deny, bypass: [], contexts: [] });
  assert.deepEqual(intersectPolicies(a, null), { blockRoots: a.blockRoots, allowRoots: [], deny: a.deny, bypass: [], contexts: [] });
  assert.equal(intersectPolicies(null, null), null);
  assert.deepEqual(closedPolicy(a), intersectPolicies(a, null));
  assert.equal(closedPolicy(null), null);
});

test("intersectPolicies keeps a learned host both policies proxy, so aggregation never blocks it", () => {
  const base = { blockRoots: ["a.com"], allowRoots: ["a.com"], deny: [], bypass: [] };
  const allowed = (a, b) => intersectPolicies({ ...base, contexts: [context("a.com", { allow: a })] }, { ...base, contexts: [context("a.com", { allow: b })] }).contexts[0].allow;
  assert.deepEqual(allowed(["a.cdn.net", "b.cdn.net", "other.net"], ["cdn.net", "other.net"]), ["a.cdn.net", "b.cdn.net", "other.net"]);
  assert.deepEqual(allowed(["cdn.net", "other.net"], ["a.cdn.net", "b.cdn.net", "other.net"]), ["a.cdn.net", "b.cdn.net", "other.net"]);
  assert.deepEqual(allowed(["x.cdn.net"], ["cdn.net"]), ["x.cdn.net"]);
  assert.deepEqual(allowed(["cdn.net"], ["x.cdn.net"]), ["x.cdn.net"]);
  assert.deepEqual(allowed(["cdn.net"], ["cdn.org"]), []);
});

test("intersectPolicies keeps a conflict blocked while either side blocks it", () => {
  const base = { blockRoots: ["a.com"], allowRoots: ["a.com"], deny: [], bypass: [] };
  const before = { ...base, contexts: [context("a.com", { allow: ["cdn.net"], deny: ["x.cdn.net"] })] };
  const after = { ...base, contexts: [context("a.com", { allow: ["cdn.net"] })] };
  assert.deepEqual(intersectPolicies(before, after).contexts, [context("a.com", { allow: ["cdn.net"], deny: ["x.cdn.net"] })]);
  assert.deepEqual(intersectPolicies(after, before).contexts, [context("a.com", { allow: ["cdn.net"], deny: ["x.cdn.net"] })]);
  const moved = { ...base, contexts: [context("a.com", { shadows: ["x.a.com"], allow: ["cdn.net"] })] };
  assert.deepEqual(intersectPolicies(after, moved).contexts, []);
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
      condition: { topDomains: ["instagram.com"], requestDomains: ["edge-chat.facebook.com", "static.cdninstagram.com"] },
    },
    {
      id: RULE_IDS.hosts + 1,
      priority: 2,
      action: { type: "allow" },
      condition: { initiatorDomains: ["instagram.com"], excludedTopDomains: ["instagram.com"], requestDomains: ["edge-chat.facebook.com", "static.cdninstagram.com"] },
    },
  ]);
});

test("buildRules is empty without a policy or roots and omits empty parts", () => {
  const empty = { dynamic: [], session: [] };
  assert.deepEqual(buildRules(null), empty);
  assert.deepEqual(buildRules({ blockRoots: [], allowRoots: [], deny: [], bypass: [], contexts: [] }), empty);
  const closed = buildRules(closedPolicy(policyOf({ enabled: true, analysis: ANALYSIS, groups: GROUPS }, PSL)));
  assert.deepEqual(closed.dynamic.map(({ id }) => id), [RULE_IDS.block, RULE_IDS.deny, RULE_IDS.frame, RULE_IDS.rootRequests, RULE_IDS.embeds, RULE_IDS.reports, RULE_IDS.reportsFrame]);
  assert.deepEqual(closed.session, []);
});

test("learned hosts are chunked into deterministic allow rules", () => {
  const hosts = Array.from({ length: HOSTS_PER_RULE * 2 + 5 }, (_, i) => `h${String(i).padStart(5, "0")}.cdn.net`);
  const groups = { "a.com": { rootHost: "a.com", hosts: Object.fromEntries([...hosts].reverse().map((host) => [host, 1])) } };
  const policy = policyOf({ enabled: true, analysis: { roots: ["a.com"], deny: [], bypass: [] }, groups }, PSL);
  const chunks = buildRules(policy).session.filter(({ id }) => id >= RULE_IDS.hosts);
  assert.deepEqual(chunks.map(({ id }) => id), Array.from({ length: 6 }, (_, i) => RULE_IDS.hosts + i));
  assert.deepEqual(chunks.slice(0, 3).flatMap(({ condition }) => condition.requestDomains), hosts);
  assert.deepEqual(chunks.slice(3).flatMap(({ condition }) => condition.requestDomains), hosts);
  assert.deepEqual(chunks.slice(0, 3).map(({ condition }) => condition.topDomains), [["a.com"], ["a.com"], ["a.com"]]);
  assert.deepEqual(chunks.slice(3).map(({ condition }) => condition.initiatorDomains), [["a.com"], ["a.com"], ["a.com"]]);
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

const TWO = { roots: ["a.com", "b.com"], deny: [], bypass: [] };
const SHARED = { "a.com": { rootHost: "www.a.com", hosts: { "cdn.net": 1 } }, "b.com": { rootHost: "www.b.com", hosts: { "cdn.net": 2, "img.org": 3 } } };
const allowOf = (policy, root) => policy.contexts.find((item) => item.root === root);

test("a record learned by roots on the same proxy is allowed for each of them", () => {
  const proxies = { "a.com": { host: "www.a.com", answer: "PROXY p:1" }, "b.com": { host: "www.b.com", answer: "PROXY p:1" } };
  const policy = policyOf({ enabled: true, analysis: TWO, groups: SHARED, proxies }, PSL);
  assert.deepEqual(allowOf(policy, "a.com"), context("a.com", { allow: ["cdn.net"] }));
  assert.deepEqual(allowOf(policy, "b.com"), context("b.com", { allow: ["cdn.net", "img.org"] }));
  const rules = buildRules(policy).session.filter(({ id }) => id >= RULE_IDS.hosts);
  assert.deepEqual(rules.map(({ condition }) => [condition.topDomains ?? condition.initiatorDomains, condition.requestDomains]), [
    [["a.com"], ["cdn.net"]],
    [["a.com"], ["cdn.net"]],
    [["b.com"], ["cdn.net", "img.org"]],
    [["b.com"], ["cdn.net", "img.org"]],
  ]);
  assert.deepEqual(rules[1].condition.excludedTopDomains, ["a.com", "b.com"]);
});

test("a record learned by roots on different proxies is allowed only for the root whose proxy routes it", () => {
  const proxies = { "a.com": { host: "www.a.com", answer: "PROXY p:1" }, "b.com": { host: "www.b.com", answer: "PROXY q:1" } };
  const policy = policyOf({ enabled: true, analysis: TWO, groups: SHARED, proxies }, PSL);
  assert.deepEqual(allowOf(policy, "a.com"), context("a.com", { allow: ["cdn.net"] }));
  assert.deepEqual(allowOf(policy, "b.com"), context("b.com", { allow: ["img.org"] }));
  const rules = buildRules(policy).session.filter(({ id }) => id >= RULE_IDS.hosts);
  assert.equal(rules.some(({ condition }) => (condition.topDomains ?? condition.initiatorDomains)[0] === "b.com" && condition.requestDomains.includes("cdn.net")), false);
});

test("a root whose proxy is not checked yet shares nothing with other roots", () => {
  const proxies = { "a.com": { host: "www.a.com", answer: "PROXY p:1" }, "b.com": { host: "old.b.com", answer: "PROXY p:1" } };
  const policy = policyOf({ enabled: true, analysis: TWO, groups: SHARED, proxies }, PSL);
  assert.deepEqual(allowOf(policy, "b.com"), context("b.com", { allow: ["img.org"] }));
  assert.deepEqual(allowOf(policy, "a.com"), context("a.com", { allow: ["cdn.net"] }));
});

test("a record of another proxy under a root's record is carved out of the root's allowance", () => {
  const groups = {
    "a.com": { rootHost: "a.com", hosts: { "cdn.net": 1 } },
    "b.com": { rootHost: "b.com", hosts: { "x.cdn.net": 1, "ok.y.x.cdn.net": 2 } },
    "c.com": { rootHost: "c.com", hosts: { "y.x.cdn.net": 1 } },
  };
  const proxies = { "a.com": { host: "a.com", answer: "PROXY p:1" }, "b.com": { host: "b.com", answer: "PROXY q:1" }, "c.com": { host: "c.com", answer: "PROXY p:1" } };
  const policy = policyOf({ enabled: true, analysis: { roots: ["a.com", "b.com", "c.com"], deny: [], bypass: [] }, groups, proxies }, PSL);
  assert.deepEqual(allowOf(policy, "a.com"), context("a.com", { allow: ["cdn.net", "y.x.cdn.net"], deny: ["ok.y.x.cdn.net", "x.cdn.net"] }));
  const rules = buildRules(policy).session.filter(({ id, condition }) => id >= RULE_IDS.hosts && condition.topDomains?.[0] === "a.com");
  assert.deepEqual(rules.map(({ condition }) => [condition.requestDomains, condition.excludedRequestDomains]), [
    [["cdn.net"], ["ok.y.x.cdn.net", "x.cdn.net"]],
    [["y.x.cdn.net"], ["ok.y.x.cdn.net"]],
  ]);
});

test("a root covered by an earlier root has no context, and a later root leaves an earlier one's subdomains to it", () => {
  const analysis = { roots: ["x.a.com", "a.com", "y.x.a.com"], deny: [], bypass: [] };
  const groups = { "x.a.com": { rootHost: null, hosts: {} }, "a.com": { rootHost: null, hosts: {} }, "y.x.a.com": { rootHost: null, hosts: {} } };
  const policy = policyOf({ enabled: true, analysis, groups }, PSL);
  assert.deepEqual(policy.contexts.map(({ root, shadows }) => [root, shadows]), [["x.a.com", []], ["a.com", ["x.a.com"]]]);
});

test("exact public suffix records are allowed by an exact regular expression and share the regex budget", () => {
  const groups = { "instagram.com": { rootHost: "www.instagram.com", hosts: { "github.io": 1, "cdn.net": 2 } } };
  const policy = policyOf({ enabled: true, analysis: ANALYSIS, groups }, PSL);
  assert.deepEqual(policy.contexts, [context("instagram.com", { allow: ["cdn.net"], allowExact: ["github.io"] })]);
  const { session } = buildRules(policy);
  assert.deepEqual(session.find((rule) => rule.id === RULE_IDS.hosts + 1).condition, {
    topDomains: ["instagram.com"],
    regexFilter: "^[a-z]+://github\\.io\\.?(?::[0-9]+)?/",
  });
  const other = { ...policy, contexts: [context("instagram.com", { allow: ["cdn.net"] })] };
  assert.deepEqual(intersectPolicies(policy, other).contexts[0].allowExact, []);
  assert.deepEqual(intersectPolicies(policy, other).contexts[0].denyExact, []);
  const full = { ...policy, bypass: Array.from({ length: 999 }, (_, i) => `b${i}.org`) };
  assert.throws(() => buildRules(full), /At most 1000 bypass masks and public suffix hosts/);
});

test("an exact public suffix record of another proxy is blocked for the root by an exact rule above its allowance", () => {
  const groups = { "a.com": { rootHost: "a.com", hosts: { "amazonaws.com": 1 } }, "b.com": { rootHost: "b.com", hosts: { "s3.amazonaws.com": 1 } } };
  const proxies = { "a.com": { host: "a.com", answer: "PROXY p:1" }, "b.com": { host: "b.com", answer: "PROXY q:1" } };
  const policy = policyOf({ enabled: true, analysis: TWO, groups, proxies }, PSL);
  assert.deepEqual(allowOf(policy, "a.com"), context("a.com", { allow: ["amazonaws.com"], denyExact: ["s3.amazonaws.com"] }));
  const block = buildRules(policy).session.find(({ action, condition }) => action.type === "block" && condition.topDomains?.[0] === "a.com");
  assert.equal(block.priority, 3);
  assert.equal(block.condition.regexFilter, "^[a-z]+://s3\\.amazonaws\\.com\\.?(?::[0-9]+)?/");
});

test("learning in one root never renumbers another root's rules", () => {
  const rulesOf = (hosts) => {
    const groups = { "a.com": { rootHost: "a.com", hosts }, "b.com": { rootHost: "b.com", hosts: { "img.org": 1 } } };
    return buildRules(policyOf({ enabled: true, analysis: TWO, groups }, PSL)).session.filter(({ condition }) => (condition.topDomains ?? condition.initiatorDomains)?.[0] === "b.com");
  };
  const many = Object.fromEntries(Array.from({ length: HOSTS_PER_RULE + 1 }, (_, i) => [`h${i}.cdn.net`, 1]));
  assert.deepEqual(rulesOf({}), rulesOf(many));
  assert.deepEqual(rulesOf({}).map(({ id }) => id), [RULE_IDS.hosts + RULES_PER_ROOT, RULE_IDS.hosts + RULES_PER_ROOT + 1]);
});
