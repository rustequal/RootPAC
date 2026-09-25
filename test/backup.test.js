import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_SCHEMA_VERSION, exportBackup, readBackup } from "../src/core/backup.js";

const USER_PAC = 'function FindProxyForURL(url, host) {\n  return root(host, "a.com") ? "PROXY p:1" : "DIRECT";\n}';
const GROUPS = { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 5 } }, "a.com": { rootHost: null, hosts: {} } };

test("export copies the User PAC and groups without session or telemetry state", () => {
  const backup = exportBackup({ userPac: USER_PAC, groups: GROUPS, seen: { "a.com": { "cdn.a.net": 9 } }, enabled: false });
  assert.deepEqual(backup, { schemaVersion: BACKUP_SCHEMA_VERSION, userPac: USER_PAC, groups: GROUPS });
  assert.notEqual(backup.groups["a.com"].hosts, GROUPS["a.com"].hosts);
  assert.throws(() => exportBackup({ userPac: null, groups: {} }), /No user PAC configured/);
});

test("an exported backup reads back to the same state", () => {
  const backup = JSON.parse(JSON.stringify(exportBackup({ userPac: USER_PAC, groups: GROUPS })));
  assert.deepEqual(readBackup(backup), { ok: true, userPac: USER_PAC, analysis: { roots: ["a.com"], deny: [], bypass: [] }, groups: GROUPS });
});

test("an invalid User PAC in a backup returns validation errors", () => {
  const result = readBackup({ schemaVersion: 1, userPac: "var root;", groups: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(({ message }) => message), ["Missing top-level function FindProxyForURL", "Identifier root must not be declared"]);
});

test("malformed backups are refused", () => {
  const good = { schemaVersion: 1, userPac: USER_PAC, groups: GROUPS };
  const cases = [
    [null, /exactly schemaVersion, userPac and groups/],
    [[], /exactly schemaVersion, userPac and groups/],
    [{ ...good, extra: 1 }, /exactly schemaVersion, userPac and groups/],
    [{ userPac: USER_PAC, groups: GROUPS }, /exactly schemaVersion, userPac and groups/],
    [{ ...good, schemaVersion: 2 }, /Unsupported backup schema version 2/],
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
