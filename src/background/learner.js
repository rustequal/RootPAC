import { buildSystemPac } from "../core/build.js";
import { aggregateGroups, hostIndex, mergeGroups, mergeSeen } from "../core/groups.js";
import { firstMatch } from "../core/glob.js";
import { hostFromUrl, isLearnable, isLearnableName, learnedOwner, rootOf, underDeny } from "../core/hosts.js";
import { reportEndpointHosts } from "../core/reporting.js";
import { CONFLICT, SAME, answersOf, claimSites, ownerOf, sitesOfState, verdict } from "../core/routes.js";
import { NO_LOG } from "./log.js";

const MAX_LOADED = 500;
const MAX_TRACKED = 2000;
const BLOCKED = "net::ERR_BLOCKED_BY_CLIENT";
const ABORTED = "net::ERR_ABORTED";
const MAX_LOGGED = 1000;
const MAX_CONFLICTS = 50;
const MAX_CACHED = 1000;
const PROXY_FAILURE = /^net::ERR_(?:PROXY_|SOCKS_|TUNNEL_|MANDATORY_PROXY_|PAC_|HTTPS_PROXY_|UNEXPECTED_PROXY_)/;
const MANDATORY = "net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED";
const PAC_FAILED = "net::ERR_PAC_SCRIPT_FAILED";
const PAC_HINT_MS = 1000;
const TAB = "tab:";

const IGNORED_LIFECYCLES = new Set(["prerender", "cached", "pending_deletion"]);

const blankTab = (host) => ({ host, navigation: 0, newHosts: 0, loaded: new Set(), proxied: new Set(), loading: false, incomplete: false, proxyError: null, conflicts: [] });

export function createLearner({ store, engine, session, tabs: browserTabs, now, log = NO_LOG }) {
  const tabs = new Map();
  // Root documents that answered before their page committed, by tab.
  const documents = new Map();
  const tracked = new Map();
  const pending = new Map();
  const observed = new Map();
  const seenThisSession = new Set();
  let indexed = { groups: null, index: new Map(), own: new Map() };
  let running = false;
  let failed = false;
  const dirty = new Set();
  let writing = false;
  let pacFailure = null;
  const awaitingPac = new Map();
  const skipped = new Set();
  const conflicted = new Set();
  let answered = { state: null, answers: {}, routes: new Map() };
  let rooted = { roots: null, hosts: new Map(), origins: new Map() };

  // Every group's records, and each root's own ones on demand; rebuilt only when the groups change.
  const indexOf = (groups) => {
    if (indexed.groups !== groups) indexed = { groups, index: hostIndex(groups), own: new Map() };
    return indexed.index;
  };

  const ownIndexOf = (groups, mask) => {
    indexOf(groups);
    let own = indexed.own.get(mask);
    if (own === undefined) {
      own = new Set(Object.hasOwn(groups, mask) ? Object.keys(groups[mask].hosts) : []);
      indexed.own.set(mask, own);
    }
    return own;
  };

  // What follows from the state alone is worked out once per state: every learned request asks for it.
  const answeredFor = (state) => {
    if (answered.state !== state) answered = { state, answers: answersOf(state), sites: sitesOfState(state, state.analysis?.roots ?? [], store.psl), routes: new Map() };
    return answered;
  };

  const answersOfState = (state) => answeredFor(state).answers;

  const sitesOf = (state) => answeredFor(state).sites;

  // The root whose proxy carries a record, the owner of its site, and whether the root may use it (core/routes.js).
  const routeFor = (entry, mask, state) => {
    const { answers, routes } = answeredFor(state);
    return cached(routes, keyOf(mask, entry), () => {
      const owner = ownerOf(sitesOf(state), entry, store.psl) ?? null;
      return { entry, owner, verdict: verdict(mask, owner, answers) };
    });
  };

  // What a root learns for a host it does not know yet. Each root learns every host it needs itself, even one another
  // root has learned; it then takes that root's record, so the groups share records instead of growing combs.
  const targetOf = (host, mask, state) => {
    if (!Object.hasOwn(state.groups, mask)) return null;
    const own = ownIndexOf(state.groups, mask);
    if (learnedOwner(host, own, store.psl) !== null) return null;
    const target = learnedOwner(host, indexOf(state.groups), store.psl) ?? host;
    return isLearnable(target, state.analysis, own, store.psl) ? target : null;
  };

  const keyOf = (mask, host) => `${mask} ${host}`;

  // A bounded memo for answers that are asked on every request.
  const cached = (map, key, find) => {
    let found = map.get(key);
    if (found === undefined) {
      if (map.size >= MAX_CACHED) map.clear();
      found = find(key);
      map.set(key, found);
    }
    return found;
  };

  // Diagnostic events that would repeat on every request are logged once per key.
  const firstTime = (keys, key) => {
    if (keys.has(key)) return false;
    if (keys.size >= MAX_LOGGED) keys.clear();
    keys.add(key);
    return true;
  };

  const persist = (items) => session.set(items).catch(() => undefined);

  const record = (tab) => ({ ...tab, loaded: [...tab.loaded], proxied: [...tab.proxied], conflicts: [...tab.conflicts] });

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

  // A root holds a record that another root's proxy carries: the request is blocked for it, and a reload cannot help.
  // `entry` is the record (or root domain) the verdict is about, `request` the host the page asked for.
  const markConflict = (source, { entry, owner }, state, request) => {
    if (log.on && firstTime(conflicted, keyOf(source.mask, request))) {
      const answers = answersOfState(state);
      log.add("conflict", { host: entry, request, root: source.mask, owner, proxy: answers[source.mask] ?? null, ownerProxy: answers[owner] ?? null, tabId: source.tabId });
    }
    if (source.tabId === null || !current(source.tabId, source.navigation)) return;
    const tab = tabs.get(source.tabId);
    if (tab.conflicts.length >= MAX_CONFLICTS || tab.conflicts.some((item) => item.request === request && item.root === source.mask)) return;
    tab.conflicts.push({ host: entry, request, root: source.mask, owner });
    changed(source.tabId);
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
    const tab = { ...blankTab(hostFromUrl(url)), navigation: (previous?.navigation ?? 0) + 1, loading: true };
    // The root document that answered before its page committed is the page's first loaded host.
    if (documents.get(tabId) === tab.host) {
      tab.loaded.add(tab.host);
      tab.proxied.add(tab.host);
    }
    documents.delete(tabId);
    tabs.set(tabId, tab);
    changed(tabId);
  };

  // A root page closed because its site goes through another root: the tab shows that root's page as blocked by a
  // proxy conflict, or, while the proxies are not checked yet, as loaded before protection was ready.
  const closePage = ({ tabId, url, closed }) => {
    resetTab(tabId, url);
    const tab = tabs.get(tabId);
    tab.loading = false;
    if (closed.verdict === CONFLICT) markConflict({ mask: closed.entry, tabId, navigation: tab.navigation }, closed, store.state, tab.host);
    else markIncomplete(tabId);
  };

  const count = (accepted) => {
    const counted = new Set();
    for (const { tabId, navigation } of accepted) {
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

  // Pages make most of their requests from a handful of hosts and origins, so the root of each is kept at hand.
  const rootsOf = (roots) => {
    if (rooted.roots !== roots) rooted = { roots, hosts: new Map(), origins: new Map() };
    return rooted;
  };

  const rootOfHost = (host, roots) => (host === null ? null : cached(rootsOf(roots).hosts, host, (name) => rootOf(name, roots)));

  const originOf = (initiator, roots) => cached(rootsOf(roots).origins, initiator, (url) => hostFromUrl(url));

  // A request belongs to the root of its tab's page: each root is on its own proxy, and a page is one site to its user,
  // frames of other roots included. Only outside root pages, as a frame or a worker of a root, does it belong to the
  // root of the origin that made it. The DNR rules scope each root's allowance the same way (core/rules.js). The top
  // frame's requests name their page in their initiator; the tab's record, updated when a navigation commits, may
  // still hold the previous page for the first requests of the next one, so only frames rely on it.
  const attribute = ({ tabId, frameId, initiator }, roots) => {
    const inTab = tabId >= 0;
    const tab = inTab ? tabs.get(tabId) : undefined;
    const origin = originOf(initiator, roots);
    const page = frameId === 0 && origin !== null ? origin : (tab?.host ?? null);
    const byPage = rootOfHost(page, roots);
    const mask = byPage ?? rootOfHost(origin, roots);
    if (mask === null) return null;
    return { mask, rootHost: byPage === null ? origin : page, tabId: inTab ? tabId : null, navigation: tab?.navigation ?? 0 };
  };

  const learning = (state) => state.enabled && state.analysis !== null && state.userPacErrors === null;

  // The helpers below only run with the diagnostic log on.
  const refusal = (host, { deny, bypass }) => {
    if (!isLearnableName(host)) return "not a learnable name";
    if (underDeny(host, deny)) return "deny";
    return firstMatch(host, bypass) !== null ? "bypass" : "covers a bypass mask";
  };

  const logSkipped = (host, mask, reason, tabId) => {
    if (firstTime(skipped, keyOf(mask, host))) log.add("skipped", { host, root: mask, reason, tabId });
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
    const accepted = [];
    for (const source of learn.values()) {
      const host = targetOf(source.request, source.mask, state);
      if (host !== null) accepted.push({ ...source, host });
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
    if (accepted.length === 0) {
      if (nextSeen !== state.seen) await store.commit({ ...state, seen: nextSeen });
      return;
    }
    const batch = accepted.map((source) => [source.host, source]);
    // A site nobody owns goes to the root that learned it first.
    const sites = claimSites(sitesOf(state), accepted.map((source) => [source.host, source.mask]), store.psl);
    const { groups, seen: aggregatedSeen } = aggregateGroups(mergeGroups(state.groups, batch, time), nextSeen, state.analysis, store.psl);
    const next = { ...state, groups, sites, seen: aggregatedSeen, appliedPac: buildSystemPac(state.userPac, groups, store.psl, sites) };
    await engine.commit(next);
    if (log.on) {
      for (const { host, mask, rootHost, tabId } of accepted) log.add("learned", { host, root: mask, rootHost, tabId });
    }
    const fresh = [];
    for (const source of accepted) {
      const entry = learnedOwner(source.request, indexOf(next.groups), store.psl);
      const route = entry === null ? null : routeFor(entry, source.mask, next);
      if (route?.verdict === CONFLICT) markConflict(source, route, next, source.request);
      else fresh.push(source);
    }
    count(fresh);
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

  const enqueue = (host, source, state) => {
    const key = keyOf(source.mask, host);
    if (pending.has(key) || targetOf(host, source.mask, state) === null) return false;
    pending.set(key, { ...source, request: host });
    return true;
  };

  const observe = (host, masks) => {
    let added = false;
    for (const mask of masks) {
      const key = keyOf(mask, host);
      if (seenThisSession.has(key)) continue;
      seenThisSession.add(key);
      const entry = observed.get(host) ?? [];
      entry.push(mask);
      observed.set(host, entry);
      added = true;
    }
    if (added) schedule();
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

    conflicts: (tabId) => [...(tabs.get(tabId)?.conflicts ?? [])],

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
        if (key.startsWith(TAB)) tabs.set(Number(key.slice(TAB.length)), { ...tab, loaded: new Set(tab.loaded), proxied: new Set(tab.proxied), conflicts: tab.conflicts ?? [] });
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
        // A root that handed its own site to a root on another proxy has its pages closed (core/rules.js): the page
        // never commits, so the blocked load itself tells the tab which root it is and why.
        const route = routeFor(mask, mask, state);
        const closed = route.verdict === SAME ? null : route;
        track(details, { main: true, url: details.url, navigation: tabs.get(details.tabId)?.navigation ?? 0, closed });
        return;
      }
      const host = hostFromUrl(details.url);
      if (!learning(state) || host === null) return;
      const { roots, bypass } = state.analysis;
      const index = indexOf(state.groups);
      const hostRoot = rootOfHost(host, roots);
      const learned = hostRoot === null ? learnedOwner(host, index, store.psl) : null;
      const tab = details.tabId >= 0 ? tabs.get(details.tabId) : undefined;
      if (tab !== undefined && rootOfHost(tab.host ?? null, roots) !== null) {
        // A root's hosts, like learned ones, go only through a proxy: the System PAC refuses DIRECT for them.
        const via = hostRoot !== null || learned !== null ? "proxy" : firstMatch(host, bypass) !== null ? "direct" : undefined;
        if (via !== undefined) track(details, { host, via, navigation: tab.navigation });
      }
      const source = attribute(details, roots);
      if (source === null) {
        if (learned !== null) observe(learned, index.get(learned));
        return;
      }
      // A root's domain is never learned: every root's pages may use it while its site goes through their proxy, and
      // are blocked from it otherwise, the root's own pages included once it has handed its site over.
      if (hostRoot !== null) {
        const route = routeFor(hostRoot, source.mask, state);
        if (route.verdict === CONFLICT) markConflict(source, route, state, host);
        else if (route.verdict !== SAME && current(source.tabId, source.navigation)) markIncomplete(source.tabId);
        return;
      }
      // A root's own records are among all the records, so a host no root knows is new to this root too.
      const own = learned === null ? null : learnedOwner(host, ownIndexOf(state.groups, source.mask), store.psl);
      if (own !== null) {
        observe(own, [source.mask]);
        const route = routeFor(own, source.mask, state);
        if (route.verdict === CONFLICT) markConflict(source, route, state, host);
        else if (route.verdict !== SAME && current(source.tabId, source.navigation)) markIncomplete(source.tabId);
        return;
      }
      if (!enqueue(host, source, state)) {
        if (log.on && !pending.has(keyOf(source.mask, host))) logSkipped(host, source.mask, refusal(host, state.analysis), source.tabId);
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
      const endpoint = { mask: source.mask, rootHost: source.rootHost, tabId: null, navigation: 0 };
      const added = hosts.filter((host) => enqueue(host, endpoint, state));
      if (added.length === 0) return;
      if (log.on) for (const host of added) log.add("reported", { host, root: source.mask, url: details.url });
      schedule();
    },

    onResponse(details) {
      const entry = settled(details);
      if (entry === null) return;
      // A root document goes through the root's proxy; it counts for its page, which may commit before or after this.
      if (entry.main) {
        const host = hostFromUrl(entry.url);
        const tab = tabs.get(entry.tabId);
        if (tab !== undefined && tab.navigation > entry.navigation && tab.host === host) markLoaded(entry.tabId, host, true);
        else if (host !== null) documents.set(entry.tabId, host);
        return;
      }
      if (!current(entry.tabId, entry.navigation)) return;
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
      if (entry?.main && entry.closed !== null && details.error === BLOCKED) {
        closePage(entry);
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

    // Logged at commit rather than at the request: a page restored from the back/forward cache, activated from a
    // prerender or answered by the site's service worker commits without a main_frame request the learner sees.
    onCommitted({ tabId, frameId, url, documentLifecycle, transitionType }) {
      if (frameId !== 0 || tabId < 0 || documentLifecycle === "prerender") return;
      resetTab(tabId, url);
      if (!log.on) return;
      const host = hostFromUrl(url);
      const { analysis } = store.state;
      const mask = host === null || analysis === null ? null : rootOf(host, analysis.roots);
      if (mask !== null) log.add("navigation", { host, root: mask, url, tabId, transition: transitionType ?? null });
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
      documents.delete(tabId);
      if (tabs.delete(tabId)) saveTab(tabId);
    },
  };
}
