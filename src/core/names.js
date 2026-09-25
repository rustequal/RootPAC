export const MAX_LABEL = 63;
export const MAX_NAME = 253;
export const LOCALHOST = "localhost";

const DNR_LABEL = "[a-z0-9_-]";

function isDigit(c) {
  return c >= "0" && c <= "9";
}

function isHex(c) {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function isMaskChar(c) {
  return isDigit(c) || (c >= "a" && c <= "z") || c === "-";
}

function isHostChar(c) {
  return isMaskChar(c) || c === "_";
}

function endsInNumber(name, start) {
  if (start === name.length) return false;
  let digits = true;
  for (let i = start; i < name.length; i++) {
    if (!isDigit(name[i])) digits = false;
  }
  if (digits) return true;
  if (name.length - start < 2 || name[start] !== "0" || (name[start + 1] !== "x" && name[start + 1] !== "X")) return false;
  for (let i = start + 2; i < name.length; i++) {
    if (!isHex(name[i])) return false;
  }
  return true;
}

function nameProblem(name, isChar, minLabels) {
  if (name.length === 0) return "empty";
  if (name.length > MAX_NAME) return "long";
  let labels = 0;
  let start = 0;
  for (let i = 0; i <= name.length; i++) {
    if (i < name.length && name[i] !== ".") {
      if (!isChar(name[i])) return "char";
      continue;
    }
    if (i === start) return "label";
    if (i - start > MAX_LABEL) return "longLabel";
    labels += 1;
    if (i < name.length) start = i + 1;
  }
  if (labels < minLabels) return "labels";
  return endsInNumber(name, start) ? "number" : null;
}

export function trimTrailingDots(name) {
  let end = name.length;
  while (end > 0 && name[end - 1] === ".") end--;
  return end === name.length ? name : name.slice(0, end);
}

export function underLocalhost(name) {
  return name === LOCALHOST || (name.length > LOCALHOST.length && name[name.length - LOCALHOST.length - 1] === "." && name.endsWith(LOCALHOST));
}

export function isHostName(host) {
  return typeof host === "string" && nameProblem(host, isHostChar, 2) === null;
}

export function isDottedQuad(host) {
  let parts = 0;
  let length = 0;
  for (let i = 0; i <= host.length; i++) {
    if (i < host.length && host[i] !== ".") {
      if (!isDigit(host[i]) || ++length > 3) return false;
      continue;
    }
    if (length === 0) return false;
    parts += 1;
    length = 0;
  }
  return parts === 4;
}

const MASK_REASONS = Object.freeze({
  longLabel: `has a label longer than ${MAX_LABEL} characters`,
  long: `is longer than ${MAX_NAME} characters`,
  number: "ends in a number, so no host name can match it",
});

export function maskProblem(mask, directive) {
  const wildcard = mask.startsWith("*.");
  if (wildcard && directive === "root") return { kind: "wildcard" };
  const domain = wildcard ? mask.slice(2) : mask;
  const problem = nameProblem(domain, isMaskChar, directive === "bypass" ? 1 : 2);
  if (problem !== null) return Object.hasOwn(MASK_REASONS, problem) ? { kind: "reason", reason: MASK_REASONS[problem] } : { kind: "syntax" };
  if (directive === "root" && underLocalhost(domain)) return { kind: "reason", reason: "is under localhost, which Chrome never sends to a proxy" };
  return null;
}

export function hostRegex(domain, subdomains) {
  let escaped = "";
  for (const c of domain) escaped += c === "." ? "\\." : c;
  return `^[a-z]+://${subdomains ? `(?:${DNR_LABEL}+\\.)+` : ""}${escaped}\\.?(?::[0-9]+)?/`;
}
