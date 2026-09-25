import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPac } from "../src/core/build.js";
import { fixture, loadPac, PSL } from "./support.js";

const PROXY = "SOCKS5 10.1.4.1:9487";

function groups() {
  return {
    "instagram.com": { rootHost: null, hosts: {} },
    "instagram.com": {
      rootHost: "www.instagram.com",
      hosts: { "edge-chat.facebook.com": 1, "scontent-ams2-1.cdninstagram.com": 1, "static.cdninstagram.com": 1 },
    },
  };
}

function route(pac, host, scheme = "https") {
  return pac.FindProxyForURL(`${scheme}://${host}/`, host);
}

function pacWith(returnExpression, extraGroups = {}) {
  const userPac = [
    "function FindProxyForURL(url, host) {",
    `  if (root(host, "a.com")) return ${returnExpression};`,
    '  return "DIRECT";',
    "}",
  ].join("\n");
  return loadPac(
    buildSystemPac(userPac, {
      "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } },
      ...extraGroups,
    }, PSL),
  );
}

test("routing through the reference System PAC", () => {
  const pac = loadPac(buildSystemPac(fixture("user.pac"), groups(), PSL));
  assert.equal(route(pac, "www.instagram.com"), PROXY);
  assert.equal(route(pac, "instagram.com"), PROXY);
  assert.equal(route(pac, "i.instagram.com"), PROXY);
  assert.equal(route(pac, "static.cdninstagram.com"), PROXY);
  assert.equal(route(pac, "edge-chat.facebook.com", "wss"), PROXY);
  assert.equal(route(pac, "www.google-analytics.com"), "DIRECT");
  assert.equal(route(pac, "example.org"), "DIRECT");
  assert.equal(route(pac, "facebook.com"), "DIRECT");
  assert.equal(route(pac, "cdninstagram.com"), "DIRECT");
});

test("a learned host also covers its subdomains", () => {
  const pac = loadPac(buildSystemPac(fixture("user.pac"), groups(), PSL));
  assert.equal(route(pac, "v2.static.cdninstagram.com"), PROXY);
  assert.equal(route(pac, "a.b.edge-chat.facebook.com"), PROXY);
  assert.equal(route(pac, "xstatic.cdninstagram.com"), "DIRECT");
});

test("User PAC declarations stay inside the wrapper", () => {
  const pac = loadPac(buildSystemPac(fixture("user.pac"), groups(), PSL));
  assert.equal(pac.PROXY, undefined);
  assert.equal(typeof pac.FindProxyForURL, "function");
  assert.equal(pac.deny("x"), undefined);
  assert.equal(pac.root("a.b.com", "b.com"), true);
  assert.equal(pac.root("b.com", "b.com"), true);
  assert.equal(pac.root("xb.com", "b.com"), false);
  assert.equal(pac.root("b.com.evil.net", "b.com"), false);
});

test("a proxy change in the User PAC applies to learned hosts without regrouping", () => {
  const changed = fixture("user.pac").replace(PROXY, "PROXY 10.2.2.2:3128");
  const pac = loadPac(buildSystemPac(changed, groups(), PSL));
  assert.equal(route(pac, "www.instagram.com"), "PROXY 10.2.2.2:3128");
  assert.equal(route(pac, "static.cdninstagram.com"), "PROXY 10.2.2.2:3128");
  assert.equal(route(pac, "example.org"), "DIRECT");
});

test("learned hosts are decided as the rootHost with a sanitized url", () => {
  const userPac = [
    "var calls = [];",
    "function FindProxyForURL(url, host) {",
    '  calls.push(url + " " + host);',
    '  if (root(host, "a.com") && dnsDomainIs(host, ".a.com")) return "PROXY p:" + calls.length;',
    '  if (root(host, "c.com")) return "SOCKS5 c:1";',
    '  return "DIRECT";',
    "}",
  ].join("\n");
  const pac = loadPac(
    buildSystemPac(userPac, {
      "a.com": { rootHost: "www.a.com", hosts: { "cdn.b.net": 1 } },
      "c.com": { rootHost: "www.c.com", hosts: { "api.d.net": 1 } },
    }, PSL),
  );
  assert.equal(pac.FindProxyForURL("https://cdn.b.net:8443/", "cdn.b.net"), "PROXY p:1");
  assert.equal(pac.FindProxyForURL("https://api.d.net/", "api.d.net"), "SOCKS5 c:1");
  assert.equal(pac.FindProxyForURL("http://cdn.b.net.evil.org/", "cdn.b.net.evil.org"), "DIRECT");
});

test("DIRECT is stripped from root and learned decisions", () => {
  const pac = pacWith('"SOCKS5 s:1; DIRECT; PROXY p:2"');
  assert.equal(route(pac, "www.a.com"), "SOCKS5 s:1; PROXY p:2");
  assert.equal(route(pac, "cdn.a.net"), "SOCKS5 s:1; PROXY p:2");
  assert.equal(route(pac, "other.org"), "DIRECT");
});

test("root and learned hosts fail closed instead of going direct", () => {
  for (const expression of ['"DIRECT"', '" DIRECT ; direct "', '""', "undefined", "null", '"NONSENSE"', '"PROXY"', '"PROXY a b"', "42"]) {
    const pac = pacWith(expression);
    assert.throws(() => route(pac, "www.a.com"), /RootPAC: no proxy for www\.a\.com, direct connection refused/, expression);
    assert.throws(() => route(pac, "x.cdn.a.net"), /RootPAC: no proxy for x\.cdn\.a\.net/, expression);
    assert.equal(route(pac, "other.org"), "DIRECT");
  }
});

test("only documented proxy schemes survive, case-insensitively", () => {
  assert.equal(route(pacWith('"proxy p:1;https h:2;socks s:3;SOCKS4 f:4;socks5 v:5"'), "a.com"), "proxy p:1; https h:2; socks s:3; SOCKS4 f:4; socks5 v:5");
  assert.equal(route(pacWith('"QUIC q:1; HTTP h:2; SOCKS5 v:5"'), "a.com"), "SOCKS5 v:5");
  assert.equal(route(pacWith('"PROXY p"'), "a.com"), "PROXY p");
});

test("proxy entries Chromium would drop are refused, so nothing falls back to DIRECT", () => {
  const refused = [
    "PROXY user:pass@10.0.0.1:8080",
    "PROXY http://10.0.0.1:8080",
    "SOCKS5 10.1.4.1:94870",
    "PROXY 10.0.0.1:0",
    "PROXY 10.0.0.1:080",
    "PROXY 10.0.0.1:",
    "PROXY :8080",
    "PROXY 1.2.3.999:80",
    "PROXY 1.2.3:80",
    "PROXY 0x7f.1:80",
    "PROXY a..b:80",
    "PROXY xn--zz:80",
    "PROXY [::1",
    "PROXY [:::1]:80",
    "PROXY [1:2:3:4:5:6:7:8:9]:80",
    "PROXY []:80",
    "PROXY\u00a0p:1",
    "\nPROXY p:1",
    "PROXY p:1 extra",
  ];
  for (const entry of refused) {
    const pac = pacWith(JSON.stringify(entry));
    assert.throws(() => route(pac, "www.a.com"), /RootPAC: no proxy for www\.a\.com/, entry);
    assert.throws(() => route(pac, "cdn.a.net"), /RootPAC: no proxy for cdn\.a\.net/, entry);
  }
  const accepted = [
    "PROXY 10.0.0.1:8080",
    "PROXY 255.255.255.255:65535",
    "PROXY [::1]:8080",
    "PROXY [2001:db8::1]",
    "SOCKS [::ffff:10.0.0.1]:1080",
    "PROXY [1:2:3:4:5:6:7:8]:1",
    "HTTPS proxy.example.com:443",
    "SOCKS5 10.1.4.1:9487",
    "PROXY my_proxy:3128",
    "PROXY\tp:1",
    "PROXY p",
  ];
  for (const entry of accepted) assert.equal(route(pacWith(JSON.stringify(entry)), "www.a.com"), entry, entry);
  assert.equal(route(pacWith('"PROXY bad:99999; SOCKS5 s:1"'), "www.a.com"), "SOCKS5 s:1");
});

test("a trailing dot does not hide a protected host", () => {
  const pac = pacWith('"PROXY p:1"');
  assert.equal(route(pac, "cdn.a.net."), "PROXY p:1");
  assert.equal(route(pac, "x.cdn.a.net.."), "PROXY p:1");
  assert.equal(route(pac, "www.a.com."), "PROXY p:1");
  assert.equal(route(pac, "a.com."), "PROXY p:1");
  assert.equal(route(pac, "other.org."), "DIRECT");
});

test("an implicit global shExpMatch in the User PAC does not change routing", () => {
  const userPac = [
    "function FindProxyForURL(url, host) {",
    "  shExpMatch = function () { return false; };",
    '  if (root(host, "a.com")) return "PROXY p:1";',
    '  return "DIRECT";',
    "}",
  ].join("\n");
  const pac = loadPac(buildSystemPac(userPac, { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } } }, PSL));
  assert.equal(route(pac, "www.a.com"), "PROXY p:1");
  assert.equal(pac.shExpMatch("a", "a"), false);
  assert.equal(route(pac, "www.a.com"), "PROXY p:1");
  assert.equal(route(pac, "cdn.a.net"), "PROXY p:1");
});

test("routing does not depend on inherited object properties", () => {
  const pac = loadPac(buildSystemPac(fixture("user.pac"), groups(), PSL));
  for (const host of ["constructor", "__proto__", "toString", "hasOwnProperty", "x.constructor", "a.__proto__"]) {
    assert.equal(route(pac, host), "DIRECT");
  }
});

test("an untrained group routes everything through the User PAC", () => {
  const pac = loadPac(buildSystemPac(fixture("user.pac"), { "instagram.com": { rootHost: null, hosts: {} } }, PSL));
  assert.equal(route(pac, "www.instagram.com"), PROXY);
  assert.equal(route(pac, "instagram.com"), PROXY);
  assert.equal(route(pac, "static.cdninstagram.com"), "DIRECT");
});

test("a name learned in several groups routes by the first group in mask order", () => {
  const userPac = [
    "function FindProxyForURL(url, host) {",
    '  if (root(host, "a.com")) return "PROXY a:1";',
    '  if (root(host, "b.com")) return "PROXY b:1";',
    '  return "DIRECT";',
    "}",
  ].join("\n");
  const pac = loadPac(
    buildSystemPac(userPac, {
      "b.com": { rootHost: "www.b.com", hosts: { "cdn.net": 1, "only.b.cdn.net": 1 } },
      "a.com": { rootHost: "www.a.com", hosts: { "cdn.net": 1 } },
    }, PSL),
  );
  assert.equal(route(pac, "x.cdn.net"), "PROXY a:1");
  assert.equal(route(pac, "cdn.net"), "PROXY a:1");
  assert.equal(route(pac, "z.only.b.cdn.net"), "PROXY b:1");
});

const TWO_ROOTS = [
  'var P1 = "PROXY p1:1";',
  'var P2 = "PROXY p2:1";',
  "function FindProxyForURL(url, host) {",
  '  if (root(host, "root.org")) return P1;',
  '  if (root(host, "site.github.io")) return P2;',
  '  return "DIRECT";',
  "}",
].join("\n");

test("a root wins over a learned record that covers it, and an exact record covers only itself", () => {
  const pac = loadPac(buildSystemPac(TWO_ROOTS, { "root.org": { rootHost: "root.org", hosts: { "github.io": 1, "example.com": 2 } }, "site.github.io": { rootHost: null, hosts: {} } }, PSL));
  const at = (host) => pac.FindProxyForURL(`https://${host}/`, host);
  assert.equal(at("github.io"), "PROXY p1:1");
  assert.equal(at("github.io."), "PROXY p1:1");
  assert.equal(at("someone.github.io"), "DIRECT");
  assert.equal(at("site.github.io"), "PROXY p2:1");
  assert.equal(at("www.site.github.io"), "PROXY p2:1");
  assert.equal(at("example.com"), "PROXY p1:1");
  assert.equal(at("a.example.com"), "PROXY p1:1");
});

test("the router answers for a host of 200 000 dots in linear time", () => {
  const pac = loadPac(buildSystemPac(TWO_ROOTS, { "root.org": { rootHost: "root.org", hosts: { "b.com": 1 } }, "site.github.io": { rootHost: null, hosts: {} } }, PSL));
  const started = performance.now();
  const long = `a${".".repeat(200000)}b.com`;
  assert.equal(pac.FindProxyForURL(`https://${long}/`, long), "PROXY p1:1");
  const other = `a${".".repeat(200000)}c.com`;
  assert.equal(pac.FindProxyForURL(`https://${other}/`, other), "DIRECT");
  assert.ok(performance.now() - started < 500);
});

test("answers are parsed once per distinct string, and answers past the memory are still parsed exactly", () => {
  const userPac = [
    "var n = 0;",
    "function FindProxyForURL(url, host) {",
    "  n++;",
    '  if (root(host, "a.com")) return n % 7 === 0 ? "DIRECT" : "PROXY p:" + (1 + (n % 300)) + "; DIRECT";',
    '  return "DIRECT";',
    "}",
  ].join("\n");
  const pac = loadPac(buildSystemPac(userPac, { "a.com": { rootHost: "www.a.com", hosts: { "cdn.a.net": 1 } } }, PSL));
  for (let n = 1; n <= 1000; n++) {
    const host = n % 2 === 0 ? "www.a.com" : "x.cdn.a.net";
    if (n % 7 === 0) assert.throws(() => route(pac, host), /RootPAC: no proxy for/);
    else assert.equal(route(pac, host), `PROXY p:${1 + (n % 300)}`);
  }
});

test("the answer memory has no prototype, so inherited names never answer for the User PAC", () => {
  const pac = loadPac(
    buildSystemPac(
      ["function FindProxyForURL(url, host) {", '  if (root(host, "a.com")) return host === "a.com" ? "PROXY p:1" : "constructor";', '  return "DIRECT";', "}"].join("\n"),
      { "a.com": { rootHost: null, hosts: {} } },
      PSL,
    ),
  );
  assert.equal(route(pac, "a.com"), "PROXY p:1");
  assert.throws(() => route(pac, "www.a.com"), /RootPAC: no proxy for www\.a\.com/);
  assert.equal(route(pac, "__proto__.org"), "DIRECT");
  assert.equal(route(pac, "constructor"), "DIRECT");
});
