import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogDb } from "../src/background/logdb.js";

// An IndexedDB of one auto-increment store, enough for the log: add, delete by upper bound, getAll by lower bound.
function fakeIndexedDb() {
  const rows = new Map();
  let next = 1;
  const deletes = [];
  const request = (result) => {
    const item = { result };
    queueMicrotask(() => item.onsuccess?.());
    return item;
  };
  const store = {
    add(entry) {
      const id = next++;
      rows.set(id, { ...entry, id });
      return request(id);
    },
    delete({ upper }) {
      deletes.push(upper);
      for (const id of rows.keys()) if (id <= upper) rows.delete(id);
    },
    getAll({ lower }) {
      return request([...rows.values()].filter((row) => row.id > lower));
    },
    clear: () => rows.clear(),
  };
  const db = {
    transaction() {
      const transaction = { objectStore: () => store };
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
  };
  const factory = {
    open() {
      const item = { result: db };
      queueMicrotask(() => item.onsuccess());
      return item;
    },
  };
  const keyRange = { upperBound: (upper) => ({ upper }), lowerBound: (lower) => ({ lower }) };
  return { factory, keyRange, rows, deletes };
}

const batch = (size) => Array.from({ length: size }, (_, index) => ({ time: index, kind: "learned" }));

test("the log keeps the last entries and deletes old ones a step at a time, not on every batch", async () => {
  const idb = fakeIndexedDb();
  const db = createLogDb({ factory: idb.factory, keyRange: idb.keyRange, limit: 100, step: 50 });
  for (let index = 0; index < 10; index++) await db.append(batch(10));
  assert.equal(idb.rows.size, 100);
  assert.deepEqual(idb.deletes, []);
  // The first batch past the limit deletes, the next ones wait for the step.
  await db.append(batch(10));
  assert.deepEqual(idb.deletes, [10]);
  for (let index = 0; index < 4; index++) await db.append(batch(10));
  assert.deepEqual(idb.deletes, [10]);
  assert.equal(idb.rows.size, 140);
  await db.append(batch(10));
  assert.deepEqual(idb.deletes, [10, 60]);
  assert.equal(idb.rows.size, 100);
  const read = await db.read(0);
  assert.equal(read.length, 100);
  assert.equal(read[0].id, 61);
});

test("a new worker deletes on its first append past the limit", async () => {
  const idb = fakeIndexedDb();
  const first = createLogDb({ factory: idb.factory, keyRange: idb.keyRange, limit: 100, step: 50 });
  for (let index = 0; index < 13; index++) await first.append(batch(10));
  assert.deepEqual(idb.deletes, [10]);
  const second = createLogDb({ factory: idb.factory, keyRange: idb.keyRange, limit: 100, step: 50 });
  await second.append(batch(10));
  assert.deepEqual(idb.deletes, [10, 40]);
  assert.equal(idb.rows.size, 100);
});
