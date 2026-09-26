import { analyzeUserPac } from "../core/analyze.js";
import { buildSystemPac } from "../core/build.js";
import { adoptLegacyGroups, aggregateGroups, pruneSeen, reconcileGroups } from "../core/groups.js";
import { LOG_SETTING } from "./log.js";

export const SCHEMA_VERSION = 1;

const GROUP = "group:";
const SEEN = "seen:";
const VERIFIED = "stateVerified";
const SCALARS = ["enabled", "userPac", "analysis", "appliedPac", "userPacErrors"];
// Settings of the pages that are not part of the routing state; the store leaves them alone.
const SETTINGS = new Set([LOG_SETTING]);

function decode(items) {
  const state = { enabled: true, userPac: null, analysis: null, appliedPac: null, userPacErrors: null, groups: {}, seen: {} };
  for (const [key, value] of Object.entries(items)) {
    if (key === "schemaVersion" || SETTINGS.has(key)) continue;
    if (SCALARS.includes(key)) state[key] = value;
    else if (key.startsWith(GROUP)) state.groups[key.slice(GROUP.length)] = value;
    else if (key.startsWith(SEEN)) state.seen[key.slice(SEEN.length)] = value;
    else throw new Error(`Unknown storage key ${JSON.stringify(key)}`);
  }
  if (typeof state.enabled !== "boolean") throw new Error("Stored enabled flag is not a boolean");
  if ((state.userPac === null) !== (state.analysis === null) || (state.userPac === null) !== (state.appliedPac === null)) {
    throw new Error("Stored userPac, analysis and appliedPac are inconsistent");
  }
  if (state.userPacErrors !== null && (state.userPac === null || !Array.isArray(state.userPacErrors))) {
    throw new Error("Stored userPacErrors are inconsistent");
  }
  for (const key of ["userPac", "appliedPac"]) {
    if (state[key] !== null && typeof state[key] !== "string") throw new Error(`Stored ${key} is not a string`);
  }
  if (state.analysis !== null && !isAnalysis(state.analysis)) throw new Error("Stored analysis is malformed");
  for (const [mask, group] of Object.entries(state.groups)) {
    const valid = isRecord(group) && (group.rootHost === null || typeof group.rootHost === "string") && isRecord(group.hosts) && Object.values(group.hosts).every(isTime);
    if (!valid) throw new Error(`Stored group ${JSON.stringify(mask)} is malformed`);
  }
  for (const [mask, seen] of Object.entries(state.seen)) {
    if (!isRecord(seen) || !Object.values(seen).every(isTime)) throw new Error(`Stored seen records of ${JSON.stringify(mask)} are malformed`);
  }
  if (state.analysis !== null && !Object.hasOwn(state.analysis, "bypass")) state.analysis = { ...state.analysis, bypass: [] };
  return state;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isAnalysis(analysis) {
  const masks = (list) => Array.isArray(list) && list.every((mask) => typeof mask === "string");
  return isRecord(analysis) && masks(analysis.roots) && masks(analysis.deny) && (analysis.bypass === undefined || masks(analysis.bypass));
}

function refresh(state, psl) {
  if (state.userPac === null) return { ...state, groups: {}, seen: {} };
  const result = analyzeUserPac(state.userPac);
  if (!result.ok) {
    const same = JSON.stringify(result.errors) === JSON.stringify(state.userPacErrors);
    return { ...state, userPacErrors: same ? state.userPacErrors : result.errors };
  }
  const fresh = { roots: result.roots, deny: result.deny, bypass: result.bypass };
  const analysis = JSON.stringify(fresh) === JSON.stringify(state.analysis) ? state.analysis : fresh;
  const adopted = adoptLegacyGroups(state.groups, state.seen, analysis.roots);
  const reconciled = reconcileGroups(adopted.groups, analysis);
  const { groups, seen } = aggregateGroups(reconciled, pruneSeen(adopted.seen, reconciled), analysis, psl);
  return { ...state, analysis, groups, seen, appliedPac: buildSystemPac(state.userPac, groups, psl), userPacErrors: null };
}

function diffRecords(prefix, prev, next, set, remove) {
  for (const [key, value] of Object.entries(next)) {
    if (prev[key] !== value) set[prefix + key] = value;
  }
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key)) remove.push(prefix + key);
  }
}

export function diffState(prev, next) {
  const set = {};
  const remove = [];
  for (const key of SCALARS) {
    if (prev[key] === next[key]) continue;
    if (next[key] === null) remove.push(key);
    else set[key] = next[key];
  }
  diffRecords(GROUP, prev.groups, next.groups, set, remove);
  diffRecords(SEEN, prev.seen, next.seen, set, remove);
  return { set, remove };
}

export class Store {
  #area;
  #session;
  #psl = null;
  #state = null;
  #stale = [];
  #verified = false;
  #tail = Promise.resolve();

  constructor(area, session) {
    if (area === undefined || session === undefined) throw new TypeError("Store needs the local and session storage areas");
    this.#area = area;
    this.#session = session;
  }

  get psl() {
    if (this.#psl === null) throw new Error("Store is not loaded");
    return this.#psl;
  }

  get state() {
    if (this.#state === null) throw new Error("Store is not loaded");
    return this.#state;
  }

  async load(psl) {
    if (typeof psl?.registrableDomain !== "function" || typeof psl.isPublicSuffix !== "function") throw new TypeError("Store needs the public suffix list");
    this.#psl = psl;
    const [items, { [VERIFIED]: verified }] = await Promise.all([this.#area.get(null), this.#session.get(VERIFIED)]);
    this.#verified = verified === true;
    if (Object.keys(items).every((key) => SETTINGS.has(key))) {
      this.#state = decode({});
      await this.#mark(false);
      await this.#area.set({ schemaVersion: SCHEMA_VERSION, enabled: this.#state.enabled });
      await this.#mark(true);
      return this.#state;
    }
    if (items.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Unsupported storage schema version ${JSON.stringify(items.schemaVersion)}`);
    }
    this.#state = decode(items);
    if (!this.#verified) await this.commit(refresh(this.#state, psl));
    return this.#state;
  }

  async #mark(verified) {
    if (this.#verified === verified) return;
    if (!verified) {
      await this.#session.set({ [VERIFIED]: false });
      this.#verified = false;
      return;
    }
    try {
      await this.#session.set({ [VERIFIED]: true });
      this.#verified = true;
    } catch {
      this.#verified = false;
    }
  }

  run(task) {
    const result = this.#tail.then(() => task(this.state));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async commit(next) {
    const { set, remove } = diffState(this.state, next);
    const removing = [...new Set([...remove, ...this.#stale])].filter((key) => !Object.hasOwn(set, key));
    const writing = Object.keys(set).length > 0;
    if (writing || removing.length > 0) await this.#mark(false);
    if (writing) await this.#area.set(set);
    this.#state = next;
    this.#stale = [];
    if (removing.length > 0) {
      try {
        await this.#area.remove(removing);
      } catch {
        this.#stale = removing;
      }
    }
    if (this.#stale.length === 0) await this.#mark(true);
    return next;
  }
}
