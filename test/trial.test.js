import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPac } from "../src/core/build.js";
import { NEUTRAL_HOST, STEP_BUDGET, probeHosts, trialErrors, trialPlan } from "../src/core/trial.js";
import { analyzeUserPac } from "../src/core/analyze.js";
import { reconcileGroups } from "../src/core/groups.js";
import { fixture, runTrial, PSL } from "./support.js";

function check(userPac, groups = null) {
  const result = analyzeUserPac(userPac);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const analysis = { roots: result.roots, deny: result.deny };
  const resolved = groups ?? reconcileGroups({}, analysis);
  const systemPac = buildSystemPac(userPac, resolved, PSL);
  const { request, shifts } = trialPlan(systemPac, analysis, resolved);
  const outcome = runTrial(request);
  return { outcome, errors: trialErrors(outcome, { systemPac, userPac, shifts }), request };
}

const pac = (body, before = "") => `${before}function FindProxyForURL(url, host) {\n${body}\n}\n`;
const ROOT = '  if (root(host, "a.com") || root(host, "b.com")) return "PROXY p:1";';

test("probes cover every root, known root hosts and the neutral host", () => {
  const analysis = { roots: ["a.com", "b.com", "example.com"], deny: [], bypass: [] };
  const groups = {
    "a.com": { rootHost: "m.a.com", hosts: {} },
    "b.com": { rootHost: "b.com", hosts: {} },
    "example.com": { rootHost: null, hosts: {} },
  };
  assert.deepEqual(probeHosts(analysis, groups), ["a.com", "m.a.com", "b.com", "example.com"]);
  assert.deepEqual(probeHosts({ roots: [] }, {}), [NEUTRAL_HOST]);
});

test("the plan carries the instrumented System PAC, the budget and the probes", () => {
  const { request } = check(fixture("user.pac"));
  assert.equal(request.budget, STEP_BUDGET);
  assert.deepEqual(request.hosts, ["instagram.com", "example.com"]);
  assert.match(request.code, /function FindProxyForURL\(url, host\) \{__fuel\(\);/);
  assert.match(request.code, /\n\/\/# sourceURL=rootpac-trial\.pac\n$/);
});

test("a working User PAC passes", () => {
  assert.deepEqual(check(fixture("user.pac")).errors, []);
  const { outcome, errors } = check(pac(`${ROOT}\n  if (isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0")) return "DIRECT";\n  return myIpAddress() === "127.0.0.1" && !isPlainHostName(host) ? "DIRECT" : "PROXY q:1";`));
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(errors, []);
});

test("an initialization error is reported at its User PAC position", () => {
  const { errors } = check(pac(ROOT + '\n  return "DIRECT";', "var p = list[0];\n"));
  assert.deepEqual(errors, [{ line: 1, column: 9, message: "User PAC failed to initialize: ReferenceError: list is not defined" }]);
});

test("DIRECT for a root is refused", () => {
  const { errors } = check(pac('  if (root(host, "a.com")) return "DIRECT; SOCK5 p:1";\n  return "PROXY q:1";'));
  assert.deepEqual(errors, [{ line: null, column: null, message: "User PAC returned no proxy for a.com" }]);
});

test("a root host learned from browsing is probed as well", () => {
  const userPac = pac('  if (root(host, "a.com")) return host === "m.a.com" ? "DIRECT" : "PROXY p:1";\n  return "DIRECT";');
  const { errors } = check(userPac, { "a.com": { rootHost: "m.a.com", hosts: { "cdn.x.net": 1 } } });
  assert.deepEqual(errors, [{ line: null, column: null, message: "User PAC returned no proxy for m.a.com" }]);
});

test("an exception for a probe is reported with the host and position", () => {
  const { errors } = check(pac(`${ROOT}\n  return missing(host);`));
  assert.deepEqual(errors, [{ line: 3, column: 3, message: "User PAC threw for example.com: ReferenceError: missing is not defined" }]);
  const root = check(pac('  if (root(host, "b.com")) return helper(host);\n  return "DIRECT";'));
  assert.deepEqual(root.errors, [{ line: 2, column: 28, message: "User PAC threw for b.com: ReferenceError: helper is not defined" }]);
});

test("an exception thrown with a non-Error value has no position", () => {
  const { errors } = check(pac(`${ROOT}\n  throw "broken";`));
  assert.deepEqual(errors, [{ line: null, column: null, message: "User PAC threw for example.com: broken" }]);
});

test("an infinite loop is stopped by the step budget", () => {
  const { errors } = check(pac(`${ROOT}\n  while (true) {}`));
  assert.deepEqual(errors, [{ line: 3, column: 17, message: "User PAC exceeded the step budget (possible infinite loop)" }]);
  const init = check(pac(ROOT + '\n  return "DIRECT";', "for (;;) { try { for (;;) {} } catch (e) {} }\n"));
  assert.equal(init.errors[0].message, "User PAC exceeded the step budget (possible infinite loop)");
  assert.equal(init.errors[0].line, 1);
  const swallowed = check(pac(ROOT + '\n  return "DIRECT";', "try { while (true) {} } catch (e) {}\n"));
  assert.deepEqual(swallowed.errors, [{ line: 1, column: 21, message: "User PAC exceeded the step budget (possible infinite loop)" }]);
});

test("the budget resets for every probe", () => {
  const userPac = pac(`${ROOT}\n  for (var i = 0; i < 600000; i++) {}\n  return "DIRECT";`);
  assert.deepEqual(check(userPac).errors, []);
});

test("malformed outcomes fail fast", () => {
  const context = { systemPac: "", userPac: "", shifts: [] };
  assert.throws(() => trialErrors(undefined, context), /no result/);
  assert.throws(() => trialErrors({ ok: false, stage: "init", host: null, kind: "other", message: "", line: null, column: null }, context), /malformed/);
  assert.throws(() => trialErrors({ ok: false, stage: "probe", host: "a.com", kind: "throw", message: "", line: 1, column: null }, context), /malformed/);
});

test("throwing null or undefined is a failure like any other exception", () => {
  for (const value of ["null", "undefined"]) {
    const { outcome, errors } = check(pac(`${ROOT}\n  throw ${value};`));
    assert.equal(outcome.ok, false, value);
    assert.deepEqual(errors, [{ line: null, column: null, message: `User PAC threw for example.com: ${value}` }], value);
  }
  const { outcome } = check(pac(ROOT + '\n  return "DIRECT";', "throw null;\n"));
  assert.equal(outcome.stage, "init");
});
