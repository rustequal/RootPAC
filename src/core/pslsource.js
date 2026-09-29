import { parsePublicSuffixList } from "./psl.js";

// The only address publicsuffix.org supports for pulling the list (the file's own header).
export const PSL_URL = "https://publicsuffix.org/list/public_suffix_list.dat";
export const MAX_PSL_BYTES = 2 * 1024 * 1024;

const VERSION = /^\/\/ VERSION: (\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC)$/m;
const COMMIT = /^\/\/ COMMIT: ([0-9a-f]{40})$/m;
const MARKERS = ["// ===BEGIN ICANN DOMAINS===", "// ===END ICANN DOMAINS===", "// ===BEGIN PRIVATE DOMAINS===", "// ===END PRIVATE DOMAINS==="];

// The list has no version number: its VERSION line is the UTC time it was built, and that time orders the lists. The
// fixed width of the stamp makes string order time order. COMMIT names the commit of publicsuffix/list, for reference.
export function pslVersion(text) {
  return VERSION.exec(text)?.[1] ?? null;
}

export function pslCommit(text) {
  return COMMIT.exec(text)?.[1] ?? null;
}

export function isNewerPsl(version, than) {
  return typeof version === "string" && (typeof than !== "string" || version > than);
}

// `2026-09-21_18-50-07_UTC` -> `2026-09-21 18:50:07 UTC`.
export function formatPslVersion(version) {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_UTC$/.exec(version ?? "");
  return match === null ? String(version) : `${match[1]} ${match[2]}:${match[3]}:${match[4]} UTC`;
}

// A downloaded or stored list, checked before it may replace the one in use: whole (all four section markers), with
// its VERSION, parsed, and answering the public suffixes every version has.
export function readPublicSuffixList(text) {
  if (typeof text !== "string") throw new TypeError("Public suffix list must be a string");
  if (text.length > MAX_PSL_BYTES) throw new Error(`Public suffix list is larger than ${MAX_PSL_BYTES} bytes`);
  const version = pslVersion(text);
  if (version === null) throw new Error("Public suffix list has no VERSION line");
  const lines = new Set(text.split("\n").map((line) => line.trim()));
  if (!MARKERS.every((marker) => lines.has(marker))) throw new Error("Public suffix list is incomplete");
  const psl = parsePublicSuffixList(text);
  const sane =
    psl.isPublicSuffix("com") &&
    psl.isPublicSuffix("co.uk") &&
    psl.isPublicSuffix("github.io") &&
    !psl.isPublicSuffix("example.com") &&
    psl.registrableDomain("a.b.example.com") === "example.com" &&
    psl.registrableDomain("a.bbc.co.uk") === "bbc.co.uk";
  if (!sane) throw new Error("Public suffix list gives wrong answers for well-known names");
  return { psl, version, commit: pslCommit(text) };
}
