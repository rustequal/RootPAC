import { formatPslVersion } from "../../core/pslsource.js";
import { formatTime } from "./rpc.js";

// The state of the whole extension that keeps the saved User PAC from working as written, shown on top of the popup and
// of Options; no DOM, so it is unit-tested. What concerns one tab (conflicts, proxy errors, a page loaded before
// protection was ready) is the popup's own.

// The keys the notices follow; a page redraws them only when one of these changes.
export const NOTICE_KEYS = Object.freeze({
  local: Object.freeze(["enabled", "userPac", "userPacErrors", "pslConflict"]),
  session: Object.freeze(["armed", "startupError", "lastLearnError"]),
});

export const CLOSED_TEXT = "Proxy settings are not under RootPAC control — root sites are blocked until it gets them back";

const problems = (count) => `${count} problem${count === 1 ? "" : "s"}`;

// A newer public suffix list the saved User PAC does not pass with (background/pslupdate.js).
export function pslConflictText({ version, errors = [] }) {
  return `Public Suffix List ${formatPslVersion(version)} is not installed: the saved User PAC does not pass with it — ${problems(errors.length)}`;
}

// Most serious first. A notice with `errors` leads to the User PAC lines to fix; the popup sends the user to Options
// for them.
export function notices(local, session, { page }) {
  const inPopup = page === "popup";
  const list = [];
  if (session.startupError !== undefined) list.push({ id: "startup", level: "error", text: `RootPAC failed to start: ${session.startupError}` });
  if (local.enabled !== true) list.push({ id: "off", level: "warn", text: "Proxy is switched off for this extension" });
  else if (local.userPac !== undefined && session.armed !== true) list.push({ id: "closed", level: "warn", text: CLOSED_TEXT });
  if (local.userPacErrors !== undefined) {
    const text = "Saved user PAC no longer passes validation — protection continues with the last applied configuration";
    list.push({ id: "safe", level: "warn", text: inPopup ? `${text}. Fix it in Options` : `${text} — ${problems(local.userPacErrors.length)}`, action: "errors", errors: local.userPacErrors });
  }
  if (local.pslConflict !== undefined) {
    const text = pslConflictText(local.pslConflict);
    list.push({ id: "psl", level: "warn", text: inPopup ? `${text}. Fix it in Options` : text, action: "errors", errors: local.pslConflict.errors ?? [] });
  }
  const learn = session.lastLearnError;
  if (learn !== undefined) list.push({ id: "learn", level: "error", text: `${formatTime(learn.time)} — Learning failed: ${learn.message}` });
  return list;
}
