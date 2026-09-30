import { test } from "node:test";
import assert from "node:assert/strict";
import { createTraffic } from "../src/background/traffic.js";

const PZ = { mask: "a.com", name: "pz.test", kind: 1 };
const EXACT_PZ = { mask: "a.com", name: "pz.test", kind: 2 };

function setup() {
  let drained = 0;
  const traffic = createTraffic({ onDrained: () => drained++ });
  let id = 0;
  const start = (host, timeStamp) => {
    const requestId = String(++id);
    traffic.start({ requestId, url: `http://${host}:8080/p`, timeStamp });
    return requestId;
  };
  const end = (requestId, timeStamp) => traffic.end({ requestId, timeStamp });
  return { traffic, start, end, drained: () => drained };
}

test("a held route waits for the requests under it and for the event stream to pass the moment it was held", () => {
  const { traffic, start, end, drained } = setup();
  const old = start("u1.a.pz.test", 90);
  traffic.hold([PZ], 100);
  assert.equal(traffic.drained(PZ), false);
  const other = start("cdn.net", 101);
  assert.equal(traffic.drained(PZ), false, "a request under the route is still on its way");
  end(old, 102);
  assert.equal(traffic.drained(PZ), true);
  assert.equal(drained(), 1);
  end(other, 103);
  assert.equal(drained(), 1, "one release at a time until the next hold");
  traffic.hold([], 104);
  assert.equal(traffic.drained(PZ), false, "a route no longer held is not drained");
});

test("without a later event the stream has not proved that earlier starts were counted", () => {
  const { traffic, start, end, drained } = setup();
  traffic.hold([PZ], 100);
  assert.equal(traffic.drained(PZ), false);
  const late = start("u2.b.pz.test", 99);
  assert.equal(traffic.drained(PZ), false);
  end(late, 105);
  assert.equal(traffic.drained(PZ), true);
  assert.equal(drained(), 1);
});

test("an exact route waits only for its own name; a redirect or an error ends a request", () => {
  const { traffic, start, end } = setup();
  const below = start("u1.a.pz.test", 90);
  traffic.hold([EXACT_PZ], 100);
  start("x.org", 101);
  assert.equal(traffic.drained(EXACT_PZ), true);
  end(below, 102);
  const own = start("pz.test", 103);
  assert.equal(traffic.drained(EXACT_PZ), false);
  end(own, 104);
  assert.equal(traffic.drained(EXACT_PZ), true);
  end(own, 105);
  assert.equal(traffic.drained(EXACT_PZ), true, "a second end of one request changes nothing");
});

test("a known route keeps the moment it was first held; a new one waits from its own", () => {
  const { traffic, start, end } = setup();
  traffic.hold([PZ], 100);
  const request = start("u1.a.pz.test", 101);
  traffic.hold([PZ, { mask: "a.com", name: "x.net", kind: 1 }], 200);
  end(request, 150);
  assert.equal(traffic.drained(PZ), true);
  assert.equal(traffic.drained({ mask: "a.com", name: "x.net", kind: 1 }), false);
});

test("a route held by an earlier worker waits for a request of its own to finish", () => {
  const { traffic, start, end, drained } = setup();
  traffic.adopt([PZ], 100);
  start("x.org", 101);
  assert.equal(traffic.drained(PZ), false);
  const own = start("u3.c.pz.test", 102);
  assert.equal(traffic.drained(PZ), false);
  end(own, 103);
  assert.equal(traffic.drained(PZ), true);
  assert.equal(drained(), 1);
  traffic.hold([PZ], 104);
  assert.equal(traffic.drained(PZ), true, "hold keeps what the adopted route has seen");
});
