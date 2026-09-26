import { LOG_CHANNEL, LOG_LIMIT } from "../../background/log.js";
import { createLogDb } from "../../background/logdb.js";
import { download, element, formatTime, onStored, readLocal, timeZone } from "../shared/rpc.js";
import { header } from "../shared/logo.js";
import { CATEGORIES, entryLevel, entryText, failuresByHost } from "./entries.js";

document.getElementById("head").replaceWith(header("Diagnostic log"));

const MAX_ROWS = 1000;
const MAX_FAILED_HOSTS = 30;

const db = createLogDb();
const banners = document.getElementById("banners");
const failuresBox = document.getElementById("failures");
const eventsBox = document.getElementById("events");
const summary = document.getElementById("summary");
const category = document.getElementById("category");
const filter = document.getElementById("filter");

let entries = [];
let lastId = 0;
let texts = new Map();

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
  const zone = element("p", "banner info", `Times are local: ${timeZone()}.`);
  if (logEnabled === true) {
    banners.replaceChildren(zone);
    return;
  }
  const off = element("p", "banner", "Recording is off. Turn on “Record a diagnostic log” in ");
  const link = element("a", undefined, "Options");
  link.href = "../options/options.html";
  link.target = "_blank";
  off.append(link, ".");
  banners.replaceChildren(off, zone);
}

function renderFailures() {
  const rows = failuresByHost(entries);
  if (rows.length === 0) {
    failuresBox.replaceChildren(element("p", "muted", "No proxy failures recorded"));
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
      renderEvents();
    });
    const errors = [...row.errors].map(([error, count]) => (row.errors.size === 1 ? error : `${error} ×${count}`)).join(", ");
    line.append(host, element("td", undefined, String(row.count)), element("td", "mono", errors), element("td", "muted", row.route ?? "—"), element("td", "muted", formatTime(row.last)));
    table.append(line);
  }
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const note = element("p", "muted", `${total} failed request${total === 1 ? "" : "s"} to ${rows.length} host${rows.length === 1 ? "" : "s"}${rows.length > MAX_FAILED_HOSTS ? `, top ${MAX_FAILED_HOSTS} shown` : ""}. Every host failing at once means the proxy itself is unreachable; a few hosts failing while the rest load mean the proxy cannot reach those hosts.`);
  failuresBox.replaceChildren(table, note);
}

function matches(entry, kinds, needle) {
  if (kinds !== null && !kinds.has(entry.kind)) return false;
  if (needle === "") return true;
  return textOf(entry).toLowerCase().includes(needle) || (entry.url ?? "").toLowerCase().includes(needle);
}

function renderEvents() {
  const kinds = CATEGORIES[category.value] ?? null;
  const needle = filter.value.trim().toLowerCase();
  const table = element("table");
  let shown = 0;
  let matched = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!matches(entry, kinds, needle)) continue;
    matched += 1;
    if (shown >= MAX_ROWS) continue;
    shown += 1;
    const row = element("tr", `level-${entryLevel(entry)}`);
    const text = element("td", "event", textOf(entry));
    if (entry.url !== undefined && entry.url !== null) text.title = entry.url;
    row.append(element("td", "muted time", formatTime(entry.time, { milliseconds: true })), text);
    table.append(row);
  }
  summary.textContent = `${matched} event${matched === 1 ? "" : "s"}${matched > shown ? `, latest ${shown} shown` : ""} · ${entries.length} of the last ${LOG_LIMIT} kept`;
  eventsBox.replaceChildren(...(shown === 0 ? [element("p", "muted", "No events")] : [table]));
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
  const stamp = formatTime(Date.now()).replace(/[: ]/g, "-");
  download(`rootpac-log-${stamp}.txt`, `RootPAC diagnostic log, times in ${timeZone()}\n${lines.join("\n")}\n`, "text/plain");
});

category.addEventListener("change", renderEvents);
filter.addEventListener("input", renderEvents);

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
