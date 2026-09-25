import { test } from "node:test";
import assert from "node:assert/strict";
import { createChecker } from "../src/background/check.js";
import { deferred } from "./fakes.js";

function fakes({ open = false } = {}) {
  const log = [];
  const state = { open, pending: [] };
  const offscreen = {
    async createDocument(details) {
      log.push(["create", details.url, details.reasons]);
      if (state.open) throw new Error("Only a single offscreen document may be created.");
      state.open = true;
    },
    async closeDocument() {
      log.push(["close"]);
      if (!state.open) throw new Error("No current offscreen document.");
      state.open = false;
      for (const reply of state.pending.splice(0)) reply.reject(new Error("The message port closed before a response was received."));
    },
  };
  const runtime = {
    async getContexts({ contextTypes }) {
      assert.deepEqual(contextTypes, ["OFFSCREEN_DOCUMENT"]);
      return state.open ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
    },
    sendMessage(message) {
      log.push(["send", message]);
      const reply = deferred();
      state.pending.push(reply);
      return reply.promise;
    },
  };
  return { log, state, offscreen, runtime };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a check opens the document, relays the request and closes it", async () => {
  const { log, state, offscreen, runtime } = fakes();
  const checker = createChecker({ offscreen, runtime });
  const running = checker.run({ code: "x" });
  await tick();
  state.pending[0].resolve({ ok: true });
  assert.deepEqual(await running, { cancelled: false, outcome: { ok: true } });
  assert.deepEqual(log, [
    ["create", "src/offscreen/offscreen.html", ["IFRAME_SCRIPTING"]],
    ["send", { target: "rootpac-trial", request: { code: "x" } }],
    ["close"],
  ]);
  assert.equal(state.open, false);
});

test("a document left over from a previous service worker is closed first", async () => {
  const { log, state, offscreen, runtime } = fakes({ open: true });
  const checker = createChecker({ offscreen, runtime });
  const running = checker.run({});
  await tick();
  state.pending[0].resolve({ ok: true });
  await running;
  assert.deepEqual(log.map(([name]) => name), ["close", "create", "send", "close"]);
});

test("cancel closes the document and the check reports cancellation", async () => {
  const { state, offscreen, runtime } = fakes();
  const checker = createChecker({ offscreen, runtime });
  const running = checker.run({});
  await tick();
  assert.equal(await checker.cancel(), true);
  assert.deepEqual(await running, { cancelled: true });
  assert.equal(state.open, false);
  assert.equal(await checker.cancel(), false);
});

test("a new check cancels the running one and then runs alone", async () => {
  const { log, state, offscreen, runtime } = fakes();
  const checker = createChecker({ offscreen, runtime });
  const first = checker.run({ n: 1 });
  await tick();
  const second = checker.run({ n: 2 });
  assert.deepEqual(await first, { cancelled: true });
  await tick();
  state.pending.at(-1).resolve({ ok: true });
  assert.deepEqual(await second, { cancelled: false, outcome: { ok: true } });
  const sends = log.filter(([name]) => name === "send").map(([, message]) => message.request.n);
  assert.deepEqual(sends, [1, 2]);
  assert.equal(state.open, false);
});

test("a failure other than cancellation is raised", async () => {
  const { offscreen, runtime } = fakes();
  runtime.sendMessage = async () => {
    throw new Error("Could not establish connection");
  };
  const checker = createChecker({ offscreen, runtime });
  await assert.rejects(checker.run({}), /Could not establish connection/);
  assert.equal(await checker.cancel(), false);
});
