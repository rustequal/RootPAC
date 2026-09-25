import { maskDomain, ownerHost } from "./hosts.js";
import { hostRegex } from "./names.js";

export const RULE_IDS = Object.freeze({ block: 1, deny: 2, frame: 3, unlock: 4, reports: 5, reportsFrame: 6, embeds: 7, rootRequests: 8, roots: 1000, bypass: 3000, exact: 4000, hosts: 100000 });
export const HOSTS_PER_RULE = 1000;
export const MAX_REGEX_RULES = 1000;

const PRIORITY = Object.freeze({ block: 1, allow: 2, deny: 3, strip: 3 });
const REPORT_HEADERS = Object.freeze(["nel", "report-to", "reporting-endpoints"]);
const MAIN_FRAME = Object.freeze(["main_frame"]);

export function policyOf({ enabled, analysis, groups }, psl) {
  if (typeof psl?.isPublicSuffix !== "function") throw new TypeError("Policy needs the public suffix list");
  if (!enabled || analysis === null) return null;
  const learned = [...new Set(Object.values(groups).flatMap(({ hosts }) => Object.keys(hosts)))];
  return {
    blockRoots: [...analysis.roots],
    allowRoots: [...analysis.roots],
    deny: [...analysis.deny],
    bypass: [...analysis.bypass],
    hosts: learned.filter((host) => !psl.isPublicSuffix(host)),
    exact: learned.filter((host) => psl.isPublicSuffix(host)),
  };
}

function union(a, b) {
  return [...new Set([...a, ...b])];
}

function intersection(a, b) {
  const other = new Set(b);
  return a.filter((item) => other.has(item));
}

export function closedPolicy(policy) {
  if (policy === null) return null;
  const { blockRoots, deny } = policy;
  return { blockRoots, allowRoots: [], deny, bypass: [], hosts: [], exact: [] };
}

function coveredBy(policy) {
  const index = new Set(policy.hosts);
  return (host) => ownerHost(host, index) !== null;
}

function allowedBy(policy) {
  const covered = coveredBy(policy);
  const exact = new Set(policy.exact);
  return (host) => exact.has(host) || covered(host);
}

export function intersectPolicies(a, b) {
  if (a === null || b === null) return closedPolicy(a ?? b);
  return {
    blockRoots: union(a.blockRoots, b.blockRoots),
    allowRoots: intersection(a.allowRoots, b.allowRoots),
    deny: union(a.deny, b.deny),
    bypass: intersection(a.bypass, b.bypass),
    hosts: union(a.hosts.filter(coveredBy(b)), b.hosts.filter(coveredBy(a))),
    exact: union(a.exact.filter(allowedBy(b)), b.exact.filter(allowedBy(a))),
  };
}

export function maskRegex(mask) {
  return hostRegex(maskDomain(mask), mask.startsWith("*."));
}

function sorted(items) {
  return [...new Set(items)].sort();
}

export function buildRules(policy) {
  const rules = { dynamic: [], session: [] };
  if (policy === null) return rules;
  const topDomains = sorted(policy.blockRoots.map(maskDomain));
  if (topDomains.length === 0) return rules;
  const allowRoots = sorted(policy.allowRoots);
  const bypass = sorted(policy.bypass);
  const exact = sorted(policy.exact);
  if (bypass.length + exact.length > MAX_REGEX_RULES) throw new Error(`At most ${MAX_REGEX_RULES} bypass masks and public suffix hosts are supported together`);
  const allow = (id, condition) => ({ id, priority: PRIORITY.allow, action: { type: "allow" }, condition });
  rules.dynamic.push({
    id: RULE_IDS.block,
    priority: PRIORITY.block,
    action: { type: "block" },
    condition: { topDomains, excludedResourceTypes: [...MAIN_FRAME] },
  });
  const deny = sorted(policy.deny.map(maskDomain));
  if (deny.length > 0) {
    rules.dynamic.push({
      id: RULE_IDS.deny,
      priority: PRIORITY.deny,
      action: { type: "block" },
      condition: { topDomains, requestDomains: deny, excludedResourceTypes: [...MAIN_FRAME] },
    });
  }
  rules.dynamic.push({
    id: RULE_IDS.frame,
    priority: PRIORITY.block,
    action: { type: "block" },
    condition: { requestDomains: topDomains, resourceTypes: [...MAIN_FRAME] },
  });
  rules.dynamic.push({
    id: RULE_IDS.rootRequests,
    priority: PRIORITY.block,
    action: { type: "block" },
    condition: { requestDomains: topDomains },
  });
  rules.dynamic.push({
    id: RULE_IDS.embeds,
    priority: PRIORITY.block,
    action: { type: "block" },
    condition: { initiatorDomains: topDomains, excludedResourceTypes: [...MAIN_FRAME] },
  });
  const strip = { type: "modifyHeaders", responseHeaders: REPORT_HEADERS.map((header) => ({ header, operation: "remove" })) };
  rules.dynamic.push(
    { id: RULE_IDS.reports, priority: PRIORITY.strip, action: strip, condition: { topDomains, excludedResourceTypes: [...MAIN_FRAME] } },
    { id: RULE_IDS.reportsFrame, priority: PRIORITY.strip, action: strip, condition: { requestDomains: topDomains, resourceTypes: [...MAIN_FRAME] } },
  );
  if (allowRoots.length > 0) {
    rules.session.push(allow(RULE_IDS.unlock, { requestDomains: allowRoots, resourceTypes: [...MAIN_FRAME] }));
    rules.session.push(allow(RULE_IDS.roots, { requestDomains: allowRoots }));
  }
  bypass.forEach((mask, index) => rules.session.push(allow(RULE_IDS.bypass + index, { regexFilter: maskRegex(mask) })));
  exact.forEach((host, index) => rules.session.push(allow(RULE_IDS.exact + index, { regexFilter: hostRegex(host, false) })));
  const hosts = sorted(policy.hosts);
  for (let start = 0; start < hosts.length; start += HOSTS_PER_RULE) {
    rules.session.push(allow(RULE_IDS.hosts + start / HOSTS_PER_RULE, { requestDomains: hosts.slice(start, start + HOSTS_PER_RULE) }));
  }
  return rules;
}
