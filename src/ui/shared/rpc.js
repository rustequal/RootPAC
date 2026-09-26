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

export const CLOSED_TEXT = "Proxy settings are not under RootPAC control — root sites are blocked until it gets them back";
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

const pad = (value, width = 2) => String(value).padStart(width, "0");

// Chrome formats toLocaleString() by its UI language (en-US gives 9/26/2026, 4:22:19 PM), not by the regional format
// of the OS, which extensions cannot read. Times are shown in the local time zone as YYYY-MM-DD HH:MM:SS instead.
export function formatTime(time, { milliseconds = false } = {}) {
  const date = new Date(time);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${clock}${milliseconds ? `.${pad(date.getMilliseconds(), 3)}` : ""}`;
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
}
