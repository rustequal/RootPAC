import { formatPslVersion, isNewerPsl } from "../../core/pslsource.js";
import { NOTICE_KEYS, notices, pslConflictText } from "../shared/notices.js";
import { download, element, onStored, readLocal, readSession, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

document.getElementById("head").replaceWith(header("User PAC"));

const text = document.getElementById("text");
const gutter = document.getElementById("gutter");
const banners = document.getElementById("banners");
const status = document.getElementById("status");
const result = document.getElementById("result");
const cancel = document.getElementById("cancel");
const backupStatus = document.getElementById("backupStatus");
const file = document.getElementById("file");
const logEnabled = document.getElementById("logEnabled");
const logStatus = document.getElementById("logStatus");
const pslInstalled = document.getElementById("pslInstalled");
const pslAvailable = document.getElementById("pslAvailable");
const pslUpdate = document.getElementById("pslUpdate");
const pslAuto = document.getElementById("pslAuto");
const pslAutoStatus = document.getElementById("pslAutoStatus");

let saved = "";
let checking = false;

const dirty = () => text.value !== saved;

function renderGutter() {
  const lines = text.value.split("\n").length;
  gutter.textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  gutter.scrollTop = text.scrollTop;
}

function setStatus(message, className = "muted") {
  status.textContent = message;
  status.className = className;
}

function setBackupStatus(message, className = "muted") {
  backupStatus.textContent = message;
  backupStatus.className = className;
}

function focusPosition(line, column) {
  const lines = text.value.split("\n");
  const offset = lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column - 1;
  text.focus();
  text.setSelectionRange(offset, offset);
}

// Errors of the User PAC: a click on one puts the cursor there.
function errorList(errors) {
  const list = element("ul", "result");
  for (const { line, column, message } of errors) {
    const item = element("li", line === null ? "error" : "error clickable", line === null ? message : `${line}:${column} ${message}`);
    if (line !== null) item.addEventListener("click", () => focusPosition(line, column));
    list.append(item);
  }
  return list;
}

function showErrors(errors) {
  result.replaceChildren(element("p", "error", `${errors.length} problem${errors.length === 1 ? "" : "s"}`), errorList(errors));
}

function analysisList({ roots, deny, bypass }) {
  const describe = (name, masks) => element("li", undefined, `${name}: ${masks.length === 0 ? "—" : masks.join(", ")}`);
  const list = element("ul", "result");
  list.append(describe("roots", roots), describe("deny", deny), describe("bypass", bypass));
  return list;
}

// The saved User PAC: its errors in safe mode; otherwise what it declares, under the errors it would have with a newer
// public suffix list that is held back for them (background/pslupdate.js).
function showResult({ analysis, userPacErrors, pslConflict }) {
  if (userPacErrors !== undefined) showErrors(userPacErrors);
  else if (analysis === undefined) result.replaceChildren();
  else if (pslConflict === undefined) result.replaceChildren(analysisList(analysis));
  else result.replaceChildren(element("p", "error", pslConflictText(pslConflict)), errorList(pslConflict.errors ?? []), analysisList(analysis));
}

const RESULT_KEYS = ["analysis", "userPacErrors", "pslConflict"];

async function load(force) {
  const stored = await readLocal(["userPac", ...RESULT_KEYS]);
  const value = stored.userPac ?? "";
  if (force || !dirty()) {
    saved = value;
    text.value = value;
    renderGutter();
    setStatus("");
  } else if (value !== saved) {
    saved = value;
    setStatus("Saved user PAC changed elsewhere");
  }
  showResult(stored);
}

async function save() {
  if (checking) return;
  checking = true;
  cancel.hidden = false;
  setStatus("Checking…");
  result.replaceChildren();
  const value = text.value;
  try {
    const response = await send({ type: "saveUserPac", text: value });
    if (response.ok) {
      saved = value;
      setStatus("Saved", "ok");
      showResult(await readLocal(RESULT_KEYS));
    } else if (response.errors !== undefined) {
      setStatus("");
      showErrors(response.errors);
    } else {
      setStatus("");
      result.replaceChildren(element("p", "error", response.error));
    }
  } catch (error) {
    setStatus("");
    result.replaceChildren(element("p", "error", error.message));
  } finally {
    checking = false;
    cancel.hidden = true;
  }
}

document.getElementById("save").addEventListener("click", save);
cancel.addEventListener("click", () => send({ type: "cancelCheck" }).catch((error) => setStatus(error.message)));

document.getElementById("revert").addEventListener("click", () => load(true));

document.getElementById("export").addEventListener("click", async () => {
  const response = await send({ type: "exportState" }).catch((error) => ({ ok: false, error: error.message }));
  if (!response.ok) {
    setBackupStatus(response.error, "error");
    return;
  }
  setBackupStatus("");
  download("rootpac-backup.json", JSON.stringify(response.backup, null, 2), "application/json");
});

document.getElementById("import").addEventListener("click", () => file.click());

file.addEventListener("change", async () => {
  const [chosen] = file.files;
  file.value = "";
  if (chosen === undefined) return;
  cancel.hidden = false;
  setBackupStatus("Checking…");
  try {
    const backup = JSON.parse(await chosen.text());
    const response = await send({ type: "importState", backup });
    if (response.ok) {
      setBackupStatus("Imported", "ok");
      await load(true);
    } else if (response.errors !== undefined) {
      setBackupStatus("The User PAC in the backup has problems, listed above", "error");
      showErrors(response.errors);
    } else {
      setBackupStatus(response.error, "error");
    }
  } catch (error) {
    setBackupStatus(error.message, "error");
  } finally {
    cancel.hidden = true;
  }
});

text.addEventListener("input", () => {
  renderGutter();
  setStatus(dirty() ? "Unsaved changes" : "");
});

text.addEventListener("scroll", () => {
  gutter.scrollTop = text.scrollTop;
});

text.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const { selectionStart, selectionEnd } = text;
  text.setRangeText("  ", selectionStart, selectionEnd, "end");
  renderGutter();
  setStatus("Unsaved changes");
});

window.addEventListener("keydown", (event) => {
  if (event.code !== "KeyS" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
  event.preventDefault();
  save();
});

async function loadLogSetting() {
  const { logEnabled: enabled } = await readLocal(["logEnabled"]);
  logEnabled.checked = enabled === true;
}

logEnabled.addEventListener("change", () => {
  logStatus.textContent = "";
  chrome.storage.local.set({ logEnabled: logEnabled.checked }).catch((error) => {
    logStatus.textContent = error.message;
    logStatus.className = "error";
    loadLogSetting();
  });
});

// Public Suffix List: what is installed, what publicsuffix.org has (checked once, when the page opens, and again after
// Update), and the weekly switch. The version of a list is the UTC time it was built. The last check is kept, so a list
// installed elsewhere (another Options page, the weekly alarm) is compared with it again without going to the network.
const pslText = ({ version, commit }) => `${formatPslVersion(version)}${commit ? ` · ${commit.slice(0, 7)}` : ""}`;

const psl = { installed: null, conflict: null, available: null, busy: false };

function setAvailable(text, className = "", update = false) {
  pslAvailable.textContent = text;
  pslAvailable.className = `mono ${className}`.trim();
  pslUpdate.hidden = !update;
}

// The result of the last check against what is installed now; nothing while a check or an update is running.
function showAvailable() {
  const { installed, conflict, available, busy } = psl;
  if (busy || installed === null || available === null) return;
  if (!isNewerPsl(available.version, installed.version)) {
    if (available.version === installed.version) setAvailable(`${pslText(available)} · up to date`, "ok");
    else setAvailable(`${pslText(available)} · the installed list is newer`, "muted");
  } else if (conflict?.version === available.version) {
    setAvailable(`${pslText(available)} · not installed, see the User PAC errors above`, "error");
  } else {
    setAvailable(`${pslText(available)} · newer`, "", true);
  }
}

function showInstalled(installed, conflict) {
  if (installed === null || installed === undefined) return;
  psl.installed = installed;
  if (conflict !== undefined) psl.conflict = conflict;
  pslInstalled.textContent = `${pslText(installed)} · ${installed.source === "downloaded" ? "downloaded" : "bundled with RootPAC"}`;
  showAvailable();
}

async function checkPsl() {
  psl.busy = true;
  setAvailable("Checking publicsuffix.org…", "muted");
  const response = await send({ type: "checkPsl" }).catch((error) => ({ ok: false, error: error.message }));
  psl.busy = false;
  psl.available = response.ok ? response.available : null;
  if (!response.ok) setAvailable(`Cannot check: ${response.error}`, "error");
  showInstalled(response.installed, response.conflict);
}

pslUpdate.addEventListener("click", async () => {
  pslUpdate.disabled = true;
  psl.busy = true;
  setAvailable("Updating…", "muted", true);
  try {
    const response = await send({ type: "updatePsl" }).catch((error) => ({ ok: false, error: error.message }));
    if (response.ok || response.outcome === "conflict") {
      psl.busy = false;
      showInstalled(response.installed, response.conflict);
    }
    if (response.outcome === "conflict") return;
    if (!response.ok) {
      setAvailable(`Update failed: ${response.error}`, "error", true);
      return;
    }
    await checkPsl();
  } finally {
    psl.busy = false;
    pslUpdate.disabled = false;
  }
});

// Notices on top of the page (ui/shared/notices.js): what keeps the saved User PAC from working as written. Built off the
// page and put in only when they changed, so a storage write that changes nothing does not redraw them.
const ACTIONS = {
  errors: (notice) => {
    const first = notice.errors.find(({ line }) => line !== null);
    const button = element("button", "small", first === undefined ? "Show" : `Go to line ${first.line}`);
    // Where it goes is part of the markup a redraw compares.
    if (first !== undefined) button.dataset.at = `${first.line}:${first.column}`;
    button.addEventListener("click", () => {
      if (first === undefined) result.scrollIntoView({ block: "nearest" });
      else focusPosition(first.line, first.column);
    });
    return button;
  },
};

function noticeNode(notice) {
  const className = notice.level === "error" ? "banner error" : "banner";
  if (notice.action === undefined) return element("p", className, notice.text);
  const node = element("div", className);
  const head = element("div", "head");
  head.append(element("span", undefined, notice.text), ACTIONS[notice.action](notice));
  node.append(head);
  return node;
}

async function loadBanners() {
  const [local, session] = await Promise.all([readLocal(NOTICE_KEYS.local), readSession(NOTICE_KEYS.session)]);
  const built = element("div");
  built.append(...notices(local, session, { page: "options" }).map(noticeNode));
  if (built.innerHTML !== banners.innerHTML) banners.replaceChildren(...built.childNodes);
}

async function loadPsl() {
  const [{ pslAutoUpdate }, status] = await Promise.all([readLocal(["pslAutoUpdate"]), send({ type: "getPsl" }).catch(() => null)]);
  pslAuto.checked = pslAutoUpdate !== false;
  if (status?.ok) showInstalled(status.installed, status.conflict);
}

pslAuto.addEventListener("change", () => {
  pslAutoStatus.textContent = "";
  chrome.storage.local.set({ pslAutoUpdate: pslAuto.checked }).catch((error) => {
    pslAutoStatus.textContent = error.message;
    pslAutoStatus.className = "error";
    loadPsl();
  });
});

const follows = (keys, changes) => keys.some((key) => Object.hasOwn(changes, key));

onStored((changes, area) => {
  if (follows(NOTICE_KEYS[area], changes)) loadBanners();
  if (area === "local" && follows(["userPac", "userPacErrors", "analysis"], changes)) load(false);
  // A list conflict set or cleared in the background changes only the result panel, not the editor or its status.
  else if (area === "local" && follows(["pslConflict"], changes)) readLocal(RESULT_KEYS).then(showResult);
  if (area === "local" && "logEnabled" in changes) loadLogSetting();
  if (area === "local" && follows(["pslList", "pslConflict", "pslAutoUpdate"], changes)) loadPsl();
});

loadBanners();

loadLogSetting();

loadPsl().then(checkPsl);

load(true);
