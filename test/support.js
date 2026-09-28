import { parsePublicSuffixList } from "../src/core/psl.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const FIXTURES = new URL("./fixtures/", import.meta.url);

export function fixture(name) {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export function loadPac(text) {
  const context = vm.createContext({});
  vm.runInContext(fixture("pac-utils.pac"), context);
  vm.runInContext(text, context);
  return context;
}

export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIBRARY = readFileSync(new URL("../vendor/pac-library.js", import.meta.url), "utf8");
const RUNNER = readFileSync(new URL("../src/sandbox/runner.js", import.meta.url), "utf8");

export function runTrial(request) {
  const context = vm.createContext({});
  vm.runInContext(LIBRARY, context);
  vm.runInContext(RUNNER, context);
  return structuredClone(context.rootpacTrial(structuredClone(request)));
}

export function vmChecker() {
  return {
    requests: [],
    async run(request) {
      this.requests.push(request);
      return { cancelled: false, outcome: runTrial(request) };
    },
    async probe(request) {
      this.requests.push(request);
      return runTrial(request);
    },
    async cancel() {
      return false;
    },
  };
}

// How Chrome's declarativeNetRequest decides a request: the highest priority matching rule wins, a block before an
// allow of the same priority, and nothing matching lets it pass.
export function dnrDecision(rules, { host, top = null, initiator = null, type = "script" }) {
  const within = (list, name) => name !== null && list.some((domain) => name === domain || name.endsWith(`.${domain}`));
  let best = null;
  for (const rule of rules) {
    const c = rule.condition;
    if (rule.action.type === "modifyHeaders") continue;
    if (c.resourceTypes && !c.resourceTypes.includes(type)) continue;
    if (c.excludedResourceTypes && c.excludedResourceTypes.includes(type)) continue;
    if (c.topDomains && !within(c.topDomains, top)) continue;
    if (c.excludedTopDomains && within(c.excludedTopDomains, top)) continue;
    if (c.initiatorDomains && !within(c.initiatorDomains, initiator)) continue;
    if (c.excludedInitiatorDomains && within(c.excludedInitiatorDomains, initiator)) continue;
    if (c.requestDomains && !within(c.requestDomains, host)) continue;
    if (c.excludedRequestDomains && within(c.excludedRequestDomains, host)) continue;
    if (c.regexFilter && !new RegExp(c.regexFilter, "i").test(`https://${host}/`)) continue;
    const priority = rule.priority ?? 1;
    if (best === null || priority > best.priority || (priority === best.priority && rule.action.type === "block")) best = { priority, type: rule.action.type };
  }
  return best?.type ?? "allow";
}

export const PSL = parsePublicSuffixList(readFileSync(new URL("../vendor/public_suffix_list.dat", import.meta.url), "utf8"));
