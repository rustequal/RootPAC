import argparse
import asyncio
import json
import statistics
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

from smoke import control, extension_worker, wait_for_armed

ROOT_URL = "http://root.test:8080/"
OTHER_URL = "http://page.other:8080/"
ROOTS = 100
HOSTS_PER_ROOT = 30
LEARNED = [f"img{k}.s{k}.net" for k in range(30)]
ROOT_PAGE = (
    "<html><body>"
    + "".join(f'<img src="http://{host}:8080/i{j}.png">' for host in LEARNED for j in range(2))
    + "".join(f'<img src="http://static.root.test:8080/r{j}.png">' for j in range(10))
    + "</body></html>"
).encode()
OTHER_PAGE = ("<html><body>" + "".join(f'<img src="http://x{k}.other:8080/i{j}.png">' for k in range(30) for j in range(2)) + "</body></html>").encode()
RESOLVER_RULES = ["MAP *.other 127.0.6.3", "MAP other 127.0.6.3"]
PAC_CASES = [
    ["root", "https://www.site50.com/x", "www.site50.com"],
    ["learned", "https://h3.cdn50x3.net/a.js", "h3.cdn50x3.net"],
    ["other", "https://static.example.org/a.png", "static.example.org"],
    ["bypass", "https://img.mail.ru/a.png", "img.mail.ru"],
]
PAC_BENCH = """
(function () {
  var cases = %s;
  var report = "";
  for (var c = 0; c < cases.length; c++) {
    for (var i = 0; i < 2000; i++) FindProxyForURL(cases[c][1], cases[c][2]);
    var started = Date.now();
    for (var k = 0; k < 20000; k++) FindProxyForURL(cases[c][1], cases[c][2]);
    report += (report === "" ? "" : " ") + cases[c][0] + "=" + ((Date.now() - started) / 20).toFixed(2);
  }
  alert("RootPAC perf " + report);
})();
"""
COUNTERS = """() => {
  const counts = globalThis.__perf = { setIcon: 0, setBadgeText: 0, sessionSet: 0, sessionBytes: 0 };
  const wrap = (target, name, count) => {
    const original = target[name].bind(target);
    target[name] = (...args) => {
      count(...args);
      return original(...args);
    };
  };
  wrap(chrome.action, "setIcon", () => counts.setIcon++);
  wrap(chrome.action, "setBadgeText", () => counts.setBadgeText++);
  wrap(chrome.storage.session, "set", (items) => {
    counts.sessionSet++;
    counts.sessionBytes += JSON.stringify(items).length;
  });
}"""
IMPORT = """async ([roots, perRoot, learned]) => {
  const { backup } = await rootpac({ type: "exportState" });
  backup.groups["root.test"] = { rootHost: "root.test", hosts: Object.fromEntries(learned.map((host) => [host, 1])) };
  for (let i = 0; i < roots; i++) {
    const hosts = {};
    for (let k = 0; k < perRoot; k++) hosts[`h${k}.cdn${i}x${k}.net`] = 1;
    backup.groups[`site${i}.com`] = { rootHost: `www.site${i}.com`, hosts };
  }
  return rootpac({ type: "importState", backup });
}"""


def handler(pages, page_type="text/html"):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            body = pages.get(self.path, b"ok")
            self.send_response(200)
            self.send_header("Content-Type", page_type if self.path in pages else "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass


def serve(address, handler_class):
    server = QuietServer(address, handler_class)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def user_pac(proxy_port):
    lines = [
        'deny("*.google-analytics.com");',
        'deny("*.doubleclick.net");',
        'bypass("*.local");',
        'bypass("*.ru");',
        f'var LOCAL = "PROXY 127.0.0.1:{proxy_port}";',
        'var NL = "SOCKS5 10.1.4.1:9487";',
        'var DE = "SOCKS5 10.1.4.2:9487";',
        "function FindProxyForURL(url, host) {",
        *(f'  if (root(host, "site{i}.com")) return {"NL" if i % 2 else "DE"};' for i in range(ROOTS)),
        '  if (root(host, "root.test")) return LOCAL;',
        '  return "DIRECT";',
        "}",
    ]
    return "\n".join(lines)


def plain_pac(proxy_port):
    helpers = 'function root(h, d) { return h === d || (h.length > d.length && h.endsWith("." + d)); }\nfunction deny() {}\nfunction bypass() {}\n'
    learned = '  if (root(host, "root.test")) return LOCAL;\n' + "".join(f'  if (root(host, "{host}")) return LOCAL;\n' for host in LEARNED)
    return helpers + user_pac(proxy_port).replace('  if (root(host, "root.test")) return LOCAL;\n', learned)


def summary(times):
    return f"median {statistics.median(times):.0f} ms (min {min(times):.0f}, max {max(times):.0f})"


async def timed_loads(page, url, count):
    times = []
    for _ in range(count):
        await page.goto(url, wait_until="load")
        times.append(await page.evaluate("performance.getEntriesByType('navigation')[0].loadEventEnd"))
    return times


def pac_alerts(path):
    text = Path(path).read_text()
    trimmed = text.rstrip()
    log, _ = json.JSONDecoder().raw_decode(trimmed if trimmed.endswith("}") else trimmed.rstrip(",") + "]}")
    names = {value: key for key, value in log["constants"]["logEventTypes"].items()}
    return [event["params"]["message"] for event in log["events"] if names.get(event["type"]) == "PAC_JAVASCRIPT_ALERT"]


async def pac_cost(playwright, pac_text):
    pac_port = serve(("127.0.0.1", 0), handler({"/": pac_text.encode()}, "application/x-ns-proxy-autoconfig"))
    netlog = Path(tempfile.mkdtemp()) / "pac.json"
    context = await playwright.chromium.launch_persistent_context(
        tempfile.mkdtemp(),
        channel="chromium",
        headless=True,
        args=[f"--proxy-pac-url=http://127.0.0.1:{pac_port}/", f"--log-net-log={netlog}", "--net-log-capture-mode=Everything"],
    )
    page = await context.new_page()
    try:
        await page.goto("http://127.0.0.1:1/", timeout=15000)
    except Exception:
        pass
    await asyncio.sleep(1)
    await context.close()
    reports = [message for message in pac_alerts(netlog) if message.startswith("RootPAC perf ")]
    if not reports:
        raise RuntimeError("the PAC benchmark reported nothing")
    return reports[-1].removeprefix("RootPAC perf ")


async def measure_extension(playwright, extension, proxy_port, loads):
    context = await playwright.chromium.launch_persistent_context(
        tempfile.mkdtemp(),
        channel="chromium",
        headless=True,
        args=[
            f"--disable-extensions-except={extension}",
            f"--load-extension={extension}",
            "--host-resolver-rules=" + ", ".join(RESOLVER_RULES),
            "--disable-features=LocalNetworkAccessChecks",
        ],
    )
    try:
        worker = await extension_worker(context)
        saved = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac(proxy_port))
        if not saved["ok"]:
            raise RuntimeError(f"saveUserPac: {saved}")
        imported = await control(worker).evaluate(IMPORT, [ROOTS, HOSTS_PER_ROOT, LEARNED])
        if not imported["ok"]:
            raise RuntimeError(f"importState: {imported}")
        if not await wait_for_armed(worker):
            raise RuntimeError("the extension did not take the proxy settings")
        page = await context.new_page()
        for _ in range(2):
            await page.goto(ROOT_URL, wait_until="load")
            await asyncio.sleep(1)
        tab = await worker.evaluate("chrome.tabs.query({}).then((tabs) => tabs.find((tab) => (tab.url || '').startsWith('http://root.test')).id)")
        state = await control(worker).evaluate("id => rootpac({ type: 'getTabState', tabId: id })", tab)
        if state["newHosts"] != 0 or state["incomplete"] or state["proxied"] != len(LEARNED):
            raise RuntimeError(f"the root tab is not trained: {state}")
        await worker.evaluate(COUNTERS)
        results = {}
        for name, url in (("root", ROOT_URL), ("other", OTHER_URL)):
            await timed_loads(page, url, 2)
            await asyncio.sleep(1)
            before = await worker.evaluate("({ ...globalThis.__perf })")
            times = await timed_loads(page, url, loads)
            await asyncio.sleep(1.5)
            after = await worker.evaluate("({ ...globalThis.__perf })")
            results[name] = (times, {key: round((after[key] - before[key]) / loads, 1) for key in after})
        pac = (await worker.evaluate("chrome.proxy.settings.get({})"))["value"]["pacScript"]["data"]
        return results, pac
    finally:
        await context.close()


async def measure_plain(playwright, proxy_port, loads):
    pac_port = serve(("127.0.0.1", 0), handler({"/": plain_pac(proxy_port).encode()}, "application/x-ns-proxy-autoconfig"))
    context = await playwright.chromium.launch_persistent_context(
        tempfile.mkdtemp(),
        channel="chromium",
        headless=True,
        args=[f"--proxy-pac-url=http://127.0.0.1:{pac_port}/", "--host-resolver-rules=" + ", ".join(RESOLVER_RULES), "--disable-features=LocalNetworkAccessChecks"],
    )
    try:
        page = await context.new_page()
        results = {}
        for name, url in (("root", ROOT_URL), ("other", OTHER_URL)):
            await timed_loads(page, url, 2)
            results[name] = await timed_loads(page, url, loads)
        return results
    finally:
        await context.close()


async def main():
    parser = argparse.ArgumentParser(description="RootPAC page load and PAC cost in Chromium")
    parser.add_argument("extension", nargs="?", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--loads", type=int, default=12)
    parser.add_argument("--baseline", action="store_true", help="also measure the same User PAC without the extension")
    args = parser.parse_args()
    proxy_port = serve(("127.0.0.1", 0), handler({ROOT_URL: ROOT_PAGE}))
    serve(("127.0.6.3", 8080), handler({"/": OTHER_PAGE}))
    bench = PAC_BENCH % json.dumps(PAC_CASES)
    async with async_playwright() as playwright:
        results, system_pac = await measure_extension(playwright, args.extension, proxy_port, args.loads)
        print(f"extension {args.extension}")
        print(f"  trained root page: {summary(results['root'][0])}; per load {results['root'][1]}")
        print(f"  other page:        {summary(results['other'][0])}; per load {results['other'][1]}")
        print(f"  System PAC in the Chromium PAC engine, us per request: {await pac_cost(playwright, system_pac + bench)}")
        if args.baseline:
            plain = await measure_plain(playwright, proxy_port, args.loads)
            print("baseline without the extension")
            print(f"  root page:  {summary(plain['root'])}")
            print(f"  other page: {summary(plain['other'])}")
            print(f"  User PAC in the Chromium PAC engine, us per request: {await pac_cost(playwright, plain_pac(proxy_port) + bench)}")


if __name__ == "__main__":
    asyncio.run(main())
