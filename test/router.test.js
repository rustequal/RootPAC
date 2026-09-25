import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUserPac } from "../src/core/analyze.js";
import { buildSystemPac } from "../src/core/build.js";
import { trialErrors, trialPlan } from "../src/core/trial.js";
import { loadPac, runTrial, PSL } from "./support.js";

const GROUPS = { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } } };
const PROTECTED = ["a.com", "www.a.com", "cdn.a.net", "x.cdn.a.net"];

const ATTACKS = {
  "router global": "this.__proxied = function (r) { return r; };",
  "entry point assignment": 'this.FindProxyForURL = function () { return "DIRECT"; };',
  "entry point assignment through globalThis": 'globalThis.FindProxyForURL = function () { return "DIRECT"; };',
  "entry point deletion": "delete this.FindProxyForURL;",
  "directive replacement": "this.root = function () { return false; };",
  "data globals": 'this.__ROOTS = []; this.__GROUPS = []; this.__BYPASS_HOSTS = ["www.a.com"]; this.__BYPASS_SUBDOMAINS = ["com"];',
  "string prototype": [
    'String.prototype.split = function () { return ["PROXY p:1"]; };',
    "String.prototype.replace = function () { return this; };",
    "String.prototype.substring = function () { return 'x'; };",
    "String.prototype.indexOf = function () { return -1; };",
    "String.prototype.slice = function () { return ''; };",
    "String.prototype.charAt = function () { return 'x'; };",
    "String.prototype[Symbol.split] = function () { return ['PROXY p:1']; };",
    "String.prototype[Symbol.replace] = function () { return 'PROXY p:1'; };",
  ].join("\n"),
  "regexp prototype": "RegExp.prototype.exec = function () { return ['x', 'PROXY', undefined, 'p', undefined]; }; RegExp.prototype.test = function () { return true; };",
  "array prototype": "Array.prototype.join = function () { return 'DIRECT'; }; Array.prototype.push = function () { return 0; };",
  "function prototype": "Function.prototype.call = function () { return 'DIRECT'; }; Function.prototype.apply = Function.prototype.call;",
  "inherited host names": 'Object.prototype["www.a.com"] = 0; Object.prototype["x.b.com"] = 1; Object.prototype.hosts = {};',
  "error constructor": "this.Error = function () { return {}; };",
};

const THROWING = {
  "entry point redefinition": 'Object.defineProperty(this, "FindProxyForURL", { value: function () { return "DIRECT"; } });',
  "entry point redeclaration": "(0, eval)(\"function FindProxyForURL() { return 'DIRECT'; }\");",
  "strict assignment": '(function () { "use strict"; globalThis.FindProxyForURL = null; })();',
};

const userPac = (attack, decision) => `${attack}\nfunction FindProxyForURL(url, host) {\n  if (root(host, "a.com")) return ${decision};\n  return ${decision};\n}\n`;

function gate(text) {
  const result = analyzeUserPac(text);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const analysis = { roots: result.roots, deny: result.deny };
  const systemPac = buildSystemPac(text, GROUPS, PSL);
  const { request, shifts } = trialPlan(systemPac, analysis, GROUPS);
  return trialErrors(runTrial(request), { systemPac, userPac: text, shifts });
}

test("a User PAC cannot make a protected host go direct by rewriting globals or built-ins", () => {
  for (const [name, attack] of Object.entries(ATTACKS)) {
    const pac = loadPac(buildSystemPac(userPac(attack, '"DIRECT"'), GROUPS, PSL));
    for (const host of PROTECTED) {
      assert.throws(() => pac.FindProxyForURL(`https://${host}/`, host), /^Error: RootPAC: no proxy for /, `${name}: ${host}`);
    }
    assert.equal(pac.FindProxyForURL("https://x.b.com/", "x.b.com"), "DIRECT", name);
    assert.notDeepEqual(gate(userPac(attack, '"DIRECT"')), [], name);
  }
});

test("the router keeps working exactly under a rewritten environment", () => {
  const attack = Object.values(ATTACKS).join("\n");
  const pac = loadPac(buildSystemPac(userPac(attack, '"DIRECT; PROXY p:1; SOCKS5 [::1]:1080"'), GROUPS, PSL));
  for (const host of PROTECTED) {
    assert.equal(pac.FindProxyForURL(`https://${host}/`, host), "PROXY p:1; SOCKS5 [::1]:1080", host);
  }
  assert.equal(pac.FindProxyForURL("https://www.a.com./", "www.a.com.."), "PROXY p:1; SOCKS5 [::1]:1080");
  assert.equal(pac.root("x.a.com", "a.com"), true);
  assert.deepEqual(gate(userPac(attack, '"DIRECT; PROXY p:1"')), []);
});

test("redefining the entry point fails at initialization and the gate refuses it", () => {
  for (const [name, attack] of Object.entries(THROWING)) {
    assert.throws(() => loadPac(buildSystemPac(userPac(attack, '"PROXY p:1"'), GROUPS, PSL)), (error) => error.name === "TypeError", name);
    const [error] = gate(userPac(attack, '"PROXY p:1"'));
    assert.match(error.message, /^User PAC failed to initialize: TypeError/, name);
    assert.equal(error.line, 1, name);
  }
});

test("the entry point and the directives are fixed global properties", () => {
  const pac = loadPac(buildSystemPac(userPac("", '"PROXY p:1"'), GROUPS, PSL));
  for (const name of ["FindProxyForURL", "root", "deny", "bypass"]) {
    const descriptor = Object.getOwnPropertyDescriptor(pac, name);
    assert.equal(typeof descriptor.value, "function", name);
    assert.equal(descriptor.writable, false, name);
    assert.equal(descriptor.configurable, false, name);
  }
  for (const name of ["__proxied", "__inDomain", "__entry", "__INDEX", "__ANSWERS", "__GROUPS", "__ROOTS", "LEARNED_a_com"]) {
    assert.equal(Object.hasOwn(pac, name), false, name);
  }
});

test("a non-string host is refused", () => {
  const pac = loadPac(buildSystemPac(userPac("", '"PROXY p:1"'), GROUPS, PSL));
  assert.throws(() => pac.FindProxyForURL("https://www.a.com/", { toString: () => "www.a.com" }), /RootPAC: host is not a string/);
});
