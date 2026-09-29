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
      // A root's own domain is never a record of its group; another root's domain is, like any other site.
      if (isLearnableName(host) && rootOf(host, roots) !== mask && !underDeny(host, deny) && firstMatch(host, bypass) === null && !coversBypass(host, bypass)) hosts[host] = firstSeen;
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

// Deepest names first, the depth counted once per name; the order within a depth does not change the result.
function deepestFirst(names) {
  return names
    .map((name) => [labels(name), name])
    .sort(([da, a], [db, b]) => db - da || (a < b ? -1 : a > b ? 1 : 0))
    .map(([, name]) => name);
}

// A candidate stays inside its site (it is at most the registrable domain), so it may cover a root's domain: the
// route is the site's either way. It is a parent of hosts the group holds, so it never lies under the group's own root;
// it may not lie under a deny or bypass mask.
function canAggregate(domain, { deny, bypass }) {
  if (underDeny(domain, deny) || firstMatch(domain, bypass) !== null) return false;
  return ![...deny, ...bypass].some((pattern) => covers(domain, maskDomain(pattern)));
}

function widestOwner(host, owners, psl) {
  let found = owners.has(host) ? host : null;
  for (let name = host; name.includes("."); ) {
    name = parentOf(name);
    if (owners.has(name) && !psl.isPublicSuffix(name)) found = name;
  }
  return found;
}

// Records merge into their nearest common parent, narrowest first: a name takes the branches right under it — records,
// or names that already merged — once there are two or more of them, and a wider name takes merged branches only when
// two of them meet under it. One pass over the names from the deepest up, so the result is linear in the group.
function aggregateGroup(group, seen, analysis, psl) {
  const names = Object.keys(group.hosts);
  const present = new Set(names);
  // Every parent of a top record up to its registrable domain, with the number of branches right under it so far.
  const branches = new Map();
  const domains = new Map();
  for (const host of names) {
    if (!isHostName(host) || widestOwner(host, present, psl) !== host) continue;
    const domain = psl.registrableDomain(host);
    if (domain === null || domain === host) continue;
    for (let name = parentOf(host); ; name = parentOf(name)) {
      if (!branches.has(name)) {
        branches.set(name, 0);
        domains.set(name, domain);
      }
      if (name === domain) break;
    }
    branches.set(parentOf(host), branches.get(parentOf(host)) + 1);
  }
  const accepted = new Set();
  for (const name of deepestFirst([...branches.keys()])) {
    const count = branches.get(name);
    const merged = count >= AGGREGATE_MIN_HOSTS && canAggregate(name, analysis);
    if (merged) accepted.add(name);
    if (name === domains.get(name)) continue;
    // A merged name is one branch of its parent; otherwise its branches stay apart and count there.
    branches.set(parentOf(name), branches.get(parentOf(name)) + (merged ? 1 : count));
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

// What aggregation did between two states of the groups, for the diagnostic log: each record of `after` that took in
// records of `before` — a new wider record, or one that covered records learned beside it — with the names it took in.
// A group left as it was is skipped by identity.
export function aggregatedRecords(before, after) {
  const merges = [];
  for (const [mask, group] of Object.entries(after)) {
    const previous = before[mask];
    if (previous === undefined || previous === group) continue;
    const gone = Object.keys(previous.hosts).filter((host) => !Object.hasOwn(group.hosts, host));
    if (gone.length === 0) continue;
    for (const record of Object.keys(group.hosts)) {
      const hosts = gone.filter((host) => covers(record, host)).sort();
      if (hosts.length > 0) merges.push({ mask, record, hosts });
    }
  }
  return merges;
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
