import { CLOSED_TEXT, INCOGNITO_TEXT, element, formatTime, incognitoAllowed, onStored, proxyErrorText, readLocal, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

const box = document.getElementById("state");
const banners = document.getElementById("banners");

document.getElementById("head").replaceWith(header("RootPAC"));

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab !== undefined) return tab.id;
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return fallback?.id ?? null;
}

function banner(text, className = "banner") {
  banners.append(element("p", className, text));
}

function stat(count, label, className) {
  const row = element("div", className === undefined ? "stat" : `stat ${className}`);
  row.append(element("span", "num", String(count)), element("span", "label", label));
  return row;
}

function showState(state, tabId) {
  box.replaceChildren();
  if (state === null || !state.ok || state.mask === null) {
    box.append(element("p", "state muted", "Not a root tab"));
    return;
  }
  const plural = (count) => (count === 1 ? "" : "s");
  box.append(element("div", "mask", state.mask));
  if (state.loaded > 0) box.append(stat(state.loaded, `host${plural(state.loaded)} loaded on this page`, "loaded"));
  if (state.proxied > 0) box.append(stat(state.proxied, `host${plural(state.proxied)} routed through the proxy`, "proxied"));
  const reload = () => {
    const button = element("button", "small primary", "Reload");
    button.addEventListener("click", async () => {
      await chrome.tabs.reload(tabId);
      window.close();
    });
    return button;
  };
  if (state.incomplete) {
    const row = element("div", "stat learned");
    row.append(element("span", "label", "Loaded before protection was ready — part of the page was blocked"), reload());
    box.append(row);
  }
  if (state.newHosts > 0) {
    const row = stat(state.newHosts, `new host${plural(state.newHosts)} blocked and learned`, "learned");
    row.append(reload());
    box.append(row);
  }
  box.append(stat(state.hostCount, `host${plural(state.hostCount)} known for this root`, "total"));
}

async function render() {
  const [stored, session, incognito, tabId] = await Promise.all([
    readLocal(["enabled", "userPac", "appliedPac", "userPacErrors"]),
    chrome.storage.session.get(["lastProxyError", "lastLearnError", "armed", "startupError"]),
    incognitoAllowed(),
    activeTabId(),
  ]);
  banners.replaceChildren();

  const state = tabId === null ? null : await send({ type: "getTabState", tabId });
  showState(state, tabId);

  if (stored.enabled !== true) banner("Proxy is switched off for this extension");
  if (stored.enabled === true && stored.userPac !== undefined && session.armed !== true) banner(CLOSED_TEXT);
  if (!incognito) banner(INCOGNITO_TEXT);
  if (stored.userPac === undefined) banner("No user PAC configured");
  if (stored.userPacErrors !== undefined) {
    banner("Saved user PAC no longer passes validation — protection continues with the last applied configuration. Fix it in Options");
  }
  if (session.startupError !== undefined) banner(`RootPAC failed to start: ${session.startupError}`, "banner error");
  const learnError = session.lastLearnError;
  if (learnError !== undefined) banner(`${formatTime(learnError.time)} — Learning failed: ${learnError.message}`, "banner error");
  const error = session.lastProxyError;
  if (error !== undefined && error !== null) {
    banner(`${formatTime(error.time)} — ${proxyErrorText(error, stored.appliedPac, stored.userPac)}`, "banner error");
  }
}

let rendering = null;
let again = false;

const refresh = () => {
  if (rendering !== null) {
    again = true;
    return;
  }
  rendering = (async () => {
    do {
      again = false;
      try {
        await render();
      } catch (error) {
        banners.replaceChildren(element("p", "banner error", error.message));
      }
    } while (again);
    rendering = null;
  })();
};

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("viewer").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/viewer/viewer.html") });
});

onStored(refresh);
refresh();
