import { covers, maskDomain, parentName } from "./hosts.js";
import { bootstrapSites, routedGroups } from "./routes.js";

// The System PAC sends a name to a root's proxy by a route: the root's own domain, or a record in the group of the
// owner of its site (core/routes.js). `kind` 1 covers the name and its subdomains, 2 the name alone (an exact record,
// rule 9 of section 3). A held route (4.11) is a route a newer PAC dropped while requests may still be on their way to it.
export const COVERING = 1;
export const EXACT = 2;

export function pacRoutes({ userPac, analysis, groups, sites, held }, psl) {
  if (userPac === null || analysis === null) return [];
  const { routed, pacRoots } = routedGroups(groups, sites ?? bootstrapSites(groups, analysis.roots, psl), analysis.roots, psl);
  const routes = pacRoots.map((mask) => ({ mask, name: maskDomain(mask), kind: COVERING }));
  for (const [mask, { hosts }] of Object.entries(routed)) {
    for (const name of Object.keys(hosts)) routes.push({ mask, name, kind: psl.isPublicSuffix(name) ? EXACT : COVERING });
  }
  return [...routes, ...heldRoutes(held)];
}

export function heldRoutes(held) {
  return Object.entries(held ?? {}).flatMap(([mask, names]) => Object.entries(names).map(([name, kind]) => ({ mask, name, kind })));
}

// Routes as the log shows them: the name and the root whose proxy they go through; an entry lists at most `LISTED`
// of them and counts the rest, so a narrowing of thousands of records does not bloat the log.
export const LISTED = 20;

export function loggedRoutes(routes) {
  return routes.map(({ mask, name, kind }) => (kind === EXACT ? { name, root: mask, exact: true } : { name, root: mask }));
}

export function heldOf(routes) {
  if (routes.length === 0) return null;
  const held = {};
  for (const { mask, name, kind } of routes) {
    held[mask] ??= {};
    held[mask][name] = Math.min(held[mask][name] ?? EXACT, kind);
  }
  return held;
}

export function sameHeld(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(held) {
  if (held === null || held === undefined) return null;
  return Object.keys(held).sort().map((mask) => [mask, Object.keys(held[mask]).sort().map((name) => [name, held[mask][name]])]);
}

export function routeCovers({ name, kind }, host) {
  return kind === EXACT ? host === name : covers(name, host);
}

// The routes of the PAC in force that the next state no longer sends to a proxy. A name the next PAC still sends to
// some root's proxy, by a root, a covering record above it or the same record, is not dropped: its route may change
// proxy, never to the User PAC. The routes of a root the next User PAC no longer declares go with the root.
export function droppedRoutes(routes, next, psl) {
  const roots = new Set(next.analysis?.roots ?? []);
  const widest = new Map();
  for (const { name, kind } of pacRoutes({ ...next, held: null }, psl)) widest.set(name, Math.min(widest.get(name) ?? EXACT, kind));
  const kept = ({ name, kind }) => {
    const own = widest.get(name);
    if (own === COVERING || (own === EXACT && kind === EXACT)) return true;
    for (let parent = parentName(name); parent !== null; parent = parentName(parent)) {
      if (widest.get(parent) === COVERING) return true;
    }
    return false;
  };
  return heldRoutes(heldOf(routes.filter((route) => roots.has(route.mask) && !kept(route))));
}
