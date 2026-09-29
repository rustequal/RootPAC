import { covers, maskDomain, parentName } from "./hosts.js";
import { hostRegex } from "./names.js";
import { answersOf, handedRoots, routesOf, sitesOfState } from "./routes.js";

export const RULE_IDS = Object.freeze({ block: 1, deny: 2, frame: 3, unlock: 4, reports: 5, reportsFrame: 6, embeds: 7, rootRequests: 8, handed: 9, roots: 1000, bypass: 3000, hosts: 100000 });
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

// Where a root's context is: its pages, and frames and workers of its own origin anywhere. Roots never overlap in a
// valid User PAC; a stored one from an older version may, and then, like root() in the User PAC, the first listed root
// that covers a host takes it: a root covered by an earlier one gets nothing, and a root that covers an earlier one
// leaves that root's subdomains to it.
function contextOf(mask, roots) {
  const domain = maskDomain(mask);
  const earlier = roots.slice(0, roots.indexOf(mask)).map(maskDomain);
  if (earlier.some((other) => covers(other, domain))) return null;
  return { root: mask, domain, shadows: earlier.filter((other) => covers(domain, other)).sort() };
}

export function policyOf({ enabled, analysis, groups, proxies, sites }, psl) {
  if (typeof psl?.isPublicSuffix !== "function") throw new TypeError("Policy needs the public suffix list");
  if (!enabled || analysis === null) return null;
  const answers = answersOf({ groups, proxies });
  const owned = { groups, sites: sitesOfState({ groups, sites }, analysis.roots, psl) };
  const routes = routesOf(owned, analysis.roots, answers, psl);
  const contexts = [];
  for (const mask of analysis.roots) {
    const context = contextOf(mask, analysis.roots);
    const route = routes.get(mask);
    if (context === null || route === undefined) continue;
    contexts.push({ ...context, allow: sorted(route.allow), allowExact: sorted(route.allowExact) });
  }
  return {
    blockRoots: [...analysis.roots],
    allowRoots: [...analysis.roots],
    handed: sorted(handedRoots(owned, analysis.roots, answers, psl)),
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
  const { blockRoots, handed, deny } = policy;
  return { blockRoots, allowRoots: [], handed, deny, bypass: [], contexts: [] };
}

// Whether a record of the set covers the name, the name itself included.
function coveredBy(name, set) {
  for (let suffix = name; suffix !== null; suffix = parentName(suffix)) {
    if (set.has(suffix)) return true;
  }
  return false;
}

const sameScope = (a, b) => a.domain === b.domain && JSON.stringify(a.shadows) === JSON.stringify(b.shadows);

// A name passes only where both contexts let it pass: a record stays if the other side covers it, so widening a.x.com
// and b.x.com into x.com keeps both allowed; an exact record only if the other side allows the same name.
function intersectContexts(a, b) {
  const inA = new Set(a.allow);
  const inB = new Set(b.allow);
  const allow = union(
    a.allow.filter((name) => coveredBy(name, inB)),
    b.allow.filter((name) => coveredBy(name, inA)),
  );
  const exactA = new Set(a.allowExact);
  const allowExact = b.allowExact.filter((name) => exactA.has(name));
  return { root: a.root, domain: a.domain, shadows: a.shadows, allow: sorted(allow), allowExact: sorted(allowExact) };
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
    handed: sorted(union(a.handed, b.handed)),
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
  const exactRules = policy.contexts.reduce((sum, { allowExact }) => sum + 2 * allowExact.length, 0);
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
  // A root whose site another root on a different proxy routes is closed, its pages included (core/routes.js).
  const handed = sorted(policy.handed.map(maskDomain));
  if (handed.length > 0) {
    rules.dynamic.push({
      id: RULE_IDS.handed,
      priority: PRIORITY.conflict,
      action: { type: "block" },
      condition: { requestDomains: handed, resourceTypes: [...MAIN_FRAME] },
    });
  }
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
    // Outside root contexts only: inside, each root allows the roots on its own proxy (its context rules below).
    rules.session.push(allow(RULE_IDS.roots, { requestDomains: allowRoots, excludedTopDomains: topDomains, excludedInitiatorDomains: topDomains }));
  }
  bypass.forEach((mask, index) => rules.session.push(allow(RULE_IDS.bypass + index, { regexFilter: maskRegex(mask) })));
  policy.contexts.forEach((context, position) => {
    let id = RULE_IDS.hosts + position * RULES_PER_ROOT;
    const conditions = hostConditions(context);
    if (2 * (conditions.length + context.allowExact.length) > RULES_PER_ROOT) throw new Error(`Root ${JSON.stringify(context.root)} needs more than ${RULES_PER_ROOT} rules`);
    for (const scope of scopesOf(context, topDomains)) {
      for (const condition of conditions) rules.session.push(allow(id++, { ...scope, ...condition }));
      for (const host of context.allowExact) rules.session.push(allow(id++, { ...scope, regexFilter: hostRegex(host, false) }));
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

// The records a root may use, a thousand to a rule.
function hostConditions({ allow }) {
  const conditions = [];
  for (let start = 0; start < allow.length; start += HOSTS_PER_RULE) conditions.push({ requestDomains: allow.slice(start, start + HOSTS_PER_RULE) });
  return conditions;
}
