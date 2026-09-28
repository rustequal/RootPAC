import { download, element, formatTime, onStored, readLocal, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

document.getElementById("head").replaceWith(header("System PAC"));

const pac = document.getElementById("pac");
const groupsBox = document.getElementById("groups");
const filter = document.getElementById("filter");
const errorBox = document.getElementById("error");

let state = { appliedPac: "", groups: new Map(), seen: new Map(), routes: {} };
const open = new Set();

// Which proxy a host goes through for this root: its own, another root's that is the same, or another root's that is
// not, in which case the host is blocked for this root (a proxy conflict) and Route here hands it to this root.
function routeCell({ owner, verdict, ownerProxy } = {}, blocked = [], routeHere = null) {
  const cell = element("td");
  const box = element("div", "route");
  const status = element("div", "status");
  const line = (className, text, ...details) => {
    status.append(element("div", className, text));
    for (const detail of details) status.append(element("div", "detail", detail));
  };
  if (owner === undefined && blocked.length > 0) {
    line("warn", "own proxy", `blocked for ${blocked.join(", ")}`);
    status.title = `A proxy conflict: ${blocked.join(", ")} learned this host too, but it goes through this root's proxy. Route here in the other group hands it over.`;
  } else if (owner === undefined) {
    line("muted", "own proxy");
  } else if (verdict === "same") {
    line("muted", `same proxy as ${owner}`);
  } else if (verdict === "unchecked") {
    line("warn", "blocked here", `via ${owner}`, "proxies not checked yet");
  } else {
    line("error", "blocked here", `via ${owner}`, ...(ownerProxy === null ? [] : [ownerProxy]));
    status.title = `A proxy conflict: the host goes through the proxy of ${owner}, so it is blocked for this root.`;
  }
  box.append(status);
  if (verdict === "conflict" && routeHere !== null) {
    const button = element("button", "small", "Route here");
    button.title = `Send this host through this root's proxy; ${owner} keeps it, blocked, until you route it back`;
    button.addEventListener("click", () => routeHere(button));
    box.append(button);
  }
  cell.append(box);
  return cell;
}

// A button that sends a command, stays disabled while it runs and reports a failure; a change redraws the page.
async function run(button, message) {
  button.disabled = true;
  try {
    const result = await send(message);
    if (!result.ok) showMessage(result.error);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

function blockedCount(route) {
  return route?.shared.filter(({ verdict }) => verdict === "conflict").length ?? 0;
}

function hostRows(mask, hosts, seen, needle, route) {
  const shared = new Map((route?.shared ?? []).map((item) => [item.host, item]));
  const table = element("table", "hosts");
  const head = element("tr");
  for (const label of ["Host", "Route", "Learned", "Last seen", ""]) head.append(element("th", undefined, label));
  table.append(head);
  for (const host of Object.keys(hosts).sort()) {
    if (needle !== "" && !host.includes(needle)) continue;
    const row = element("tr");
    row.append(element("td", "host", host));
    row.append(routeCell(shared.get(host), route?.blocks[host], (button) => run(button, { type: "routeHere", mask, hosts: [host] })));
    row.append(element("td", "muted", formatTime(hosts[host])));
    row.append(element("td", "muted", seen[host] === undefined ? "—" : formatTime(seen[host])));
    const cell = element("td");
    const remove = element("button", "small", "Remove");
    remove.addEventListener("click", () => run(remove, { type: "removeHost", mask, host }));
    cell.append(remove);
    row.append(cell);
    table.append(row);
  }
  // Records of other roots under this root's records decide the route of the names under them, and are blocked here
  // when their proxy differs.
  for (const item of route?.shared ?? []) {
    if (Object.hasOwn(hosts, item.host) || item.verdict === "same" || (needle !== "" && !item.host.includes(needle))) continue;
    const row = element("tr");
    const cell = element("td", "host", item.host);
    cell.append(element("span", "muted", ` learned by ${item.owner}`));
    row.append(cell, routeCell(item), element("td", "muted", "—"), element("td", "muted", "—"), element("td"));
    table.append(row);
  }
  return table;
}

function showMessage(text) {
  errorBox.replaceChildren(element("p", "banner error", text));
}

function renderGroups() {
  const needle = filter.value.trim().toLowerCase();
  const boxes = [];
  for (const [mask, group] of [...state.groups.entries()].sort()) {
    const hosts = Object.keys(group.hosts);
    const route = state.routes[mask];
    const names = [...hosts, ...(route?.shared ?? []).filter(({ verdict }) => verdict !== "same").map(({ host }) => host)];
    if (needle !== "" && !names.some((host) => host.includes(needle))) continue;
    const box = element("details");
    box.open = needle !== "" || open.has(mask);
    const summary = element("summary");
    summary.append(element("span", "mask", mask));
    const proxy = group.rootHost === null ? "" : ` · ${route?.proxy ?? "proxy not checked yet"}`;
    const info = element("span", "muted grow", `${group.rootHost ?? "no root host yet"}${proxy} · ${hosts.length} host${hosts.length === 1 ? "" : "s"}`);
    const blocked = blockedCount(route);
    if (blocked > 0) info.append(element("span", "error", ` · ${blocked} blocked by a proxy conflict`));
    summary.append(info);
    const clear = element("button", "small", "Clear group");
    clear.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!confirm(`Clear every learned host of ${mask}?`)) return;
      try {
        const result = await send({ type: "clearGroup", mask });
        if (!result.ok) showMessage(result.error);
      } catch (error) {
        showMessage(error.message);
      }
    });
    summary.append(clear);
    box.append(summary);
    box.addEventListener("toggle", () => {
      if (needle === "") {
        if (box.open) open.add(mask);
        else open.delete(mask);
      }
      if (!box.open) return;
      box.replaceChildren(summary, hostRows(mask, group.hosts, state.seen.get(mask) ?? {}, needle, route));
    });
    if (box.open) box.append(hostRows(mask, group.hosts, state.seen.get(mask) ?? {}, needle, route));
    boxes.push(box);
  }
  groupsBox.replaceChildren(...(boxes.length === 0 ? [element("p", "muted", "No groups")] : boxes));
}

async function render() {
  const [stored, routes] = await Promise.all([readLocal(null), send({ type: "getRoutes" }).catch(() => null)]);
  state = {
    routes: routes?.ok ? routes.roots : {},
    appliedPac: stored.appliedPac ?? "",
    userPac: stored.userPac,
    groups: new Map(Object.entries(stored).filter(([key]) => key.startsWith("group:")).map(([key, value]) => [key.slice(6), value])),
    seen: new Map(Object.entries(stored).filter(([key]) => key.startsWith("seen:")).map(([key, value]) => [key.slice(5), value])),
  };
  pac.textContent = state.appliedPac === "" ? "—" : state.appliedPac;
  errorBox.replaceChildren();
  renderGroups();
}

document.getElementById("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.appliedPac);
  const status = document.getElementById("status");
  status.textContent = "Copied";
  status.className = "ok";
});
document.getElementById("download").addEventListener("click", () => download("rootpac.pac", state.appliedPac, "application/x-ns-proxy-autoconfig"));
filter.addEventListener("input", renderGroups);
let refresh = 0;
const VIEWED = new Set(["appliedPac", "userPac", "analysis", "proxies"]);

onStored((changes) => {
  if (!Object.keys(changes).some((key) => VIEWED.has(key) || key.startsWith("group:") || key.startsWith("seen:"))) return;
  clearTimeout(refresh);
  refresh = setTimeout(render, 200);
});
render();
