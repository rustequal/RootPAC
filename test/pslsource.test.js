import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_PSL_LENGTH, bundledPublicSuffixList, formatPslVersion, isNewerPsl, pslCommit, pslVersion, readPublicSuffixList } from "../src/core/pslsource.js";

const BUNDLED = readFileSync(new URL("../vendor/public_suffix_list.dat", import.meta.url), "utf8");

test("the version of a list is the UTC time on its VERSION line, the commit is for reference", () => {
  assert.equal(pslVersion(BUNDLED), "2026-09-21_18-50-07_UTC");
  assert.equal(pslCommit(BUNDLED), "728555a30ef4d40e42a82d5678e5fbad2ad17b26");
  assert.equal(pslVersion("// nothing\ncom\n"), null);
  assert.equal(formatPslVersion("2026-09-21_18-50-07_UTC"), "2026-09-21 18:50:07 UTC");
  assert.equal(formatPslVersion("odd"), "odd");
});

test("lists are ordered by their build time", () => {
  assert.equal(isNewerPsl("2026-09-28_07-12-00_UTC", "2026-09-21_18-50-07_UTC"), true);
  assert.equal(isNewerPsl("2026-09-21_18-50-07_UTC", "2026-09-21_18-50-07_UTC"), false);
  assert.equal(isNewerPsl("2025-12-31_23-59-59_UTC", "2026-01-01_00-00-00_UTC"), false);
  assert.equal(isNewerPsl("2026-01-01_00-00-00_UTC", null), true);
  assert.equal(isNewerPsl(undefined, "2026-01-01_00-00-00_UTC"), false);
});

test("the bundled list reads with its version and commit", () => {
  const { psl, version, commit } = readPublicSuffixList(BUNDLED);
  assert.equal(version, "2026-09-21_18-50-07_UTC");
  assert.equal(commit, "728555a30ef4d40e42a82d5678e5fbad2ad17b26");
  assert.equal(psl.registrableDomain("x.user.github.io"), "user.github.io");
});

test("a list that is cut off, has no version, is too large or answers wrong is refused", () => {
  assert.throws(() => readPublicSuffixList(BUNDLED.slice(0, BUNDLED.length / 2)), /incomplete/);
  assert.throws(() => readPublicSuffixList(BUNDLED.replace(/^\/\/ VERSION: .*$/m, "")), /no VERSION/);
  assert.throws(() => readPublicSuffixList(BUNDLED + " ".repeat(MAX_PSL_LENGTH)), /larger/);
  assert.throws(() => readPublicSuffixList(BUNDLED.replace(/^github\.io$/m, "")), /wrong answers/);
  assert.throws(() => readPublicSuffixList("<html>Not Found</html>"), /no VERSION/);
  assert.throws(() => readPublicSuffixList(null), /must be a string/);
});

test("the bundled snapshot is only parsed, with the same version and answers", () => {
  const bundled = bundledPublicSuffixList(BUNDLED);
  const checked = readPublicSuffixList(BUNDLED);
  assert.equal(bundled.version, checked.version);
  assert.equal(bundled.commit, checked.commit);
  assert.equal(bundled.psl.registrableDomain("a.b.bbc.co.uk"), "bbc.co.uk");
});
