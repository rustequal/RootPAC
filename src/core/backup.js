import { analyzeUserPac } from "./analyze.js";

// Schema 2 adds the owner of each site (core/routes.js), schema 3 the hosts of root domains each root's pages requested
// (core/groups.js); older backups are read without them.
export const BACKUP_SCHEMA_VERSION = 3;

const BACKUP_KEYS = {
  1: ["groups", "schemaVersion", "userPac"],
  2: ["groups", "schemaVersion", "sites", "userPac"],
  3: ["groups", "schemaVersion", "sites", "userPac", "uses"],
};
const GROUP_KEYS = ["hosts", "rootHost"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

export function exportBackup({ userPac, groups, sites, uses }) {
  if (userPac === null) throw new Error("No user PAC configured");
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    userPac,
    groups: Object.fromEntries(
      Object.entries(groups).map(([mask, { rootHost, hosts }]) => [mask, { rootHost, hosts: { ...hosts } }]),
    ),
    sites: { ...(sites ?? {}) },
    uses: Object.fromEntries(Object.entries(uses ?? {}).map(([mask, records]) => [mask, { ...records }])),
  };
}

function readUses(uses) {
  if (!isPlainObject(uses)) throw new Error("Backup uses must be an object");
  const next = {};
  for (const [mask, records] of Object.entries(uses)) {
    const valid = isPlainObject(records) && Object.values(records).every((times) => Array.isArray(times) && times.length === 2 && times.every((time) => Number.isSafeInteger(time) && time >= 0));
    if (!valid) throw new Error(`Backup uses of ${JSON.stringify(mask)} must map hosts to [first, last] times`);
    next[mask] = Object.fromEntries(Object.entries(records).map(([host, times]) => [host, [...times]]));
  }
  return next;
}

function readGroup(mask, group) {
  const label = JSON.stringify(mask);
  if (!isPlainObject(group) || !hasExactKeys(group, GROUP_KEYS)) {
    throw new Error(`Backup group ${label} must have exactly rootHost and hosts`);
  }
  if (!isPlainObject(group.hosts)) throw new Error(`Backup group ${label} hosts must be an object`);
  const hosts = {};
  for (const [host, firstSeen] of Object.entries(group.hosts)) {
    if (!Number.isSafeInteger(firstSeen) || firstSeen < 0) {
      throw new Error(`Backup host ${JSON.stringify(host)} has an invalid firstSeen`);
    }
    hosts[host] = firstSeen;
  }
  return { rootHost: group.rootHost, hosts };
}

export function readBackup(backup, psl = null) {
  if (!isPlainObject(backup)) throw new Error("Backup must be an object");
  const keys = Object.hasOwn(BACKUP_KEYS, backup.schemaVersion) ? BACKUP_KEYS[backup.schemaVersion] : null;
  if (keys === null) throw new Error(`Unsupported backup schema version ${JSON.stringify(backup.schemaVersion)}`);
  if (!hasExactKeys(backup, keys)) throw new Error(`Backup must have exactly ${keys.join(", ")}`);
  const sites = backup.schemaVersion === 1 ? null : backup.sites;
  if (sites !== null && !(isPlainObject(sites) && Object.values(sites).every((mask) => typeof mask === "string"))) {
    throw new Error("Backup sites must map sites to roots");
  }
  if (typeof backup.userPac !== "string") throw new Error("Backup userPac must be a string");
  if (!isPlainObject(backup.groups)) throw new Error("Backup groups must be an object");
  const result = analyzeUserPac(backup.userPac, psl);
  if (!result.ok) return { ok: false, errors: result.errors };
  const groups = {};
  for (const [mask, group] of Object.entries(backup.groups)) groups[mask] = readGroup(mask, group);
  const uses = backup.schemaVersion >= 3 ? readUses(backup.uses) : {};
  return { ok: true, userPac: backup.userPac, analysis: { roots: result.roots, deny: result.deny, bypass: result.bypass }, groups, sites: sites === null ? null : { ...sites }, uses };
}
