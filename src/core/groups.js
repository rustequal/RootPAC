import { firstMatch } from "./glob.js";
import { covers, coversBypass, isHostName, isLearnableName, maskDomain, rootOf, underDeny } from "./hosts.js";

const AGGREGATE_MIN_HOSTS = 2;

export function hostIndex(groups) {
  const index = new Map();
  for (const mask of Object.keys(groups).sort()) {
    for (const host of Object.keys(groups[mask].hosts)) {
      if (!index.has(host)) index.set(host, []);
      index.get(host).push(mask);
    }
  }
  return index;
}

export function reconcileGroups(groups, { roots, deny, bypass }) {
  const next = {};
  for (const mask of roots) {
    const group = Object.hasOwn(groups, mask) ? groups[mask] : null;
    if (group === null) {
      next[mask] = { rootHost: null, hosts: {} };
      continue;
    }
    const hosts = {};
    let dropped = false;
    for (const [host, firstSeen] of Object.entries(group.hosts)) {
      if (isLearnableName(host) && rootOf(host, roots) === null && !underDeny(host, deny) && firstMatch(host, bypass) === null && !coversBypass(host, bypass)) hosts[host] = firstSeen;
      else dropped = true;
    }
    next[mask] = dropped ? { rootHost: group.rootHost, hosts } : group;
  }
  return next;
}

export function adoptLegacyGroups(groups, seen, roots) {
  let nextGroups = groups;
  let nextSeen = seen;
  for (const root of roots) {
    const legacy = `*.${root}`;
    if (!Object.hasOwn(groups, legacy)) continue;
    const { [legacy]: old, ...restGroups } = nextGroups;
    const current = restGroups[root] ?? { rootHost: null, hosts: {} };
    const hosts = { ...old.hosts };
    for (const [host, firstSeen] of Object.entries(current.hosts)) hosts[host] = Math.min(hosts[host] ?? firstSeen, firstSeen);
    nextGroups = { ...restGroups, [root]: { rootHost: current.rootHost ?? old.rootHost, hosts } };
    if (Object.hasOwn(nextSeen, legacy)) {
      const { [legacy]: oldSeen, ...restSeen } = nextSeen;
      const merged = { ...oldSeen };
      for (const [host, time] of Object.entries(restSeen[root] ?? {})) merged[host] = Math.max(merged[host] ?? time, time);
      nextSeen = { ...restSeen, [root]: merged };
    }
  }
  return { groups: nextGroups, seen: nextSeen };
}

export function mergeGroups(groups, batch, now) {
  const added = new Map();
  for (const [host, { mask, rootHost }] of batch) {
    if (!added.has(mask)) added.set(mask, { rootHost, hosts: {} });
    added.get(mask).hosts[host] = now;
  }
  const next = { ...groups };
  for (const [mask, { rootHost, hosts }] of added) {
    const group = groups[mask];
    next[mask] = { rootHost: group.rootHost ?? rootHost, hosts: { ...group.hosts, ...hosts } };
  }
  return next;
}

export function pruneSeen(seen, groups) {
  const next = {};
  for (const [mask, entries] of Object.entries(seen)) {
    if (!Object.hasOwn(groups, mask)) continue;
    const { hosts } = groups[mask];
    const kept = Object.entries(entries).filter(([host]) => Object.hasOwn(hosts, host));
    if (kept.length === 0) continue;
    next[mask] = kept.length === Object.keys(entries).length ? entries : Object.fromEntries(kept);
  }
  return next;
}

export function mergeSeen(seen, observed, now) {
  const added = new Map();
  for (const [host, masks] of observed) {
    for (const mask of masks) {
      if (!added.has(mask)) added.set(mask, {});
      added.get(mask)[host] = now;
    }
  }
  const next = { ...seen };
  for (const [mask, entries] of added) next[mask] = { ...seen[mask], ...entries };
  return next;
}

function parentOf(name) {
  return name.slice(name.indexOf(".") + 1);
}

function labels(name) {
  return name.split(".").length;
}

function byBreadth(a, b) {
  return labels(a) - labels(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function canAggregate(domain, { roots, deny, bypass }) {
  if (rootOf(domain, roots) !== null || underDeny(domain, deny) || firstMatch(domain, bypass) !== null) return false;
  return ![...roots, ...deny, ...bypass].some((pattern) => covers(domain, maskDomain(pattern)));
}

function widestOwner(host, owners, psl) {
  let found = owners.has(host) ? host : null;
  for (let name = host; name.includes("."); ) {
    name = parentOf(name);
    if (owners.has(name) && !psl.isPublicSuffix(name)) found = name;
  }
  return found;
}

function aggregateGroup(group, seen, analysis, psl) {
  const names = Object.keys(group.hosts);
  const present = new Set(names);
  const under = new Map();
  for (const host of names) {
    if (!isHostName(host) || widestOwner(host, present, psl) !== host) continue;
    const domain = psl.registrableDomain(host);
    if (domain === null || domain === host) continue;
    for (let name = parentOf(host); ; name = parentOf(name)) {
      under.set(name, (under.get(name) ?? 0) + 1);
      if (name === domain) break;
    }
  }
  const accepted = new Set();
  for (const domain of [...under.keys()].sort(byBreadth)) {
    if (under.get(domain) < AGGREGATE_MIN_HOSTS || widestOwner(domain, accepted, psl) !== null || !canAggregate(domain, analysis)) continue;
    accepted.add(domain);
  }
  const owners = accepted.size === 0 ? present : new Set([...present, ...accepted]);
  const hosts = {};
  const entries = seen === undefined ? undefined : {};
  let changed = false;
  for (const host of names) {
    const owner = widestOwner(host, owners, psl);
    if (owner !== host) changed = true;
    hosts[owner] = Object.hasOwn(hosts, owner) ? Math.min(hosts[owner], group.hosts[host]) : group.hosts[host];
    if (entries !== undefined && Object.hasOwn(seen, host)) entries[owner] = Object.hasOwn(entries, owner) ? Math.max(entries[owner], seen[host]) : seen[host];
  }
  return changed ? { hosts, entries } : { hosts: group.hosts, entries: seen };
}

export function aggregateGroups(groups, seen, analysis, psl) {
  let nextGroups = groups;
  let nextSeen = seen;
  for (const mask of Object.keys(groups).sort()) {
    const group = groups[mask];
    const { hosts, entries } = aggregateGroup(group, Object.hasOwn(seen, mask) ? seen[mask] : undefined, analysis, psl);
    if (hosts === group.hosts) continue;
    nextGroups = { ...nextGroups, [mask]: { rootHost: group.rootHost, hosts } };
    if (entries !== undefined) nextSeen = { ...nextSeen, [mask]: entries };
  }
  return { groups: nextGroups, seen: nextSeen };
}
