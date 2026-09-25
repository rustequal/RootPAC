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
    async cancel() {
      return false;
    },
  };
}

export const PSL = parsePublicSuffixList(readFileSync(new URL("../vendor/public_suffix_list.dat", import.meta.url), "utf8"));
