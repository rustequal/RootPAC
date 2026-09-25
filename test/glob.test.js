import { test } from "node:test";
import assert from "node:assert/strict";
import { firstMatch, matchMask } from "../src/core/glob.js";
import { loadPac, prng } from "./support.js";

const cases = [
  ["instagram.com", "instagram.com", true],
  ["www.instagram.com", "instagram.com", false],
  ["www.instagram.com", "*.instagram.com", true],
  ["a.b.instagram.com", "*.instagram.com", true],
  ["instagram.com", "*.instagram.com", false],
  [".instagram.com", "*.instagram.com", true],
  ["instagram.com", "*instagram.com", true],
  ["abc", "a?c", true],
  ["ac", "a?c", false],
  ["abbc", "a?c", false],
  ["a.c", "a?c", true],
  ["abc", "a.c", false],
  ["a.c", "a.c", true],
  ["a-c", "a-c", true],
  ["abc", "a-c", false],
  ["xa.com", "a.com", false],
  ["a.comx", "a.com", false],
  ["anything", "*", true],
  ["", "*", true],
  ["", "", true],
  ["a", "", false],
  ["", "?", false],
  ["a", "?", true],
  ["a+b", "a+b", true],
  ["aab", "a+b", false],
  ["a(b)", "a(b)", true],
  ["ab", "a(b)", false],
  ["a$b", "a$b", true],
  ["a\\b", "a\\b", true],
  ["a[b]", "a[b]", true],
  ["ab", "a[b]", false],
  ["a|b", "a|b", true],
  ["a", "a|b", false],
  ["a^b", "a^b", true],
  ["a{2}", "a{2}", true],
  ["aa", "a{2}", false],
];

test("matchMask follows shExpMatch semantics", () => {
  for (const [host, mask, expected] of cases) {
    assert.equal(matchMask(host, mask), expected, `${JSON.stringify(host)} ~ ${JSON.stringify(mask)}`);
  }
});

test("matchMask is stable across repeated calls", () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(matchMask("www.a.com", "*.a.com"), true);
    assert.equal(matchMask("a.com", "*.a.com"), false);
  }
});

test("firstMatch returns the first matching mask in order", () => {
  const masks = ["*.a.com", "www.a.com", "*"];
  assert.equal(firstMatch("www.a.com", masks), "*.a.com");
  assert.equal(firstMatch("www.a.com", ["www.a.com", "*.a.com"]), "www.a.com");
  assert.equal(firstMatch("b.com", ["*.a.com", "a.com"]), null);
  assert.equal(firstMatch("b.com", []), null);
});

test("matchMask agrees with Chromium shExpMatch on the mask alphabet", () => {
  const { shExpMatch } = loadPac("");
  const random = prng(20260921);
  const pick = (alphabet, max) => {
    const length = Math.floor(random() * (max + 1));
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(random() * alphabet.length)];
    return out;
  };
  let matches = 0;
  for (let i = 0; i < 20000; i++) {
    const mask = pick("ab.-*?0", 6);
    const host = pick("ab.-0", 7);
    const expected = shExpMatch(host, mask);
    if (expected) matches++;
    assert.equal(matchMask(host, mask), expected, `${JSON.stringify(host)} ~ ${JSON.stringify(mask)}`);
  }
  assert.ok(matches > 1000);
});
