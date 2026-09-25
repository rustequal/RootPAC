import { hostFromUrl } from "./hosts.js";

function reportToUrls(value) {
  let groups;
  try {
    groups = JSON.parse(`[${value}]`);
  } catch {
    return [];
  }
  const urls = [];
  for (const group of groups) {
    if (group === null || typeof group !== "object" || !Array.isArray(group.endpoints)) continue;
    for (const endpoint of group.endpoints) {
      if (endpoint !== null && typeof endpoint === "object" && typeof endpoint.url === "string") urls.push(endpoint.url);
    }
  }
  return urls;
}

function quoted(value, start) {
  let text = "";
  for (let i = start + 1; i < value.length; i++) {
    const c = value[i];
    if (c === '"') return { text, end: i + 1 };
    if (c === "\\") {
      i++;
      if (value[i] !== '"' && value[i] !== "\\") return null;
      text += value[i];
    } else {
      text += c;
    }
  }
  return null;
}

function dictionaryStrings(value) {
  const strings = [];
  let i = 0;
  while (i < value.length) {
    const eq = value.indexOf("=", i);
    const comma = value.indexOf(",", i);
    let next = comma === -1 ? value.length : comma;
    if (eq !== -1 && eq < next) {
      let j = eq + 1;
      while (value[j] === " " || value[j] === "\t") j++;
      if (value[j] === '"') {
        const string = quoted(value, j);
        if (string === null) return strings;
        strings.push(string.text);
        j = string.end;
      }
      for (; j < value.length && value[j] !== ","; j++) {
        if (value[j] !== '"') continue;
        const skipped = quoted(value, j);
        if (skipped === null) return strings;
        j = skipped.end - 1;
      }
      next = j;
    }
    i = next + 1;
  }
  return strings;
}

function endpointHost(url, base) {
  if (!URL.canParse(url, base)) return null;
  const resolved = new URL(url, base);
  return resolved.protocol === "https:" ? hostFromUrl(resolved.href) : null;
}

export function reportEndpointHosts(headers, base) {
  const hosts = new Set();
  for (const { name, value } of headers) {
    if (typeof value !== "string") continue;
    const header = name.toLowerCase();
    const urls = header === "report-to" ? reportToUrls(value) : header === "reporting-endpoints" ? dictionaryStrings(value) : [];
    for (const url of urls) {
      const host = endpointHost(url, base);
      if (host !== null) hosts.add(host);
    }
  }
  return [...hosts].sort();
}
