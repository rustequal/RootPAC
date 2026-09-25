import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPac } from "../src/core/build.js";
import { loadPac, prng, PSL } from "./support.js";

function referenceProxied(result, host) {
  function ipv4(text) {
    const octets = text.split(".");
    if (octets.length !== 4) return false;
    return octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && +octet <= 255);
  }
  function ipv6(text) {
    const halves = text.split("::");
    if (halves.length > 2) return false;
    let groups = 0;
    for (let h = 0; h < halves.length; h++) {
      if (halves[h] === "") continue;
      const parts = halves[h].split(":");
      for (let i = 0; i < parts.length; i++) {
        if (h === halves.length - 1 && i === parts.length - 1 && parts[i].includes(".")) {
          if (!ipv4(parts[i])) return false;
          groups += 2;
        } else if (/^[0-9a-f]{1,4}$/i.test(parts[i])) {
          groups += 1;
        } else {
          return false;
        }
      }
    }
    return halves.length === 2 ? groups <= 7 : groups === 8;
  }
  function hostname(text) {
    const labels = text.split(".");
    if (!labels.every((label) => /^[a-z0-9_-]+$/i.test(label) && !/^xn--/i.test(label))) return false;
    return /^([0-9]+|0x[0-9a-f]*)$/i.test(labels.at(-1)) ? ipv4(text) : true;
  }
  function server(text) {
    const m = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)[ \t]+(?:\[([^\]]*)\]|([^ \t:[\]]+))(?::([1-9][0-9]{0,4}))?$/i.exec(text);
    if (m === null) return false;
    if (m[4] && +m[4] > 65535) return false;
    return m[3] === undefined ? ipv6(m[2]) : hostname(m[3]);
  }
  const kept = typeof result === "string" ? result.split(";").map((part) => part.replace(/^[ \t]+|[ \t]+$/g, "")).filter(server) : [];
  if (kept.length === 0) throw new Error(`RootPAC: no proxy for ${host}, direct connection refused`);
  return kept.join("; ");
}

const USER_PAC = 'function FindProxyForURL(url, host) {\n  if (root(host, "a.com")) return CASE;\n  return "DIRECT";\n}\n';

function outcome(run) {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error.message };
  }
}

const PIECES = [
  "PROXY", "proxy", "Proxy", "HTTPS", "SOCKS", "socks4", "SOCKS5", "SOCKS6", "DIRECT", "QUIC", " ", "\t", "  ", ";", "; ", ":", "::", ".", "[", "]",
  "0", "1", "00", "01", "255", "256", "65535", "65536", "0x1f", "0X", "xn--", "XN--p1ai", "a", "Z", "_", "-", "host", "example.com", "10.1.4.1",
  "127.0.0.1", "1.2.3", "1.2.3.4.5", "fe80", "abcd", "abcde", "::1", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:1.2.3.4", "@", "user:pass@", "é", "\n",
];

test("__proxied keeps exactly what the regular-expression parser keeps", () => {
  const pac = loadPac(buildSystemPac(USER_PAC, { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } } }, PSL));
  const random = prng(20260924);
  const cases = [
    "PROXY p:1", "PROXY p:1; DIRECT", "DIRECT", "", "PROXY [::1]:8080", "PROXY [1:2:3:4:5:6:7:8]", "PROXY [1::2::3]", "PROXY 1.2.3.4:0",
    "SOCKS5 10.1.4.1:9487; SOCKS 10.1.4.2", "PROXY 1.2.3.04:80", "PROXY 0x7f.1:80", "PROXY a.0x:80", "PROXY [1.2.3.4::]:1",
  ];
  for (let n = 0; n < 60000; n++) {
    let text = "";
    const length = 1 + Math.floor(random() * 9);
    for (let k = 0; k < length; k++) text += PIECES[Math.floor(random() * PIECES.length)];
    cases.push(text);
  }
  for (const text of cases) {
    pac.CASE = text;
    for (const host of ["www.a.com", "x.cdn.a.net"]) {
      assert.deepEqual(outcome(() => pac.FindProxyForURL(`https://${host}/`, host)), outcome(() => referenceProxied(text, host)), JSON.stringify(text));
    }
  }
  for (const value of [null, undefined, 42, { toString: () => "PROXY p:1" }]) {
    pac.CASE = value;
    assert.throws(() => pac.FindProxyForURL("https://www.a.com/", "www.a.com"), /RootPAC: no proxy for www\.a\.com/);
  }
});
