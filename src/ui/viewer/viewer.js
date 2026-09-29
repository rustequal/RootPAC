import { download, element, formatTime, onStored, readLocal, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

document.getElementById("head").replaceWith(header("System PAC"));

const pac = document.getElementById("pac");
const groupsBox = document.getElementById("groups");
const filter = document.getElementById("filter");
const errorBox = document.getElementById("error");

let state = { appliedPac: "", groups: new Map(), seen: new Map(), routes: {} };
const open = new Set();

// Which proxy a host goes through for this root. Every host of a site goes through the proxy of the root that owns the
// site: this root, another root on the same proxy, or another root on a different proxy, in which case the host is
// blocked here (a proxy conflict) and Route here hands the site to this root.
function routeCell(mask, { site, owner, verdict, ownerProxy }, blocked = [], routeHere = null) {
  const cell = element("td");
  const box = element("div", "route");
  const status = element("div", "status");
  const line = (className, text, ...details) => {
    status.append(element("div", className, text));
    for (const detail of details) status.append(element("div", "detail", detail));
  };
  if (owner === mask && blocked.length > 0) {
    line("warn", "own proxy", `blocked for ${blocked.join(", ")}`);
    status.title = `A proxy conflict: ${blocked.join(", ")} learned hosts of ${site} too, but the site goes through this root's proxy. Route here in their group hands it over.`;
  } else if (owner === mask) {
    line("muted", "own proxy");
  } else if (verdict === "same") {
    line("muted", `same proxy as ${owner}`);
  } else if (verdict === "unchecked") {
    line("warn", "blocked here", `via ${owner}`, "proxies not checked yet");
  } else {
    line("error", "blocked here", `via ${owner}`, ...(ownerProxy === null ? [] : [ownerProxy]));
    status.title = `A proxy conflict: ${site} goes through the proxy of ${owner}, so it is blocked for this root. Route here hands the whole site to this root.`;
  }
  box.append(status);
  if (verdict === "conflict" && routeHere !== null) {
    const button = element("button", "small", "Route here");
    button.title = `Send every host of ${site} through this root's proxy; ${owner} keeps its hosts, blocked, until you route the site back`;
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
  return Object.values(route?.records ?? {}).filter(({ verdict }) => verdict === "conflict").length;
}

function hostRows(mask, hosts, seen, needle, route) {
  const table = element("table", "hosts");
  const head = element("tr");
  for (const label of ["Host", "Route", "Learned", "Last seen", ""]) head.append(element("th", undefined, label));
  table.append(head);
  for (const host of Object.keys(hosts).sort()) {
    if (needle !== "" && !host.includes(needle)) continue;
    const record = route?.records[host] ?? { site: host, owner: mask, verdict: "same", ownerProxy: null };
    const row = element("tr");
    row.append(element("td", "host", host));
    row.append(routeCell(mask, record, route?.blocks[record.site], (button) => run(button, { type: "routeHere", mask, hosts: [host] })));
    row.append(element("td", "muted", formatTime(hosts[host])));
    row.append(element("td", "muted", seen[host] === undefined ? "—" : formatTime(seen[host])));
    const cell = element("td");
    const remove = element("button", "small", "Remove");
    remove.addEventListener("click", () => run(remove, { type: "removeHost", mask, host }));
    cell.append(remove);
    row.append(cell);
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
    if (needle !== "" && !hosts.some((host) => host.includes(needle))) continue;
    const box = element("details");
    box.open = needle !== "" || open.has(mask);
    const summary = element("summary");
    summary.append(element("span", "mask", mask));
    const proxy = group.rootHost === null ? "" : ` · ${route?.proxy ?? "proxy not checked yet"}`;
    const info = element("span", "muted grow", `${group.rootHost ?? "no root host yet"}${proxy} · ${hosts.length} host${hosts.length === 1 ? "" : "s"}`);
    const blocked = blockedCount(route);
    if (blocked > 0) info.append(element("span", "error", ` · ${blocked} blocked by a proxy conflict`));
    summary.append(info);
    // The root's own site handed to another root: the root's pages go through that root's proxy, or are closed.
    const siteOwner = route?.siteOwner ?? mask;
    if (siteOwner !== mask) {
      info.append(element("span", "warn", ` · site routed by ${siteOwner}`));
      const back = element("button", "small", "Route here");
      back.title = `Route ${mask} through this root's proxy again`;
      back.addEventListener("click", (event) => {
        event.preventDefault();
        run(back, { type: "routeHere", mask, hosts: [mask] });
      });
      summary.append(back);
    }
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
const VIEWED = new Set(["appliedPac", "userPac", "analysis", "proxies", "sites"]);

onStored((changes) => {
  if (!Object.keys(changes).some((key) => VIEWED.has(key) || key.startsWith("group:") || key.startsWith("seen:"))) return;
  clearTimeout(refresh);
  refresh = setTimeout(render, 200);
});
render();
