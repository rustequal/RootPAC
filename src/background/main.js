import { parsePublicSuffixList } from "../core/psl.js";
import { createBadge, decodeIcon } from "./badge.js";
import { createChecker } from "./check.js";
import { createDnr } from "./dnr.js";
import { createEngine } from "./engine.js";
import { createLearner } from "./learner.js";
import { createLog, LOG_CHANNEL, LOG_SETTING } from "./log.js";
import { createLogDb } from "./logdb.js";
import { createCommands } from "./messages.js";
import { createProxy } from "./proxy.js";
import { Store } from "./store.js";

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
const engine = createEngine({
  store,
  proxy: createProxy({ proxy: chrome.proxy, privacy: chrome.privacy, extension: chrome.extension }),
  dnr: createDnr(chrome.declarativeNetRequest),
  session: chrome.storage.session,
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
  decode: decodeIcon,
});

learner.onTabChange((tabId) => {
  badge.update(tabId).catch(ignore);
});

const commands = createCommands({
  store,
  engine,
  checker: createChecker({ offscreen: chrome.offscreen, runtime: chrome.runtime }),
  learner,
  log,
});
const ready = logSetting
  .catch(ignore)
  .then(() => fetch(chrome.runtime.getURL("vendor/public_suffix_list.dat")))
  .then((response) => {
    if (!response.ok) throw new Error(`Public suffix list is unavailable: ${response.status}`);
    return response.text();
  })
  .then((text) => store.load(parsePublicSuffixList(text)))
  .then(() => learner.restore())
  .then(() => engine.check());

ready.then(() => badge.start()).catch(ignore);

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

const NETWORK = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
chrome.webRequest.onBeforeRequest.addListener(whenReady(learner.onRequest), NETWORK);
chrome.webRequest.onHeadersReceived.addListener(
  whenReady((details) => {
    learner.onResponse(details);
    learner.onHeaders(details);
  }),
  NETWORK,
  ["responseHeaders"],
);
chrome.webRequest.onCompleted.addListener(whenReady(learner.onResponse), NETWORK);
chrome.webRequest.onErrorOccurred.addListener(whenReady(learner.onError), NETWORK);
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
    (key) => key.startsWith("group:") || ["enabled", "analysis", "userPacErrors", "armed"].includes(key),
  );

chrome.storage.onChanged.addListener(
  whenReady((changes) => {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  ready
    .then(() => commands.dispatch(message))
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .then(sendResponse);
  return true;
});

