import { test } from "node:test";
import assert from "node:assert/strict";
import { domainToASCII } from "node:url";
import { parsePublicSuffixList } from "../src/core/psl.js";
import { PSL, fixture } from "./support.js";

test("the official publicsuffix.org test vectors pass", () => {
  const cases = fixture("test_psl.txt")
    .split("\n")
    .map((line) => /^checkPublicSuffix\((null|'[^']*'), (null|'[^']*')\);$/.exec(line.trim()))
    .filter((match) => match !== null);
  assert.equal(cases.length, 78);
  for (const [, input, expected] of cases) {
    const raw = input === "null" ? null : input.slice(1, -1);
    const host = raw === null ? null : raw.startsWith(".") ? raw.toLowerCase() : domainToASCII(raw);
    const want = expected === "null" ? null : domainToASCII(expected.slice(1, -1));
    assert.equal(PSL.registrableDomain(host), want, input);
  }
});

test("registrable domains respect ICANN and private suffixes", () => {
  const cases = {
    "abc.youtube.com": "youtube.com",
    "rr1---sn-x.googlevideo.com": "googlevideo.com",
    "a.bbc.co.uk": "bbc.co.uk",
    "x.github.io": "x.github.io",
    "d1.cloudfront.net": "d1.cloudfront.net",
    "a.corp.lan": "corp.lan",
    "co.uk": null,
    "com": null,
    "a..com": null,
  };
  for (const [host, domain] of Object.entries(cases)) assert.equal(PSL.registrableDomain(host), domain, host);
});

test("rules are read up to whitespace, comments are skipped and IDN rules become punycode", () => {
  const psl = parsePublicSuffixList("// comment\nuk extra\nco.uk\n*.ck\n!www.ck\n\u0440\u0444\n");
  assert.equal(psl.registrableDomain("a.b.co.uk"), "b.co.uk");
  assert.equal(psl.registrableDomain("a.b.ck"), "a.b.ck");
  assert.equal(psl.registrableDomain("a.www.ck"), "www.ck");
  assert.equal(psl.registrableDomain("a.b.xn--p1ai"), "b.xn--p1ai");
  assert.throws(() => parsePublicSuffixList("// nothing\n"), /no rules/);
  assert.throws(() => parsePublicSuffixList(null), /must be a string/);
});
