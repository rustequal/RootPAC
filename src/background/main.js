import { LISTED, heldRoutes, loggedRoutes } from "../core/held.js";
import { createBadge, decodeIcon } from "./badge.js";
import { createChecker } from "./check.js";
import { createDnr } from "./dnr.js";
import { createEngine } from "./engine.js";
import { createLearner } from "./learner.js";
import { createLog, LOG_CHANNEL, LOG_SETTING } from "./log.js";
import { createLogDb } from "./logdb.js";
import { createCommands } from "./messages.js";
import { createProxy } from "./proxy.js";
import { PSL_ALARM, createPslUpdater } from "./pslupdate.js";
import { createResolver } from "./resolve.js";
import { PSL_KEYS, Store } from "./store.js";
import { createTraffic } from "./traffic.js";

const ignore = () => undefined;

const channel = new BroadcastChannel(LOG_CHANNEL);
const log = createLog({ sink: createLogDb(), notify: () => channel.postMessage("appended") });
const logSetting = chrome.storage.local.get(LOG_SETTING).then((items) => log.set(items[LOG_SETTING]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.hasOwn(changes, LOG_SETTING)) return;
  const enabled = changes[LOG_SETTING].newValue === true;
  if (!enabled && log.on) log.add("log", { enabled });
  log.set(enabled);
  if (enabled) log.add("log", { enabled, version: chrome.runtime.getManifest().version });
});

const store = new Store(chrome.storage.local, chrome.storage.session);
// A held route whose requests have drained leaves the PAC with the next commit of the state as it is (4.11).
const traffic = createTraffic({ onDrained: () => release() });
const engine = createEngine({
  store,
  proxy: createProxy({ proxy: chrome.proxy, privacy: chrome.privacy, extension: chrome.extension }),
  dnr: createDnr(chrome.declarativeNetRequest),
  session: chrome.storage.session,
  traffic,
  log,
});
const psl = createPslUpdater({
  store,
  engine,
  area: chrome.storage.local,
  alarms: chrome.alarms,
  fetch: (...args) => fetch(...args),
  bundledUrl: chrome.runtime.getURL("vendor/public_suffix_list.dat"),
  log,
});
const learner = createLearner({ store, engine, session: chrome.storage.session, tabs: chrome.tabs, now: Date.now, log });
const badge = createBadge({
  action: chrome.action,
  runtime: chrome.runtime,
  tabs: chrome.tabs,
  engine,
  store,
  learner,
  warning: () => psl.conflict !== null,
  decode: decodeIcon,
});

learner.onTabChange((tabId) => {
  badge.update(tabId).catch(ignore);
});

const checker = createChecker({ offscreen: chrome.offscreen, runtime: chrome.runtime });
const resolver = createResolver({ store, engine, checker, log });
const commands = createCommands({ store, engine, checker, learner, psl, log });
const ready = logSetting
  .catch(ignore)
  .then(() => psl.select())
  .then((list) => store.load(list))
  .then(() => {
    if (log.on && store.expiredHeld !== null) {
      const routes = heldRoutes(store.expiredHeld);
      log.add("routesReleased", { reason: "restart", routes: loggedRoutes(routes.slice(0, LISTED)), count: routes.length, held: [], heldCount: 0 });
    }
    traffic.adopt(heldRoutes(store.state.held), Date.now());
  })
  .then(() => learner.restore())
  .then(() => engine.check());

ready.then(() => badge.start()).catch(ignore);
ready.then(() => resolver.schedule()).catch(ignore);
ready.then(() => psl.schedule()).catch(ignore);

ready.then(
  () => chrome.storage.session.remove(["startupError"]),
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (log.on) log.add("startupError", { message });
    return chrome.storage.session.set({ startupError: message });
  },
).catch(ignore);

const whenReady =
  (handler) =>
  (...args) => {
    ready.then(() => handler(...args)).catch(ignore);
  };

const wake = whenReady(() => badge.refresh());

chrome.runtime.onInstalled.addListener((details) => {
  wake();
  logSetting.then(() => {
    if (log.on) log.add("lifecycle", { event: details.reason, version: chrome.runtime.getManifest().version, previousVersion: details.previousVersion ?? null });
  }, ignore);
});
chrome.runtime.onStartup.addListener(() => {
  wake();
  logSetting.then(() => {
    if (log.on) log.add("lifecycle", { event: "startup", version: chrome.runtime.getManifest().version });
  }, ignore);
});

const release = whenReady(() => store.run((state) => engine.commit(state)));

// Requests are counted as their events arrive, before `ready`: a request on its way is one whatever the state.
const NETWORK = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
const counted = (handler, count) => (details) => {
  count(details);
  handler(details);
};
chrome.webRequest.onBeforeRequest.addListener(counted(whenReady(learner.onRequest), traffic.start), NETWORK);
chrome.webRequest.onHeadersReceived.addListener(
  counted(
    whenReady((details) => {
      learner.onResponse(details);
      learner.onHeaders(details);
    }),
    traffic.end,
  ),
  NETWORK,
  ["responseHeaders"],
);
chrome.webRequest.onBeforeRedirect.addListener(traffic.end, NETWORK);
chrome.webRequest.onCompleted.addListener(counted(whenReady(learner.onResponse), traffic.end), NETWORK);
chrome.webRequest.onErrorOccurred.addListener(counted(whenReady(learner.onError), traffic.end), NETWORK);
chrome.webNavigation.onCommitted.addListener(
  whenReady(async (details) => {
    learner.onCommitted(details);
    if (details.frameId === 0 && details.tabId >= 0) await badge.update(details.tabId, true);
  }),
);
chrome.webNavigation.onCompleted.addListener(
  whenReady((details) => {
    if (details.frameId !== 0 || details.tabId < 0) return undefined;
    learner.onCompleted(details.tabId, details.url);
    return badge.update(details.tabId, true);
  }),
);
chrome.tabs.onUpdated.addListener(
  whenReady((tabId, changeInfo, tab) => {
    if (changeInfo.status === undefined) return undefined;
    if (changeInfo.status === "complete") learner.onCompleted(tabId, tab.url);
    return badge.update(tabId, true);
  }),
);
chrome.tabs.onReplaced.addListener(whenReady(learner.onReplaced));
chrome.tabs.onRemoved.addListener(whenReady(learner.onRemoved));

const badgeKeys = (changes) =>
  Object.keys(changes).some(
    (key) => key.startsWith("group:") || ["enabled", "analysis", "userPacErrors", "armed", PSL_KEYS.conflict].includes(key),
  );

chrome.storage.onChanged.addListener(
  whenReady((changes, area) => {
    // A root gets its rootHost with its first learned host; its proxy is checked then.
    if (area === "local" && Object.keys(changes).some((key) => key.startsWith("group:") || key === "enabled")) resolver.schedule();
    if (area === "local" && Object.hasOwn(changes, PSL_KEYS.auto)) psl.schedule().catch(ignore);
    if (badgeKeys(changes)) return badge.refresh();
  }),
);

for (const setting of [chrome.proxy.settings, chrome.privacy.network.networkPredictionEnabled, chrome.privacy.network.webRTCIPHandlingPolicy]) {
  setting.onChange.addListener(
    whenReady(async () => {
      await engine.recheck();
      await badge.refresh();
    }),
  );
}

chrome.proxy.onProxyError.addListener(whenReady(learner.onProxyError));

// The weekly public suffix list check: quiet, only the log and a list the User PAC does not pass with show it.
chrome.alarms.onAlarm.addListener(
  whenReady(async ({ name }) => {
    if (name === PSL_ALARM) await psl.update({ weekly: true });
  }),
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  ready
    .then(() => commands.dispatch(message))
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .then(sendResponse);
  return true;
});

