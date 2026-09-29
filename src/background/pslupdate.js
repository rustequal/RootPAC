import { analyzeUserPac } from "../core/analyze.js";
import { PSL_URL, isNewerPsl, pslVersion, readPublicSuffixList } from "../core/pslsource.js";
import { NO_LOG } from "./log.js";
import { PSL_KEYS, refresh } from "./store.js";

export const PSL_ALARM = "pslUpdate";
export const PSL_PERIOD_MINUTES = 7 * 24 * 60;
const PERIOD_MS = PSL_PERIOD_MINUTES * 60 * 1000;
const TIMEOUT_MS = 30_000;

const ignore = () => undefined;
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const released = ({ version, commit }) => ({ version, commit });

// The public suffix list in use (4.8): the bundled snapshot or a newer one downloaded from publicsuffix.org, from the
// Options page or by the weekly alarm. A list the saved User PAC does not pass with is not installed: it is kept as
// the conflict (Options, popup and the icon show it) until a User PAC that passes brings it in.
export function createPslUpdater({ store, engine, area, alarms, fetch, bundledUrl, now = Date.now, log = NO_LOG }) {
  let installed = null;
  let conflict = null;
  let tail = Promise.resolve();

  // One download or install at a time: a second press of Update waits for the first.
  const serial = (task) => {
    const result = tail.then(task);
    tail = result.then(ignore, ignore);
    return result;
  };

  const status = () => ({ installed, conflict });

  const download = async () => {
    let response;
    try {
      response = await fetch(PSL_URL, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`Cannot reach publicsuffix.org: ${messageOf(error)}`);
    }
    if (!response.ok) throw new Error(`publicsuffix.org answered HTTP ${response.status}`);
    const text = await response.text();
    return { ...readPublicSuffixList(text), text };
  };

  const setConflict = async (value) => {
    conflict = value;
    if (value === null) await area.remove([PSL_KEYS.conflict]);
    else await area.set({ [PSL_KEYS.conflict]: value });
  };

  // Installs a newer list: the state is worked out again with it and applied, as a new User PAC would be.
  const install = (list) =>
    store.run(async (state) => {
      if (state.userPac !== null && state.userPacErrors === null) {
        const result = analyzeUserPac(state.userPac, list.psl);
        if (!result.ok) {
          await setConflict({ ...released(list), errors: result.errors });
          return "conflict";
        }
      }
      const next = refresh(state, list.psl);
      const previous = store.psl;
      store.setPsl(list.psl);
      try {
        await engine.commit(next);
      } catch (error) {
        store.setPsl(previous);
        throw error;
      }
      installed = { ...released(list), source: "downloaded" };
      await area.set({ [PSL_KEYS.list]: { ...released(list), text: list.text, installedAt: now() } });
      if (conflict !== null) await setConflict(null);
      return "updated";
    });

  return {
    get installed() {
      return installed;
    },

    get conflict() {
      return conflict;
    },

    // At start: the newer of the bundled snapshot and the downloaded list. Only the chosen one is parsed; a stored
    // list that is broken, or older than a snapshot an extension update brought, is dropped.
    async select() {
      const response = await fetch(bundledUrl);
      if (!response.ok) throw new Error(`Public suffix list is unavailable: ${response.status}`);
      const bundledText = await response.text();
      const { [PSL_KEYS.list]: stored, [PSL_KEYS.conflict]: held } = await area.get([PSL_KEYS.list, PSL_KEYS.conflict]);
      let chosen = null;
      if (typeof stored?.text === "string" && isNewerPsl(stored.version, pslVersion(bundledText))) {
        try {
          chosen = { ...readPublicSuffixList(stored.text), source: "downloaded" };
        } catch {
          chosen = null;
        }
      }
      if (chosen === null) {
        chosen = { ...readPublicSuffixList(bundledText), source: "bundled" };
        if (stored !== undefined) await area.remove([PSL_KEYS.list]).catch(ignore);
      }
      installed = { ...released(chosen), source: chosen.source };
      conflict = held ?? null;
      if (conflict !== null && !isNewerPsl(conflict.version, installed.version)) await setConflict(null).catch(ignore);
      return chosen.psl;
    },

    status,

    // What publicsuffix.org has now; nothing changes.
    check: () =>
      serial(async () => {
        try {
          const list = await download();
          return { ok: true, ...status(), available: released(list), newer: isNewerPsl(list.version, installed.version) };
        } catch (error) {
          return { ok: false, ...status(), error: messageOf(error) };
        }
      }),

    // Downloads the list and installs it if it is newer. `weekly` is the alarm's run: it records its time.
    update: ({ weekly = false } = {}) =>
      serial(async () => {
        let outcome;
        let version = null;
        let error;
        try {
          const list = await download();
          version = list.version;
          outcome = isNewerPsl(list.version, installed.version) ? await install(list) : "current";
        } catch (failure) {
          outcome = "error";
          error = messageOf(failure);
        }
        if (weekly) await area.set({ [PSL_KEYS.checked]: now() }).catch(ignore);
        if (log.on) log.add("psl", { trigger: weekly ? "weekly" : "manual", outcome, version, installed: installed.version, message: error });
        const ok = outcome === "updated" || outcome === "current";
        return { ok, outcome, ...status(), ...(error === undefined ? {} : { error }) };
      }),

    // The weekly alarm follows the switch in Options (on unless turned off). Chrome may drop alarms on restart, so
    // every start checks it; the week counts from the last weekly check, or from the first start.
    async schedule() {
      const { [PSL_KEYS.auto]: enabled, [PSL_KEYS.checked]: last } = await area.get([PSL_KEYS.auto, PSL_KEYS.checked]);
      if (enabled === false) {
        await alarms.clear(PSL_ALARM);
        return;
      }
      if ((await alarms.get(PSL_ALARM)) !== undefined) return;
      let since = last;
      if (!Number.isSafeInteger(since)) {
        since = now();
        await area.set({ [PSL_KEYS.checked]: since });
      }
      const delayInMinutes = Math.max(1, (since + PERIOD_MS - now()) / 60_000);
      await alarms.create(PSL_ALARM, { delayInMinutes, periodInMinutes: PSL_PERIOD_MINUTES });
    },
  };
}

