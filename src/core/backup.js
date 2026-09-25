import { analyzeUserPac } from "./analyze.js";

export const BACKUP_SCHEMA_VERSION = 1;

const BACKUP_KEYS = ["groups", "schemaVersion", "userPac"];
const GROUP_KEYS = ["hosts", "rootHost"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

export function exportBackup({ userPac, groups }) {
  if (userPac === null) throw new Error("No user PAC configured");
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    userPac,
    groups: Object.fromEntries(
      Object.entries(groups).map(([mask, { rootHost, hosts }]) => [mask, { rootHost, hosts: { ...hosts } }]),
    ),
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

export function readBackup(backup) {
  if (!isPlainObject(backup) || !hasExactKeys(backup, BACKUP_KEYS)) {
    throw new Error("Backup must have exactly schemaVersion, userPac and groups");
  }
  if (backup.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version ${JSON.stringify(backup.schemaVersion)}`);
  }
  if (typeof backup.userPac !== "string") throw new Error("Backup userPac must be a string");
  if (!isPlainObject(backup.groups)) throw new Error("Backup groups must be an object");
  const result = analyzeUserPac(backup.userPac);
  if (!result.ok) return { ok: false, errors: result.errors };
  const groups = {};
  for (const [mask, group] of Object.entries(backup.groups)) groups[mask] = readGroup(mask, group);
  return { ok: true, userPac: backup.userPac, analysis: { roots: result.roots, deny: result.deny, bypass: result.bypass }, groups };
}
