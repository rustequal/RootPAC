import { analyzeUserPac } from "./analyze.js";

// Schema 2 adds the owner of each site (core/routes.js); schema 1 backups are read without owners. Schema 3 (1.0.34)
// also carried the root hosts a root's pages requested, which are learned records now: it reads as schema 2.
export const BACKUP_SCHEMA_VERSION = 2;

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

export function exportBackup({ userPac, groups, sites }) {
  if (userPac === null) throw new Error("No user PAC configured");
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    userPac,
    groups: Object.fromEntries(
      Object.entries(groups).map(([mask, { rootHost, hosts }]) => [mask, { rootHost, hosts: { ...hosts } }]),
    ),
    sites: { ...(sites ?? {}) },
  };
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
  return { ok: true, userPac: backup.userPac, analysis: { roots: result.roots, deny: result.deny, bypass: result.bypass }, groups, sites: sites === null ? null : { ...sites } };
}
