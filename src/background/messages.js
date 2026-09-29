import { analyzeUserPac } from "../core/analyze.js";
import { exportBackup, readBackup } from "../core/backup.js";
import { buildSystemPac } from "../core/build.js";
import { rootOf } from "../core/hosts.js";
import { adoptLegacyGroups, aggregateGroups, pruneSeen, reconcileGroups } from "../core/groups.js";
import { answersOf, bootstrapSites, normalizeSites, proxiesOf, releaseSites, routeSites, sharedRoutes } from "../core/routes.js";
import { trialAnswers, trialErrors, trialPlan } from "../core/trial.js";
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


export function createCommands({ store, engine, checker, learner, log = NO_LOG, now = Date.now }) {
  // The groups, their seen times and the site owners for a User PAC, from the state it replaces.
  const normalize = (state, analysis) => {
    const adopted = adoptLegacyGroups(state.groups, state.seen, analysis.roots);
    const owners = state.sites ?? bootstrapSites(adopted.groups, state.analysis?.roots ?? analysis.roots, store.psl);
    const reconciled = releaseSites(reconcileGroups(adopted.groups, analysis), owners, analysis.roots, store.psl);
    const { groups, seen } = aggregateGroups(reconciled, pruneSeen(adopted.seen, reconciled), analysis, store.psl);
    const sites = normalizeSites(owners, groups, analysis.roots, store.psl, state.analysis?.roots ?? []);
    return { groups, seen, sites };
  };

  // Groups changed by a command: the owners of sites nobody holds any more are dropped.
  const rebuild = (state, groups, seen, sites = normalizeSites(state.sites, groups, state.analysis.roots, store.psl)) => ({
    ...state,
    groups,
    seen,
    sites,
    appliedPac: buildSystemPac(state.userPac, groups, store.psl, sites),
  });

  const trial = async (userPac, analysis, { groups, sites }) => {
    const systemPac = buildSystemPac(userPac, groups, store.psl, sites);
    const { request, shifts } = trialPlan(systemPac, analysis, groups);
    const { cancelled, outcome } = await checker.run(request);
    if (cancelled) throw new Error("Check was cancelled");
    return { errors: trialErrors(outcome, { systemPac, userPac, shifts }), answers: trialAnswers(outcome) };
  };

  const saveUserPac = async ({ text }) => {
    requireString(text, "text");
    const result = analyzeUserPac(text, store.psl);
    if (!result.ok) return { ok: false, errors: result.errors };
    const analysis = { roots: result.roots, deny: result.deny, bypass: result.bypass };
    const { errors, answers } = await trial(text, analysis, normalize(store.state, analysis));
    if (errors.length > 0) return { ok: false, errors };
    return store.run(async (state) => {
      const { groups, seen, sites } = normalize(state, analysis);
      const next = rebuild({ ...state, userPac: text, analysis, userPacErrors: null, proxies: proxiesOf(groups, answers) }, groups, seen, sites);
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

  // Route here: the root takes the sites of these names, hosts it holds or root domains; every host of those sites, in
  // any group, then goes through its proxy.
  const routeHere = async ({ mask, hosts }) => {
    if (!Array.isArray(hosts) || hosts.length === 0) throw new TypeError("hosts must be a non-empty array");
    for (const host of hosts) requireString(host, "host");
    return store.run(async (state) => {
      requireValidUserPac(state);
      const group = requireGroup(state, mask);
      for (const host of hosts) {
        if (!Object.hasOwn(group.hosts, host) && !state.analysis.roots.includes(host)) throw new Error(`Host ${JSON.stringify(host)} is not in group ${JSON.stringify(mask)}`);
      }
      const sites = routeSites(state.sites, mask, hosts, store.psl);
      if (sites === state.sites) return { ok: true, control: null };
      return { ok: true, control: await engine.commit(rebuild(state, state.groups, state.seen, sites)) };
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
    const read = readBackup(backup, store.psl);
    if (!read.ok) return { ok: false, errors: read.errors };
    const { userPac, analysis } = read;
    buildSystemPac(userPac, read.groups, store.psl);
    // Owners the backup names win; a site it names no owner for, or a schema 1 backup, gets the route it had.
    const owners = { ...bootstrapSites(read.groups, analysis.roots, store.psl), ...(read.sites ?? {}) };
    const { groups } = aggregateGroups(releaseSites(read.groups, owners, analysis.roots, store.psl), {}, analysis, store.psl);
    const sites = normalizeSites(owners, groups, analysis.roots, store.psl);
    const { errors, answers } = await trial(userPac, analysis, { groups, sites });
    if (errors.length > 0) return { ok: false, errors };
    return store.run(async (state) => {
      const next = rebuild({ ...state, userPac, analysis, userPacErrors: null, proxies: proxiesOf(groups, answers) }, groups, {}, sites);
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
    const answers = answersOf(store.state);
    return {
      ok: true,
      mask,
      rootHost: group?.rootHost ?? null,
      // The root itself and its learned hosts: what the System PAC viewer lists for the group.
      hostCount: group === null ? 0 : Object.keys(group.hosts).length + 1,
      loaded: learner.loaded(tabId),
      proxied: learner.proxied(tabId),
      newHosts: learner.newHosts(tabId),
      incomplete: learner.incomplete(tabId),
      proxyError: learner.proxyError(tabId),
      conflicts: learner.conflicts(tabId).map((item) => ({ ...item, proxy: answers[item.root] ?? null, ownerProxy: answers[item.owner] ?? null })),
    };
  };

  const getRoutes = async () => ({ ok: true, roots: sharedRoutes(store.state, store.psl) });

  const handlers = { saveUserPac, setEnabled, removeHost, routeHere, clearGroup, getTabState, getRoutes, exportState, importState, cancelCheck };

  // What a command changed, for the diagnostic log; read-only commands are not logged.
  const userPac = (message, response) => (response.ok ? { roots: response.analysis.roots.length } : { problems: response.errors?.length ?? 0, error: response.error });
  const describe = {
    saveUserPac: userPac,
    importState: userPac,
    setEnabled: ({ enabled }, response) => ({ enabled, error: response.error }),
    removeHost: ({ mask, host }, response) => ({ root: mask, host, error: response.error }),
    routeHere: ({ mask, hosts }, response) => ({ root: mask, hosts, error: response.error }),
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
