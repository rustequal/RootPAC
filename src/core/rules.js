import { covers, maskDomain, parentName } from "./hosts.js";
import { hostRegex } from "./names.js";
import { answersOf, routesOf } from "./routes.js";

export const RULE_IDS = Object.freeze({ block: 1, deny: 2, frame: 3, unlock: 4, reports: 5, reportsFrame: 6, embeds: 7, rootRequests: 8, roots: 1000, bypass: 3000, hosts: 100000 });
export const HOSTS_PER_RULE = 1000;
// Each root's rules take ids from a range of their own, so learning in one root never renumbers another root's rules.
export const RULES_PER_ROOT = 10000;
export const MAX_REGEX_RULES = 1000;

const PRIORITY = Object.freeze({ block: 1, allow: 2, deny: 3, strip: 3, conflict: 3 });
const REPORT_HEADERS = Object.freeze(["nel", "report-to", "reporting-endpoints"]);
const MAIN_FRAME = Object.freeze(["main_frame"]);

function sorted(items) {
  return [...new Set(items)].sort();
}

// Where a root's context is: its pages, and frames and workers of its own origin anywhere. Like root() in the User
// PAC, the first listed root that covers a host takes it: a root covered by an earlier one gets nothing, and a root
// that covers an earlier one leaves that root's subdomains to it.
function contextOf(mask, roots) {
  const domain = maskDomain(mask);
  const earlier = roots.slice(0, roots.indexOf(mask)).map(maskDomain);
  if (earlier.some((other) => covers(other, domain))) return null;
  return { root: mask, domain, shadows: earlier.filter((other) => covers(domain, other)).sort() };
}

export function policyOf({ enabled, analysis, groups, proxies }, psl) {
  if (typeof psl?.isPublicSuffix !== "function") throw new TypeError("Policy needs the public suffix list");
  if (!enabled || analysis === null) return null;
  const routes = routesOf(groups, answersOf({ groups, proxies }), psl);
  const contexts = [];
  for (const mask of analysis.roots) {
    const context = contextOf(mask, analysis.roots);
    const route = routes.get(mask);
    if (context === null || route === undefined) continue;
    contexts.push({ ...context, ...carve(route) });
  }
  return {
    blockRoots: [...analysis.roots],
    allowRoots: [...analysis.roots],
    deny: [...analysis.deny],
    bypass: [...analysis.bypass],
    contexts,
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
  return { blockRoots, allowRoots: [], deny, bypass: [], contexts: [] };
}

// Whether a record of the set covers the name, the name itself aside.
function under(name, set) {
  for (let suffix = parentName(name); suffix !== null; suffix = parentName(suffix)) {
    if (set.has(suffix)) return true;
  }
  return false;
}

// A blocked record matters only under an allowed one: anything else is blocked already.
function carve({ allow, deny, allowExact, denyExact }) {
  const allowed = new Set(allow);
  const inside = (host) => under(host, allowed);
  return { allow: sorted(allow), deny: sorted(deny.filter(inside)), allowExact: sorted(allowExact), denyExact: sorted(denyExact.filter(inside)) };
}

// Whether a context lets a name through: an exact public suffix record first, then the most specific record.
function decider({ allow, deny, allowExact, denyExact }) {
  const allowed = new Set(allow);
  const denied = new Set(deny);
  const exactAllowed = new Set(allowExact);
  const exactDenied = new Set(denyExact);
  return (name) => {
    if (exactAllowed.has(name)) return true;
    if (exactDenied.has(name)) return false;
    for (let suffix = name; suffix !== null; suffix = parentName(suffix)) {
      if (allowed.has(suffix)) return true;
      if (denied.has(suffix)) return false;
    }
    return false;
  };
}

const sameScope = (a, b) => a.domain === b.domain && JSON.stringify(a.shadows) === JSON.stringify(b.shadows);

// A name passes only where both contexts let it pass. Every record of either side decides the names under it, down
// to the next record of either side, so judging each record by both sides is exact.
function intersectContexts(a, b) {
  const inA = decider(a);
  const inB = decider(b);
  const split = (names) => {
    const both = names.filter((name) => inA(name) && inB(name));
    const pass = new Set(both);
    return [sorted(both), sorted(names.filter((name) => !pass.has(name)))];
  };
  const [allow, deny] = split(union([...a.allow, ...a.deny], [...b.allow, ...b.deny]));
  const [allowExact, denyExact] = split(union([...a.allowExact, ...a.denyExact], [...b.allowExact, ...b.denyExact]));
  return { root: a.root, domain: a.domain, shadows: a.shadows, ...carve({ allow, deny, allowExact, denyExact }) };
}

export function intersectPolicies(a, b) {
  if (a === null || b === null) return closedPolicy(a ?? b);
  const contexts = [];
  for (const context of a.contexts) {
    const other = b.contexts.find((item) => item.root === context.root);
    if (other !== undefined && sameScope(context, other)) contexts.push(intersectContexts(context, other));
  }
  return {
    blockRoots: union(a.blockRoots, b.blockRoots),
    allowRoots: intersection(a.allowRoots, b.allowRoots),
    deny: union(a.deny, b.deny),
    bypass: intersection(a.bypass, b.bypass),
    contexts,
  };
}

export function maskRegex(mask) {
  return hostRegex(maskDomain(mask), mask.startsWith("*."));
}

export function buildRules(policy) {
  const rules = { dynamic: [], session: [] };
  if (policy === null) return rules;
  const topDomains = sorted(policy.blockRoots.map(maskDomain));
  if (topDomains.length === 0) return rules;
  const allowRoots = sorted(policy.allowRoots);
  const bypass = sorted(policy.bypass);
  const exactRules = policy.contexts.reduce((sum, { allowExact, denyExact }) => sum + 2 * (allowExact.length + denyExact.length), 0);
  if (bypass.length + exactRules > MAX_REGEX_RULES) throw new Error(`At most ${MAX_REGEX_RULES} bypass masks and public suffix hosts per root are supported together`);
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
  policy.contexts.forEach((context, position) => {
    let id = RULE_IDS.hosts + position * RULES_PER_ROOT;
    const conditions = hostConditions(context);
    if (2 * (conditions.length + context.allowExact.length + context.denyExact.length) > RULES_PER_ROOT) throw new Error(`Root ${JSON.stringify(context.root)} needs more than ${RULES_PER_ROOT} rules`);
    for (const scope of scopesOf(context, topDomains)) {
      for (const condition of conditions) rules.session.push(allow(id++, { ...scope, ...condition }));
      for (const host of context.allowExact) rules.session.push(allow(id++, { ...scope, regexFilter: hostRegex(host, false) }));
      for (const host of context.denyExact) {
        rules.session.push({ id: id++, priority: PRIORITY.conflict, action: { type: "block" }, condition: { ...scope, regexFilter: hostRegex(host, false) } });
      }
    }
  });
  return rules;
}

// A request belongs to the root of its page, and outside root pages to the root of the frame or worker that made it;
// the learner attributes it the same way.
function scopesOf({ domain, shadows }, roots) {
  const shadowed = (key) => (shadows.length === 0 ? {} : { [key]: [...shadows] });
  return [
    { topDomains: [domain], ...shadowed("excludedTopDomains") },
    { initiatorDomains: [domain], ...shadowed("excludedInitiatorDomains"), excludedTopDomains: [...roots] },
  ];
}

// The records a root may use, each without the records under it that another root's proxy carries. A record under
// such an exclusion gets a rule of its own, since an exclusion covers every name under it.
function hostConditions({ allow, deny }) {
  const denied = new Set(deny);
  const condition = (hosts) => {
    const inside = new Set(hosts);
    const except = deny.filter((host) => under(host, inside));
    return except.length === 0 ? { requestDomains: hosts } : { requestDomains: hosts, excludedRequestDomains: except };
  };
  const top = allow.filter((host) => !under(host, denied));
  const conditions = [];
  for (let start = 0; start < top.length; start += HOSTS_PER_RULE) conditions.push(condition(top.slice(start, start + HOSTS_PER_RULE)));
  for (const host of allow) if (under(host, denied)) conditions.push(condition([host]));
  return conditions;
}
