import { buildSystemPac } from "../core/build.js";
import { aggregateGroups, hostIndex, mergeGroups, mergeSeen } from "../core/groups.js";
import { firstMatch } from "../core/glob.js";
import { hostFromUrl, isLearnable, isLearnableName, learnedOwner, rootOf, underDeny } from "../core/hosts.js";
import { reportEndpointHosts } from "../core/reporting.js";
import { NO_LOG } from "./log.js";

const MAX_LOADED = 500;
const MAX_TRACKED = 2000;
const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";
const ABORTED = "net::ERR_ABORTED";
const MAX_SKIPPED = 1000;
const PROXY_FAILURE = /^net::ERR_(?:PROXY_|SOCKS_|TUNNEL_|MANDATORY_PROXY_|PAC_|HTTPS_PROXY_|UNEXPECTED_PROXY_)/;
const MANDATORY = "net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED";
const PAC_FAILED = "net::ERR_PAC_SCRIPT_FAILED";
const PAC_HINT_MS = 1000;
const TAB = "tab:";

const IGNORED_LIFECYCLES = new Set(["prerender", "cached", "pending_deletion"]);

const blankTab = (host) => ({ host, navigation: 0, newHosts: 0, loaded: new Set(), proxied: new Set(), loading: false, incomplete: false, proxyError: null });

export function createLearner({ store, engine, session, tabs: browserTabs, now, log = NO_LOG }) {
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
  let pacFailure = null;
  const awaitingPac = new Map();
  const skipped = new Set();

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

  // The first proxy failure of a load is kept, later ones are counted. chrome.proxy.onProxyError carries the PAC line
  // but no tab, and webRequest reports the same failure for the tab just before or just after it.
  const recentPac = () => (pacFailure !== null && now() - pacFailure.time <= PAC_HINT_MS ? pacFailure : null);

  const failProxy = (entry, details) => {
    if (entry.main) resetTab(entry.tabId, entry.url);
    else if (!current(entry.tabId, entry.navigation)) return;
    const tab = tabs.get(entry.tabId);
    if (tab.proxyError !== null && tab.proxyError !== undefined) {
      tab.proxyError = { ...tab.proxyError, count: tab.proxyError.count + 1 };
    } else {
      const pac = details.error === MANDATORY ? recentPac() : null;
      tab.proxyError = { time: details.timeStamp, error: pac?.error ?? details.error, details: pac?.details ?? "", count: 1 };
      if (details.error === MANDATORY && pac === null) awaitingPac.set(entry.tabId, { navigation: tab.navigation, time: now() });
    }
    changed(entry.tabId);
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

  // The helpers below only run with the diagnostic log on.
  const refusal = (host, { deny, bypass }) => {
    if (!isLearnableName(host)) return "not a learnable name";
    if (underDeny(host, deny)) return "deny";
    return firstMatch(host, bypass) !== null ? "bypass" : "covers a bypass mask";
  };

  const logSkipped = (host, mask, reason, tabId) => {
    const key = `${mask} ${host}`;
    if (skipped.has(key)) return;
    if (skipped.size >= MAX_SKIPPED) skipped.clear();
    skipped.add(key);
    log.add("skipped", { host, root: mask, reason, tabId });
  };

  const routeOf = (host) => {
    const state = store.state;
    if (host === null || state.analysis === null) return {};
    const root = rootOf(host, state.analysis.roots);
    if (root !== null) return { route: "root", group: root };
    const index = indexOf(state.groups);
    const learned = learnedOwner(host, index, store.psl);
    if (learned !== null) return { route: "learned", group: index.get(learned).join(", "), entry: learned };
    return { route: firstMatch(host, state.analysis.bypass) !== null ? "bypass" : "user PAC" };
  };

  const logFailure = (details, entry) => {
    const host = hostFromUrl(details.url);
    const tabId = details.tabId >= 0 ? details.tabId : null;
    log.add(PROXY_FAILURE.test(details.error ?? "") ? "proxyFailure" : "requestError", {
      host,
      url: details.url,
      error: details.error,
      type: details.type,
      method: details.method,
      tabId,
      tabHost: tabId === null ? null : (tabs.get(tabId)?.host ?? null),
      initiator: details.initiator ?? null,
      ip: details.ip ?? null,
      tracked: entry !== null,
      ...routeOf(host),
    });
  };

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
    if (log.on) {
      for (const [host, { mask, rootHost, tabId }] of accepted) log.add("learned", { host, root: mask, rootHost, tabId });
    }
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
          if (log.on) log.add("learnError", { message: failure instanceof Error ? failure.message : String(failure) });
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

    proxyError: (tabId) => tabs.get(tabId)?.proxyError ?? null,

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
        const mask = learning(state) && host !== null ? rootOf(host, state.analysis.roots) : null;
        if (mask === null) return;
        track(details, { main: true, url: details.url });
        if (log.on) log.add("navigation", { host, root: mask, url: details.url, tabId: details.tabId });
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
      if (source === null) return;
      if (!enqueue(host, source, state, index)) {
        if (log.on && !underRoot && !pending.has(host)) logSkipped(host, source.mask, refusal(host, state.analysis), source.tabId);
        return;
      }
      if (log.on) log.add("blocked", { host, root: source.mask, type: details.type, url: details.url, initiator: details.initiator ?? null, tabId: source.tabId });
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
      if (added.length === 0) return;
      if (log.on) for (const host of added) log.add("reported", { host, root: source.mask, url: details.url });
      schedule();
    },

    onResponse(details) {
      const entry = settled(details);
      if (entry === null || entry.main || entry.via === null || !current(entry.tabId, entry.navigation)) return;
      markLoaded(entry.tabId, entry.host, entry.via === "proxy");
    },

    onProxyError({ error, details, fatal }) {
      if (log.on) log.add("proxyError", { error, details: details ?? "", fatal: fatal === true });
      if (error !== PAC_FAILED) return;
      pacFailure = { time: now(), error, details: details ?? "" };
      for (const [tabId, awaiting] of awaitingPac) {
        awaitingPac.delete(tabId);
        const tab = tabs.get(tabId);
        if (tab?.navigation !== awaiting.navigation || tab.proxyError?.error !== MANDATORY || pacFailure.time - awaiting.time > PAC_HINT_MS) continue;
        tab.proxyError = { ...tab.proxyError, error, details: pacFailure.details };
        changed(tabId);
      }
    },

    onError(details) {
      const entry = settled(details);
      if (log.on && details.error !== BLOCKED && (PROXY_FAILURE.test(details.error ?? "") || (entry !== null && details.error !== ABORTED))) {
        logFailure(details, entry);
      }
      if (entry !== null && PROXY_FAILURE.test(details.error ?? "")) {
        failProxy(entry, details);
        return;
      }
      if (entry === null || details.error !== BLOCKED || !engine.blockedBeforeOpen(entry.time)) return;
      if (entry.main) {
        resetTab(entry.tabId, entry.url);
        markIncomplete(entry.tabId);
      } else if (current(entry.tabId, entry.navigation)) {
        markIncomplete(entry.tabId);
      } else {
        return;
      }
      if (log.on) log.add("incomplete", { host: entry.main ? hostFromUrl(entry.url) : entry.host, url: details.url, tabId: entry.tabId });
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
      awaitingPac.delete(tabId);
      if (tabs.delete(tabId)) saveTab(tabId);
    },
  };
}
