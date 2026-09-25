import asyncio
import json
import select
import socket
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

EXTENSION = str(Path(__file__).resolve().parent.parent)
ROOT = "https://en.wikipedia.org/wiki/Cryptography"
ROOT_HOST = "en.wikipedia.org"
SECOND_ROOT = "https://ya.ru/"
BYPASS_PROBE = "https://lenta.ru/favicon.ico"
BYPASS_HOST = "lenta.ru"
DENY_PROBE = "https://www.google-analytics.com/analytics.js"
OUTSIDE = "https://example.com/"

tunneled = []


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        host, _, port = self.path.rpartition(":")
        tunneled.append(host)
        try:
            upstream = socket.create_connection((host, int(port)), 15)
        except OSError:
            self.send_error(502)
            return
        self.send_response(200, "Connection Established")
        self.end_headers()
        self.wfile.flush()
        client = self.connection
        try:
            while True:
                ready, _, broken = select.select([client, upstream], [], [client, upstream], 60)
                if broken or not ready:
                    break
                for source in ready:
                    target = upstream if source is client else client
                    data = source.recv(65536)
                    if not data:
                        return
                    target.sendall(data)
        except OSError:
            pass
        finally:
            upstream.close()

    def forward(self):
        url = self.path
        host = url.split("//", 1)[-1].split("/")[0]
        tunneled.append(host.split(":")[0])
        name, _, port = host.partition(":")
        path = "/" + url.split("//", 1)[-1].partition("/")[2]
        try:
            upstream = socket.create_connection((name, int(port or 80)), 15)
        except OSError:
            self.send_error(502)
            return
        head = f"{self.command} {path} HTTP/1.1\r\n"
        for key, value in self.headers.items():
            if key.lower() in ("proxy-connection", "connection"):
                continue
            head += f"{key}: {value}\r\n"
        head += "Connection: close\r\n\r\n"
        upstream.sendall(head.encode("latin-1"))
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            upstream.sendall(self.rfile.read(length))
        try:
            while True:
                data = upstream.recv(65536)
                if not data:
                    break
                self.connection.sendall(data)
        except OSError:
            pass
        finally:
            upstream.close()
        self.close_connection = True

    do_GET = forward
    do_POST = forward
    do_HEAD = forward


def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


CONTROL = {}


async def extension_worker(context):
    if not context.service_workers:
        await context.wait_for_event("serviceworker")
    for _ in range(200):
        for worker in list(context.service_workers):
            if worker.url.endswith("/src/background/main.js"):
                extension = worker.url.split("/")[2]
                page = await context.new_page()
                await page.goto(f"chrome-extension://{extension}/src/ui/viewer/viewer.html")
                await page.evaluate("globalThis.rootpac = (message) => chrome.runtime.sendMessage(message)")
                CONTROL[extension] = page
                return worker
        await asyncio.sleep(0.1)
    raise RuntimeError("RootPAC service worker did not start")


def control(worker):
    return CONTROL[worker.url.split("/")[2]]


def group_hosts(state, mask):
    group = state.get(f"group:{mask}")
    return sorted(group["hosts"]) if group else []


async def load(page, url, blocked, wait=4):
    blocked.clear()
    await page.goto(url, wait_until="load", timeout=60000)
    await asyncio.sleep(wait)
    return sorted(set(blocked))


async def probe(page, url):
    return await page.evaluate(
        "url => fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(() => 'loaded', () => 'blocked')",
        url,
    )


def netlog_report(path, domains, failures, label, direct_ok=()):
    log = json.loads(Path(path).read_text(encoding="utf-8"))
    names = {value: key for key, value in log["constants"]["logEventTypes"].items()}
    urls = {}
    chains = {}
    for event in log["events"]:
        params = event.get("params", {})
        source = event["source"]["id"]
        if names[event["type"]] in ("HTTP_STREAM_JOB_CONTROLLER", "REQUEST_ALIVE", "URL_REQUEST_START_JOB") and "url" in params:
            urls[source] = params["url"]
        if names[event["type"]] == "HTTP_STREAM_JOB_CONTROLLER_PROXY_SERVER_RESOLVED" and source in urls:
            host = urls[source].split("//", 1)[-1].split("/")[0].split(":")[0]
            chains.setdefault(host, {}).setdefault(params["proxy_chain"], 0)
            chains[host][params["proxy_chain"]] += 1
    protected = {host: routes for host, routes in chains.items() if any(host == d or host.endswith("." + d) for d in domains)}
    violations = sorted(host for host, routes in protected.items() if "[direct://]" in routes)
    print(f"{label}: {len(protected)} protected hosts in the netlog, DIRECT for {violations or 'none'}")
    for host in violations:
        print(f"  {host}: {protected[host]}")
    if violations:
        failures.append(f"{label}: DIRECT to protected hosts {violations}")
    for host in direct_ok:
        routes = chains.get(host)
        print(f"  bypass {host}: {routes or 'not seen'}")
        if routes and set(routes) != {"[direct://]"}:
            failures.append(f"{label}: bypass host {host} did not go direct: {routes}")
    return protected


async def session(playwright, profile, port, netlog, first, failures, results):
    context = await playwright.chromium.launch_persistent_context(
        profile,
        channel="chromium",
        headless=True,
        bypass_csp=True,
        args=[
            f"--disable-extensions-except={EXTENSION}",
            f"--load-extension={EXTENSION}",
            f"--log-net-log={netlog}",
            "--net-log-capture-mode=Default",
        ],
    )
    blocked = []
    try:
        worker = await extension_worker(context)
        user_pac = (
            'deny("*.google-analytics.com");\n'
            'bypass("*.ru");\n\n'
            f'var PROXY = "PROXY 127.0.0.1:{port}";\n\n'
            "function FindProxyForURL(url, host) {\n"
            '  if (root(host, "wikipedia.org") || root(host, "ya.ru")) return PROXY;\n'
            '  return "DIRECT";\n'
            "}"
        )
        if first:
            print("browser", await worker.evaluate("navigator.userAgent.match(/Chrome\\/[0-9]+/)[0]"))
            saved = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac)
            if not saved["ok"]:
                failures.append(f"saveUserPac: {saved}")
                return
        page = await context.new_page()
        page.on("requestfailed", lambda request: blocked.append(request.url.split("//", 1)[-1].split("/")[0]))

        if first:
            for attempt in range(1, 4):
                stopped = await load(page, ROOT, blocked)
                state = await worker.evaluate("chrome.storage.local.get(null)")
                hosts = group_hosts(state, "wikipedia.org")
                print(f"load {attempt}: blocked {stopped or 'none'}, group {hosts}")
                results.append((f"first visit, load {attempt}", f"blocked {len(stopped)}, in group {len(hosts)}"))
                if not stopped:
                    break
            if stopped:
                failures.append(f"the page was still incomplete after three loads: {stopped}")

            deny = await probe(page, DENY_PROBE)
            state = await worker.evaluate("chrome.storage.local.get(null)")
            learned_deny = [h for h in group_hosts(state, "wikipedia.org") if "google-analytics" in h]
            print(f"deny: {DENY_PROBE} {deny}, learned {learned_deny or 'none'}")
            results.append(("request to a deny host from the root page", f"{deny}, kept out of the group: {not learned_deny}"))
            if deny != "blocked" or learned_deny:
                failures.append(f"deny host: {deny}, learned {learned_deny}")

            tunneled.clear()
            bypass = await probe(page, BYPASS_PROBE)
            state = await worker.evaluate("chrome.storage.local.get(null)")
            learned_ru = [h for h in group_hosts(state, "wikipedia.org") if h.endswith(".ru")]
            through = [h for h in tunneled if h.endswith(BYPASS_HOST)]
            print(f"bypass: {BYPASS_HOST} {bypass}, through the proxy {through or 'none'}, learned {learned_ru or 'none'}")
            results.append(('bypass("*.ru"), a .ru resource from the root page', f"{bypass}, through the proxy: {bool(through)}, learned: {bool(learned_ru)}"))
            if bypass != "loaded" or through or learned_ru:
                failures.append(f"bypass: {bypass}, proxy {through}, learned {learned_ru}")

            tunneled.clear()
            await load(page, SECOND_ROOT, blocked)
            proxied_root = [h for h in tunneled if h.endswith("ya.ru")]
            print(f"root under the bypass mask: ya.ru through the proxy {proxied_root or 'none'}")
            results.append(("root matching a bypass mask (ya.ru)", f"through the proxy: {bool(proxied_root)}"))
            if not proxied_root:
                failures.append("a root matching the bypass mask did not go through the proxy")

            tab = await worker.evaluate("chrome.tabs.query({ active: true }).then((t) => t[0].id)")
            await load(page, ROOT, blocked, wait=3)
            on_root = await worker.evaluate("id => chrome.action.getBadgeText({ tabId: id })", tab)
            before = group_hosts(await worker.evaluate("chrome.storage.local.get(null)"), "wikipedia.org")
            await load(page, OUTSIDE, blocked, wait=3)
            outside = await worker.evaluate("id => chrome.action.getBadgeText({ tabId: id })", tab)
            after = group_hosts(await worker.evaluate("chrome.storage.local.get(null)"), "wikipedia.org")
            print(f"external link: badge {on_root!r} -> {outside!r}, group {len(before)} -> {len(after)}")
            results.append(("following an external link", f"badge {on_root!r} → {outside!r}, group unchanged: {before == after}"))
            if outside != "" or on_root == "" or before != after:
                failures.append(f"external link: badge {on_root!r} -> {outside!r}, group {len(before)} -> {len(after)}")

            await page.go_back(wait_until="load")
            await asyncio.sleep(3)
            back = await worker.evaluate("id => chrome.action.getBadgeText({ tabId: id })", tab)
            state = await control(worker).evaluate("id => rootpac({ type: 'getTabState', tabId: id })", tab)
            print(f"back through BFCache: badge {back!r}, state {state['mask']}")
            results.append(("back through BFCache", f"badge {back!r}, mask {state['mask']}"))
            if back == "" or state["mask"] != "wikipedia.org":
                failures.append(f"BFCache: badge {back!r}, state {state}")

            await worker.evaluate("globalThis.__mark = 1")
            cdp = await context.new_cdp_session(page)
            await cdp.send("ServiceWorker.enable")
            await cdp.send("ServiceWorker.stopAllWorkers")
            await cdp.detach()
            await asyncio.sleep(1)
            stopped = await load(page, ROOT, blocked)
            worker = await extension_worker(context)
            mark = await worker.evaluate("typeof globalThis.__mark")
            state = await control(worker).evaluate("id => rootpac({ type: 'getTabState', tabId: id })", tab)
            print(f"service worker restart: fresh {mark == 'undefined'}, blocked {stopped or 'none'}, state {state['mask']} {state['hostCount']}")
            results.append(("service worker stop", f"restarted: {mark == 'undefined'}, state restored: {state['mask'] == '*.wikipedia.org'}, blocked {len(stopped)}"))
            if mark != "undefined" or state["mask"] != "wikipedia.org" or stopped:
                failures.append(f"service worker restart: {mark}, {state}, blocked {stopped}")

            rules_before = await worker.evaluate("Promise.all([chrome.declarativeNetRequest.getDynamicRules(), chrome.declarativeNetRequest.getSessionRules()]).then(([d, s]) => d.length + s.length)")
            dropped = await control(worker).evaluate(
                "text => rootpac({ type: 'saveUserPac', text })",
                user_pac.replace(' || root(host, "ya.ru")', ""),
            )
            state = await worker.evaluate("chrome.storage.local.get(null)")
            rules_after = await worker.evaluate("Promise.all([chrome.declarativeNetRequest.getDynamicRules(), chrome.declarativeNetRequest.getSessionRules()]).then(([d, s]) => d.length + s.length)")
            pac = state["appliedPac"]
            print(f"root removed: ok {dropped['ok']}, group present {('group:*.ya.ru' in state)}, in PAC {'ya.ru' in pac}, rules {rules_before} -> {rules_after}")
            results.append(("removing root() from the User PAC", f"group removed: {'group:*.ya.ru' not in state}, gone from the PAC: {'ya.ru' not in pac}, rules {rules_before} → {rules_after}"))
            if not dropped["ok"] or "group:*.ya.ru" in state or "ya.ru" in pac or rules_after >= rules_before:
                failures.append(f"removing a root: {dropped}, rules {rules_before} -> {rules_after}")
            await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac)
        else:
            start = await worker.evaluate("chrome.proxy.settings.get({}).then((s) => ({ level: s.levelOfControl, mode: s.value.mode }))")
            for _ in range(100):
                level = await worker.evaluate("chrome.proxy.settings.get({}).then((s) => s.levelOfControl)")
                if level == "controlled_by_this_extension":
                    break
                await asyncio.sleep(0.1)
            print(f"restart: settings at startup {start}, after resync {level}")
            results.append(("proxy setting right after browser start", f"{start['level']}, mode {start['mode']}; after resync {level}"))
            tunneled.clear()
            stopped = await load(page, ROOT, blocked)
            hosts = group_hosts(await worker.evaluate("chrome.storage.local.get(null)"), "wikipedia.org")
            through = sorted({h for h in tunneled if h.endswith("wikipedia.org") or h.endswith("wikimedia.org")})
            print(f"after restart: blocked {stopped or 'none'}, through the proxy {len(through)} hosts, group {len(hosts)}")
            results.append(("browser restart", f"blocked {len(stopped)}, {len(through)} hosts through the proxy"))
            if stopped or not through:
                failures.append(f"after the restart: blocked {stopped}, proxied {through}")
        aggregated = [h for h in group_hosts(await worker.evaluate("chrome.storage.local.get(null)"), "wikipedia.org") if h.endswith("wikimedia.org")]
        print(f"aggregation on a real site: {aggregated}")
        if first:
            results.append(("subdomain aggregation (wikimedia.org)", f"{aggregated}"))
        settings = await worker.evaluate("chrome.proxy.settings.get({})")
        if not settings["value"]["pacScript"]["mandatory"]:
            failures.append("PAC is not mandatory")
    finally:
        await context.close()


async def main():
    port = serve()
    profile = tempfile.mkdtemp()
    logs = [str(Path(tempfile.mkdtemp()) / "netlog1.json"), str(Path(tempfile.mkdtemp()) / "netlog2.json")]
    failures = []
    results = []
    async with async_playwright() as playwright:
        await session(playwright, profile, port, logs[0], True, failures, results)
        await session(playwright, profile, port, logs[1], False, failures, results)
    domains = ["wikipedia.org", "wikimedia.org", "ya.ru"]
    for index, path in enumerate(logs, start=1):
        netlog_report(path, domains, failures, f"netlog session {index}", direct_ok=[BYPASS_HOST] if index == 1 else [])
    print()
    print("| Scenario | Result |")
    print("| --- | --- |")
    for name, verdict in results:
        print(f"| {name} | {verdict} |")
    print()
    print("RESULT:", "PASS" if not failures else "FAIL")
    for failure in failures:
        print("  -", failure)
    sys.exit(1 if failures else 0)


asyncio.run(main())
