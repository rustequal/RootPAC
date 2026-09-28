import { hostIndex } from "./groups.js";
import { parentName } from "./hosts.js";

// Which proxy carries a learned record, and which roots may use it.
//
// A PAC sees only the host, never the tab, so a record learned by several roots has one route: the System PAC asks
// the User PAC on behalf of the root that learned the record last, which Route here makes of any root (routeThrough).
// A root whose own proxy is a different one must not reach the record at all, or its pages would go out through
// another root's proxy: that is a proxy conflict.

export const SAME = "same";
export const UNCHECKED = "unchecked";
export const CONFLICT = "conflict";

// The User PAC's answer for each root, from the trial run on its rootHost; a root without one is not checked yet.
export function answersOf({ groups, proxies }) {
  const answers = {};
  if (proxies === null || proxies === undefined) return answers;
  for (const [mask, { rootHost }] of Object.entries(groups)) {
    const known = Object.hasOwn(proxies, mask) ? proxies[mask] : undefined;
    if (rootHost !== null && known?.host === rootHost) answers[mask] = known.answer;
  }
  return answers;
}

// The trial answers worth keeping: the ones for each group's rootHost; null when there is none.
export function proxiesOf(groups, answers) {
  const proxies = {};
  for (const [mask, { rootHost }] of Object.entries(groups)) {
    if (rootHost !== null && Object.hasOwn(answers, rootHost) && typeof answers[rootHost] === "string") proxies[mask] = { host: rootHost, answer: answers[rootHost] };
  }
  return Object.keys(proxies).length === 0 ? null : proxies;
}

// Roots whose rootHost has no checked answer yet.
export function unchecked(state) {
  const answers = answersOf(state);
  return Object.keys(state.groups).filter((mask) => state.groups[mask].rootHost !== null && !Object.hasOwn(answers, mask));
}

// The group that routes a record: the one that learned it last, the first in mask order on a tie. `masks` are the
// groups that hold the record, in mask order.
export function ownerOf(groups, masks, host) {
  let owner = masks[0];
  for (const mask of masks) if (groups[mask].hosts[host] > groups[owner].hosts[host]) owner = mask;
  return owner;
}

// Route here: the root's copy of the record becomes the latest learned, so its proxy carries the record. The groups
// come back unchanged when the root routes the record already.
export function routeThrough(groups, mask, host, now) {
  const holders = Object.keys(groups).filter((name) => Object.hasOwn(groups[name].hosts, host)).sort();
  if (ownerOf(groups, holders, host) === mask) return groups;
  return { ...groups, [mask]: { rootHost: groups[mask].rootHost, hosts: { ...groups[mask].hosts, [host]: now } } };
}

// Every group with only the records it routes: what the System PAC needs. Only a group that holds a record another
// group routes is copied; without shared records the groups come back as they are.
export function routedGroups(groups) {
  const dropped = new Map();
  for (const [host, masks] of hostIndex(groups)) {
    if (masks.length < 2) continue;
    const owner = ownerOf(groups, masks, host);
    for (const mask of masks) {
      if (mask === owner) continue;
      if (!dropped.has(mask)) dropped.set(mask, new Set());
      dropped.get(mask).add(host);
    }
  }
  if (dropped.size === 0) return groups;
  const routed = { ...groups };
  for (const [mask, hosts] of dropped) {
    const { rootHost, hosts: all } = groups[mask];
    routed[mask] = { rootHost, hosts: Object.fromEntries(Object.entries(all).filter(([host]) => !hosts.has(host))) };
  }
  return routed;
}

// Whether a root may use a record routed for `owner`: always its own, another root's only on a proxy known to be the
// same. Until both proxies are checked the record is blocked for the root without being a conflict yet.
export function verdict(mask, owner, answers) {
  if (owner === mask) return SAME;
  if (!Object.hasOwn(answers, mask) || !Object.hasOwn(answers, owner)) return UNCHECKED;
  return answers[mask] === answers[owner] ? SAME : CONFLICT;
}

// Calls visit(mask, host, owner, verdict, exact) for every root and each record that decides the route of a name it
// has learned: its own records and every other group's record under one of them. Public suffix records match their
// exact name only, like in the System PAC, so they neither cover other records nor count as covered for a root that
// does not hold them.
function eachRoute(groups, answers, psl, visit) {
  const index = hostIndex(groups);
  const suffixes = new Set([...index.keys()].filter((host) => psl.isPublicSuffix(host)));
  for (const [host, masks] of index) {
    const holders = new Set(masks);
    for (let name = parentName(host); name !== null; name = parentName(name)) {
      if (index.has(name) && !suffixes.has(name)) for (const mask of index.get(name)) holders.add(mask);
    }
    const owner = ownerOf(groups, masks, host);
    for (const mask of holders) visit(mask, host, owner, verdict(mask, owner, answers), suffixes.has(host));
  }
}

// What each root's DNR rules allow and block.
export function routesOf(groups, answers, psl) {
  const routes = new Map(Object.keys(groups).map((mask) => [mask, { allow: [], deny: [], allowExact: [], denyExact: [] }]));
  eachRoute(groups, answers, psl, (mask, host, owner, result, exact) => {
    const route = routes.get(mask);
    if (result === SAME) (exact ? route.allowExact : route.allow).push(host);
    else (exact ? route.denyExact : route.deny).push(host);
  });
  return routes;
}

// For the viewer: each root's proxy, the records it uses through another root's route, and the roots each record
// it routes is blocked for.
export function sharedRoutes(state, psl) {
  const answers = answersOf(state);
  const roots = Object.fromEntries(Object.keys(state.groups).map((mask) => [mask, { proxy: answers[mask] ?? null, shared: [], blocks: {} }]));
  eachRoute(state.groups, answers, psl, (mask, host, owner, result) => {
    if (owner === mask) return;
    roots[mask].shared.push({ host, owner, verdict: result, ownerProxy: answers[owner] ?? null });
    if (result === CONFLICT) (roots[owner].blocks[host] ??= []).push(mask);
  });
  for (const root of Object.values(roots)) {
    root.shared.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    for (const masks of Object.values(root.blocks)) masks.sort();
  }
  return roots;
}
