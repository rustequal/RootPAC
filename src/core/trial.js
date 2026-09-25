import { userPacLine } from "./build.js";
import { instrument, originalColumn } from "./fuel.js";

export const STEP_BUDGET = 1_000_000;
export const NEUTRAL_HOST = "example.com";
export const TRIAL_TARGET = "rootpac-trial";

const SOURCE_URL = "\n//# sourceURL=rootpac-trial.pac\n";
const KINDS = new Set(["budget", "noproxy", "throw"]);
const STAGES = new Set(["init", "probe"]);

export function probeHosts({ roots }, groups) {
  const hosts = new Set();
  for (const mask of roots) {
    hosts.add(mask);
    const rootHost = groups[mask]?.rootHost ?? null;
    if (rootHost !== null) hosts.add(rootHost);
  }
  hosts.add(NEUTRAL_HOST);
  return [...hosts];
}

export function trialPlan(systemPac, analysis, groups) {
  const { code, shifts } = instrument(systemPac);
  return { request: { code: code + SOURCE_URL, budget: STEP_BUDGET, hosts: probeHosts(analysis, groups) }, shifts };
}

function isPosition(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 1);
}

function checkOutcome(outcome) {
  if (typeof outcome !== "object" || outcome === null) throw new Error("Trial run returned no result");
  if (outcome.ok === true) return;
  const valid =
    outcome.ok === false &&
    STAGES.has(outcome.stage) &&
    KINDS.has(outcome.kind) &&
    typeof outcome.message === "string" &&
    (outcome.stage === "init" ? outcome.host === null : typeof outcome.host === "string") &&
    isPosition(outcome.line) &&
    isPosition(outcome.column) &&
    (outcome.line === null) === (outcome.column === null);
  if (!valid) throw new Error("Trial run returned a malformed result");
}

function describe({ stage, kind, host, message }) {
  if (kind === "budget") return "User PAC exceeded the step budget (possible infinite loop)";
  if (kind === "noproxy") return `User PAC returned no proxy for ${host}`;
  return stage === "init" ? `User PAC failed to initialize: ${message}` : `User PAC threw for ${host}: ${message}`;
}

export function trialErrors(outcome, { systemPac, userPac, shifts }) {
  checkOutcome(outcome);
  if (outcome.ok) return [];
  const line = outcome.line === null ? null : userPacLine(systemPac, userPac, outcome.line);
  const column = line === null ? null : originalColumn(shifts, outcome.line, outcome.column);
  return [{ line, column, message: describe(outcome) }];
}
