import { hostIndex } from "./groups.js";
import { parentName } from "./hosts.js";

// Which proxy carries a learned record, and which roots may use it.
//
// A PAC sees only the host, never the tab, so a record learned by several roots has one route: the System PAC asks
// the User PAC on behalf of the record's first group in mask order. A root whose own proxy is a different one must
// not reach the record at all, or its pages would go out through another root's proxy: that is a proxy conflict.

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

// Whether a root may use a record routed for `owner`: always its own, another root's only on a proxy known to be the
// same. Until both proxies are checked the record is blocked for the root without being a conflict yet.
export function verdict(mask, owner, answers) {
  if (owner === mask) return SAME;
  if (!Object.hasOwn(answers, mask) || !Object.hasOwn(answers, owner)) return UNCHECKED;
  return answers[mask] === answers[owner] ? SAME : CONFLICT;
}

// For every root, each record that decides the route of a name it has learned, allowed or blocked: its own records
// and every other group's record under one of them. Public suffix records match their exact name only, like in the
// System PAC, so they neither cover other records nor count as covered for a root that does not hold them.
export function routesOf(groups, answers, psl) {
  const index = hostIndex(groups);
  const suffixes = new Set([...index.keys()].filter((host) => psl.isPublicSuffix(host)));
  const routes = new Map(Object.keys(groups).map((mask) => [mask, { allow: [], deny: [], allowExact: [], denyExact: [] }]));
  for (const [host, masks] of index) {
    const holders = new Set(masks);
    for (let name = parentName(host); name !== null; name = parentName(name)) {
      if (index.has(name) && !suffixes.has(name)) for (const mask of index.get(name)) holders.add(mask);
    }
    const exact = suffixes.has(host);
    // The System PAC indexes the groups in mask order and keeps the first group for each record.
    const owner = masks[0];
    for (const mask of holders) {
      const route = routes.get(mask);
      if (verdict(mask, owner, answers) === SAME) (exact ? route.allowExact : route.allow).push(host);
      else (exact ? route.denyExact : route.deny).push(host);
    }
  }
  return routes;
}
