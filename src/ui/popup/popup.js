import { NOTICE_KEYS, notices } from "../shared/notices.js";
import { INCOGNITO_TEXT, element, formatTime, incognitoAllowed, onStored, proxyErrorText, readLocal, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

// A render builds the card and the messages off the page and puts them in at once, and only when they changed: a popup
// emptied while it waits for the worker shrinks and grows again, and Chrome redraws its window each time.
const shown = { box: document.getElementById("state"), banners: document.getElementById("banners") };
let box = shown.box;
let banners = shown.banners;
// The tab the popup shows, once known: storage writes of other tabs do not redraw it.
let shownTab = null;

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

// Blocked hosts are listed by site, the unit a route is decided for, with the hosts the page asked for; a few names each,
// the rest are in System PAC.
const LISTED_HOSTS = 3;

function conflictBanner(conflicts, mask, tabId) {
  const node = element("div", "banner error");
  const sites = Map.groupBy(conflicts, ({ site }) => site);
  const plural = sites.size === 1 ? "" : "s";
  const head = element("div", "head");
  head.append(element("div", "title", `Proxy conflict: ${sites.size} site${plural} blocked`));
  // Route here gives this root every site the page is blocked from and reloads the page to use them.
  const routeHere = element("button", "small", "Route here");
  const hosts = [...new Set(conflicts.map(({ host }) => host))];
  // What the button sends is part of the markup a redraw compares.
  routeHere.dataset.hosts = hosts.join(" ");
  routeHere.title = `Send ${sites.size === 1 ? "this site" : "these sites"} through the proxy of ${mask}; the other roots keep their hosts, blocked`;
  routeHere.addEventListener("click", async () => {
    routeHere.disabled = true;
    try {
      const result = await send({ type: "routeHere", mask, hosts });
      if (!result.ok) throw new Error(result.error);
      await chrome.tabs.reload(tabId);
      window.close();
    } catch (error) {
      routeHere.disabled = false;
      banner(error.message, "banner error");
    }
  });
  head.append(routeHere);
  node.append(head);
  const list = element("ul");
  for (const [site, items] of sites) {
    const item = element("li");
    const { owner, ownerProxy } = items[0];
    const requests = [...new Set(items.map(({ request }) => request))];
    const more = requests.length > LISTED_HOSTS ? ` and ${requests.length - LISTED_HOSTS} more` : "";
    item.append(element("span", "mono", site), ` via ${owner}${ownerProxy === null ? "" : ` (${ownerProxy})`}: `, element("span", "mono", requests.slice(0, LISTED_HOSTS).join(", ")), more);
    list.append(item);
  }
  const { proxy } = conflicts[0];
  const own = proxy === null ? "" : `This root uses ${proxy}. `;
  const hint = `${own}Every host of a site goes through the proxy of the root that owns the site: Route here gives ${sites.size === 1 ? "it" : "them"} to this root and blocks the other roots instead, or use one proxy for these roots.`;
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
  const sites = new Set(conflicts.map(({ site }) => site)).size;
  if (conflicts.length > 0) box.append(stat(sites, `site${plural(sites)} blocked by a proxy conflict`, "failed"));
  if (state.newHosts > 0) box.append(stat(state.newHosts, `new host${plural(state.newHosts)} blocked and learned`, "learned"));
  box.append(stat(state.hostCount, `host${plural(state.hostCount)} known for this root`, "total"));
}

async function render() {
  const [stored, session, incognito, tabId] = await Promise.all([
    readLocal([...NOTICE_KEYS.local, "appliedPac"]),
    chrome.storage.session.get(NOTICE_KEYS.session),
    incognitoAllowed(),
    activeTabId(),
  ]);
  const state = tabId === null ? null : await send({ type: "getTabState", tabId });
  shownTab = tabId;
  box = element("div");
  banners = element("div");
  showState(state, tabId);

  for (const notice of notices(stored, session, { page: "popup" })) banner(notice.text, notice.level === "error" ? "banner error" : "banner");
  if (!incognito) banner(INCOGNITO_TEXT);
  if (stored.userPac === undefined) banner("No user PAC configured");
  const conflicts = state?.ok ? (state.conflicts ?? []) : [];
  if (conflicts.length > 0) conflictBanner(conflicts, state.mask, tabId);
  const error = state?.ok ? state.proxyError : null;
  if (error !== null && error !== undefined) {
    const failed = error.count > 1 ? ` (${error.count} requests failed on this page)` : "";
    banner(`${formatTime(error.time)} — ${proxyErrorText(error, stored.appliedPac, stored.userPac)}${failed}`, "banner error");
  }
  return show();
}

// Puts a built view in; false when the page already shows the same.
function show() {
  const built = { box, banners };
  box = shown.box;
  banners = shown.banners;
  if (built.box.innerHTML === box.innerHTML && built.banners.innerHTML === banners.innerHTML) return false;
  box.replaceChildren(...built.box.childNodes);
  banners.replaceChildren(...built.banners.childNodes);
  return true;
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
      let changed = true;
      try {
        changed = await render();
      } catch (error) {
        box = shown.box;
        banners = shown.banners;
        banners.replaceChildren(element("p", "banner error", error.message));
      }
      if (changed) fit();
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

// What the popup shows: the settings, the groups (the root's known hosts) and owners, the worker's state and this tab.
const SHOWN = new Set([...NOTICE_KEYS.local, ...NOTICE_KEYS.session, "appliedPac", "analysis", "sites", "proxies"]);

onStored((changes) => {
  const tabKey = shownTab === null ? null : `tab:${shownTab}`;
  if (Object.keys(changes).some((key) => SHOWN.has(key) || key.startsWith("group:") || key === tabKey || (shownTab === null && key.startsWith("tab:")))) refresh();
});
refresh();
