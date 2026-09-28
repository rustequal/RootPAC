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
  const node = element("p", className, text);
  node.title = text;
  banners.append(node);
}

// Chrome shows at most 600 px of a popup and scrolls the rest. When the messages do not fit, their explanations go
// first and then their text is cut to two lines, then to one, then the page counters to one line each; the full text
// of each message stays in its tooltip.
const MAX_HEIGHT = 600;
const FITS = ["tight", "tighter", "tightest"];

function fit() {
  document.body.classList.remove(...FITS);
  for (const level of FITS) {
    if (document.body.getBoundingClientRect().height <= MAX_HEIGHT) return;
    document.body.classList.add(level);
  }
}

// Blocked hosts are listed by the root whose proxy carries them; a few names each, the rest are in System PAC.
const LISTED_HOSTS = 3;

function conflictBanner(conflicts) {
  const node = element("div", "banner error");
  const plural = conflicts.length === 1 ? "" : "s";
  node.append(element("div", "title", `Proxy conflict: ${conflicts.length} host${plural} blocked on this root`));
  const owners = Map.groupBy(conflicts, ({ owner }) => owner);
  const list = element("ul");
  for (const [owner, items] of owners) {
    const item = element("li");
    const hosts = items.slice(0, LISTED_HOSTS).map(({ host }) => host).join(", ");
    const more = items.length > LISTED_HOSTS ? ` and ${items.length - LISTED_HOSTS} more` : "";
    item.append(`${owner}${items[0].ownerProxy === null ? "" : ` (${items[0].ownerProxy})`}: `, element("span", "mono", hosts), more);
    list.append(item);
  }
  const { proxy } = conflicts[0];
  const own = proxy === null ? "" : `This root uses ${proxy}. `;
  const hint = `${own}A PAC sees the host, not the tab, so a host has one proxy for all roots: use one proxy for these roots, or remove the host from a group in System PAC.`;
  node.title = hint;
  node.append(list, element("div", "hint", hint));
  banners.append(node);
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
  const head = element("div", "head");
  head.append(element("div", "mask", state.mask));
  // One Reload for whatever a reload can fix: a proxy failure, a load that raced protection, newly learned hosts.
  const failed = state.proxyError !== null && state.proxyError !== undefined;
  if (failed || state.incomplete || state.newHosts > 0) {
    const reload = element("button", "small primary", "Reload");
    reload.addEventListener("click", async () => {
      await chrome.tabs.reload(tabId);
      window.close();
    });
    head.append(reload);
  }
  box.append(head);
  if (state.loaded > 0) box.append(stat(state.loaded, `host${plural(state.loaded)} loaded on this page`, "loaded"));
  if (state.proxied > 0) box.append(stat(state.proxied, `host${plural(state.proxied)} routed through the proxy`, "proxied"));
  if (failed) box.append(stat(state.proxyError.count, `request${plural(state.proxyError.count)} failed at the proxy`, "failed"));
  if (state.incomplete) {
    const row = element("div", "stat learned");
    row.append(element("span", "label", "Loaded before protection was ready — part of the page was blocked"));
    box.append(row);
  }
  const conflicts = state.conflicts ?? [];
  if (conflicts.length > 0) box.append(stat(conflicts.length, `host${plural(conflicts.length)} blocked by a proxy conflict`, "failed"));
  if (state.newHosts > 0) box.append(stat(state.newHosts, `new host${plural(state.newHosts)} blocked and learned`, "learned"));
  box.append(stat(state.hostCount, `host${plural(state.hostCount)} known for this root`, "total"));
}

async function render() {
  const [stored, session, incognito, tabId] = await Promise.all([
    readLocal(["enabled", "userPac", "appliedPac", "userPacErrors"]),
    chrome.storage.session.get(["lastLearnError", "armed", "startupError"]),
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
  const conflicts = state?.ok ? (state.conflicts ?? []) : [];
  if (conflicts.length > 0) conflictBanner(conflicts);
  const error = state?.ok ? state.proxyError : null;
  if (error !== null && error !== undefined) {
    const failed = error.count > 1 ? ` (${error.count} requests failed on this page)` : "";
    banner(`${formatTime(error.time)} — ${proxyErrorText(error, stored.appliedPac, stored.userPac)}${failed}`, "banner error");
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
      fit();
    } while (again);
    rendering = null;
  })();
};

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("viewer").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/viewer/viewer.html") });
});

document.getElementById("log").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/log/log.html") });
});

onStored((changes) => {
  if (Object.keys(changes).some((key) => key !== "logEnabled")) refresh();
});
refresh();
