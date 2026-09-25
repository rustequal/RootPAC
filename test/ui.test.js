import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyErrorLine, proxyErrorText } from "../src/ui/shared/rpc.js";
import { buildSystemPac } from "../src/core/build.js";
import { fixture, PSL } from "./support.js";

const USER_PAC = fixture("user.pac");
const APPLIED = buildSystemPac(USER_PAC, { "instagram.com": { rootHost: null, hosts: {} }, "instagram.com": { rootHost: null, hosts: {} } }, PSL);
const OPEN = APPLIED.split("\n").indexOf("var __user = (function () {") + 1;
const USER_LINES = USER_PAC.split("\n").length;
const record = (details) => ({ time: 1, error: "net::ERR_PAC_SCRIPT_FAILED", details, fatal: false });

test("a PAC error line is translated into User PAC coordinates", () => {
  assert.equal(proxyErrorLine(record(`line: ${OPEN + 1}: Uncaught ReferenceError: x is not defined`), APPLIED, USER_PAC), 1);
  assert.equal(proxyErrorLine(record(`line: ${OPEN + 5}: Uncaught TypeError: y`), APPLIED, USER_PAC), 5);
  assert.equal(proxyErrorLine(record(`line: ${OPEN}: Uncaught Error: z`), APPLIED, USER_PAC), null);
  assert.equal(proxyErrorLine(record("line: 50: Uncaught Error: z"), APPLIED, USER_PAC), null);
  assert.equal(proxyErrorLine(record(`line: ${OPEN + USER_LINES + 1}: Uncaught Error: z`), APPLIED, USER_PAC), null);
  assert.equal(proxyErrorLine(record("Uncaught Error: z"), APPLIED, USER_PAC), null);
  assert.equal(proxyErrorLine(record("line: 8: x"), undefined, undefined), null);
});

test("error text names the User PAC line, the __proxied refusal or the raw error", () => {
  assert.equal(proxyErrorText(record(`line: ${OPEN + 1}: Uncaught ReferenceError: x`), APPLIED, USER_PAC), "User PAC line 1: Uncaught ReferenceError: x");
  assert.equal(
    proxyErrorText(record("line: 96: Uncaught Error: RootPAC: no proxy for www.instagram.com"), APPLIED, USER_PAC),
    "User PAC returned no proxy for a protected host",
  );
  assert.equal(proxyErrorText(record(""), APPLIED, USER_PAC), "net::ERR_PAC_SCRIPT_FAILED");
});
