import { test } from "node:test";
import assert from "node:assert/strict";
import { reportEndpointHosts } from "../src/core/reporting.js";

const BASE = "https://www.a.com/page";
const hosts = (...headers) => reportEndpointHosts(headers.map(([name, value]) => ({ name, value })), BASE);

test("Report-To yields every endpoint of every group", () => {
  const value = '{"group":"default","max_age":86400,"endpoints":[{"url":"https://r1.example.net/r"},{"url":"https://R2.Example.net:8443/x"}]}, {"group":"csp","endpoints":[{"url":"https://csp.example.org/c"}]}';
  assert.deepEqual(hosts(["Report-To", value]), ["csp.example.org", "r1.example.net", "r2.example.net"]);
  assert.deepEqual(hosts(["report-to", '{"group":"x","endpoints":[{"url":"/relative"}]}']), ["www.a.com"]);
});

test("broken or foreign Report-To entries are ignored", () => {
  assert.deepEqual(hosts(["Report-To", '{"group":"x","endpoints":[{"url":"https://a.net/"}'], ["Report-To", '{"group":"x"}, null, 5, {"endpoints":[null, {"url":7}, {"url":"http://plain.net/"}, {"url":"https://ok.net/"}]}']), ["ok.net"]);
});

test("Reporting-Endpoints yields the string values of its dictionary", () => {
  const value = 'default="https://r.example.net/r", csp-endpoint = "https://c.example.org/a,b";p="x,y", flag, num=5, esc="https://e.example.com/\\"q\\"", rel="/local"';
  assert.deepEqual(hosts(["Reporting-Endpoints", value]), ["c.example.org", "e.example.com", "r.example.net", "www.a.com"]);
  assert.deepEqual(hosts(["reporting-endpoints", 'a="https://x.net/', ]), []);
});

test("other headers and duplicates are ignored", () => {
  assert.deepEqual(
    hosts(["NEL", '{"report_to":"default","max_age":1}'], ["Content-Security-Policy", "report-uri https://csp.net/"], ["Report-To", '{"endpoints":[{"url":"https://d.net/"}]}'], ["Reporting-Endpoints", 'a="https://d.net/x"']),
    ["d.net"],
  );
});
