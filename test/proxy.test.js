import { test } from "node:test";
import assert from "node:assert/strict";
import { createProxy } from "../src/background/proxy.js";
import { FakeBrowser } from "./fakes.js";

test("apply sets the privacy settings before the mandatory PAC", async () => {
  const browser = new FakeBrowser();
  const control = await createProxy(browser).apply("function FindProxyForURL() {}");
  assert.deepEqual(browser.journal.entries, [
    ["prediction.set", { scope: "regular", value: false }],
    ["webrtc.set", { scope: "regular", value: "disable_non_proxied_udp" }],
    ["proxy.set", { scope: "regular", value: { mode: "pac_script", pacScript: { data: "function FindProxyForURL() {}", mandatory: true } } }],
  ]);
  assert.deepEqual(control, {
    levels: { proxy: "controlled_by_this_extension", prediction: "controlled_by_this_extension", webrtc: "controlled_by_this_extension" },
    incognitoLevels: null,
    controllable: true,
    armed: true,
  });
});

test("armed requires all three settings owned and holding exactly the applied values", async () => {
  const pac = "function FindProxyForURL() {}";
  const armed = async (change) => {
    const browser = new FakeBrowser();
    const proxy = createProxy(browser);
    await proxy.apply(pac);
    change(browser);
    return (await proxy.control(pac)).armed;
  };
  assert.equal(await armed(() => undefined), true);
  assert.equal(await armed((browser) => browser.takeOver()), false);
  assert.equal(await armed((browser) => (browser.privacy.network.networkPredictionEnabled.level = "controlled_by_other_extensions")), false);
  assert.equal(await armed((browser) => (browser.proxy.settings.value = { mode: "pac_script", pacScript: { data: "other", mandatory: true } })), false);
  assert.equal(await armed((browser) => (browser.proxy.settings.value = { mode: "pac_script", pacScript: { data: pac, mandatory: false } })), false);
  assert.equal(await armed((browser) => (browser.proxy.settings.value = { mode: "direct" })), false);
  assert.equal(await armed((browser) => (browser.privacy.network.networkPredictionEnabled.value = true)), false);
  assert.equal(await armed((browser) => (browser.privacy.network.webRTCIPHandlingPolicy.value = "default")), false);
  const browser = new FakeBrowser();
  await createProxy(browser).apply(pac);
  assert.equal((await createProxy(browser).control()).armed, false);
  assert.equal((await createProxy(browser).clear()).armed, false);
});

test("clear resets all three settings", async () => {
  const browser = new FakeBrowser();
  await createProxy(browser).clear();
  assert.deepEqual(browser.journal.names(), ["proxy.clear", "prediction.clear", "webrtc.clear"]);
});

test("control reports settings owned by someone else", async () => {
  for (const level of ["controlled_by_other_extensions", "not_controllable"]) {
    const { controllable, levels } = await createProxy(new FakeBrowser(undefined, level)).control();
    assert.equal(controllable, false);
    assert.deepEqual(Object.values(levels), [level, level, level]);
  }
});

test("with incognito access the incognito values must hold the same conditions", async () => {
  const pac = "function FindProxyForURL() {}";
  const OWN = "controlled_by_this_extension";
  const run = async (override, allowed = true) => {
    const browser = new FakeBrowser();
    browser.incognitoAllowed = allowed;
    const proxy = createProxy(browser);
    await proxy.apply(pac);
    override?.(browser);
    return proxy.control(pac);
  };
  const inherited = await run();
  assert.equal(inherited.armed, true);
  assert.deepEqual(inherited.incognitoLevels, { proxy: OWN, prediction: OWN, webrtc: OWN });
  const foreign = (browser) => (browser.proxy.settings.incognito = { level: "controlled_by_other_extensions", value: { mode: "direct" } });
  const taken = await run(foreign);
  assert.equal(taken.armed, false);
  assert.equal(taken.controllable, false);
  assert.equal(taken.levels.proxy, OWN);
  assert.equal(taken.incognitoLevels.proxy, "controlled_by_other_extensions");
  const webrtc = (browser) => (browser.privacy.network.webRTCIPHandlingPolicy.incognito = { level: OWN, value: "default" });
  assert.equal((await run(webrtc)).armed, false);
  const blind = await run(foreign, false);
  assert.equal(blind.armed, true);
  assert.equal(blind.incognitoLevels, null);
});
