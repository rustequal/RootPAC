import { LOG_CHANNEL, LOG_LIMIT } from "../../background/log.js";
import { createLogDb } from "../../background/logdb.js";
import { download, element, formatTime, onStored, readLocal, timeZone } from "../shared/rpc.js";
import { header } from "../shared/logo.js";
import { CATEGORIES, entryLevel, entryText, failuresByHost, pageNumbers, paginate } from "./entries.js";

document.getElementById("head").replaceWith(header("Diagnostic log"));

const PAGE_SIZE = 1000;
const MAX_FAILED_HOSTS = 30;
const FILTER_DELAY_MS = 150;

const db = createLogDb();
const banners = document.getElementById("banners");
const failuresBox = document.getElementById("failures");
const failuresCount = document.getElementById("failures-count");
const failuresBody = document.getElementById("failures-body");
const pagers = [document.getElementById("pager-top"), document.getElementById("pager-bottom")];
const eventsBox = document.getElementById("events");
const summary = document.getElementById("summary");
const category = document.getElementById("category");
const filter = document.getElementById("filter");

let entries = [];
let lastId = 0;
let texts = new Map();
// The page shown, 1 for the newest events. Page 1 follows new events; away from it the pages count from `anchor`, the
// newest event when the reader left page 1, so the events of a page stay put while new ones arrive.
let page = 1;
let anchor = null;

const textOf = (entry) => {
  let text = texts.get(entry.id);
  if (text === undefined) {
    text = entryText(entry);
    texts.set(entry.id, text);
  }
  return text;
};

async function showBanners() {
  const { logEnabled } = await readLocal(["logEnabled"]);
  if (logEnabled === true) {
    banners.replaceChildren();
    return;
  }
  const off = element("p", "banner", "Recording is off. Turn on “Record a diagnostic log” in ");
  const link = element("a", undefined, "Options");
  link.href = "../options/options.html";
  link.target = "_blank";
  off.append(link, ".");
  banners.replaceChildren(off);
}

// The table is built only while the block is open; the page opens with it closed.
function renderFailures() {
  const rows = failuresByHost(entries);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  failuresCount.textContent = rows.length === 0 ? "none recorded" : `${plural(rows.length, "host")}, ${plural(total, "failed request")}`;
  if (!failuresBox.open) {
    failuresBody.replaceChildren();
    return;
  }
  if (rows.length === 0) {
    failuresBody.replaceChildren(element("p", "muted", "No proxy failures recorded"));
    return;
  }
  const table = element("table");
  const head = element("tr");
  for (const label of ["Host", "Failures", "Errors", "Route", "Last"]) head.append(element("th", undefined, label));
  table.append(head);
  for (const row of rows.slice(0, MAX_FAILED_HOSTS)) {
    const line = element("tr");
    const host = element("td", "host clickable", row.host);
    host.title = "Show the events of this host";
    host.addEventListener("click", () => {
      filter.value = row.host;
      category.value = "all";
      showFirstPage();
      filter.scrollIntoView({ block: "nearest" });
    });
    const errors = [...row.errors].map(([error, count]) => (row.errors.size === 1 ? error : `${error} ×${count}`)).join(", ");
    line.append(host, element("td", undefined, String(row.count)), element("td", "mono", errors), element("td", "muted", row.route ?? "—"), element("td", "muted", formatTime(row.last)));
    table.append(line);
  }
  const note = element("p", "muted note", `${total} failed request${total === 1 ? "" : "s"} to ${rows.length} host${rows.length === 1 ? "" : "s"}${rows.length > MAX_FAILED_HOSTS ? `, top ${MAX_FAILED_HOSTS} shown` : ""}. Every host failing at once means the proxy itself is unreachable; a few hosts failing while the rest load mean the proxy cannot reach those hosts.`);
  failuresBody.replaceChildren(table, note);
}

function matches(entry, kinds, needle) {
  if (kinds !== null && !kinds.has(entry.kind)) return false;
  if (needle === "") return true;
  return textOf(entry).toLowerCase().includes(needle) || (entry.url ?? "").toLowerCase().includes(needle);
}

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function goTo(number) {
  if (number === 1) anchor = null;
  else if (anchor === null) anchor = lastId;
  page = number;
  renderEvents();
}

function showFirstPage() {
  page = 1;
  anchor = null;
  renderEvents();
}

function pageButton(label, number, title, disabled = false) {
  const button = element("button", "small", label);
  button.title = title;
  button.disabled = disabled;
  button.addEventListener("click", () => {
    goTo(number);
    // A page read from the bottom pager starts at its top.
    pagers[0].scrollIntoView({ block: "nearest" });
  });
  return button;
}

function renderPager(pages) {
  for (const pager of pagers) {
    if (pages <= 1) {
      pager.replaceChildren();
      continue;
    }
    const first = page === 1;
    const last = page === pages;
    const items = [pageButton("«", 1, "First page", first), pageButton("‹", page - 1, "Previous page", first)];
    for (const number of pageNumbers(page, pages)) {
      if (number === null) {
        items.push(element("span", "gap muted", "…"));
        continue;
      }
      const button = pageButton(String(number), number, `Page ${number}`);
      if (number === page) {
        button.classList.add("current");
        button.setAttribute("aria-current", "page");
      }
      items.push(button);
    }
    items.push(pageButton("›", page + 1, "Next page", last), pageButton("»", pages, "Last page", last));
    pager.replaceChildren(...items);
  }
}

function renderEvents() {
  const kinds = CATEGORIES[category.value] ?? null;
  const needle = filter.value.trim().toLowerCase();
  // The matching events, newest first; those newer than the anchor wait for page 1.
  const matched = [];
  let fresh = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!matches(entry, kinds, needle)) continue;
    if (anchor !== null && entry.id > anchor) fresh += 1;
    else matched.push(entry);
  }
  const view = paginate(matched.length, page, PAGE_SIZE);
  page = view.page;
  const table = element("table");
  for (const entry of matched.slice(view.from, view.to)) {
    const row = element("tr", `level-${entryLevel(entry)}`);
    const text = element("td", "event", textOf(entry));
    if (entry.url !== undefined && entry.url !== null) text.title = entry.url;
    row.append(element("td", "muted time", formatTime(entry.time, { milliseconds: true })), text);
    table.append(row);
  }
  const range = view.pages > 1 ? ` · page ${page} of ${view.pages}, ${(view.from + 1).toLocaleString()}–${view.to.toLocaleString()}` : "";
  summary.replaceChildren(`${plural(matched.length + fresh, "event")}${range} · ${entries.length.toLocaleString()} of the last ${LOG_LIMIT.toLocaleString()} kept`);
  if (fresh > 0) {
    const link = element("a", "fresh", `${plural(fresh, "new event")} — show`);
    link.href = "#";
    link.title = "Go to the first page, which follows new events";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showFirstPage();
    });
    summary.append(" · ", link);
  }
  renderPager(view.pages);
  eventsBox.replaceChildren(view.to === view.from ? element("p", "muted empty", "No events") : table);
}

function render() {
  renderFailures();
  renderEvents();
}

async function readNew() {
  const rows = await db.read(lastId);
  if (rows.length === 0) return;
  lastId = rows[rows.length - 1].id;
  entries = entries.concat(rows);
  if (entries.length > LOG_LIMIT) {
    const dropped = entries.splice(0, entries.length - LOG_LIMIT);
    for (const entry of dropped) texts.delete(entry.id);
  }
  render();
}

let pending = 0;
const scheduleRead = () => {
  clearTimeout(pending);
  pending = setTimeout(() => readNew().catch(showError), 300);
};

function showError(error) {
  banners.append(element("p", "banner error", error.message));
}

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear the diagnostic log?")) return;
  try {
    await db.clear();
    entries = [];
    texts = new Map();
    page = 1;
    anchor = null;
    render();
  } catch (error) {
    showError(error);
  }
});

document.getElementById("export").addEventListener("click", () => {
  const lines = entries.map((entry) => {
    const { id, time, kind, ...fields } = entry;
    return `${formatTime(time, { milliseconds: true })}\t${kind}\t${textOf(entry)}\t${JSON.stringify(fields)}`;
  });
  const now = new Date();
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join("-");
  download(`rootpac-log-${stamp}.txt`, `RootPAC diagnostic log, times in ${timeZone()}\n${lines.join("\n")}\n`, "text/plain");
});

let filtering = 0;
category.addEventListener("change", showFirstPage);
filter.addEventListener("input", () => {
  clearTimeout(filtering);
  filtering = setTimeout(showFirstPage, FILTER_DELAY_MS);
});
failuresBox.addEventListener("toggle", renderFailures);

new BroadcastChannel(LOG_CHANNEL).addEventListener("message", scheduleRead);
onStored((changes, area) => {
  if (area === "local" && "logEnabled" in changes) showBanners().catch(showError);
});

showBanners().catch(showError);
readNew()
  .then(() => {
    if (entries.length === 0) render();
  })
  .catch(showError);
