import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUserPac, isValidMask, isValidRoot } from "../src/core/analyze.js";
import { fixture } from "./support.js";

const MAIN = 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}\n';

function withBody(body) {
  return `function FindProxyForURL(url, host) {\n${body}\n  return "DIRECT";\n}\n`;
}

function errorsOf(text) {
  const result = analyzeUserPac(text);
  assert.equal(result.ok, false, "expected analysis to fail");
  return result.errors.map(({ line, column, message }) => `${line}:${column} ${message}`);
}

function ok(text) {
  const result = analyzeUserPac(text);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

test("reference user PAC yields roots and deny in source order", () => {
  assert.deepEqual(ok(fixture("user.pac")), {
    ok: true,
    roots: ["instagram.com"],
    deny: ["*.google-analytics.com", "*.doubleclick.net"],
    bypass: [],
  });
});

test("rule 1: syntax errors report 1-based line and column", () => {
  assert.deepEqual(errorsOf("var a = ;\n" + MAIN), ["1:9 Unexpected token"]);
  assert.deepEqual(errorsOf(MAIN + "}\n"), ["4:1 Unexpected token"]);
  assert.deepEqual(errorsOf("\n\n  let = 1 +;\n" + MAIN), ["3:12 Unexpected token"]);
});

test("rule 1: hashbang, top-level return and module syntax are rejected", () => {
  const moduleOnly = "1:1 'import' and 'export' may appear only with 'sourceType: module'";
  assert.deepEqual(errorsOf("#!/usr/bin/env node\n" + MAIN), ["1:2 Unexpected character '!'"]);
  assert.deepEqual(errorsOf("return;\n" + MAIN), ["1:1 'return' outside of function"]);
  assert.deepEqual(errorsOf('import x from "y";\n' + MAIN), [moduleOnly]);
  assert.deepEqual(errorsOf("export var a = 1;\n" + MAIN), [moduleOnly]);
});

test("rule 1: modern syntax parses", () => {
  ok(`const a = { ...{ b: 1 } };\nclass C { #x = 1; static { this.y = a?.b ?? 2n; } }\n${MAIN}`);
});

test("rule 2: exactly one top-level FindProxyForURL", () => {
  assert.deepEqual(errorsOf('var PROXY = "DIRECT";\n'), ["1:1 Missing top-level function FindProxyForURL"]);
  assert.deepEqual(errorsOf(`{\n${MAIN}}\n`), ["1:1 Missing top-level function FindProxyForURL"]);
  assert.deepEqual(errorsOf("var FindProxyForURL = function (url, host) { return \"DIRECT\"; };\n"), [
    "1:1 Missing top-level function FindProxyForURL",
  ]);
  assert.deepEqual(errorsOf(MAIN + MAIN), ["4:10 Duplicate top-level function FindProxyForURL"]);
  assert.deepEqual(errorsOf("async " + MAIN), ["1:16 FindProxyForURL must be a plain function, not async or generator"]);
  assert.deepEqual(errorsOf(MAIN.replace("function", "function*")), [
    "1:11 FindProxyForURL must be a plain function, not async or generator",
  ]);
});

test("rule 3: root takes two arguments with a string literal mask", () => {
  assert.deepEqual(ok(withBody('  if (root(host, "a.com")) return "PROXY p:1";')).roots, ["a.com"]);
  assert.deepEqual(errorsOf(withBody('  root("*.a.com");')), ["2:3 root() requires exactly 2 arguments"]);
  assert.deepEqual(errorsOf(withBody('  root(host, "a.com", 1);')), ["2:3 root() requires exactly 2 arguments"]);
  assert.deepEqual(errorsOf(withBody("  root(host, MASK);")), ["2:14 root() mask must be a string literal"]);
  assert.deepEqual(errorsOf(withBody("  root(host, `a.com`);")), ["2:14 root() mask must be a string literal"]);
  assert.deepEqual(errorsOf(withBody('  root(host, "a" + ".com");')), ["2:14 root() mask must be a string literal"]);
  assert.deepEqual(errorsOf(withBody("  root(host, 1);")), ["2:14 root() mask must be a string literal"]);
  assert.deepEqual(errorsOf(withBody('  root(...args, "a.com");')), ["2:3 root() does not accept spread arguments"]);
});

test("rule 3: root may be called anywhere and inside helpers", () => {
  const text = [
    'function isA(h) { return root(h, "a.com"); }',
    'var early = function (h) { return root(h, "b.com"); };',
    MAIN,
  ].join("\n");
  assert.deepEqual(ok(text).roots, ["a.com", "b.com"]);
  assert.deepEqual(ok(withBody('  return root?.(host, "c.com") ? "PROXY p:1" : "DIRECT";')).roots, ["c.com"]);
});

test("rule 4: deny is a standalone top-level statement with one literal", () => {
  assert.deepEqual(ok('deny("*.a.com");\ndeny("b.com")\n' + MAIN).deny, ["*.a.com", "b.com"]);
  assert.deepEqual(errorsOf(withBody('  deny("a.com");')), ["2:3 deny() must be a standalone top-level statement"]);
  assert.deepEqual(errorsOf('var d = deny("a.com");\n' + MAIN), ["1:9 deny() must be a standalone top-level statement"]);
  assert.deepEqual(errorsOf('deny("a.com"), deny("b.com");\n' + MAIN), [
    "1:1 deny() must be a standalone top-level statement",
    "1:16 deny() must be a standalone top-level statement",
  ]);
  assert.deepEqual(errorsOf('if (1) deny("a.com");\n' + MAIN), ["1:8 deny() must be a standalone top-level statement"]);
  assert.deepEqual(errorsOf('deny?.("a.com");\n' + MAIN), ["1:1 deny() must be a standalone top-level statement"]);
  assert.deepEqual(errorsOf("deny();\n" + MAIN), ["1:1 deny() requires exactly 1 argument"]);
  assert.deepEqual(errorsOf('deny("a.com", "b.com");\n' + MAIN), ["1:1 deny() requires exactly 1 argument"]);
  assert.deepEqual(errorsOf("deny(MASK);\n" + MAIN), ["1:6 deny() mask must be a string literal"]);
  assert.deepEqual(errorsOf("deny(...masks);\n" + MAIN), ["1:1 deny() does not accept spread arguments"]);
});

test("rule 5: masks are a lowercase domain or *.domain", () => {
  for (const mask of ["a.com", "*.a.com", "a-b.c0.com", "*.xn--d1acpjx3f.xn--p1ai", "cdn.x2"]) assert.equal(isValidMask(mask), true, mask);
  for (const mask of ["", "com", "*.com", "A.com", "*a.com", "a.*.com", "a?.com", "*", "*.", ".a.com", "a..com", "a.com.", "a_b.com", "**.a.com", "cdn.2", "a.0x1f", null]) {
    assert.equal(isValidMask(mask), false, String(mask));
  }
  assert.deepEqual(errorsOf('deny("");\n' + MAIN), ["1:6 deny() mask must not be empty"]);
  assert.deepEqual(errorsOf(withBody('  root(host, "");')), ["2:14 root() mask must not be empty"]);
  assert.deepEqual(errorsOf(withBody('  root(host, "Instagram.com");')), ['2:14 root() mask must be lowercase: "Instagram.com"']);
  assert.deepEqual(errorsOf(withBody('  root(host, "insta*.com");')), ['2:14 root() mask must be a domain: "insta*.com"']);
  assert.deepEqual(errorsOf(withBody('  root(host, "com");')), ['2:14 root() mask must be a domain: "com"']);
  assert.deepEqual(errorsOf(withBody('  root(host, "*.youtube.com");')), [
    '2:14 root() takes a domain and always covers all its subdomains: write "youtube.com" instead of "*.youtube.com"',
  ]);
  for (const mask of ["a.com", "www.a-b.c0.com", "cdn.2a"]) assert.equal(isValidRoot(mask), true, mask);
  for (const mask of ["*.a.com", "com", "A.com", "a_b.com", "cdn.2", "1.2.3.4", "x.localhost", null]) assert.equal(isValidRoot(mask), false, String(mask));
  assert.deepEqual(errorsOf('deny("a.com/x");\n' + MAIN), ['1:6 deny() mask must be a domain or *.domain: "a.com/x"']);
  assert.deepEqual(errorsOf('deny("?.a.com");\n' + MAIN), ['1:6 deny() mask must be a domain or *.domain: "?.a.com"']);
});

test("rule 6: root and deny are never declared in any scope", () => {
  const declared = [
    ["var root = 1;", "1:5"],
    ["let deny;", "1:5"],
    ["const { root } = {};", "1:9"],
    ["const { a: deny } = {};", "1:12"],
    ["var [x, root] = [];", "1:9"],
    ["var { a: [root] } = {};", "1:11"],
    ["var { ...deny } = {};", "1:10"],
    ["var [root = 1] = [];", "1:6"],
    ["function root() {}", "1:10"],
    ["function f(root) {}", "1:12"],
    ["function f(a, ...deny) {}", "1:18"],
    ["function f({ root }) {}", "1:14"],
    ["function f(a = 1, [deny]) {}", "1:20"],
    ["var f = function root() {};", "1:18"],
    ["var f = (root) => 1;", "1:10"],
    ["var f = root => 1;", "1:9"],
    ["class root {}", "1:7"],
    ["var C = class deny {};", "1:15"],
    ["class C { m(root) {} }", "1:13"],
    ["try {} catch (root) {}", "1:15"],
    ["try {} catch ({ deny }) {}", "1:17"],
    ["for (let root of []) {}", "1:10"],
  ];
  for (const [source, at] of declared) {
    const name = source.includes("root") ? "root" : "deny";
    assert.deepEqual(errorsOf(`${source}\n${MAIN}`), [`${at} Identifier ${name} must not be declared`], source);
  }
  assert.deepEqual(errorsOf(withBody('  var root = function () {};\n  root(host, "a.com");')), [
    "2:7 Identifier root must not be declared",
  ]);
});

test("rule 7: root and deny may only be called directly", () => {
  const used = [
    ["var f = root;", "1:9", "root"],
    ["typeof deny;", "1:8", "deny"],
    ["root = function () {};", "1:1", "root"],
    ["[root] = [];", "1:2", "root"],
    ["({ deny } = {});", "1:4", "deny"],
    ["new root(1, \"a.com\");", "1:5", "root"],
    ["root`a.com`;", "1:1", "root"],
    ["var o = { root };", "1:11", "root"],
    ["var o = { a: deny };", "1:14", "deny"],
    ["root.call(null, 1, \"a.com\");", "1:1", "root"],
    ["(0, root)(1, \"a.com\");", "1:5", "root"],
    ["f(root);", "1:3", "root"],
    ["var o = { [deny]: 1 };", "1:12", "deny"],
    ["var { [root]: x } = {};", "1:8", "root"],
    ["var [x = deny] = [];", "1:10", "deny"],
    ["delete root;", "1:8", "root"],
  ];
  for (const [source, at, name] of used) {
    assert.deepEqual(errorsOf(`${source}\n${MAIN}`), [`${at} ${name} may only be called directly`], source);
  }
});

test("property keys, members and labels named root or deny are not directives", () => {
  const text = [
    "var o = { root: 1, deny() {}, get root2() { return 1; } };",
    "o.root(1, \"a.com\");",
    "o.deny(\"b.com\");",
    "class C { root = 1; deny() {} static root() {} }",
    "root: for (;;) { break root; }",
    "deny: while (false) { continue deny; }",
    MAIN,
  ].join("\n");
  assert.deepEqual(ok(text), { ok: true, roots: [], deny: [], bypass: [] });
});

test("only the global System PAC names __user and __fuel are reserved", () => {
  assert.deepEqual(errorsOf("__user = null;\n" + MAIN), ["1:1 Identifier __user is reserved by RootPAC"]);
  assert.deepEqual(errorsOf("function f(__fuel) {}\n" + MAIN), ["1:12 Identifier __fuel is reserved by RootPAC"]);
  ok("var __GROUPS = [], __ROOTS, __proxied, __learned, __inDomain, LEARNED_x;\nvar o = { __user: 1, __fuel: 2 };\no.__user = 1;\n" + MAIN);
});

test("commented and string occurrences are not extracted", () => {
  const text = [
    '// root(host, "a.com")',
    '/* deny("b.com"); */',
    'var s = "root(host, \\"c.com\\")";',
    'var t = `deny("d.com")`;',
    withBody('  if (root(host, "e.com")) return "PROXY p:1";'),
  ].join("\n");
  assert.deepEqual(ok(text), { ok: true, roots: ["e.com"], deny: [], bypass: [] });
});

test("duplicate masks collapse and keep first-appearance order", () => {
  const text = [
    'deny("x.com");',
    'function g(h) { return root(h, "b.com") || root(h, "a.com"); }',
    'deny("y.com");',
    'deny("x.com");',
    withBody('  if (root(host, "a.com") || root(host, "c.com") || root(host, "b.com")) return "PROXY p:1";'),
    'function wild(h) { return root(h, "a.com") || root(h, "b.com") || root(h, "c.com"); }',
  ].join("\n");
  assert.deepEqual(ok(text), { ok: true, roots: ["b.com", "a.com", "c.com"], deny: ["x.com", "y.com"], bypass: [] });
});


test("all semantic errors are reported sorted by position", () => {
  const text = ['deny("Bad");', "var root;", withBody("  root(host);\n  var f = deny;")].join("\n");
  assert.deepEqual(errorsOf(text), [
    '1:6 deny() mask must be lowercase: "Bad"',
    "2:5 Identifier root must not be declared",
    "4:3 root() requires exactly 2 arguments",
    "5:11 deny may only be called directly",
  ]);
  assert.deepEqual(errorsOf("var root;\n"), [
    "1:1 Missing top-level function FindProxyForURL",
    "1:5 Identifier root must not be declared",
  ]);
});

test("CRLF line endings keep positions correct", () => {
  assert.deepEqual(errorsOf('deny("a.com");\r\nvar x = root;\r\n' + MAIN.replace(/\n/g, "\r\n")), [
    "2:9 root may only be called directly",
  ]);
});

test("non-string input is a programming error", () => {
  assert.throws(() => analyzeUserPac(null), TypeError);
});
