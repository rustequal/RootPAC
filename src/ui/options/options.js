import { download, element, onStored, readLocal, send } from "../shared/rpc.js";
import { header } from "../shared/logo.js";

document.getElementById("head").replaceWith(header("User PAC"));

const text = document.getElementById("text");
const gutter = document.getElementById("gutter");
const status = document.getElementById("status");
const result = document.getElementById("result");
const cancel = document.getElementById("cancel");
const backupStatus = document.getElementById("backupStatus");
const file = document.getElementById("file");
const logEnabled = document.getElementById("logEnabled");
const logStatus = document.getElementById("logStatus");

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

function showErrors(errors) {
  const list = element("ul", "result");
  for (const { line, column, message } of errors) {
    const item = element("li", line === null ? "error" : "error clickable", line === null ? message : `${line}:${column} ${message}`);
    if (line !== null) item.addEventListener("click", () => focusPosition(line, column));
    list.append(item);
  }
  result.replaceChildren(element("p", "error", `${errors.length} problem${errors.length === 1 ? "" : "s"}`), list);
}

function showAnalysis({ roots, deny, bypass }) {
  const describe = (name, masks) => element("li", undefined, `${name}: ${masks.length === 0 ? "—" : masks.join(", ")}`);
  const list = element("ul", "result");
  list.append(describe("roots", roots), describe("deny", deny), describe("bypass", bypass));
  result.replaceChildren(list);
}

async function load(force) {
  const stored = await readLocal(["userPac", "analysis", "userPacErrors"]);
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
  if (stored.userPacErrors !== undefined) showErrors(stored.userPacErrors);
  else if (stored.analysis !== undefined) showAnalysis(stored.analysis);
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
      showAnalysis(response.analysis);
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

onStored((changes, area) => {
  if (area === "local" && ("userPac" in changes || "userPacErrors" in changes || "analysis" in changes)) load(false);
  if (area === "local" && "logEnabled" in changes) loadLogSetting();
});

loadLogSetting();

load(true);
