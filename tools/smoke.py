import asyncio
import json
import re
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

EXTENSION = str(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent))
ORIGINS = ["cdn", "api.cdn2", "frame", "fcdn", "ws", "pre", "px.ads", "a.agg", "b.agg", "fresh.agg", "root2", "a.fna.shared", "c.shared", "d.xx.shared", "fresh.shared", "e.shared"]
BYPASS_ORIGIN = "img.zone.byp"
EMBEDDER = "news.embed.site"
EMBEDS = ("http://root.test:8080/embed.gif", "http://root.test:8080/embed.html")
direct = []
proxied = []

PAGE = b"""<!doctype html><html><head><link rel="preconnect" href="http://pre.test:8080"></head><body>root
<img src="http://cdn.test:8080/img.png">
<img src="http://px.ads.test:8080/pixel.gif">
<img src="http://a.agg.test:8080/a.png">
<img src="http://b.agg.test:8080/b.png">
<img src="http://img.zone.byp:8080/z.png">
<iframe src="http://frame.test:8080/frame.html"></iframe>
<script>fetch("http://api.cdn2.test:8080/x").catch(() => 0); new WebSocket("ws://ws.test:8080/ws");</script>
</body></html>"""
FRAME = b'<html><body><img src="http://fcdn.test:8080/f.png"></body></html>'
CACHED = b'<html><body>cached<script>navigator.serviceWorker.register("/sw.js")</script><img src="http://cdn.test:8080/img.png"><img src="http://px.ads.test:8080/pixel.gif"></body></html>'
CACHED_SW = b"""self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open("c").then((c) => c.add("/cached"))); });
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate" && new URL(e.request.url).pathname === "/cached") e.respondWith(caches.match("/cached").then((r) => r || fetch(e.request)));
});"""
SHARED_ROOT = b'<html><body>shared<img src="http://a.fna.shared.test:8080/a.png"></body></html>'
SHARED_ROOT2 = b'<html><body>root2<img src="http://c.shared.test:8080/c.png"><img src="http://d.xx.shared.test:8080/d.png"></body></html>'
EMBEDDING = f'<html><body>news<img src="{EMBEDS[0]}"><iframe src="{EMBEDS[1]}"></iframe></body></html>'.encode()


def serve(address, handler):
    server = ThreadingHTTPServer(address, handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Embedder(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(EMBEDDING)))
        self.end_headers()
        self.wfile.write(EMBEDDING)

    def log_message(self, *args):
        pass


def origin_handler(name):
    class Origin(BaseHTTPRequestHandler):
        def setup(self):
            direct.append(name)
            super().setup()

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    return Origin


proxied_all = []


class Proxy(BaseHTTPRequestHandler):
    def do_GET(self):
        proxied.append(self.path.split("?")[0])
        proxied_all.append(self.path.split("?")[0])
        body, kind = b"ok", "text/plain"
        if self.path == "http://root.test:8080/":
            body, kind = PAGE, "text/html"
        elif self.path == "http://frame.test:8080/frame.html":
            body, kind = FRAME, "text/html"
        elif self.path == "http://root.test:8080/cached":
            body, kind = CACHED, "text/html"
        elif self.path == "http://root.test:8080/sw.js":
            body, kind = CACHED_SW, "text/javascript"
        elif self.path == "http://root.test:8080/shared":
            body, kind = SHARED_ROOT, "text/html"
        elif self.path == "http://root2.test:8080/":
            body, kind = SHARED_ROOT2, "text/html"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_CONNECT(self):
        proxied.append(f"CONNECT {self.path}")
        self.send_response(502)
        self.end_headers()

    def log_message(self, *args):
        pass


CONTROL = {}
ENTRY = "/src/background/main.js"


async def extension_worker(context, marker=None):
    if not context.service_workers:
        await context.wait_for_event("serviceworker")
    for _ in range(200):
        for worker in list(context.service_workers):
            try:
                if marker is None and worker.url.endswith(ENTRY):
                    await open_control(context, worker)
                    return worker
                if marker is not None and await asyncio.wait_for(worker.evaluate(f"typeof globalThis.{marker}"), 10) == "function":
                    return worker
            except Exception:
                pass
        await asyncio.sleep(0.1)
    raise RuntimeError(f"service worker {marker or ENTRY} did not start")


async def open_control(context, worker):
    extension = worker.url.split("/")[2]
    page = await context.new_page()
    await page.goto(f"chrome-extension://{extension}/src/ui/viewer/viewer.html")
    await page.evaluate("globalThis.rootpac = (message) => chrome.runtime.sendMessage(message)")
    CONTROL[extension] = page


def control(worker):
    return CONTROL[worker.url.split("/")[2]]


async def wait_for_armed(worker, expected=True):
    for _ in range(100):
        stored = await worker.evaluate("chrome.storage.session.get('armed')")
        if stored.get("armed") is expected:
            return True
        await asyncio.sleep(0.1)
    return False


async def open_root(page):
    try:
        await page.goto("http://root.test:8080/", timeout=10000)
        return "loaded"
    except Exception as error:
        text = str(error)
        return "blocked" if "ERR_BLOCKED_BY_CLIENT" in text else text.splitlines()[0][:120]


BROKEN = {
    "initialization error": ("var p = list[0];\n", 1, "User PAC failed to initialize: ReferenceError: list is not defined"),
    "DIRECT for a root": (None, None, "User PAC returned no proxy for root.test"),
    "infinite loop": (None, 8, "User PAC exceeded the step budget (possible infinite loop)"),
    "unparseable proxy port": (None, None, "User PAC returned no proxy for root.test"),
    "credentials in the proxy": (None, None, "User PAC returned no proxy for root.test"),
    "router rewrite": (None, None, "User PAC returned no proxy for root.test"),
    "entry point redefinition": (None, 1, "User PAC failed to initialize: TypeError: Cannot redefine property: FindProxyForURL"),
    "strict mode": (None, 2, "User PAC failed to initialize: ReferenceError: undeclared is not defined"),
}


async def check_gate(worker, user_pac, failures):
    applied = (await worker.evaluate("chrome.proxy.settings.get({})"))["value"]["pacScript"]["data"]
    variants = {
        "initialization error": BROKEN["initialization error"][0] + user_pac,
        "DIRECT for a root": user_pac.replace("return PROXY;", 'return "DIRECT";'),
        "infinite loop": user_pac.replace('  return "DIRECT";', "  while (true) {}"),
        "unparseable proxy port": re.sub(r'"PROXY 127\.0\.0\.1:(\d+)"', r'"PROXY 127.0.0.1:\g<1>0"', user_pac),
        "credentials in the proxy": user_pac.replace('"PROXY 127.0.0.1:', '"PROXY user:pass@127.0.0.1:'),
        "router rewrite": "this.__proxied = function (r) { return r; };\n" + user_pac.replace("return PROXY;", 'return "DIRECT";'),
        "entry point redefinition": 'Object.defineProperty(this, "FindProxyForURL", { value: function () { return "DIRECT"; } });\n' + user_pac,
        "strict mode": '"use strict";\nundeclared = 1;\n' + user_pac,
    }
    for name, text in variants.items():
        result = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", text)
        _, line, message = BROKEN[name]
        error = (result.get("errors") or [{}])[0]
        print(f"gate {name}: {result}")
        if result["ok"] or error.get("message") != message or error.get("line") != line:
            failures.append(f"gate {name}: {result}")
    hang = "var slow = /^(a+)+$/.test('" + "a" * 40 + "!');\n" + user_pac
    await control(worker).evaluate("text => { globalThis.__hang = rootpac({ type: 'saveUserPac', text }); }", hang)
    await asyncio.sleep(2)
    cancelled = await control(worker).evaluate("rootpac({ type: 'cancelCheck' })")
    hung = await control(worker).evaluate("globalThis.__hang")
    print(f"gate cancel: {cancelled} -> {hung}")
    if cancelled != {"ok": True, "cancelled": True} or hung != {"ok": False, "error": "Check was cancelled"}:
        failures.append(f"cancel: {cancelled}, {hung}")
    after = (await worker.evaluate("chrome.proxy.settings.get({})"))["value"]["pacScript"]["data"]
    if after != applied:
        failures.append("a refused User PAC changed the applied System PAC")
    saved = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac)
    if not saved["ok"]:
        failures.append(f"valid User PAC after refusals: {saved}")


def under(name, entry):
    return name == entry or name.endswith(f".{entry}")


def badge_text(count):
    return "" if count == 0 else "99+" if count > 99 else str(count)


async def check_badge(worker, page, failures):
    tab_id = await worker.evaluate("chrome.tabs.query({ active: true }).then((t) => t[0].id)")
    badge = await worker.evaluate("id => chrome.action.getBadgeText({ tabId: id })", tab_id)
    state = await control(worker).evaluate("id => rootpac({ type: 'getTabState', tabId: id })", tab_id)
    print(f"badge on the root tab: {badge!r}, loaded {state['loaded']}, proxied {state['proxied']}, known {state['hostCount']}, new {state['newHosts']}")
    if badge != badge_text(state["proxied"]):
        failures.append(f"badge {badge!r} does not match the proxied host count {state['proxied']}")
    if state["proxied"] == 0:
        failures.append("no proxied host is counted on the root tab")
    await page.goto(f"http://{BYPASS_ORIGIN}:8080/")
    await asyncio.sleep(1)
    outside = await worker.evaluate("id => chrome.action.getBadgeText({ tabId: id })", tab_id)
    if outside != "":
        failures.append(f"badge {outside!r} is shown outside a root tab")
    await page.goto("http://root.test:8080/")
    await asyncio.sleep(2)
    applied = await worker.evaluate(
        """async (id) => {
          const decode = async (path) => {
            const bitmap = await createImageBitmap(await (await fetch(path)).blob());
            const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
            context.drawImage(bitmap, 0, 0);
            return context.getImageData(0, 0, bitmap.width, bitmap.height);
          };
          const imageData = { 16: await decode('/icons/active-16.png'), 32: await decode('/icons/active-32.png') };
          return chrome.action.setIcon({ tabId: id, imageData }).then(() => 'ok', (e) => String(e));
        }""",
        tab_id,
    )
    print(f"setIcon from the service worker: {applied}")
    if applied != "ok":
        failures.append(f"setIcon failed: {applied}")
    loading = await worker.evaluate("id => chrome.storage.session.get(`tab:${id}`).then((s) => s[`tab:${id}`]?.loading === true)", tab_id)
    if loading:
        failures.append("the tab is still marked as loading after the page finished")
    for reload in range(1, 4):
        await page.reload()
        await asyncio.sleep(2)
        kept = await worker.evaluate("id => chrome.action.getBadgeText({ tabId: id })", tab_id)
        state = await control(worker).evaluate("id => rootpac({ type: 'getTabState', tabId: id })", tab_id)
        print(f"badge after reload {reload}: {kept!r}, proxied {state['proxied']}")
        if kept != badge_text(state["proxied"]):
            failures.append(f"badge {kept!r} was lost after reload {reload}")


async def check_ui(context, worker, page, user_pac, failures):
    base = worker.url.split("/src/")[0]
    options = await context.new_page()
    await options.goto(f"{base}/src/ui/options/options.html")
    await options.fill("#text", user_pac + "\nvar root = 1;\n")
    await options.click("#save")
    await options.wait_for_selector("#result li.error")
    problem = await options.text_content("#result li.error")
    print(f"ui options error: {problem}")
    if not problem.startswith("10:5"):
        failures.append(f"options did not show the error position: {problem}")
    await options.fill("#text", user_pac)
    await options.click("#save")
    for _ in range(100):
        if await options.text_content("#status") == "Saved":
            break
        await asyncio.sleep(0.1)
    else:
        failures.append("options did not report a successful save")
    roots = await options.text_content("#result li")
    if "root.test" not in roots:
        failures.append(f"options did not show the analysis: {roots}")

    viewer = await context.new_page()
    await viewer.goto(f"{base}/src/ui/viewer/viewer.html")
    await viewer.wait_for_selector("details summary")
    pac_text = await viewer.text_content("#pac")
    if "FindProxyForURL" not in pac_text:
        failures.append("viewer did not show the applied PAC")
    back = await viewer.get_attribute("#options", "href")
    if back is None or "options.html" not in back:
        failures.append(f"viewer does not link back to Options: {back!r}")
    await viewer.click("details summary")
    await viewer.wait_for_selector("details table tr td button")
    host = await viewer.text_content("details table tr:nth-child(2) td")
    await viewer.click("details table tr:nth-child(2) td button")
    await asyncio.sleep(1)
    hosts = (await worker.evaluate("chrome.storage.local.get('group:root.test')"))["group:root.test"]["hosts"]
    print(f"ui viewer removed {host}, left {sorted(hosts)}")
    if host in hosts:
        failures.append(f"viewer Remove did not remove {host}")
    await options.close()
    await viewer.close()
    for attempt in range(2):
        before = len([name for name in direct if under(f"{name}.test", host)])
        proxied.clear()
        await page.goto("http://root.test:8080/")
        await asyncio.sleep(2)
        touched = len([name for name in direct if under(f"{name}.test", host)]) - before
        seen = [url for url in proxied if under(url.split("//")[-1].split(":")[0], host)]
        if attempt == 0:
            print(f"after Remove: {host} contacted directly x{touched}, through the proxy {seen or 'none'}")
            if touched or seen:
                failures.append(f"a host removed from the group was requested before the reload: {touched}, {seen}")
        elif not seen:
            failures.append(f"{host} did not go through the proxy after the reload")
    relearned = (await worker.evaluate("chrome.storage.local.get('group:root.test')"))["group:root.test"]["hosts"]
    print(f"ui relearned after Remove: {sorted(relearned)}")
    if host not in relearned:
        failures.append(f"{host} was not learned again after Remove")


async def check_trailing_dot(page, failures):
    contacted = len([name for name in direct if name != BYPASS_ORIGIN])
    proxied.clear()
    status = await page.evaluate("fetch('http://cdn.test.:8080/dot', { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked')")
    await asyncio.sleep(1)
    touched = [name for name in direct if name != BYPASS_ORIGIN][contacted:]
    through = "http://cdn.test.:8080/dot" in proxied
    print(f"trailing dot: cdn.test. from the root page {status}, through the proxy {through}, direct {touched or 'none'}")
    if touched:
        failures.append(f"a learned host with a trailing dot was contacted directly: {touched}")
    if status == "loaded" and not through:
        failures.append("a learned host with a trailing dot loaded without the proxy")


async def groups_of(worker):
    stored = await worker.evaluate("chrome.storage.local.get(['group:root.test', 'group:root2.test'])")
    return {key.split(":", 1)[1]: sorted(value["hosts"]) for key, value in stored.items()}


async def fresh_request(page, url):
    return await page.evaluate("url => fetch(url, { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked')", url)


async def check_shared_cdn(worker, page, failures):
    before = (await control(worker).evaluate("rootpac({ type: 'exportState' })"))["backup"]
    for url in ["http://root.test:8080/shared", "http://root.test:8080/shared", "http://root2.test:8080/", "http://root2.test:8080/"]:
        await page.goto(url)
        await asyncio.sleep(1.5)
    groups = await groups_of(worker)
    status = await fresh_request(page, "http://fresh.shared.test:8080/f")
    proxied_fresh = "http://fresh.shared.test:8080/f" in proxied
    await asyncio.sleep(1.5)
    after = await groups_of(worker)
    print(f"shared CDN: groups {groups}, fresh.shared.test from root2.test {status}, proxied {proxied_fresh}, groups after {after}")
    if groups.get("root2.test") != ["shared.test"] or groups.get("root.test", [None])[-1:] == ["shared.test"]:
        failures.append(f"root2.test did not aggregate its shared CDN hosts next to a root.test host: {groups}")
    if status != "loaded" or not proxied_fresh or after != groups:
        failures.append(f"a new shared CDN node was not proxied on its first request or was learned: {status}, {after}")
    exported = await control(worker).evaluate("rootpac({ type: 'exportState' })")
    legacy = json.loads(json.dumps(exported["backup"]))
    legacy["groups"]["root.test"]["hosts"].update({"a.fna.shared.test": 1, "b.fna.shared.test": 2})
    legacy["groups"]["root2.test"]["hosts"] = {"c.shared.test": 3, "d.xx.shared.test": 4}
    imported = await control(worker).evaluate("backup => rootpac({ type: 'importState', backup })", legacy)
    both = await groups_of(worker)
    domains = await worker.evaluate("chrome.declarativeNetRequest.getSessionRules().then((rules) => rules.flatMap((rule) => rule.condition.requestDomains || []))")
    await page.goto("http://root2.test:8080/")
    await asyncio.sleep(1)
    status = await fresh_request(page, "http://e.shared.test:8080/e")
    print(f"shared CDN legacy import: {imported.get('ok')}, groups {both}, shared.test in DNR x{domains.count('shared.test')}, e.shared.test {status}")
    if not imported.get("ok") or "shared.test" not in both.get("root.test", []) or both.get("root2.test") != ["shared.test"] or domains.count("shared.test") != 1:
        failures.append(f"a shared record in two groups was not built: {imported}, {both}, {domains}")
    if status != "loaded" or "http://e.shared.test:8080/e" not in proxied:
        failures.append(f"a node of a record shared by two groups was not proxied: {status}")
    restored = await control(worker).evaluate("backup => rootpac({ type: 'importState', backup })", before)
    if not restored.get("ok"):
        failures.append(f"state restore after the shared CDN check: {restored}")


async def check_aggregation(worker, page, failures):
    hosts = (await worker.evaluate("chrome.storage.local.get('group:root.test')"))["group:root.test"]["hosts"]
    if "agg.test" not in hosts or "a.agg.test" in hosts or "b.agg.test" in hosts:
        failures.append(f"a.agg.test and b.agg.test were not aggregated: {sorted(hosts)}")
    proxied.clear()
    status = await page.evaluate("fetch('http://fresh.agg.test:8080/f', { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked')")
    fresh = "http://fresh.agg.test:8080/f" in proxied
    print(f"aggregation: learned agg.test, fresh.agg.test on first request {status}, proxied {fresh}")
    if status != "loaded" or not fresh:
        failures.append(f"fresh.agg.test was not proxied on its first request: {status}")
    after = (await worker.evaluate("chrome.storage.local.get('group:root.test')"))["group:root.test"]["hosts"]
    if "fresh.agg.test" in after:
        failures.append("a covered subdomain was learned separately")


SCALE = 20000
LEARN_LIMIT = 10


async def check_scale(worker, page, failures):
    saved = await control(worker).evaluate("rootpac({ type: 'exportState' })")
    if not saved["ok"]:
        failures.append(f"exportState before the load test: {saved}")
        return
    report = await control(worker).evaluate(
        """async (count) => {
          const before = await rootpac({ type: 'exportState' });
          const backup = before.backup;
          const hosts = backup.groups['root.test'].hosts;
          for (let i = 0; i < count; i++) hosts[`www.h${i}.load`] = 1;
          const start = performance.now();
          const result = await rootpac({ type: 'importState', backup });
          const applied = performance.now() - start;
          const settings = await chrome.proxy.settings.get({});
          const rules = [...(await chrome.declarativeNetRequest.getDynamicRules()), ...(await chrome.declarativeNetRequest.getSessionRules())];
          const stored = await chrome.storage.local.get('group:root.test');
          return {
            ok: result.ok,
            error: result.error ?? null,
            applied: Math.round(applied),
            pacBytes: settings.value.pacScript.data.length,
            mandatory: settings.value.pacScript.mandatory,
            rules: rules.length,
            hosts: Object.keys(stored['group:root.test'].hosts).length,
          };
        }""",
        SCALE,
    )
    print(f"scale {SCALE}: {report}")
    if not report["ok"]:
        failures.append(f"importState with {SCALE} hosts failed: {report['error']}")
    if report["hosts"] < SCALE:
        failures.append(f"only {report['hosts']} hosts survived the import")
    if not report["mandatory"]:
        failures.append("PAC is not mandatory after the load test")
    proxied.clear()
    contacted = len([name for name in direct if name != BYPASS_ORIGIN])
    await page.goto("http://root.test:8080/")
    await asyncio.sleep(2)
    touched = [name for name in direct if name != BYPASS_ORIGIN][contacted:]
    if touched:
        failures.append(f"a direct connection was made while the big group was applied: {touched}")
    if "http://cdn.test:8080/img.png" not in proxied:
        failures.append("a learned host stopped going through the proxy under load")
    started = time.monotonic()
    await page.evaluate("() => { new Image().src = 'http://www.fresh.load:8080/x.png'; }")
    learned = False
    while not learned and time.monotonic() - started < LEARN_LIMIT:
        state = await control(worker).evaluate("rootpac({ type: 'exportState' })")
        learned = "www.fresh.load" in state["backup"]["groups"]["root.test"]["hosts"]
        await asyncio.sleep(0.1)
    print(f"scale {SCALE}: one new host learned in {time.monotonic() - started:.2f} s")
    if not learned:
        failures.append(f"a new host was not learned within {LEARN_LIMIT} s in a group of {SCALE} hosts")
    restored = await control(worker).evaluate("backup => rootpac({ type: 'importState', backup })", saved["backup"])
    if not restored["ok"]:
        failures.append(f"restoring the state after the load test: {restored}")


async def check_worker_restart(context, worker, page, failures):
    tab_id = await worker.evaluate("chrome.tabs.query({ active: true }).then((t) => t[0].id)")
    await worker.evaluate("globalThis.__mark = 1")
    try:
        cdp = await context.new_cdp_session(page)
        await asyncio.wait_for(cdp.send("ServiceWorker.enable"), 20)
        await asyncio.wait_for(cdp.send("ServiceWorker.stopAllWorkers"), 20)
        await asyncio.wait_for(cdp.detach(), 20)
        print("restart: service worker stopped over CDP", flush=True)
    except Exception as error:
        print(f"restart: CDP stop failed ({type(error).__name__}), waiting out the idle timeout", flush=True)
        await asyncio.sleep(45)
    contacted = len([name for name in direct if name != BYPASS_ORIGIN])
    proxied.clear()
    await page.goto("http://root.test:8080/")
    await asyncio.sleep(3)
    revived = context.service_workers[-1]
    try:
        mark = await asyncio.wait_for(revived.evaluate("typeof globalThis.__mark"), 60)
        state = await asyncio.wait_for(control(revived).evaluate("id => rootpac({ type: 'getTabState', tabId: id })", tab_id), 60)
    except asyncio.TimeoutError:
        failures.append("the service worker did not answer after being stopped")
        return None
    touched = [name for name in direct if name != BYPASS_ORIGIN][contacted:]
    print(f"service worker restart: fresh {mark == 'undefined'}, tab state {state}, direct {touched or 'none'}", flush=True)
    if mark != "undefined":
        failures.append("the service worker did not restart")
    if state["mask"] != "root.test" or state["hostCount"] == 0:
        failures.append(f"tab state was not restored after the restart: {state}")
    if touched:
        failures.append(f"a direct connection was made after the service worker restart: {touched}")
    if "http://cdn.test:8080/img.png" not in proxied:
        failures.append("learning did not continue after the service worker restart")
    return revived


CONFLICT_MANIFEST = """{
  "manifest_version": 3,
  "name": "Conflicting proxy",
  "version": "1.0",
  "permissions": ["proxy"],
  "background": { "service_worker": "sw.js" }
}"""

CONFLICT_SW = """globalThis.takeover = () => chrome.proxy.settings.set({ scope: "regular", value: { mode: "direct" } }).then(() => "set");
globalThis.release = () => chrome.proxy.settings.clear({ scope: "regular" }).then(() => "cleared");
takeover();"""


def write_conflict_extension():
    path = Path(tempfile.mkdtemp())
    (path / "manifest.json").write_text(CONFLICT_MANIFEST)
    (path / "sw.js").write_text(CONFLICT_SW)
    return str(path)


async def check_conflict(playwright, profile, rules, conflict, failures):
    context = await playwright.chromium.launch_persistent_context(
        profile,
        channel="chromium",
        headless=True,
        args=[
            f"--disable-extensions-except={EXTENSION},{conflict}",
            f"--load-extension={EXTENSION},{conflict}",
            "--host-resolver-rules=" + ", ".join(rules),
            "--disable-features=LocalNetworkAccessChecks",
        ],
    )
    try:
        worker = await extension_worker(context)
        other = await extension_worker(context, "takeover")
        page = await context.new_page()

        async def phase(name, expect_armed, expect_page):
            armed = await wait_for_armed(worker, expect_armed)
            level = await worker.evaluate("chrome.proxy.settings.get({}).then((s) => s.levelOfControl + ' ' + s.value.mode)")
            allows = await worker.evaluate("chrome.declarativeNetRequest.getSessionRules().then((r) => r.length)")
            contacted = len(direct)
            proxied.clear()
            result = await open_root(page)
            embedder = await page.context.new_page()
            await embedder.goto(f"http://{EMBEDDER}:8080/")
            await asyncio.sleep(1)
            await embedder.close()
            touched = [origin for origin in direct[contacted:] if origin != BYPASS_ORIGIN]
            embedded = sorted(entry for entry in proxied if entry in EMBEDS)
            print(f"conflict {name}: {level}, armed {expect_armed if armed else 'unexpected'}, session rules {allows}, root {result}, embedded root via proxy {len(embedded)}, direct {touched or 'none'}")
            if embedded != (sorted(EMBEDS) if expect_armed else []):
                failures.append(f"conflict {name}: root embedded on another site went through the proxy {embedded}")
            if not armed:
                failures.append(f"conflict {name}: armed did not become {expect_armed}")
            if result != expect_page:
                failures.append(f"conflict {name}: the root page was {result}, expected {expect_page}")
            if touched:
                failures.append(f"conflict {name}: direct connections {touched}")
            if not expect_armed and allows != 0:
                failures.append(f"conflict {name}: {allows} allow rules while closed")

        await phase("at startup", False, "blocked")
        await other.evaluate("release()")
        await phase("after release", True, "loaded")
        await other.evaluate("takeover()")
        await phase("after takeover", False, "blocked")
        await other.evaluate("release()")
        await phase("after second release", True, "loaded")
    finally:
        await context.close()


def start_network():
    proxy_port = serve(("127.0.0.1", 0), Proxy).server_address[1]
    rules = ["MAP root.test 127.0.0.2"]
    serve(("127.0.0.2", 8080), origin_handler("root.test"))
    for index, name in enumerate(ORIGINS, start=1):
        serve((f"127.0.2.{index}", 8080), origin_handler(name))
        rules.append(f"MAP {name}.test 127.0.2.{index}")
        rules.append(f"MAP {name}.test. 127.0.2.{index}")
    serve(("127.0.3.1", 8080), origin_handler(BYPASS_ORIGIN))
    rules.append(f"MAP {BYPASS_ORIGIN} 127.0.3.1")
    serve(("127.0.4.1", 8080), Embedder)
    rules.append(f"MAP {EMBEDDER} 127.0.4.1")
    return proxy_port, rules


def user_pac_for(proxy_port):
    return (
        'deny("*.ads.test");\n'
        'bypass("*.byp");\n\n'
        f'var PROXY = "PROXY 127.0.0.1:{proxy_port}";\n\n'
        "function FindProxyForURL(url, host) {\n"
        '  if (root(host, "root.test") || root(host, "root2.test")) return PROXY;\n'
        '  return "DIRECT";\n'
        "}"
    )


async def main():
    proxy_port, rules = start_network()
    user_pac = user_pac_for(proxy_port)
    profile = tempfile.mkdtemp()
    conflict = write_conflict_extension()
    failures = []
    try:
        async with async_playwright() as playwright:
            for session, loads in ((1, 3), (2, 1)):
                context = await playwright.chromium.launch_persistent_context(
                    profile,
                    channel="chromium",
                    headless=True,
                    args=[
                        f"--disable-extensions-except={EXTENSION}",
                        f"--load-extension={EXTENSION}",
                        "--host-resolver-rules=" + ", ".join(rules),
                        "--disable-features=LocalNetworkAccessChecks",
                    ],
                )
                worker = await extension_worker(context)
                if session == 1:
                    print("browser", await worker.evaluate("navigator.userAgent.match(/Chrome\\/[0-9]+/)[0]"))
                    saved = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac)
                    if not saved["ok"] or not saved["control"]["armed"]:
                        failures.append(f"saveUserPac: {saved}")
                page = await context.new_page()
                if session == 2:
                    contacted = len(direct)
                    early = await open_root(page)
                    armed = await wait_for_armed(worker)
                    allows = await worker.evaluate("chrome.declarativeNetRequest.getSessionRules().then((r) => r.length)")
                    touched = [origin for origin in direct[contacted:] if origin != BYPASS_ORIGIN]
                    del direct[contacted:]
                    if touched:
                        print(f"WARNING session 2 before the check: direct {touched} — Chrome preconnect while --load-extension has not restored the extension settings yet; check a normal install by hand")
                    print(f"session 2 before the check: root {early}, direct {touched or 'none'}; armed after the check {armed}, session rules {allows}")
                    if not armed:
                        failures.append("the check did not re-arm the protection after the browser restart")
                    await page.close()
                    page = await context.new_page()
                for load in range(1, loads + 1):
                    proxied.clear()
                    await page.goto("http://root.test:8080/")
                    await asyncio.sleep(2)
                    group = await worker.evaluate("chrome.storage.local.get('group:root.test')")
                    print(f"session {session} load {load}: proxied {sorted(set(proxied))}")
                    print(f"session {session} load {load}: learned {sorted(group['group:root.test']['hosts'])}")
                    if any("byp" in host for host in group["group:root.test"]["hosts"]):
                        failures.append("a bypass host was learned")
                    if session == 1 and load == 1:
                        touched = sorted({name for name in direct if name != BYPASS_ORIGIN})
                        reached = sorted({url for url in proxied if not url.startswith("http://root.test:8080/")})
                        print(f"first load: unlearned hosts reached directly {touched or 'none'}, through the proxy {reached or 'none'}")
                        if touched:
                            failures.append(f"an unlearned host was contacted directly before the reload: {touched}")
                        if reached:
                            failures.append(f"an unlearned host was requested before the reload: {reached}")
                if session == 1:
                    await check_badge(worker, page, failures)
                    await check_aggregation(worker, page, failures)
                    await check_shared_cdn(worker, page, failures)
                    await check_trailing_dot(page, failures)
                    worker = await check_worker_restart(context, worker, page, failures) or worker
                    await check_scale(worker, page, failures)
                    await check_gate(worker, user_pac, failures)
                    await check_ui(context, worker, page, user_pac, failures)
                if session == 2:
                    errors = await worker.evaluate("chrome.storage.local.get('userPacErrors')")
                    print("session 2 safe mode:", errors.get("userPacErrors"))
                    if not errors.get("userPacErrors"):
                        failures.append("safe mode was not entered for an invalid stored User PAC")
                settings = await worker.evaluate("chrome.proxy.settings.get({})")
                prediction = await worker.evaluate("chrome.privacy.network.networkPredictionEnabled.get({})")
                webrtc = await worker.evaluate("chrome.privacy.network.webRTCIPHandlingPolicy.get({})")
                if not settings["value"]["pacScript"]["mandatory"]:
                    failures.append("PAC is not mandatory")
                if prediction["value"] is not False or webrtc["value"] != "disable_non_proxied_udp":
                    failures.append(f"privacy settings: {prediction['value']}, {webrtc['value']}")
                if session == 1:
                    await worker.evaluate("text => chrome.storage.local.set({ userPac: text })", user_pac.replace('root(host, "root.test")', 'root(host, "root.test") || root(host, "Bad.test")'))
                await context.close()
            await check_conflict(playwright, profile, rules, conflict, failures)
    finally:
        shutil.rmtree(profile)
        shutil.rmtree(conflict)
    learned_last = {"http://cdn.test:8080/img.png", "http://api.cdn2.test:8080/x", "http://fcdn.test:8080/f.png", "CONNECT ws.test:8080", "http://a.agg.test:8080/a.png", "http://b.agg.test:8080/b.png"}
    if not learned_last <= set(proxied):
        failures.append(f"after restart not everything went through the proxy: {sorted(set(proxied))}")
    bypassed = [name for name in direct if name == BYPASS_ORIGIN]
    leaked = [name for name in direct if name != BYPASS_ORIGIN]
    if not bypassed:
        failures.append("the bypass host img.zone.byp was not reached directly")
    if any("zone.byp" in entry for entry in proxied_all):
        failures.append("the bypass host went through the proxy")
    if leaked:
        failures.append(f"direct connections to origins: {leaked}")
    print(f"bypass: {BYPASS_ORIGIN} direct x{len(bypassed)}, via proxy: {any('zone.byp' in entry for entry in proxied_all)}")
    print("DIRECT connections to origins:", leaked or "none")
    print("RESULT:", "PASS" if not failures else "FAIL")
    for failure in failures:
        print("  -", failure)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
