import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEMA_VERSION, exportBackup, readBackup } from "../src/core/backup.js";

const USER_PAC = 'function FindProxyForURL(url, host) {\n  return root(host, "a.com") ? "PROXY p:1" : "DIRECT";\n}';
const GROUPS = { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 5 } }, "a.com": { rootHost: null, hosts: {} } };
const SITES = { "a.com": "a.com", "a.net": "a.com" };
const USES = { "a.com": { "www.a.com": [3, 7] } };

test("export copies the User PAC, groups, site owners and root hosts without session or telemetry state", () => {
  const backup = exportBackup({ userPac: USER_PAC, groups: GROUPS, sites: SITES, uses: USES, seen: { "a.com": { "cdn.a.net": 9 } }, enabled: false, proxies: {} });
  assert.deepEqual(backup, { schemaVersion: BACKUP_SCHEMA_VERSION, userPac: USER_PAC, groups: GROUPS, sites: SITES, uses: USES });
  assert.notEqual(backup.groups["a.com"].hosts, GROUPS["a.com"].hosts);
  assert.notEqual(backup.uses["a.com"], USES["a.com"]);
  assert.deepEqual(exportBackup({ userPac: USER_PAC, groups: GROUPS, sites: SITES }).uses, {});
  assert.throws(() => exportBackup({ userPac: null, groups: {} }), /No user PAC configured/);
});

test("an exported backup reads back to the same state", () => {
  const backup = JSON.parse(JSON.stringify(exportBackup({ userPac: USER_PAC, groups: GROUPS, sites: SITES, uses: USES })));
  assert.deepEqual(readBackup(backup), { ok: true, userPac: USER_PAC, analysis: { roots: ["a.com"], deny: [], bypass: [] }, groups: GROUPS, sites: SITES, uses: USES });
  assert.deepEqual(readBackup({ schemaVersion: 2, userPac: USER_PAC, groups: GROUPS, sites: SITES }).uses, {});
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
  const good = { schemaVersion: 3, userPac: USER_PAC, groups: GROUPS, sites: SITES, uses: USES };
  const cases = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...good, extra: 1 }, /exactly groups, schemaVersion, sites, userPac, uses/],
    [{ userPac: USER_PAC, groups: GROUPS }, /Unsupported backup schema version undefined/],
    [{ ...good, schemaVersion: 4 }, /Unsupported backup schema version 4/],
    [{ schemaVersion: 2, userPac: USER_PAC, groups: GROUPS, sites: SITES, uses: USES }, /exactly groups, schemaVersion, sites, userPac$/],
    [{ ...good, uses: [] }, /uses must be an object/],
    [{ ...good, uses: { "a.com": { "www.a.com": 5 } } }, /uses of "a.com" must map hosts/],
    [{ ...good, uses: { "a.com": { "www.a.com": [1, -1] } } }, /uses of "a.com" must map hosts/],
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
