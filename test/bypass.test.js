import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUserPac, denyOverlapsBypass } from "../src/core/analyze.js";
import { buildSystemPac } from "../src/core/build.js";
import { aggregateGroups, reconcileGroups } from "../src/core/groups.js";
import { hostIndex } from "../src/core/groups.js";
import { isLearnable } from "../src/core/hosts.js";
import { RULE_IDS, buildRules, policyOf } from "../src/core/rules.js";
import { PSL, loadPac } from "./support.js";

const USER_PAC = [
  'bypass("*.ru");',
  'bypass("*.xn--p1ai");',
  'bypass("static.example.org");',
  'deny("*.ads.com");',
  "",
  "function FindProxyForURL(url, host) {",
  '  if (root(host, "mail.ru") || root(host, "a.com")) return "PROXY p:1";',
  '  return host === "everything.org" ? "PROXY q:1" : "DIRECT";',
  "}",
].join("\n");
const ANALYSIS = { roots: ["mail.ru", "a.com"], deny: ["*.ads.com"], bypass: ["*.ru", "*.xn--p1ai", "static.example.org"] };
const route = (pac, host) => pac.FindProxyForURL(`https://${host}/`, host);

test("bypass() is a top-level directive with zone masks and no overlap with deny", () => {
  assert.deepEqual(analyzeUserPac(USER_PAC), { ok: true, ...ANALYSIS });
  const errors = (text) => (analyzeUserPac(`${text}\nfunction FindProxyForURL(url, host) { return "DIRECT"; }`).errors ?? []).map(({ message }) => message);
  assert.deepEqual(errors('bypass("RU");'), ['bypass() mask must be lowercase: "RU"']);
  assert.deepEqual(errors('bypass("*.");'), ['bypass() mask must be a domain, a zone or *.domain: "*."']);
  assert.deepEqual(errors('bypass("");'), ["bypass() mask must not be empty"]);
  assert.deepEqual(errors('bypass("*.ru", "x");'), ["bypass() requires exactly 1 argument"]);
  assert.deepEqual(errors('if (1) bypass("*.ru");'), ["bypass() must be a standalone top-level statement"]);
  assert.deepEqual(errors("var b = bypass;"), ["bypass may only be called directly"]);
  assert.deepEqual(errors("function bypass() {}"), ["Identifier bypass must not be declared"]);
  assert.deepEqual(errors('bypass("*.ru");\ndeny("*.ads.ru");'), ['bypass() mask "*.ru" overlaps deny() mask "*.ads.ru"']);
  assert.deepEqual(errors('deny("x.ru");\nbypass("*.ru");'), ['bypass() mask "*.ru" overlaps deny() mask "x.ru"']);
  assert.deepEqual(errors('deny("*.ads.com");\nbypass("*.ru");'), []);
  assert.deepEqual(errors('deny("ru.com");\nbypass("*.ru");'), []);
  const roots = analyzeUserPac('bypass("*.ru");\nfunction FindProxyForURL(url, host) { return root(host, "mail.ru") ? "PROXY p:1" : "DIRECT"; }');
  assert.equal(roots.ok, true);
});

test("denyOverlapsBypass treats deny as its whole domain, as DNR requestDomains does", () => {
  const cases = [
    ["a.com", "a.com", true],
    ["a.com", "b.com", false],
    ["*.a.com", "x.a.com", true],
    ["a.com", "x.a.com", true],
    ["a.com", "*.a.com", true],
    ["*.a.com", "a.com", true],
    ["*.a.com", "*.a.com", true],
    ["*.com", "a.com", true],
    ["*.a.com", "*.com", true],
    ["x.y.ru", "*.ru", true],
    ["*.a.com", "*.b.com", false],
    ["x.ru", "ru", false],
    ["ru.com", "*.ru", false],
    ["x.a.com", "a.com", false],
  ];
  for (const [deny, bypass, expected] of cases) assert.equal(denyOverlapsBypass(deny, bypass), expected, `${deny} ${bypass}`);
});

test("System PAC: learned hosts and roots win, bypass returns DIRECT, the rest follows the User PAC", () => {
  const groups = { "a.com": { rootHost: "www.a.com", hosts: { "cdn.b.net": 1 } }, "mail.ru": { rootHost: null, hosts: {} } };
  const text = buildSystemPac(USER_PAC, groups, PSL);
  assert.match(text, /var __BYPASS_HOSTS = \[\n {2}"static\.example\.org"\n\];\n\nvar __BYPASS_SUBDOMAINS = \[\n {2}"ru",\n {2}"xn--p1ai"\n\];/);
  const pac = loadPac(text);
  assert.equal(route(pac, "e.mail.ru"), "PROXY p:1");
  assert.equal(route(pac, "www.a.com"), "PROXY p:1");
  assert.equal(route(pac, "x.cdn.b.net"), "PROXY p:1");
  assert.equal(route(pac, "yandex.ru"), "DIRECT");
  assert.equal(route(pac, "img.imgsmail.ru"), "DIRECT");
  assert.equal(route(pac, "xn--80a.xn--p1ai"), "DIRECT");
  assert.equal(route(pac, "static.example.org"), "DIRECT");
  assert.equal(route(pac, "everything.org"), "PROXY q:1");
  assert.equal(route(pac, "a.static.example.org"), "DIRECT");
});

test("learned hosts never match or cover a bypass domain", () => {
  const base = { "a.com": { rootHost: "www.a.com", hosts: {} }, "mail.ru": { rootHost: null, hosts: {} } };
  const withHost = (host) => ({ ...base, "a.com": { rootHost: "www.a.com", hosts: { [host]: 1 } } });
  assert.throws(() => buildSystemPac(USER_PAC, withHost("x.ru"), PSL), /matches bypass "\*\.ru"/);
  assert.throws(() => buildSystemPac(USER_PAC, withHost("example.org"), PSL), /covers bypass "static\.example\.org"/);
  assert.throws(() => buildSystemPac(USER_PAC, withHost("static.example.org"), PSL), /matches bypass/);
  const index = hostIndex(base);
  for (const host of ["x.ru", "a.b.xn--p1ai", "example.org", "static.example.org"]) assert.equal(isLearnable(host, ANALYSIS, index, PSL), false, host);
  assert.equal(isLearnable("cdn.example.org", ANALYSIS, index, PSL), true);
  const reconciled = reconcileGroups({ ...base, "a.com": { rootHost: "www.a.com", hosts: { "x.ru": 1, "example.org": 2, "cdn.b.net": 3 } } }, ANALYSIS);
  assert.deepEqual(reconciled["a.com"].hosts, { "cdn.b.net": 3 });
});

test("aggregation never produces a record matching or covering a bypass domain", () => {
  const analysis = { roots: ["a.com"], deny: [], bypass: ["static.cdn.net"] };
  const groups = { "a.com": { rootHost: "www.a.com", hosts: { "x.cdn.net": 1, "y.cdn.net": 2 } } };
  assert.equal(aggregateGroups(groups, {}, analysis, PSL).groups, groups);
  const allowed = aggregateGroups(groups, {}, { ...analysis, bypass: ["*.ru"] }, PSL);
  assert.deepEqual(allowed.groups["a.com"].hosts, { "cdn.net": 1 });
});

test("DNR allows bypass masks by exact regex so the root block never stops them", () => {
  const { dynamic, session } = buildRules(policyOf({ enabled: true, analysis: ANALYSIS, groups: {} }, PSL));
  const bypass = session.filter((rule) => rule.id >= RULE_IDS.bypass && rule.id < RULE_IDS.hosts);
  assert.deepEqual(
    bypass.map(({ id, priority, action, condition }) => [id, priority, action.type, condition.regexFilter]),
    [
      [3000, 2, "allow", "^[a-z]+://(?:[a-z0-9_-]+\\.)+ru\\.?(?::[0-9]+)?/"],
      [3001, 2, "allow", "^[a-z]+://(?:[a-z0-9_-]+\\.)+xn--p1ai\\.?(?::[0-9]+)?/"],
      [3002, 2, "allow", "^[a-z]+://static\\.example\\.org\\.?(?::[0-9]+)?/"],
    ],
  );
  assert.equal(dynamic.find((rule) => rule.id === RULE_IDS.deny).priority, 3);
  const many = { roots: Array.from({ length: 600 }, (_, i) => `r${i}.com`), deny: [], bypass: Array.from({ length: 1001 }, (_, i) => `b${i}.org`) };
  assert.throws(() => buildRules(policyOf({ enabled: true, analysis: many, groups: {} }, PSL)), /At most 1000 bypass masks/);
});
