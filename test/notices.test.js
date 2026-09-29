import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_TEXT, NOTICE_KEYS, notices, pslConflictText } from "../src/ui/shared/notices.js";

const PAC = "function FindProxyForURL(url, host) { return \"DIRECT\"; }";
const WORKING = { local: { enabled: true, userPac: PAC }, session: { armed: true } };
const ERRORS = [{ line: 2, column: 21, message: 'root() mask "instagram.com" is a public suffix, not a site' }];
const CONFLICT = { version: "2099-01-01_00-00-00_UTC", commit: null, errors: ERRORS };

const ids = (list) => list.map(({ id }) => id);
const on = (page, local = {}, session = {}) => notices({ ...WORKING.local, ...local }, { ...WORKING.session, ...session }, { page });

test("a working extension has no notices", () => {
  assert.deepEqual(on("options"), []);
  assert.deepEqual(on("popup"), []);
});

test("notices come most serious first, each once", () => {
  const list = on("options", { userPacErrors: ERRORS, pslConflict: CONFLICT }, { armed: false, startupError: "boom", lastLearnError: { time: 1, message: "apply failed" } });
  assert.deepEqual(ids(list), ["startup", "closed", "safe", "psl", "learn"]);
  assert.deepEqual(list.map(({ level }) => level), ["error", "warn", "warn", "warn", "error"]);
  assert.equal(list[0].text, "RootPAC failed to start: boom");
  assert.equal(list[1].text, CLOSED_TEXT);
  assert.match(list[4].text, / — Learning failed: apply failed$/);
});

test("a switched-off proxy is said instead of lost control, and no User PAC means nothing to control", () => {
  assert.deepEqual(ids(on("options", { enabled: false }, { armed: false })), ["off"]);
  assert.deepEqual(ids(on("options", { userPac: undefined }, { armed: false })), []);
  assert.deepEqual(ids(notices({}, {}, { page: "popup" })), ["off"]);
});

test("Options leads to the lines to fix; the popup sends the user to Options", () => {
  const options = on("options", { userPacErrors: ERRORS, pslConflict: CONFLICT }, { armed: false });
  assert.deepEqual(options.map(({ action }) => action), [undefined, "errors", "errors"]);
  assert.deepEqual(options[1].errors, ERRORS);
  assert.equal(options[1].text, "Saved user PAC no longer passes validation — protection continues with the last applied configuration — 1 problem");
  assert.equal(options[2].text, "Public Suffix List 2099-01-01 00:00:00 UTC is not installed: the saved User PAC does not pass with it — 1 problem");
  const popup = on("popup", { userPacErrors: ERRORS, pslConflict: CONFLICT });
  assert.equal(popup[0].text, "Saved user PAC no longer passes validation — protection continues with the last applied configuration. Fix it in Options");
  assert.equal(popup[1].text, `${pslConflictText(CONFLICT)}. Fix it in Options`);
});

test("the notices follow exactly the keys they read", () => {
  const read = { local: new Set(), session: new Set() };
  const spy = (area, values) => new Proxy(values, { get: (target, key) => (read[area].add(key), target[key]) });
  notices(spy("local", { ...WORKING.local, userPacErrors: ERRORS, pslConflict: CONFLICT }), spy("session", { armed: false, startupError: "x", lastLearnError: { time: 1, message: "m" } }), { page: "options" });
  assert.deepEqual([...read.local].sort(), [...NOTICE_KEYS.local].sort());
  assert.deepEqual([...read.session].sort(), [...NOTICE_KEYS.session].sort());
});
