import { firstMatch } from "./glob.js";
import { MAX_NAME, isDottedQuad, isHostName, trimTrailingDots, underLocalhost } from "./names.js";

export { isHostName };

// Every webRequest event asks it, so the URL is parsed once (URL.parse, not canParse and a constructor).
export function hostFromUrl(url) {
  const parsed = typeof url === "string" ? URL.parse(url) : null;
  if (parsed === null) return null;
  const host = trimTrailingDots(parsed.hostname.toLowerCase());
  return host === "" ? null : host;
}

export function isIpLiteral(host) {
  return host.startsWith("[") || isDottedQuad(host);
}

export function isPlainName(host) {
  return !host.includes(".");
}

export function isLearnableName(host) {
  return isHostName(host) && !underLocalhost(host);
}

export function parentName(name) {
  const dot = name.indexOf(".");
  return dot < 0 ? null : name.slice(dot + 1);
}

function longestNameIn(host) {
  if (host.length <= MAX_NAME) return host;
  const dot = host.indexOf(".", host.length - MAX_NAME - 1);
  return dot < 0 ? null : host.slice(dot + 1);
}

export function ownerHost(host, index) {
  for (let suffix = longestNameIn(host); suffix !== null; suffix = parentName(suffix)) {
    if (index.has(suffix)) return suffix;
  }
  return null;
}

export function coveringParent(host, index, psl) {
  for (let suffix = host.length > MAX_NAME ? longestNameIn(host) : parentName(host); suffix !== null; suffix = parentName(suffix)) {
    if (index.has(suffix) && !psl.isPublicSuffix(suffix)) return suffix;
  }
  return null;
}

export function learnedOwner(host, index, psl) {
  return index.has(host) ? host : coveringParent(host, index, psl);
}

export function covers(parent, name) {
  return name === parent || name.endsWith(`.${parent}`);
}

export function maskDomain(mask) {
  return mask.startsWith("*.") ? mask.slice(2) : mask;
}

export function rootOf(host, roots) {
  return roots.find((root) => covers(root, host)) ?? null;
}

export function coversBypass(host, bypass) {
  return bypass.some((mask) => covers(host, maskDomain(mask)));
}

export function underDeny(host, deny) {
  return deny.some((mask) => covers(maskDomain(mask), host));
}

// Whether root `mask` may learn the host. Its own domain never: the root mask routes it. Another root's domain it may,
// like any other site: the record goes through the owner of its site and lets the root's pages use it (core/routes.js).
export function isLearnable(host, { roots, deny, bypass }, index, psl, mask) {
  return (
    isLearnableName(host) &&
    learnedOwner(host, index, psl) === null &&
    rootOf(host, roots) !== mask &&
    !underDeny(host, deny) &&
    firstMatch(host, bypass) === null &&
    !coversBypass(host, bypass)
  );
}
