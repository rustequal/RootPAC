import { userPacLine } from "../../core/pacline.js";

export async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result === undefined) throw new Error("The background worker did not respond");
  return result;
}

export function readLocal(keys = null) {
  return chrome.storage.local.get(keys);
}

export function readSession(keys = null) {
  return chrome.storage.session.get(keys);
}

export function onStored(handler) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" || area === "session") handler(changes, area);
  });
}

export const INCOGNITO_TEXT = "Not allowed in Incognito — root sites opened in Incognito windows are not protected. Allow it in chrome://extensions";

export async function incognitoAllowed() {
  return chrome.extension.isAllowedIncognitoAccess();
}

export function proxyErrorLine({ details }, appliedPac, userPac) {
  const match = /^line: (\d+): /.exec(details ?? "");
  if (match === null || appliedPac === undefined || userPac === undefined) return null;
  return userPacLine(appliedPac, userPac, Number(match[1]));
}

export function proxyErrorText(record, appliedPac, userPac) {
  const line = proxyErrorLine(record, appliedPac, userPac);
  if (line !== null) return `User PAC line ${line}: ${record.details.replace(/^line: \d+: /, "")}`;
  if (/RootPAC: no proxy for /.test(record.details ?? "")) return "User PAC returned no proxy for a protected host";
  return record.details === undefined || record.details === "" ? record.error : `${record.error}: ${record.details}`;
}

const pad = (value) => String(value).padStart(2, "0");

// Chrome's own date and time format (its UI language); extensions cannot read the regional format of the OS.
const PLAIN = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };
const WITH_MILLISECONDS = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 };

// One formatter each: `toLocaleString` builds a new one on every call, which the log pays for every row it draws.
const formats = { plain: null, milliseconds: null };

export function formatTime(time, { milliseconds = false } = {}) {
  if (milliseconds) formats.milliseconds ??= new Intl.DateTimeFormat(undefined, WITH_MILLISECONDS);
  else formats.plain ??= new Intl.DateTimeFormat(undefined, PLAIN);
  return (milliseconds ? formats.milliseconds : formats.plain).format(new Date(time));
}

export function timeZone(time = Date.now()) {
  const offset = -new Date(time).getTimezoneOffset();
  const hours = Math.floor(Math.abs(offset) / 60);
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time";
  return `${name}, UTC${offset < 0 ? "−" : "+"}${pad(hours)}:${pad(Math.abs(offset) % 60)}`;
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element("a");
  link.href = url;
  link.download = name;
  link.click();
  // The page may stay open for long; the download has long taken the file when the URL is let go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
