import { maskDomain } from "./hosts.js";

// Which proxy carries a learned host, and which roots may use it.
//
// A PAC sees only the host, never the tab, so a name has one route for the whole browser. The route is decided per
// site (registrable domain): a service sees every host of its site as one user, so a site split between proxies
// would reach it from two IPs. Each site has one owner root, kept in `sites`; every learned host of the site, in any
// group, goes through the owner's proxy. A root owns its own site; a site without a root belongs to the first root
// that learns one of its hosts; Route here hands a site to another root. A root that holds a host of a site owned by
// a root on another proxy may not use it: that is a proxy conflict.

export const SAME = "same";
export const UNCHECKED = "unchecked";
export const CONFLICT = "conflict";
export const UNOWNED = "unowned";

const MAX_SITES = 100_000;
const siteCache = new WeakMap();

// The site of a name: its registrable domain; a public suffix, learned only as an exact record, is a site of its own.
// Every build of the System PAC and the rules asks it for every learned host, so the answers are kept per list.
export function siteOf(name, psl) {
  let cache = siteCache.get(psl);
  if (cache === undefined) {
    cache = new Map();
    siteCache.set(psl, cache);
  }
  let site = cache.get(name);
  if (site === undefined) {
    if (cache.size >= MAX_SITES) cache.clear();
    site = psl.registrableDomain(name) ?? name;
    cache.set(name, site);
  }
  return site;
}

// The host a root's proxy is asked for: the root page it learned from, or its domain before it has one.
export function rootHostOf(mask, groups) {
  return groups[mask]?.rootHost ?? maskDomain(mask);
}

const PROXY_ITEM = /^(?:PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)[ \t]+[^ \t;]+$/i;

// A User PAC answer as the System PAC applies it: the proxy items only; null when none is left.
export function normalizeAnswer(answer) {
  if (typeof answer !== "string") return null;
  const items = answer
    .split(";")
    .map((item) => item.trim())
    .filter((item) => PROXY_ITEM.test(item));
  return items.length === 0 ? null : items.join("; ");
}

// Each root's proxy: the User PAC's own answer for its rootHost (never the System PAC's, which follows the owner of
// the root's site). A root without a current answer is not checked yet.
export function answersOf({ groups, proxies }) {
  const answers = {};
  if (proxies === null || proxies === undefined) return answers;
  for (const mask of Object.keys(groups)) {
    const known = Object.hasOwn(proxies, mask) ? proxies[mask] : undefined;
    if (known?.host === rootHostOf(mask, groups)) answers[mask] = known.answer;
  }
  return answers;
}

// The trial answers worth keeping: the normalized ones for each root's rootHost; null when there is none.
export function proxiesOf(groups, answers) {
  const proxies = {};
  for (const mask of Object.keys(groups)) {
    const host = rootHostOf(mask, groups);
    const answer = Object.hasOwn(answers, host) ? normalizeAnswer(answers[host]) : null;
    if (answer !== null) proxies[mask] = { host, answer };
  }
  return Object.keys(proxies).length === 0 ? null : proxies;
}

// Roots whose proxy is not known for their current rootHost.
export function unchecked(state) {
  const answers = answersOf(state);
  return Object.keys(state.groups).filter((mask) => !Object.hasOwn(answers, mask));
}

function sameRecord(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

// The owners kept: a root's claim on a site it or another group still holds a host of, or on a root's site. Every
// root owns its own site unless it handed it over; a root that was not declared before takes its site back.
export function normalizeSites(sites, groups, roots, psl, previousRoots = roots) {
  const held = new Set();
  for (const { hosts } of Object.values(groups)) for (const host of Object.keys(hosts)) held.add(siteOf(host, psl));
  // One root per site in a valid User PAC; a stored one from an older version may have more, and the first keeps it.
  const rootSites = new Map();
  for (const mask of roots) if (!rootSites.has(siteOf(mask, psl))) rootSites.set(siteOf(mask, psl), mask);
  const next = {};
  for (const [site, mask] of Object.entries(sites ?? {})) {
    if (roots.includes(mask) && (held.has(site) || rootSites.has(site))) next[site] = mask;
  }
  for (const [site, mask] of rootSites) {
    if (!Object.hasOwn(next, site) || !previousRoots.includes(mask)) next[site] = mask;
  }
  return sites !== null && sites !== undefined && sameRecord(sites, next) ? sites : next;
}

// A root removed from the User PAC takes its sites with it: every group forgets the hosts of the sites it owned, and
// whoever needs them again learns them anew, the site going to the first root that does.
export function releaseSites(groups, sites, roots, psl) {
  const released = new Set(Object.entries(sites ?? {}).filter(([, mask]) => !roots.includes(mask)).map(([site]) => site));
  if (released.size === 0) return groups;
  let next = groups;
  for (const [mask, group] of Object.entries(groups)) {
    const kept = Object.entries(group.hosts).filter(([host]) => !released.has(siteOf(host, psl)));
    if (kept.length === Object.keys(group.hosts).length) continue;
    if (next === groups) next = { ...groups };
    next[mask] = { rootHost: group.rootHost, hosts: Object.fromEntries(kept) };
  }
  return next;
}

// Owners for a state that has none yet (an older version or backup): a root owns its site, and any other site goes to
// the group that learned one of its hosts last, the route those versions gave it.
export function bootstrapSites(groups, roots, psl) {
  const sites = {};
  const times = {};
  for (const mask of Object.keys(groups).sort()) {
    for (const [host, time] of Object.entries(groups[mask].hosts)) {
      const site = siteOf(host, psl);
      if (!Object.hasOwn(times, site) || time > times[site]) {
        times[site] = time;
        sites[site] = mask;
      }
    }
  }
  return normalizeSites(sites, groups, roots, psl, []);
}

// The owners of a state; one without owners (older versions, tests) gets them from its groups.
export function sitesOfState({ groups, sites }, roots, psl) {
  return sites === null || sites === undefined ? bootstrapSites(groups, roots, psl) : sites;
}

// New sites a batch of learned hosts brings: each goes to the root that learned it, the first one on a tie.
export function claimSites(sites, learned, psl) {
  let next = sites;
  for (const [host, mask] of learned) {
    const site = siteOf(host, psl);
    if (Object.hasOwn(next, site)) continue;
    if (next === sites) next = { ...sites };
    next[site] = mask;
  }
  return next;
}

// Route here: the root takes the sites of these names. Nothing changes for a site it owns already.
export function routeSites(sites, mask, names, psl) {
  let next = sites;
  for (const name of names) {
    const site = siteOf(name, psl);
    if (next[site] === mask) continue;
    if (next === sites) next = { ...sites };
    next[site] = mask;
  }
  return next;
}

// Whether a root may use a name of a site `owner` routes: always its own, another root's only on a proxy known to be
// the same. A site without an owner, or a proxy not checked yet, keeps the name blocked without a conflict.
export function verdict(mask, owner, answers) {
  if (owner === undefined || owner === null) return UNOWNED;
  if (owner === mask) return SAME;
  if (!Object.hasOwn(answers, mask) || !Object.hasOwn(answers, owner)) return UNCHECKED;
  return answers[mask] === answers[owner] ? SAME : CONFLICT;
}

// The owner of the site of a name, or undefined.
export function ownerOf(sites, name, psl) {
  const site = siteOf(name, psl);
  return Object.hasOwn(sites, site) ? sites[site] : undefined;
}

// What each root's DNR rules allow: its learned hosts and the domains of roots whose site goes through the same proxy,
// its own included. Everything a record covers is of the record's site, so a record is allowed or blocked whole.
export function routesOf({ groups, sites }, roots, answers, psl) {
  const routes = new Map();
  for (const mask of Object.keys(groups)) {
    const allow = [];
    const allowExact = [];
    for (const host of Object.keys(groups[mask].hosts)) {
      if (verdict(mask, ownerOf(sites, host, psl), answers) !== SAME) continue;
      (psl.isPublicSuffix(host) ? allowExact : allow).push(host);
    }
    for (const root of roots) {
      if (verdict(mask, ownerOf(sites, root, psl), answers) === SAME) allow.push(root);
    }
    routes.set(mask, { allow, allowExact });
  }
  return routes;
}

// Roots whose own site was handed to a root on another proxy: their pages, the top frame included, are blocked. A root
// that shares its site with an earlier root (a stored User PAC from an older version) is left to that root's rules.
export function handedRoots({ groups, sites }, roots, answers, psl) {
  return roots.filter((mask) => {
    if (!Object.hasOwn(groups, mask)) return false;
    const owner = ownerOf(sites, mask, psl);
    return verdict(mask, owner, answers) !== SAME && siteOf(owner, psl) !== siteOf(mask, psl);
  });
}

// The System PAC's groups: each carries the learned hosts of the sites it owns, whoever learned them, and the domains
// of roots that handed their site to it. A host of a site without an owner has no route. `pacRoots` are the roots that
// still route their own site.
export function routedGroups(groups, sites, roots, psl) {
  const pacRoots = roots.filter((mask) => ownerOf(sites, mask, psl) === mask);
  const routed = {};
  for (const mask of Object.keys(groups)) routed[mask] = { rootHost: rootHostOf(mask, groups), hosts: {} };
  for (const { hosts } of Object.values(groups)) {
    for (const host of Object.keys(hosts)) {
      const owner = ownerOf(sites, host, psl);
      if (owner === undefined || !Object.hasOwn(routed, owner)) continue;
      routed[owner].hosts[host] = 1;
    }
  }
  for (const mask of roots) {
    const owner = ownerOf(sites, mask, psl);
    if (owner !== mask && owner !== undefined && Object.hasOwn(routed, owner)) routed[owner].hosts[maskDomain(mask)] = 1;
  }
  return { routed, pacRoots };
}

// For the viewer: each root's proxy, the site, owner and verdict of its own domain and of every host it holds — learned,
// or of a root's domain its pages requested (`uses`) — the domains of roots that handed their site to it, and for the
// sites it owns, the roots a proxy conflict blocks. A root's domain is never learned, but it is a site of the root that
// routes it like any learned one.
export function sharedRoutes(state, psl) {
  const answers = answersOf(state);
  const { groups } = state;
  const sites = sitesOfState(state, Object.keys(groups), psl);
  const roots = Object.fromEntries(
    Object.keys(groups).map((mask) => [mask, { proxy: answers[mask] ?? null, root: null, records: {}, taken: {}, blocks: {} }]),
  );
  const routeOf = (mask, name) => {
    const owner = ownerOf(sites, name, psl);
    return { site: siteOf(name, psl), owner: owner ?? null, verdict: verdict(mask, owner, answers), ownerProxy: owner === undefined ? null : (answers[owner] ?? null) };
  };
  const block = (owner, site, mask) => {
    if (!Object.hasOwn(roots, owner)) return;
    const blocked = (roots[owner].blocks[site] ??= []);
    if (!blocked.includes(mask)) blocked.push(mask);
  };
  for (const mask of Object.keys(groups)) {
    roots[mask].root = routeOf(mask, mask);
    for (const host of [...Object.keys(groups[mask].hosts), ...Object.keys(state.uses?.[mask] ?? {})]) {
      const route = routeOf(mask, host);
      roots[mask].records[host] = route;
      if (route.verdict === CONFLICT) block(route.owner, route.site, mask);
    }
  }
  for (const mask of Object.keys(groups)) {
    const { owner, site, verdict: rootVerdict } = roots[mask].root;
    if (owner === null || owner === mask || !Object.hasOwn(roots, owner)) continue;
    roots[owner].taken[mask] = routeOf(owner, mask);
    if (rootVerdict === CONFLICT) block(owner, site, mask);
  }
  for (const root of Object.values(roots)) for (const masks of Object.values(root.blocks)) masks.sort();
  return roots;
}
