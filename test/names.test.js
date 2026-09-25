import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUserPac } from "../src/core/analyze.js";
import { coveringParent, hostFromUrl, isHostName, isIpLiteral, isLearnable, learnedOwner, ownerHost } from "../src/core/hosts.js";
import { hostRegex, maskProblem, trimTrailingDots } from "../src/core/names.js";
import { PSL, prng } from "./support.js";

const MAIN = 'function FindProxyForURL(url, host) { if (root(host, "root.org")) return "PROXY p:1"; return "DIRECT"; }';

test("host names: labels of [a-z0-9_-] up to 63, names up to 253, at least two labels, no number at the end", () => {
  const label = "a".repeat(63);
  for (const host of ["a.com", "a_b.x-y.com", `${label}.com`, `${[label, label, label].join(".")}.${"b".repeat(61)}`, "1.2.3.a", "a.0xg"]) assert.equal(isHostName(host), true, host);
  for (const host of ["com", "", "A.com", "a..com", ".a.com", "a.com.", `${label}a.com`, `${[label, label, label].join(".")}.${"b".repeat(62)}`, "a.1", "a.0x1f", "a.0x", "1.2.3.4", "a b.com", "a*.com", null]) {
    assert.equal(isHostName(host), false, String(host));
  }
  assert.equal(isIpLiteral("1.2.3.4"), true);
  assert.equal(isIpLiteral("1.2.3.4.5"), false);
  assert.equal(isIpLiteral("1..3.4"), false);
});

test("every accepted host name survives URL canonicalization unchanged", () => {
  const random = prng(43);
  const alphabet = "ab0_-.x9";
  for (let i = 0; i < 20000; i++) {
    let name = "";
    const length = 1 + Math.floor(random() * 12);
    for (let k = 0; k < length; k++) name += alphabet[Math.floor(random() * alphabet.length)];
    if (!isHostName(name)) continue;
    assert.equal(new URL(`http://${name}/`).hostname, name, name);
    assert.equal(hostFromUrl(`https://${name}./x`), name, name);
  }
});

test("mask errors name the reason", () => {
  const errors = (text) => analyzeUserPac(text).errors?.map(({ message }) => message);
  assert.deepEqual(errors(`deny("a.1");\n${MAIN}`), ['deny() mask "a.1" ends in a number, so no host name can match it']);
  assert.deepEqual(errors(`deny("${"a".repeat(64)}.com");\n${MAIN}`), [`deny() mask "${"a".repeat(64)}.com" has a label longer than 63 characters`]);
  assert.deepEqual(errors(`bypass("*.${"a.".repeat(127)}b");\n${MAIN}`), [`bypass() mask "*.${"a.".repeat(127)}b" is longer than 253 characters`]);
  assert.deepEqual(errors(MAIN.replace("root.org", "x.localhost")), ['root() mask "x.localhost" is under localhost, which Chrome never sends to a proxy']);
  assert.deepEqual(errors(`deny("*.root.org");\n${MAIN}`), ['deny() mask "*.root.org" covers root() mask "root.org"']);
  assert.deepEqual(errors(`deny("org.root.org");\n${MAIN}`), undefined);
  assert.equal(maskProblem("*.ru", "bypass"), null);
  assert.equal(maskProblem("localhost", "bypass"), null);
  assert.deepEqual(maskProblem("*.a.com", "root"), { kind: "wildcard" });
});

test("host regular expressions keep the host alphabet and a trailing dot and nothing else", () => {
  const zone = new RegExp(hostRegex("ru", true));
  for (const url of ["https://a.ru/", "https://a_b.x.ru/", "http://x.ru.:8080/p", "wss://a.b.ru/"]) assert.equal(zone.test(url), true, url);
  for (const url of ["https://ru/", "https://a.rux/", "https://a.ru@evil.com/", "https://a.ru:1@evil.com/", "https://a.ru.evil.com/", "https://evil.com/a.ru/"]) assert.equal(zone.test(url), false, url);
  const exact = new RegExp(hostRegex("github.io", false));
  assert.equal(exact.test("https://github.io/x"), true);
  assert.equal(exact.test("https://github.io.:443/"), true);
  assert.equal(exact.test("https://a.github.io/"), false);
  assert.equal(exact.test("https://githubxio/"), false);
});

test("a host of 200 000 dots is normalized and looked up in linear time", () => {
  const host = `a${".".repeat(200000)}b.com`;
  const index = new Map([["b.com", ["root.org"]]]);
  const started = performance.now();
  assert.equal(trimTrailingDots(`${host}${".".repeat(200000)}`), host);
  assert.equal(hostFromUrl(`http://${host}../x`), host);
  assert.equal(ownerHost(host, index), "b.com");
  assert.equal(learnedOwner(host, index, PSL), "b.com");
  assert.equal(coveringParent(host, index, PSL), "b.com");
  assert.equal(isLearnable(host, { roots: ["root.org"], deny: [], bypass: ["*.byp"] }, new Map(), PSL), false);
  assert.ok(performance.now() - started < 500);
});
