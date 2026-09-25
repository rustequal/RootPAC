import { test } from "node:test";
import assert from "node:assert/strict";
import { hostFromUrl, isIpLiteral, isLearnable, isPlainName, learnedOwner, ownerHost } from "../src/core/hosts.js";
import { PSL } from "./support.js";

test("hostFromUrl normalizes the hostname", () => {
  assert.equal(hostFromUrl("https://WWW.Instagram.COM/path?q=1#x"), "www.instagram.com");
  assert.equal(hostFromUrl("https://www.instagram.com./"), "www.instagram.com");
  assert.equal(hostFromUrl("https://user:pass@static.cdninstagram.com:8443/a"), "static.cdninstagram.com");
  assert.equal(hostFromUrl("wss://edge-chat.facebook.com/chat"), "edge-chat.facebook.com");
  assert.equal(hostFromUrl("ws://a.example.com/"), "a.example.com");
  assert.equal(hostFromUrl("https://www.instagram.com"), "www.instagram.com");
  assert.equal(hostFromUrl("https://\u042F\u041D\u0414\u0415\u041A\u0421.\u0440\u0444/"), "xn--d1acpjx3f.xn--p1ai");
});

test("hostFromUrl canonicalizes IP literals", () => {
  assert.equal(hostFromUrl("http://0x7f.1/"), "127.0.0.1");
  assert.equal(hostFromUrl("http://3232235777/"), "192.168.1.1");
  assert.equal(hostFromUrl("http://[0:0:0:0:0:0:0:1]/"), "[::1]");
  assert.equal(hostFromUrl("http://[::FFFF:1.2.3.4]/"), "[::ffff:102:304]");
});

test("hostFromUrl returns null for unusable input", () => {
  assert.equal(hostFromUrl("null"), null);
  assert.equal(hostFromUrl(""), null);
  assert.equal(hostFromUrl("not a url"), null);
  assert.equal(hostFromUrl("file:///etc/hosts"), null);
  assert.equal(hostFromUrl(undefined), null);
  assert.equal(hostFromUrl("http://999.1.1.1/"), null);
});

test("isIpLiteral detects canonical IPv4 and IPv6", () => {
  assert.equal(isIpLiteral("127.0.0.1"), true);
  assert.equal(isIpLiteral("10.1.4.1"), true);
  assert.equal(isIpLiteral("[::1]"), true);
  assert.equal(isIpLiteral("[2001:db8::1]"), true);
  assert.equal(isIpLiteral("1.2.3.example.com"), false);
  assert.equal(isIpLiteral("www.instagram.com"), false);
  assert.equal(isIpLiteral("localhost"), false);
});

test("isPlainName detects dotless names", () => {
  assert.equal(isPlainName("localhost"), true);
  assert.equal(isPlainName("fileserver"), true);
  assert.equal(isPlainName("www.instagram.com"), false);
  assert.equal(isPlainName("a.b"), false);
});

test("ownerHost finds the host itself or its closest learned parent", () => {
  const index = new Map([
    ["cdn.a.net", ["a.com"]],
    ["b.net", ["b.com", "c.com"]],
  ]);
  assert.equal(ownerHost("cdn.a.net", index), "cdn.a.net");
  assert.equal(ownerHost("x.cdn.a.net", index), "cdn.a.net");
  assert.equal(ownerHost("a.net", index), null);
  assert.equal(ownerHost("cdn.b.net", index), "b.net");
  assert.equal(ownerHost("b.net", index), "b.net");
  assert.equal(ownerHost("net", index), null);
  assert.equal(ownerHost("xb.net", index), null);
});

test("isLearnable applies every filter", () => {
  const analysis = { roots: ["instagram.com"], deny: ["*.google-analytics.com", "graph.facebook.com"], bypass: [] };
  const index = new Map([["static.cdninstagram.com", "instagram.com"]]);
  assert.equal(isLearnable("scontent-ams2-1.cdninstagram.com", analysis, index, PSL), true);
  assert.equal(isLearnable("edge-chat.facebook.com", analysis, index, PSL), true);
  assert.equal(isLearnable("www.instagram.com", analysis, index, PSL), false);
  assert.equal(isLearnable("instagram.com", analysis, index, PSL), false);
  assert.equal(isLearnable("www.google-analytics.com", analysis, index, PSL), false);
  assert.equal(isLearnable("graph.facebook.com", analysis, index, PSL), false);
  assert.equal(isLearnable("static.cdninstagram.com", analysis, index, PSL), false);
  assert.equal(isLearnable("v1.static.cdninstagram.com", analysis, index, PSL), false);
  assert.equal(isLearnable("157.240.1.35", analysis, index, PSL), false);
  assert.equal(isLearnable("[2a03:2880::1]", analysis, index, PSL), false);
  assert.equal(isLearnable("localhost", analysis, index, PSL), false);
  assert.equal(isLearnable("scontent-ams2-1.cdninstagram.com", { roots: [], deny: [], bypass: [] }, new Map(), PSL), true);
});

test("deny covers its whole domain, as DNR requestDomains does", () => {
  const analysis = { roots: ["a.com"], deny: ["*.tracker.com", "x.com"], bypass: [] };
  for (const host of ["tracker.com", "px.tracker.com", "x.com", "cdn.x.com"]) assert.equal(isLearnable(host, analysis, new Map(), PSL), false, host);
  for (const host of ["nottracker.com", "tracker.com.net", "xx.com"]) assert.equal(isLearnable(host, analysis, new Map(), PSL), true, host);
});

test("hostFromUrl drops every trailing dot", async () => {
  const { hostFromUrl } = await import("../src/core/hosts.js");
  assert.equal(hostFromUrl("https://cdn.a.net./x"), "cdn.a.net");
  assert.equal(hostFromUrl("https://cdn.a.net../x"), "cdn.a.net");
  assert.equal(hostFromUrl("https://CDN.A.NET/"), "cdn.a.net");
});

test("ownerHost returns the learned name covering a host and covers compares whole labels", async () => {
  const { covers, ownerHost } = await import("../src/core/hosts.js");
  const index = new Map([["googlevideo.com", "a.com"], ["x.cdn.net", "a.com"]]);
  assert.equal(ownerHost("rr1.googlevideo.com", index), "googlevideo.com");
  assert.equal(ownerHost("googlevideo.com", index), "googlevideo.com");
  assert.equal(ownerHost("y.cdn.net", index), null);
  assert.equal(ownerHost("notgooglevideo.com", index), null);
  assert.equal(covers("a.com", "a.com"), true);
  assert.equal(covers("a.com", "x.a.com"), true);
  assert.equal(covers("a.com", "xa.com"), false);
});

test("an exact public suffix record covers only itself, and localhost names are never learned", () => {
  const analysis = { roots: ["root.org"], deny: [], bypass: [] };
  const index = new Map([["github.io", ["root.org"]], ["amazonaws.com", ["root.org"]]]);
  assert.equal(learnedOwner("github.io", index, PSL), "github.io");
  assert.equal(learnedOwner("a.github.io", index, PSL), null);
  assert.equal(learnedOwner("x.s3.amazonaws.com", index, PSL), "amazonaws.com");
  assert.equal(isLearnable("someone.github.io", analysis, index, PSL), true);
  assert.equal(isLearnable("co.uk", analysis, new Map(), PSL), true);
  for (const host of ["x.localhost", "a.b.localhost"]) assert.equal(isLearnable(host, analysis, new Map(), PSL), false, host);
  assert.equal(isLearnable("localhost.com", analysis, new Map(), PSL), true);
});
