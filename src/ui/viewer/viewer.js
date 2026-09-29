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
function routeCell(mask, { site, owner, verdict, ownerProxy }, blocked = [], routeHere = null, own = false) {
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
  // The root's own site handed to another root can always be taken back, on the same proxy too.
  if (routeHere !== null && (verdict === "conflict" || (own && owner !== mask))) {
    const button = element("button", "small", "Route here");
    button.title = own
      ? `Route ${site} through this root's proxy again`
      : `Send every host of ${site} through this root's proxy; ${owner} keeps its hosts, blocked, until you route the site back`;
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

// The sites of a group, the root's own first: each with its route (the same for every host of the site), the learned
// hosts of this group in it and the root domains in it — the group's own, and those of roots that handed their site to
// this one. A root's domain is never learned, but it is a site of the group that routes it like any learned one.
function sitesOf(mask, hosts, route) {
  const rootRoute = route?.root ?? { site: mask, owner: mask, verdict: "same", ownerProxy: null };
  const sites = new Map([[rootRoute.site, { route: rootRoute, hosts: [], roots: [mask], own: true }]]);
  const siteFor = (record) => {
    if (!sites.has(record.site)) sites.set(record.site, { route: record, hosts: [], roots: [], own: false });
    return sites.get(record.site);
  };
  for (const host of Object.keys(hosts).sort()) siteFor(route?.records[host] ?? { site: host, owner: mask, verdict: "same", ownerProxy: null }).hosts.push(host);
  for (const [root, record] of Object.entries(route?.taken ?? {}).sort()) siteFor(record).roots.push(root);
  const others = [...sites.keys()].filter((site) => site !== rootRoute.site).sort();
  return [rootRoute.site, ...others].map((site) => [site, sites.get(site)]);
}

function blockedCount(mask, hosts, route) {
  return sitesOf(mask, hosts, route).filter(([, { route: site }]) => site.verdict === "conflict").length;
}

function times(list, values, pick) {
  const known = list.filter((host) => values[host] !== undefined).map((host) => values[host]);
  return known.length === 0 ? "—" : formatTime(pick(...known));
}

// A row per site with its route, Route here and Remove for the whole site, and under it a row per root domain and per
// learned host of the site, unless the site is a single name of its own.
function siteRows(mask, hosts, seen, needle, route) {
  const table = element("table", "hosts");
  const head = element("tr");
  for (const label of ["Site and hosts", "Route", "Learned", "Last seen", ""]) head.append(element("th", undefined, label));
  table.append(head);
  for (const [site, { route: siteRoute, hosts: list, roots, own }] of sitesOf(mask, hosts, route)) {
    if (needle !== "" && ![site, ...roots, ...list].some((name) => name.includes(needle))) continue;
    const row = element("tr", "site");
    const target = own ? mask : (list[0] ?? roots[0]);
    row.append(element("td", "host", site), routeCell(mask, siteRoute, route?.blocks[site], (button) => run(button, { type: "routeHere", mask, hosts: [target] }), own));
    row.append(element("td", "muted", times(list, hosts, Math.min)), element("td", "muted", times(list, seen, Math.max)));
    const actions = element("td", "actions");
    if (list.length > 0) {
      const remove = element("button", "small", "Remove site");
      remove.title = `Remove every learned host of ${site} from ${mask}`;
      remove.addEventListener("click", () => run(remove, { type: "removeSite", mask, site }));
      actions.append(remove);
    }
    row.append(actions);
    table.append(row);
    const sub = (host, learned, last, action = null) => {
      const line = element("tr", "sub");
      line.append(element("td", "host", host), element("td"), element("td", "muted", learned), element("td", "muted", last));
      const cell = element("td", "actions");
      if (action !== null) cell.append(action);
      line.append(cell);
      table.append(line);
    };
    const names = [...roots, ...list];
    if (names.length === 1 && names[0] === site) continue;
    // A root's domain is never learned: it has no times and cannot be removed.
    for (const root of roots) sub(root, "—", "—");
    for (const host of list) {
      const remove = element("button", "small", "Remove");
      remove.title = `Remove ${host} from ${mask}`;
      remove.addEventListener("click", () => run(remove, { type: "removeHost", mask, host }));
      sub(host, formatTime(hosts[host]), seen[host] === undefined ? "—" : formatTime(seen[host]), remove);
    }
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
    const names = [...hosts, ...Object.keys(route?.taken ?? {})];
    if (needle !== "" && !mask.includes(needle) && !names.some((host) => host.includes(needle))) continue;
    const box = element("details");
    box.open = needle !== "" || open.has(mask);
    const summary = element("summary");
    summary.append(element("span", "mask", mask));
    // The root's proxy and counts only: which sites are blocked and through which roots they go is in the table.
    // Hosts: the learned ones and the root domains the group lists, its own included.
    const sites = sitesOf(mask, group.hosts, route);
    const hostCount = sites.reduce((sum, [, site]) => sum + site.hosts.length + site.roots.length, 0);
    const info = element("span", "muted grow", `${route?.proxy ?? "proxy not checked yet"} · ${sites.length} site${sites.length === 1 ? "" : "s"}, ${hostCount} host${hostCount === 1 ? "" : "s"}`);
    const blocked = blockedCount(mask, group.hosts, route);
    if (blocked > 0) info.append(element("span", "error", ` · ${blocked} blocked`));
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
      box.replaceChildren(summary, siteRows(mask, group.hosts, state.seen.get(mask) ?? {}, needle, route));
    });
    if (box.open) box.append(siteRows(mask, group.hosts, state.seen.get(mask) ?? {}, needle, route));
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
