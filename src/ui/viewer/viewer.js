import { download, element, formatTime, onStored, readLocal, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

document.getElementById("head").replaceWith(header("System PAC"));

const pac = document.getElementById("pac");
const groupsBox = document.getElementById("groups");
const filter = document.getElementById("filter");
const errorBox = document.getElementById("error");

let state = { appliedPac: "", groups: new Map(), seen: new Map() };
const open = new Set();

function hostRows(mask, hosts, seen, needle) {
  const table = element("table");
  const head = element("tr");
  for (const label of ["Host", "First seen", "Last seen", ""]) head.append(element("th", undefined, label));
  table.append(head);
  for (const host of Object.keys(hosts).sort()) {
    if (needle !== "" && !host.includes(needle)) continue;
    const row = element("tr");
    row.append(element("td", "host", host));
    row.append(element("td", "muted", formatTime(hosts[host])));
    row.append(element("td", "muted", seen[host] === undefined ? "—" : formatTime(seen[host])));
    const cell = element("td");
    const remove = element("button", "small", "Remove");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        const result = await send({ type: "removeHost", mask, host });
        if (!result.ok) throw new Error(result.error);
      } catch (error) {
        remove.disabled = false;
        showMessage(error.message);
      }
    });
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
    const matches = needle === "" ? hosts : hosts.filter((host) => host.includes(needle));
    if (needle !== "" && matches.length === 0) continue;
    const box = element("details");
    box.open = needle !== "" || open.has(mask);
    const summary = element("summary");
    summary.append(element("span", "mask", mask));
    summary.append(element("span", "muted grow", `${group.rootHost ?? "no root host yet"} · ${hosts.length} host${hosts.length === 1 ? "" : "s"}`));
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
      box.replaceChildren(summary, hostRows(mask, group.hosts, state.seen.get(mask) ?? {}, needle));
    });
    if (box.open) box.append(hostRows(mask, group.hosts, state.seen.get(mask) ?? {}, needle));
    boxes.push(box);
  }
  groupsBox.replaceChildren(...(boxes.length === 0 ? [element("p", "muted", "No groups")] : boxes));
}

async function render() {
  const stored = await readLocal(null);
  state = {
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
const VIEWED = new Set(["appliedPac", "userPac", "analysis"]);

onStored((changes) => {
  if (!Object.keys(changes).some((key) => VIEWED.has(key) || key.startsWith("group:") || key.startsWith("seen:"))) return;
  clearTimeout(refresh);
  refresh = setTimeout(render, 200);
});
render();
