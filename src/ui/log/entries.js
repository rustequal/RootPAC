// Text of diagnostic log entries; no DOM, so it is unit-tested.

export const CATEGORIES = {
  errors: new Set(["proxyFailure", "proxyError", "requestError", "incomplete", "learnError", "applyError", "startupError"]),
  learning: new Set(["navigation", "blocked", "reported", "learned", "skipped"]),
  state: new Set(["protection", "command", "log", "lifecycle"]),
};

const LEVELS = {
  proxyFailure: "error",
  proxyError: "error",
  learnError: "error",
  applyError: "error",
  startupError: "error",
  requestError: "warn",
  incomplete: "warn",
  skipped: "warn",
};

const REASONS = {
  deny: "matches a deny() mask, blocked in the root's pages",
  bypass: "matches a bypass() mask, goes direct",
  "covers a bypass mask": "would cover a bypass() mask",
  "not a learnable name": "not a learnable host name",
};

const COMMANDS = {
  saveUserPac: "User PAC saved",
  importState: "Backup imported",
  setEnabled: "Proxy switched",
  removeHost: "Host removed",
  clearGroup: "Group cleared",
};

const tab = ({ tabId, tabHost }) => {
  if (tabId === null || tabId === undefined) return "";
  return tabHost === null || tabHost === undefined ? ` · tab ${tabId}` : ` · tab ${tabId} (${tabHost})`;
};

export function routeText({ route, group, entry }) {
  if (route === "root") return `root ${group}`;
  if (route === "learned") return entry === undefined ? `learned in ${group}` : `learned as ${entry} in ${group}`;
  if (route === "bypass") return "bypass, direct";
  if (route === "user PAC") return "User PAC route";
  return null;
}

function requestText(entry) {
  const route = routeText(entry);
  const from = entry.initiator === null || entry.initiator === undefined ? "" : ` from ${entry.initiator}`;
  const via = entry.ip === null || entry.ip === undefined ? "" : ` · ip ${entry.ip}`;
  return `${entry.error} — ${entry.host ?? entry.url}${route === null ? "" : ` [${route}]`} · ${entry.type ?? "request"}${from}${tab(entry)}${via}`;
}

function commandText(entry) {
  if (!entry.ok) return `${COMMANDS[entry.command] ?? entry.command} failed: ${entry.error ?? `${entry.problems} problem${entry.problems === 1 ? "" : "s"} in the User PAC`}`;
  switch (entry.command) {
    case "saveUserPac":
    case "importState":
      return `${COMMANDS[entry.command]}: ${entry.roots} root${entry.roots === 1 ? "" : "s"}`;
    case "setEnabled":
      return entry.enabled ? "Proxy switched on" : "Proxy switched off";
    case "removeHost":
      return `Host ${entry.host} removed from ${entry.root}`;
    case "clearGroup":
      return `Group ${entry.root} cleared`;
    default:
      return entry.command;
  }
}

function lifecycleText({ event, version, previousVersion }) {
  if (event === "startup") return `Browser started, RootPAC ${version}`;
  if (event === "install") return `RootPAC ${version} installed`;
  if (event === "update") return previousVersion === null ? `RootPAC updated to ${version}` : `RootPAC updated from ${previousVersion} to ${version}`;
  return `RootPAC ${version}: ${event}`;
}

export function entryText(entry) {
  switch (entry.kind) {
    case "navigation":
      return `Root page ${entry.host} [${entry.root}]${tab(entry)}`;
    case "blocked":
      return `New host ${entry.host} blocked and queued for learning into ${entry.root} · ${entry.type}${entry.initiator ? ` from ${entry.initiator}` : ""}${tab(entry)}`;
    case "reported":
      return `Reporting endpoint ${entry.host} of ${entry.root} queued for learning`;
    case "learned":
      return `${entry.host} learned into ${entry.root}${tab(entry)}`;
    case "skipped":
      return `${entry.host} requested by ${entry.root} is not learned: ${REASONS[entry.reason] ?? entry.reason}${tab(entry)}`;
    case "proxyFailure":
    case "requestError":
      return requestText(entry);
    case "proxyError":
      return `Proxy error ${entry.error}${entry.details ? `: ${entry.details}` : ""}${entry.fatal ? " (fatal)" : ""}`;
    case "incomplete":
      return `${entry.host} was blocked before protection was ready${tab(entry)}`;
    case "learnError":
      return `Learning failed: ${entry.message}`;
    case "applyError":
      return `Applying the configuration failed: ${entry.message}`;
    case "startupError":
      return `RootPAC failed to start: ${entry.message}`;
    case "protection":
      return entry.armed ? "Protection on: the System PAC and blocking rules are applied" : "Protection off: proxy settings are not under RootPAC control, root sites are blocked";
    case "command":
      return commandText(entry);
    case "log":
      return entry.enabled ? `Diagnostic log started, RootPAC ${entry.version}` : "Diagnostic log stopped";
    case "lifecycle":
      return lifecycleText(entry);
    default:
      return entry.kind;
  }
}

export function entryLevel(entry) {
  if (entry.kind === "protection" && !entry.armed) return "warn";
  if (entry.kind === "command" && !entry.ok) return "warn";
  return LEVELS[entry.kind] ?? "info";
}

// Proxy failures by host, most frequent first. A proxy that is down fails every host; failures of a few hosts
// while others load point at the proxy's side of those hosts (DNS, IPv6, a block on the exit).
export function failuresByHost(entries) {
  const hosts = new Map();
  for (const entry of entries) {
    if (entry.kind !== "proxyFailure") continue;
    const key = entry.host ?? entry.url;
    let row = hosts.get(key);
    if (row === undefined) {
      row = { host: key, count: 0, errors: new Map(), first: entry.time, last: entry.time, route: routeText(entry) };
      hosts.set(key, row);
    }
    row.count += 1;
    row.errors.set(entry.error, (row.errors.get(entry.error) ?? 0) + 1);
    row.first = Math.min(row.first, entry.time);
    row.last = Math.max(row.last, entry.time);
  }
  return [...hosts.values()].sort((a, b) => b.count - a.count || b.last - a.last);
}
