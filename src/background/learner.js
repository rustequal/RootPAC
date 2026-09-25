import { buildSystemPac } from "../core/build.js";
import { aggregateGroups, hostIndex, mergeGroups, mergeSeen } from "../core/groups.js";
import { firstMatch } from "../core/glob.js";
import { hostFromUrl, isLearnable, learnedOwner, rootOf } from "../core/hosts.js";
import { reportEndpointHosts } from "../core/reporting.js";

const MAX_LOADED = 500;
const MAX_TRACKED = 2000;
const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";
const TAB = "tab:";

const IGNORED_LIFECYCLES = new Set(["prerender", "cached", "pending_deletion"]);

const blankTab = (host) => ({ host, navigation: 0, newHosts: 0, loaded: new Set(), proxied: new Set(), loading: false, incomplete: false });

export function createLearner({ store, engine, session, tabs: browserTabs, now }) {
  const tabs = new Map();
  const tracked = new Map();
  const pending = new Map();
  const observed = new Map();
  const seenThisSession = new Set();
  let indexed = { groups: null, index: new Map() };
  let running = false;
  let failed = false;
  const dirty = new Set();
  let writing = false;

  const indexOf = (groups) => {
    if (indexed.groups !== groups) indexed = { groups, index: hostIndex(groups) };
    return indexed.index;
  };

  const persist = (items) => session.set(items).catch(() => undefined);

  const record = (tab) => ({ ...tab, loaded: [...tab.loaded], proxied: [...tab.proxied] });

  const writeTabs = async () => {
    writing = true;
    while (dirty.size > 0) {
      const items = {};
      const removed = [];
      for (const tabId of dirty) {
        const tab = tabs.get(tabId);
        if (tab === undefined) removed.push(TAB + tabId);
        else items[TAB + tabId] = record(tab);
      }
      dirty.clear();
      if (removed.length > 0) await session.remove(removed).catch(() => undefined);
      if (Object.keys(items).length > 0) await persist(items);
    }
    writing = false;
  };

  const saveTab = (tabId) => {
    dirty.add(tabId);
    if (!writing) writeTabs();
  };

  const listeners = new Set();
  const notify = (tabId) => {
    if (tabId === null || tabId < 0) return;
    for (const listener of listeners) listener(tabId);
  };

  const changed = (tabId) => {
    saveTab(tabId);
    notify(tabId);
  };

  const tabOf = (tabId) => {
    let tab = tabs.get(tabId);
    if (tab === undefined) {
      tab = blankTab(null);
      tabs.set(tabId, tab);
    }
    return tab;
  };

  const current = (tabId, navigation) => tabs.get(tabId)?.navigation === navigation;

  const markLoaded = (tabId, host, throughProxy) => {
    const tab = tabs.get(tabId);
    if (tab === undefined || tab.loaded.has(host) || tab.loaded.size >= MAX_LOADED) return;
    tab.loaded.add(host);
    if (throughProxy) tab.proxied.add(host);
    changed(tabId);
  };

  const markIncomplete = (tabId) => {
    const tab = tabOf(tabId);
    if (tab.incomplete) return;
    tab.incomplete = true;
    changed(tabId);
  };

  const track = (details, entry) => {
    if (tracked.size >= MAX_TRACKED) tracked.delete(tracked.keys().next().value);
    tracked.set(details.requestId, { ...entry, tabId: details.tabId, time: details.timeStamp });
  };

  const settled = (details) => {
    const entry = tracked.get(details.requestId);
    if (entry === undefined) return null;
    tracked.delete(details.requestId);
    return entry;
  };

  const resetTab = (tabId, url) => {
    const previous = tabs.get(tabId);
    tabs.set(tabId, { ...blankTab(hostFromUrl(url)), navigation: (previous?.navigation ?? 0) + 1, loading: true });
    changed(tabId);
  };

  const count = (accepted) => {
    const counted = new Set();
    for (const { tabId, navigation } of accepted.values()) {
      if (tabId === null || !current(tabId, navigation)) continue;
      tabs.get(tabId).newHosts += 1;
      counted.add(tabId);
    }
    for (const tabId of counted) changed(tabId);
  };

  const startLoading = (tabId) => {
    const tab = tabOf(tabId);
    if (tab.loading) return;
    tab.loading = true;
    changed(tabId);
  };

  const attribute = ({ tabId, initiator }, roots) => {
    const inTab = tabId >= 0;
    const tab = inTab ? tabs.get(tabId) : undefined;
    const origin = hostFromUrl(initiator);
    const byOrigin = origin === null ? null : rootOf(origin, roots);
    const rootHost = byOrigin !== null ? origin : (tab?.host ?? null);
    const mask = byOrigin ?? (rootHost === null ? null : rootOf(rootHost, roots));
    if (mask === null) return null;
    return { mask, rootHost, tabId: inTab ? tabId : null, navigation: tab?.navigation ?? 0 };
  };

  const learning = (state) => state.enabled && state.analysis !== null && state.userPacErrors === null;

  const accept = (state, learn) => {
    const index = indexOf(state.groups);
    const accepted = new Map();
    for (const [host, source] of learn) {
      if (Object.hasOwn(state.groups, source.mask) && isLearnable(host, state.analysis, index, store.psl)) accepted.set(host, source);
    }
    return accepted;
  };

  const apply = async (state, learn, seen) => {
    if (!learning(state)) return;
    const accepted = accept(state, learn);
    const observedNow = [...seen]
      .map(([host, masks]) => [host, masks.filter((mask) => Object.hasOwn(state.groups[mask]?.hosts ?? {}, host))])
      .filter(([, masks]) => masks.length > 0);
    const time = now();
    const nextSeen = observedNow.length > 0 ? mergeSeen(state.seen, observedNow, time) : state.seen;
    if (accepted.size === 0) {
      if (nextSeen !== state.seen) await store.commit({ ...state, seen: nextSeen });
      return;
    }
    const { groups, seen: aggregatedSeen } = aggregateGroups(mergeGroups(state.groups, accepted, time), nextSeen, state.analysis, store.psl);
    await engine.commit({ ...state, groups, seen: aggregatedSeen, appliedPac: buildSystemPac(state.userPac, groups, store.psl) });
    count(accepted);
  };

  const commitSafely = async (learn, seen) => {
    try {
      await store.run((state) => apply(state, learn, seen));
      return null;
    } catch (error) {
      if (learn.size <= 1) return error;
      let failure = null;
      for (const entry of learn) {
        try {
          await store.run((state) => apply(state, new Map([entry]), new Map()));
        } catch (single) {
          failure = single;
        }
      }
      return failure;
    }
  };

  const flush = async () => {
    running = true;
    try {
      while (pending.size > 0 || observed.size > 0) {
        const learn = new Map(pending);
        const seen = new Map(observed);
        pending.clear();
        observed.clear();
        const failure = await commitSafely(learn, seen);
        if (failure !== null) {
          failed = true;
          persist({ lastLearnError: { time: now(), message: failure instanceof Error ? failure.message : String(failure) } });
        } else if (failed) {
          failed = false;
          session.remove(["lastLearnError"]).catch(() => undefined);
        }
        persist({ seenThisSession: [...seenThisSession] });
      }
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (!running) flush();
  };

  const enqueue = (host, source, state, index) => {
    if (pending.has(host) || !isLearnable(host, state.analysis, index, store.psl)) return false;
    pending.set(host, source);
    return true;
  };

  return {
    get writing() {
      return writing;
    },

    get running() {
      return running;
    },

    tabHost: (tabId) => tabs.get(tabId)?.host ?? null,
    onTabChange: (listener) => listeners.add(listener),

    newHosts: (tabId) => tabs.get(tabId)?.newHosts ?? 0,

    loaded: (tabId) => tabs.get(tabId)?.loaded.size ?? 0,

    proxied: (tabId) => tabs.get(tabId)?.proxied.size ?? 0,

    loading: (tabId) => tabs.get(tabId)?.loading ?? false,

    incomplete: (tabId) => tabs.get(tabId)?.incomplete ?? false,

    pending: (tabId) => [...pending.values()].filter((source) => source.tabId === tabId).length,

    onCompleted(tabId, url) {
      const tab = tabs.get(tabId);
      if (tab === undefined || !tab.loading || hostFromUrl(url) !== tab.host) return;
      tab.loading = false;
      changed(tabId);
    },

    async restore() {
      const items = await session.get(null);
      for (const host of items.seenThisSession ?? []) seenThisSession.add(host);
      for (const [key, tab] of Object.entries(items)) {
        if (key.startsWith(TAB)) tabs.set(Number(key.slice(TAB.length)), { ...tab, loaded: new Set(tab.loaded), proxied: new Set(tab.proxied) });
      }
      if (tabs.size > 0) return;
      for (const { id, url } of await browserTabs.query({})) {
        const host = hostFromUrl(url);
        if (id === undefined || host === null) continue;
        tabs.set(id, blankTab(host));
        saveTab(id);
      }
    },

    onRequest(details) {
      if (IGNORED_LIFECYCLES.has(details.documentLifecycle)) return;
      const state = store.state;
      if (details.type === "main_frame") {
        if (details.tabId < 0) return;
        startLoading(details.tabId);
        const host = hostFromUrl(details.url);
        if (learning(state) && host !== null && rootOf(host, state.analysis.roots) !== null) track(details, { main: true, url: details.url });
        return;
      }
      const host = hostFromUrl(details.url);
      if (!learning(state) || host === null) return;
      const { roots, bypass } = state.analysis;
      const index = indexOf(state.groups);
      const underRoot = rootOf(host, roots) !== null;
      const learned = underRoot ? null : learnedOwner(host, index, store.psl);
      const tab = details.tabId >= 0 ? tabs.get(details.tabId) : undefined;
      if (tab !== undefined && rootOf(tab.host ?? "", roots) !== null) {
        const via = underRoot ? null : learned !== null ? "proxy" : firstMatch(host, bypass) !== null ? "direct" : undefined;
        if (via !== undefined) track(details, { host, via, navigation: tab.navigation });
      }
      if (learned !== null) {
        if (!seenThisSession.has(learned)) {
          seenThisSession.add(learned);
          observed.set(learned, index.get(learned));
          schedule();
        }
        return;
      }
      const source = attribute(details, roots);
      if (source === null || !enqueue(host, source, state, index)) return;
      notify(source.tabId);
      schedule();
    },

    onHeaders(details) {
      if (IGNORED_LIFECYCLES.has(details.documentLifecycle)) return;
      const hosts = reportEndpointHosts(details.responseHeaders ?? [], details.url);
      const state = store.state;
      if (hosts.length === 0 || !learning(state)) return;
      const { roots } = state.analysis;
      let source;
      if (details.type === "main_frame") {
        const responseHost = hostFromUrl(details.url);
        const mask = responseHost === null ? null : rootOf(responseHost, roots);
        source = mask === null ? null : { mask, rootHost: responseHost };
      } else {
        source = attribute(details, roots);
      }
      if (source === null) return;
      const index = indexOf(state.groups);
      const endpoint = { mask: source.mask, rootHost: source.rootHost, tabId: null, navigation: 0 };
      const added = hosts.filter((host) => enqueue(host, endpoint, state, index));
      if (added.length > 0) schedule();
    },

    onResponse(details) {
      const entry = settled(details);
      if (entry === null || entry.main || entry.via === null || !current(entry.tabId, entry.navigation)) return;
      markLoaded(entry.tabId, entry.host, entry.via === "proxy");
    },

    onError(details) {
      const entry = settled(details);
      if (entry === null || details.error !== BLOCKED || !engine.blockedBeforeOpen(entry.time)) return;
      if (entry.main) {
        resetTab(entry.tabId, entry.url);
        markIncomplete(entry.tabId);
      } else if (current(entry.tabId, entry.navigation)) {
        markIncomplete(entry.tabId);
      }
    },

    onCommitted({ tabId, frameId, url, documentLifecycle }) {
      if (frameId !== 0 || tabId < 0 || documentLifecycle === "prerender") return;
      resetTab(tabId, url);
    },

    onReplaced(addedTabId, removedTabId) {
      const tab = tabs.get(removedTabId);
      tabs.delete(removedTabId);
      if (tab === undefined) tabs.delete(addedTabId);
      else tabs.set(addedTabId, tab);
      saveTab(removedTabId);
      changed(addedTabId);
    },

    onRemoved(tabId) {
      if (tabs.delete(tabId)) saveTab(tabId);
    },
  };
}
