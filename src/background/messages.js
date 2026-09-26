import { analyzeUserPac } from "../core/analyze.js";
import { exportBackup, readBackup } from "../core/backup.js";
import { buildSystemPac } from "../core/build.js";
import { rootOf } from "../core/hosts.js";
import { adoptLegacyGroups, aggregateGroups, pruneSeen, reconcileGroups } from "../core/groups.js";
import { trialErrors, trialPlan } from "../core/trial.js";
import { NO_LOG } from "./log.js";

function requireString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
}

function requireGroup(state, mask) {
  requireString(mask, "mask");
  if (!Object.hasOwn(state.groups, mask)) throw new Error(`Unknown group ${JSON.stringify(mask)}`);
  return state.groups[mask];
}

function requireValidUserPac(state) {
  if (state.userPacErrors !== null) throw new Error("User PAC must be fixed first");
}


export function createCommands({ store, engine, checker, learner, log = NO_LOG }) {
  const normalize = (groups, seen, analysis) => {
    const adopted = adoptLegacyGroups(groups, seen, analysis.roots);
    const reconciled = reconcileGroups(adopted.groups, analysis);
    return aggregateGroups(reconciled, pruneSeen(adopted.seen, reconciled), analysis, store.psl);
  };

  const rebuild = (state, groups, seen) => ({ ...state, groups, seen, appliedPac: buildSystemPac(state.userPac, groups, store.psl) });

  const trial = async (userPac, analysis, groups) => {
    const systemPac = buildSystemPac(userPac, groups, store.psl);
    const { request, shifts } = trialPlan(systemPac, analysis, groups);
    const { cancelled, outcome } = await checker.run(request);
    if (cancelled) throw new Error("Check was cancelled");
    return trialErrors(outcome, { systemPac, userPac, shifts });
  };

  const saveUserPac = async ({ text }) => {
    requireString(text, "text");
    const result = analyzeUserPac(text);
    if (!result.ok) return { ok: false, errors: result.errors };
    const analysis = { roots: result.roots, deny: result.deny, bypass: result.bypass };
    const errors = await trial(text, analysis, normalize(store.state.groups, store.state.seen, analysis).groups);
    if (errors.length > 0) return { ok: false, errors };
    return store.run(async (state) => {
      const { groups, seen } = normalize(state.groups, state.seen, analysis);
      const next = rebuild({ ...state, userPac: text, analysis, userPacErrors: null }, groups, seen);
      const control = await engine.commit(next);
      return { ok: true, errors: [], analysis, control };
    });
  };

  const setEnabled = async ({ enabled }) => {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    return store.run(async (state) => ({ ok: true, control: await engine.commit({ ...state, enabled }) }));
  };

  const removeHost = async ({ mask, host }) => {
    requireString(host, "host");
    return store.run(async (state) => {
      requireValidUserPac(state);
      const group = requireGroup(state, mask);
      if (!Object.hasOwn(group.hosts, host)) throw new Error(`Host ${JSON.stringify(host)} is not in group ${JSON.stringify(mask)}`);
      const hosts = { ...group.hosts };
      delete hosts[host];
      const groups = { ...state.groups, [mask]: { rootHost: group.rootHost, hosts } };
      return { ok: true, control: await engine.commit(rebuild(state, groups, pruneSeen(state.seen, groups))) };
    });
  };

  const clearGroup = async ({ mask }) => {
    return store.run(async (state) => {
      requireValidUserPac(state);
      requireGroup(state, mask);
      const groups = { ...state.groups, [mask]: { rootHost: null, hosts: {} } };
      return { ok: true, control: await engine.commit(rebuild(state, groups, pruneSeen(state.seen, groups))) };
    });
  };

  const exportState = async () => store.run(async (state) => ({ ok: true, backup: exportBackup(state) }));

  const importState = async ({ backup }) => {
    const read = readBackup(backup);
    if (!read.ok) return { ok: false, errors: read.errors };
    const { userPac, analysis } = read;
    buildSystemPac(userPac, read.groups, store.psl);
    const { groups } = aggregateGroups(read.groups, {}, analysis, store.psl);
    const errors = await trial(userPac, analysis, groups);
    if (errors.length > 0) return { ok: false, errors };
    return store.run(async (state) => {
      const next = rebuild({ ...state, userPac, analysis, userPacErrors: null }, groups, {});
      const control = await engine.commit(next);
      return { ok: true, errors: [], analysis, control };
    });
  };

  const cancelCheck = async () => ({ ok: true, cancelled: await checker.cancel() });

  const getTabState = async ({ tabId }) => {
    if (!Number.isSafeInteger(tabId)) throw new TypeError("tabId must be an integer");
    const { analysis, groups } = store.state;
    const host = learner.tabHost(tabId);
    const mask = analysis === null || host === null ? null : rootOf(host, analysis.roots);
    const group = mask === null ? null : groups[mask];
    return {
      ok: true,
      mask,
      rootHost: group?.rootHost ?? null,
      hostCount: group === null ? 0 : Object.keys(group.hosts).length,
      loaded: learner.loaded(tabId),
      proxied: learner.proxied(tabId),
      newHosts: learner.newHosts(tabId),
      incomplete: learner.incomplete(tabId),
      proxyError: learner.proxyError(tabId),
    };
  };

  const handlers = { saveUserPac, setEnabled, removeHost, clearGroup, getTabState, exportState, importState, cancelCheck };

  // What a command changed, for the diagnostic log; read-only commands are not logged.
  const userPac = (message, response) => (response.ok ? { roots: response.analysis.roots.length } : { problems: response.errors?.length ?? 0, error: response.error });
  const describe = {
    saveUserPac: userPac,
    importState: userPac,
    setEnabled: ({ enabled }, response) => ({ enabled, error: response.error }),
    removeHost: ({ mask, host }, response) => ({ root: mask, host, error: response.error }),
    clearGroup: ({ mask }, response) => ({ root: mask, error: response.error }),
  };

  const run = async (handler, message) => {
    try {
      return await handler(message);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    async dispatch(message) {
      const type = message !== null && typeof message === "object" ? message.type : undefined;
      const handler = typeof type === "string" && Object.hasOwn(handlers, type) ? handlers[type] : null;
      if (handler === null) return { ok: false, error: `Unknown command ${JSON.stringify(type)}` };
      const response = await run(handler, message);
      if (log.on && Object.hasOwn(describe, type)) log.add("command", { command: type, ok: response.ok, ...describe[type](message, response) });
      return response;
    },
  };
}
