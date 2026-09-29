import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEMA_VERSION, exportBackup, readBackup } from "../src/core/backup.js";

const USER_PAC = 'function FindProxyForURL(url, host) {\n  return root(host, "a.com") ? "PROXY p:1" : "DIRECT";\n}';
const GROUPS = { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 5 } }, "a.com": { rootHost: null, hosts: {} } };
const SITES = { "a.com": "a.com", "a.net": "a.com" };

test("export copies the User PAC, groups and site owners without session or telemetry state", () => {
  const backup = exportBackup({ userPac: USER_PAC, groups: GROUPS, sites: SITES, seen: { "a.com": { "cdn.a.net": 9 } }, enabled: false, proxies: {} });
  assert.deepEqual(backup, { schemaVersion: BACKUP_SCHEMA_VERSION, userPac: USER_PAC, groups: GROUPS, sites: SITES });
  assert.notEqual(backup.groups["a.com"].hosts, GROUPS["a.com"].hosts);
  assert.throws(() => exportBackup({ userPac: null, groups: {} }), /No user PAC configured/);
});

test("an exported backup reads back to the same state", () => {
  const backup = JSON.parse(JSON.stringify(exportBackup({ userPac: USER_PAC, groups: GROUPS, sites: SITES })));
  assert.deepEqual(readBackup(backup), { ok: true, userPac: USER_PAC, analysis: { roots: ["a.com"], deny: [], bypass: [] }, groups: GROUPS, sites: SITES });
});

test("a schema 3 backup of 1.0.34 reads as schema 2, without its root hosts", () => {
  const read = readBackup({ schemaVersion: 3, userPac: USER_PAC, groups: GROUPS, sites: SITES, uses: { "a.com": { "www.a.com": [1, 2] } } });
  assert.deepEqual(read, { ok: true, userPac: USER_PAC, analysis: { roots: ["a.com"], deny: [], bypass: [] }, groups: GROUPS, sites: SITES });
});

test("a schema 1 backup reads without site owners", () => {
  const read = readBackup({ schemaVersion: 1, userPac: USER_PAC, groups: GROUPS });
  assert.equal(read.sites, null);
  assert.deepEqual(read.groups, GROUPS);
});

test("an invalid User PAC in a backup returns validation errors", () => {
  const result = readBackup({ schemaVersion: 1, userPac: "var root;", groups: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(({ message }) => message), ["Missing top-level function FindProxyForURL", "Identifier root must not be declared"]);
});

test("malformed backups are refused", () => {
  const good = { schemaVersion: 2, userPac: USER_PAC, groups: GROUPS, sites: SITES };
  const cases = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...good, extra: 1 }, /exactly groups, schemaVersion, sites, userPac/],
    [{ userPac: USER_PAC, groups: GROUPS }, /Unsupported backup schema version undefined/],
    [{ ...good, schemaVersion: 4 }, /Unsupported backup schema version 4/],
    [{ ...good, schemaVersion: 3 }, /exactly groups, schemaVersion, sites, userPac, uses/],
    [{ schemaVersion: 1, userPac: USER_PAC, groups: GROUPS, sites: SITES }, /exactly groups, schemaVersion, userPac/],
    [{ ...good, sites: [] }, /sites must map sites to roots/],
    [{ ...good, sites: { "a.net": 1 } }, /sites must map sites to roots/],
    [{ ...good, userPac: 1 }, /userPac must be a string/],
    [{ ...good, groups: [] }, /groups must be an object/],
    [{ ...good, groups: { "a.com": { rootHost: null, hosts: {} }, "a.com": { rootHost: null } } }, /exactly rootHost and hosts/],
    [{ ...good, groups: { "a.com": { rootHost: null, hosts: {} }, "a.com": { rootHost: null, hosts: [], x: 1 } } }, /exactly rootHost and hosts/],
    [{ ...good, groups: { "a.com": { rootHost: null, hosts: {} }, "a.com": { rootHost: null, hosts: null } } }, /hosts must be an object/],
    [{ ...good, groups: { "a.com": { rootHost: null, hosts: {} }, "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": -1 } } } }, /invalid firstSeen/],
    [{ ...good, groups: { "a.com": { rootHost: null, hosts: {} }, "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1.5 } } } }, /invalid firstSeen/],
  ];
  for (const [backup, error] of cases) assert.throws(() => readBackup(backup), error, JSON.stringify(backup));
});
