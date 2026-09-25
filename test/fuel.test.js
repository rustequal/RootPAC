import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { instrument, originalColumn } from "../src/core/fuel.js";
import { parseScript } from "../src/core/analyze.js";

function run(code, budget = 1000) {
  const context = vm.createContext({ calls: 0 });
  let left = budget;
  let exhausted = false;
  Object.defineProperty(context, "__fuel", {
    value: () => {
      context.calls++;
      if (exhausted || --left < 0) {
        exhausted = true;
        throw new Error("budget");
      }
    },
  });
  let error = null;
  try {
    vm.runInContext(code, context);
  } catch (caught) {
    error = caught;
  }
  return { context, exhausted, error };
}

test("every loop kind and function kind starts with a fuel call", () => {
  const source = [
    "while (a) { x(); }",
    "do { x(); } while (a);",
    "for (;;) { x(); }",
    "for (k in o) { x(); }",
    "for (v of o) { x(); }",
    "function f() { return 1; }",
    "var g = function () {};",
    "var h = () => { return 2; };",
    "class C { m() {} get p() { return 1; } static s() {} }",
    "var o2 = { m() {}, set q(v) {} };",
  ].join("\n");
  const { code } = instrument(source);
  assert.deepEqual(code.split("\n"), [
    "while (a) {__fuel(); x(); }",
    "do {__fuel(); x(); } while (a);",
    "for (;;) {__fuel(); x(); }",
    "for (k in o) {__fuel(); x(); }",
    "for (v of o) {__fuel(); x(); }",
    "function f() {__fuel(); return 1; }",
    "var g = function () {__fuel();};",
    "var h = () => {__fuel(); return 2; };",
    "class C { m() {__fuel();} get p() {__fuel(); return 1; } static s() {__fuel();} }",
    "var o2 = { m() {__fuel();}, set q(v) {__fuel();} };",
  ]);
  parseScript(code);
});

test("bodies without braces and expression arrows are wrapped", () => {
  const source = "while (a) while (b) x\nfor (;;);\ndo y; while (z)\nvar f = () => ({ a: 1 });\nvar g = (a) => (a, b);\nwhile (a) () => b\nif (c) for (;;) d; else e;";
  const { code } = instrument(source);
  assert.deepEqual(code.split("\n"), [
    "while (a) {__fuel();while (b) {__fuel();x}}",
    "for (;;){__fuel();;}",
    "do {__fuel();y;} while (z)",
    "var f = () => ((__fuel(), { a: 1 }));",
    "var g = (a) => ((__fuel(), a, b));",
    "while (a) {__fuel();() => (__fuel(), b)}",
    "if (c) for (;;) {__fuel();d;} else e;",
  ]);
  parseScript(code);
});

test("line numbers are kept and columns map back to the original", () => {
  const source = "var s = `a\nb`;\r\nwhile (a) while (b) x\nfunction g(){ return 1 }";
  const { code, shifts } = instrument(source);
  const lines = code.split(/\r\n|\n/);
  assert.equal(lines.length, source.split(/\r\n|\n/).length);
  const x = lines[2].indexOf("x}") + 1;
  assert.equal(originalColumn(shifts, 3, x), 21);
  const ret = lines[3].indexOf("return") + 1;
  assert.equal(originalColumn(shifts, 4, ret), 15);
  assert.equal(originalColumn(shifts, 3, 11), 11);
  assert.equal(originalColumn(shifts, 1, 5), 5);
});

test("instrumented code behaves the same within the budget", () => {
  const source = "var out = [];\nfor (var i = 0; i < 3; i++) out.push([1, 2].map((v) => v * i));\nfunction f(n) { return n < 2 ? n : f(n - 1) + f(n - 2); }\nvar fib = f(10);";
  const plain = vm.createContext({});
  vm.runInContext(source, plain);
  const { context, error } = run(instrument(source).code);
  assert.equal(error, null);
  assert.deepEqual(JSON.stringify(context.out), JSON.stringify(plain.out));
  assert.equal(context.fib, 55);
});

test("an infinite loop exhausts the budget", () => {
  const { exhausted, error, context } = run(instrument("while (true) {}").code, 100);
  assert.equal(exhausted, true);
  assert.equal(error.message, "budget");
  assert.equal(context.calls, 101);
});

test("exhaustion is sticky even when the script catches it", () => {
  const { exhausted, error } = run(instrument("for (;;) { try { for (;;) {} } catch (e) {} }").code, 100);
  assert.equal(exhausted, true);
  assert.equal(error.message, "budget");
  const swallowed = run(instrument("try { while (true) {} } catch (e) {}\nvar done = 1;").code, 100);
  assert.equal(swallowed.exhausted, true);
  assert.equal(swallowed.error, null);
});

test("unbounded recursion is stopped", () => {
  const { exhausted, error } = run(instrument("function f() { return f(); }\nf();").code, 100);
  assert.equal(exhausted, true);
  assert.equal(error.message, "budget");
});

test("a directive prologue stays first, so strict mode survives instrumentation", () => {
  const source = 'function f() { "use strict"; return this; }\nfunction g() { "a"\n"use strict"\nreturn typeof this; }\nvar h = function () { "use strict"; while (false) {} return this; };\nvar strict = [f(), g(), h()];';
  const { code, shifts } = instrument(source);
  assert.match(code, /^function f\(\) \{ "use strict";;__fuel\(\); return this; \}/);
  const { context, error } = run(code);
  assert.equal(error, null);
  assert.equal(JSON.stringify(context.strict), JSON.stringify([undefined, "undefined", undefined]));
  const line = code.split("\n")[0];
  assert.equal(originalColumn(shifts, 1, line.indexOf("return") + 1), source.indexOf("return") + 1);
});
