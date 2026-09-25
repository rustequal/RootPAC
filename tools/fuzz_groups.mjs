import { readFileSync } from "node:fs";
import vm from "node:vm";
import { analyzeUserPac } from "../src/core/analyze.js";
import { exportBackup, readBackup } from "../src/core/backup.js";
import { buildSystemPac } from "../src/core/build.js";
import { firstMatch } from "../src/core/glob.js";
import { adoptLegacyGroups, aggregateGroups, hostIndex, mergeGroups, pruneSeen, reconcileGroups } from "../src/core/groups.js";
import { covers, hostFromUrl, isHostName, isLearnable, maskDomain } from "../src/core/hosts.js";
import { underLocalhost } from "../src/core/names.js";
import { parsePublicSuffixList } from "../src/core/psl.js";
import { buildRules, intersectPolicies, policyOf } from "../src/core/rules.js";

const ROOT = new URL("../", import.meta.url);
const PSL = parsePublicSuffixList(readFileSync(new URL("vendor/public_suffix_list.dat", ROOT), "utf8"));
const LIBRARY = readFileSync(new URL("vendor/pac-library.js", ROOT), "utf8");
const MUTATION = ['if (i > 0 && host[i - 1] !== ".") continue;', "if (i > 0) continue;"];

const args = process.argv.slice(2);
const mutate = args.includes("--mutate");
const [SEEDS = 4, RUNS = 300, STEPS = 25] = args.filter((arg) => !arg.startsWith("--")).map(Number);

const TLDS = ["com", "co.uk", "github.io", "ck", "kawasaki.jp", "city.kawasaki.jp", "ru", "com.ru", "xn--p1ai", "test", "localhost", "cloudfront.net", "blogspot.com", "s3.amazonaws.com", "zzz", "_", "a-", "io"];
const LABELS = ["a", "b", "x", "www", "cdn", "ads", "img", "co", "uk", "ru", "com", "github", "io", "city", "xn--p1ai", "_", "-", "a-b", "xn--80a", "s3", "0a", "9", "y".repeat(63), "q_q", "--", "ck", "localhost"];
const ODD_URLS = ["http://[::1]/", "http://127.1/", "http://A.COM./", "http://x.localhost/", "http://localhost.x.localhost/", "http://a.co.uk/", "http://co.uk/", "http://github.io/", "http://e.x.github.io.../", "http://s3.amazonaws.com/b/k", `http://a${".".repeat(3000)}b.com/`];

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const findings = new Map();
const flag = (kind, sample) => {
  if (!findings.has(kind)) findings.set(kind, { count: 0, sample });
  findings.get(kind).count += 1;
};

function userPacText({ roots, deny, bypass }) {
  return [
    ...deny.map((mask) => `deny(${JSON.stringify(mask)});`),
    ...bypass.map((mask) => `bypass(${JSON.stringify(mask)});`),
    "function FindProxyForURL(url, host) {",
    ...roots.map((mask, i) => `  if (root(host, ${JSON.stringify(mask)})) return "PROXY p${i}.proxy:1";`),
    '  return "DIRECT";',
    "}",
  ].join("\n");
}

function loadPac(text) {
  const context = vm.createContext({});
  vm.runInContext(LIBRARY, context);
  vm.runInContext(mutate ? text.replace(...MUTATION) : text, context);
  return context;
}

function route(pac, host) {
  try {
    return pac.FindProxyForURL(`https://${host}/`, host);
  } catch {
    return "THROW";
  }
}

const userDecision = (host, roots) => {
  const i = roots.findIndex((mask) => covers(mask, host));
  return i < 0 ? "DIRECT" : `PROXY p${i}.proxy:1`;
};

function oracle(host, { roots, bypass }, groups) {
  if (roots.some((mask) => covers(mask, host))) return userDecision(host, roots);
  const masks = Object.keys(groups).sort();
  let found = null;
  const labels = host.split(".");
  for (let k = labels.length - 1; k >= 0; k--) {
    const name = labels.slice(k).join(".");
    if (name.length > 253 || (k > 0 && PSL.isPublicSuffix(name))) continue;
    const mask = masks.find((m) => Object.hasOwn(groups[m].hosts, name));
    if (mask !== undefined) found = groups[mask];
  }
  if (found !== null) return userDecision(found.rootHost, roots);
  return firstMatch(host, bypass) !== null ? "DIRECT" : userDecision(host, roots);
}

function allowedInRootContext(rules, host, top) {
  const url = `https://${host}/`;
  let best = null;
  const within = (list, name) => list.some((domain) => covers(domain, name));
  for (const rule of [...rules.dynamic, ...rules.session]) {
    const c = rule.condition;
    if (rule.action.type === "modifyHeaders" || (c.resourceTypes && !c.resourceTypes.includes("script"))) continue;
    if ((c.topDomains && !within(c.topDomains, top)) || (c.initiatorDomains && !within(c.initiatorDomains, top))) continue;
    if ((c.requestDomains && !within(c.requestDomains, host)) || (c.regexFilter && !new RegExp(c.regexFilter).test(url))) continue;
    const priority = rule.priority ?? 1;
    if (best === null || priority > best.priority || (priority === best.priority && rule.action.type === "block")) best = { priority, type: rule.action.type };
  }
  return best?.type === "allow";
}

function probesOf(groups, analysis, extra) {
  const probes = new Set(extra);
  const add = (name) => {
    if (name === null || name === undefined) return;
    const labels = name.split(".");
    for (let k = 0; k < labels.length - 1; k++) probes.add(labels.slice(k).join("."));
    probes.add(`zz.${name}`);
  };
  for (const group of Object.values(groups)) {
    Object.keys(group.hosts).forEach(add);
    add(group.rootHost);
  }
  [...analysis.roots, ...analysis.deny, ...analysis.bypass].forEach((mask) => add(maskDomain(mask)));
  return [...probes].filter((name) => isHostName(name) || name.length > 253);
}

function check(tag, state, analysis, userPac, extra, learnedAlone) {
  let pac;
  let rules;
  try {
    pac = buildSystemPac(userPac, state.groups, PSL);
    rules = buildRules(policyOf({ enabled: true, analysis, groups: state.groups }, PSL));
  } catch (error) {
    flag("build or rules throw", { tag, message: error.message });
    return null;
  }
  const again = aggregateGroups(state.groups, {}, analysis, PSL).groups;
  if (JSON.stringify(again) !== JSON.stringify(state.groups)) flag("aggregation not idempotent", { tag });
  const context = loadPac(pac);
  for (const host of probesOf(state.groups, analysis, extra)) {
    const got = route(context, host);
    const expected = oracle(host, analysis, state.groups);
    if (got !== expected) flag("router differs from the oracle", { tag, host, got, expected });
    const bypassed = firstMatch(host, analysis.bypass) !== null;
    for (const top of analysis.roots) {
      if (!allowedInRootContext(rules, host, top)) continue;
      if (got === "DIRECT" && !bypassed) flag("LEAK: DNR allows what the PAC sends DIRECT", { tag, host, top });
      if (underLocalhost(host) && !bypassed) flag("a localhost name is allowed in a root context", { tag, host });
    }
  }
  for (const [mask, group] of Object.entries(state.groups)) {
    for (const host of Object.keys(group.hosts)) {
      if (!learnedAlone.has(host) && PSL.isPublicSuffix(host)) flag("aggregation produced a public suffix", { tag, mask, host });
    }
  }
  return { state, analysis, pac };
}

function transition(tag, prev, next) {
  if (prev === null || next === null) return;
  const policy = intersectPolicies(policyOf({ enabled: true, analysis: prev.analysis, groups: prev.state.groups }, PSL), policyOf({ enabled: true, analysis: next.analysis, groups: next.state.groups }, PSL));
  const rules = buildRules(policy);
  const contexts = [loadPac(prev.pac), loadPac(next.pac)];
  const probes = new Set([...probesOf(prev.state.groups, prev.analysis, []), ...probesOf(next.state.groups, next.analysis, [])]);
  for (const host of probes) {
    for (const top of policy.blockRoots.map(maskDomain)) {
      if (!allowedInRootContext(rules, host, top)) continue;
      for (const context of contexts) {
        if (route(context, host) === "DIRECT" && firstMatch(host, policy.bypass) === null) flag("LEAK: a transition allows what a PAC sends DIRECT", { tag, host, top });
      }
    }
  }
}

function scenario(random) {
  const pick = (items) => items[Math.floor(random() * items.length)];
  const name = (depth) => [...Array.from({ length: depth }, () => pick(LABELS)), pick(TLDS)].join(".");
  const pool = Array.from({ length: 14 }, () => name(1 + Math.floor(random() * 3)));
  const tail = (host) => host.split(".").slice(Math.floor(random() * host.split(".").length)).join(".");
  const mask = () => (random() < 0.7 ? tail(pick(pool)) : name(1 + Math.floor(random() * 2)));
  const config = () => {
    const roots = [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, mask))];
    const deny = Array.from({ length: Math.floor(random() * 3) }, () => (random() < 0.5 ? "*." : "") + mask());
    const bypass = Array.from({ length: Math.floor(random() * 4) }, () => (random() < 0.6 ? "*." : "") + (random() < 0.2 ? pick(["ru", "com", "uk", "io", "test", "_", "xn--p1ai", "localhost"]) : mask()));
    return { roots, deny, bypass };
  };
  return { pick, name, pool, config };
}

function fuzz(seed) {
  let steps = 0;
  for (let run = 0; run < RUNS; run++) {
    const random = prng(seed * 100003 + run);
    const s = scenario(random);
    let userPac = userPacText(s.config());
    let result = analyzeUserPac(userPac);
    if (!result.ok) continue;
    let analysis = { roots: result.roots, deny: result.deny, bypass: result.bypass };
    let state = { groups: reconcileGroups({}, analysis), seen: {} };
    const learnedAlone = new Set();
    let previous = null;
    for (let step = 0; step < STEPS; step++) {
      const tag = `seed ${seed} run ${run} step ${step}`;
      const roll = random();
      const extra = [];
      if (roll < 0.7) {
        const batch = new Map();
        const index = hostIndex(state.groups);
        for (let i = 1 + Math.floor(random() * 4); i > 0; i--) {
          const url = random() < 0.15 ? s.pick(ODD_URLS) : `https://${random() < 0.5 ? s.pick(s.pool) : s.name(1 + Math.floor(random() * 4))}/`;
          const host = hostFromUrl(url);
          if (host === null) continue;
          extra.push(host);
          const mask = s.pick(analysis.roots);
          const rootHost = random() < 0.5 ? mask : `${s.pick(LABELS)}.${mask}`;
          if (isHostName(rootHost) && !batch.has(host) && isLearnable(host, analysis, index, PSL)) batch.set(host, { mask, rootHost });
        }
        if (batch.size > 0) {
          for (const host of batch.keys()) learnedAlone.add(host);
          state = aggregateGroups(mergeGroups(state.groups, batch, step), state.seen, analysis, PSL);
          const after = hostIndex(state.groups);
          for (const host of batch.keys()) if (isLearnable(host, analysis, after, PSL)) flag("a learned host is learnable again", { tag, host });
        }
      } else if (roll < 0.85) {
        const text = userPacText(s.config());
        result = analyzeUserPac(text);
        if (!result.ok) continue;
        userPac = text;
        analysis = { roots: result.roots, deny: result.deny, bypass: result.bypass };
        const adopted = adoptLegacyGroups(state.groups, state.seen, analysis.roots);
        const reconciled = reconcileGroups(adopted.groups, analysis);
        state = aggregateGroups(reconciled, pruneSeen(adopted.seen, reconciled), analysis, PSL);
      } else if (roll < 0.93) {
        const masks = Object.keys(state.groups).filter((mask) => Object.keys(state.groups[mask].hosts).length > 0);
        if (masks.length === 0) continue;
        const mask = s.pick(masks);
        const hosts = { ...state.groups[mask].hosts };
        delete hosts[s.pick(Object.keys(hosts))];
        state = { groups: { ...state.groups, [mask]: { rootHost: state.groups[mask].rootHost, hosts } }, seen: pruneSeen(state.seen, state.groups) };
      } else {
        try {
          const read = readBackup(JSON.parse(JSON.stringify(exportBackup({ userPac, groups: state.groups }))));
          buildSystemPac(read.userPac, read.groups, PSL);
          state = { groups: aggregateGroups(read.groups, {}, read.analysis, PSL).groups, seen: {} };
        } catch (error) {
          flag("export and import do not round-trip", { tag, message: error.message });
        }
      }
      steps += 1;
      const current = check(tag, state, analysis, userPac, extra, learnedAlone);
      if (current !== null) transition(tag, previous, current);
      previous = current;
    }
  }
  return steps;
}

function orderIndependence(seed) {
  const random = prng(seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  let differing = 0;
  let total = 0;
  for (let run = 0; run < RUNS; run++) {
    const base = pick(["e.com", "e.co.uk", "x.ck", "www.ck", "e.city.kawasaki.jp", "b.kawasaki.jp"]);
    const universe = Array.from({ length: 12 }, () => [...Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(["a", "b", "c", "www"])), base].join("."));
    const tail = (host) => host.split(".").slice(Math.floor(random() * 3)).join(".");
    const deny = Array.from({ length: Math.floor(random() * 3) }, () => (random() < 0.5 ? "*." : "") + tail(pick(universe)));
    const result = analyzeUserPac(userPacText({ roots: ["root.org"], deny, bypass: [] }));
    if (!result.ok) continue;
    const analysis = { roots: result.roots, deny: result.deny, bypass: result.bypass };
    const learn = (hosts, size) => {
      let groups = reconcileGroups({}, analysis);
      for (let i = 0; i < hosts.length; i += size) {
        const index = hostIndex(groups);
        const batch = new Map(hosts.slice(i, i + size).filter((host) => isLearnable(host, analysis, index, PSL)).map((host) => [host, { mask: "root.org", rootHost: "root.org" }]));
        if (batch.size > 0) groups = aggregateGroups(mergeGroups(groups, batch, i), {}, analysis, PSL).groups;
      }
      return Object.keys(groups["root.org"].hosts).sort().join(" ");
    };
    total += 1;
    const forward = learn(universe, 1);
    if (forward !== learn([...universe].reverse(), 1) || forward !== learn(universe, universe.length)) differing += 1;
  }
  return { differing, total };
}

let steps = 0;
for (let seed = 1; seed <= SEEDS; seed++) steps += fuzz(seed);
const order = orderIndependence(SEEDS);
console.log(`steps ${steps}${mutate ? " (mutated router)" : ""}`);
console.log(`order of learning changed the records in ${order.differing} of ${order.total} scenarios (widening to the widest allowed level depends on whether a parent was requested itself first)`);
for (const [kind, { count, sample }] of findings) console.log(`  - ${kind}: ${count}, e.g. ${JSON.stringify(sample).slice(0, 400)}`);
console.log(`RESULT: ${findings.size === 0 ? "PASS" : "FAIL"}`);
process.exit(findings.size === 0 ? 0 : 1);
