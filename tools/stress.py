import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke import control, extension_worker, wait_for_armed  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PSL_URL = "https://publicsuffix.org/list/public_suffix_list.dat"
ROOT_ADDRESS = "127.0.6.1"
ORIGIN_ADDRESS = "127.0.6.2"
# Hosts under ZONE merge into one record while ZONE is not a public suffix; the lists the stand serves add and drop it,
# so the record turns exact and back while the pages keep requesting its subdomains.
ZONE = "pz.test"
lock = threading.Lock()
direct = Counter()
through_proxy = Counter()


def serve(address, handler):
    server = ThreadingHTTPServer(address, handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def page(tab, generation, fresh, interval, lifetime):
    hosts = [f"n{index}.t{tab}g{generation}.test" for index in range(fresh)] + [f"u{index}.{side}.{ZONE}" for index, side in ((1, "a"), (2, "b"), (3, "c"))]
    script = f"""
const hosts = {json.dumps(hosts)};
let n = 0;
setInterval(() => {{ for (const host of hosts) fetch(`http://${{host}}:8080/p?${{n++}}`, {{ mode: "no-cors", cache: "no-store" }}).catch(() => 0); }}, {interval});
setTimeout(() => {{ location.href = "/stress?tab={tab}&g={generation + 1}"; }}, {lifetime});
"""
    return f"<!doctype html><html><body>stress {tab} {generation}<script>{script}</script></body></html>".encode()


class Origin(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        with lock:
            direct["(connection)"] += 1
        super().setup()

    def do_GET(self):
        with lock:
            direct[self.headers.get("Host", "?").split(":")[0]] += 1
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


def proxy_handler(options):
    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            host = self.path.split("//")[-1].split("/")[0].split(":")[0]
            with lock:
                through_proxy[host] += 1
            body, kind = b"", "text/plain"
            if host == "root.test" and "/stress?" in self.path:
                query = dict(item.split("=") for item in self.path.split("?", 1)[1].split("&"))
                body, kind = page(int(query["tab"]), int(query["g"]), options.fresh, options.interval, options.lifetime), "text/html"
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_CONNECT(self):
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    return Proxy


def user_pac(port, variant):
    extra = 'deny("*.nope.test");\n' if variant % 2 else ""
    return f'{extra}var PROXY = "PROXY 127.0.0.1:{port}";\n\nfunction FindProxyForURL(url, host) {{\n  if (root(host, "root.test")) return PROXY;\n  return "DIRECT";\n}}'


def public_suffix_list(serial):
    text = (ROOT / "vendor" / "public_suffix_list.dat").read_text(encoding="utf-8")
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S_UTC", time.gmtime(4102444800 + serial))
    text = text.replace("// VERSION: 2026-09-21_18-50-07_UTC", f"// VERSION: {stamp}")
    zone = f"{ZONE}\n" if serial % 2 else ""
    return text.replace("// ===END PRIVATE DOMAINS===", f"{zone}// ===END PRIVATE DOMAINS===")


async def every(seconds, stop, action):
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), seconds)
        except asyncio.TimeoutError:
            await action()


def churn(worker, port, options, stop, stats, served, timings):
    counter = {"serial": 0, "variant": 0}

    async def update_list():
        counter["serial"] += 1
        served["text"] = public_suffix_list(counter["serial"])
        started = time.monotonic()
        result = await control(worker).evaluate("rootpac({ type: 'updatePsl' })")
        timings["psl"].append(time.monotonic() - started)
        stats[f"psl {result.get('outcome')}"] += 1

    async def save_user_pac():
        counter["variant"] += 1
        started = time.monotonic()
        result = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac(port, counter["variant"]))
        timings["user PAC"].append(time.monotonic() - started)
        stats["user PAC saved" if result.get("ok") else "user PAC refused"] += 1

    async def remove_site():
        started = time.monotonic()
        result = await control(worker).evaluate(f"rootpac({{ type: 'removeSite', mask: 'root.test', site: '{ZONE}' }})")
        timings["remove site"].append(time.monotonic() - started)
        stats["site removed" if result.get("ok") else "site not removed"] += 1

    return [every(options.psl_every, stop, update_list), every(options.pac_every, stop, save_user_pac), every(options.remove_every, stop, remove_site)]


# The log keeps its last 5000 entries and the stand writes thousands (learning, pages): it is read as it grows.
READ_HELD_LOG = """after => new Promise((resolve, reject) => {
  const open = indexedDB.open("rootpac-log", 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const all = open.result.transaction("entries", "readonly").objectStore("entries").getAll(IDBKeyRange.lowerBound(after, true));
    all.onerror = () => reject(all.error);
    all.onsuccess = () => resolve(all.result);
  };
})"""


async def read_held_log(worker, events, seen):
    for entry in await worker.evaluate(READ_HELD_LOG, seen["id"]):
        seen["id"] = max(seen["id"], entry["id"])
        if entry["kind"] in ("routesHeld", "routesReleased"):
            events.append(entry)


# The log shows every narrowing: each route held is released later, with how long it was held (4.11, 6.5).
def held_log_report(events, stats):
    failures = []
    open_routes = set()
    reasons = Counter()
    after = []
    for event in events:
        names = {(route["root"], route["name"]) for route in event["routes"]}
        if event["count"] > len(event["routes"]):
            failures.append(f"the stand expects short lists, {event['count']} routes in one event")
        if event["kind"] == "routesHeld":
            open_routes |= names
        else:
            reasons[event["reason"]] += len(names)
            open_routes -= names
            after += [route["after"] for route in event["routes"] if "after" in route]
    held = sum(1 for event in events if event["kind"] == "routesHeld")
    print(f"log: {held} routesHeld, {len(events) - held} routesReleased, released {dict(reasons)}")
    if after:
        after.sort()
        print(f"log: held for median {after[len(after) // 2]:.0f} ms, p90 {after[int(len(after) * 0.9)]:.0f} ms, longest {after[-1]:.0f} ms")
    if held == 0 and (stats["site removed"] > 0 or stats["psl updated"] > 0):
        failures.append("the log shows no held routes although the PAC narrowed")
    if open_routes:
        failures.append(f"routes held in the log and never released: {sorted(open_routes)[:10]}")
    return failures


async def run(options):
    # Playwright routes a service worker's fetch (the list download) only with this switch.
    os.environ["PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS"] = "1"
    port = serve(("127.0.0.1", 0), proxy_handler(options)).server_address[1]
    serve((ORIGIN_ADDRESS, 8080), Origin)
    rules = [f"MAP root.test {ROOT_ADDRESS}", f"MAP *.test {ORIGIN_ADDRESS}"]
    netlog = options.netlog or str(Path(tempfile.mkdtemp()) / "stress-netlog.json")
    stats = Counter()
    timings = {"psl": [], "user PAC": [], "remove site": []}
    served = {"text": public_suffix_list(0)}
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            tempfile.mkdtemp(),
            channel="chromium",
            headless=True,
            args=[
                f"--disable-extensions-except={options.extension}",
                f"--load-extension={options.extension}",
                "--host-resolver-rules=" + ", ".join(rules),
                "--disable-features=LocalNetworkAccessChecks",
                f"--log-net-log={netlog}",
            ],
        )

        async def serve_list(route):
            await route.fulfill(status=200, body=served["text"], content_type="text/plain")

        await context.route(PSL_URL, serve_list)
        worker = await extension_worker(context)
        print("browser", await worker.evaluate("navigator.userAgent.match(/Chrome\\/[0-9]+/)[0]"))
        if options.log:
            await worker.evaluate("chrome.storage.local.set({ logEnabled: true })")
        saved = await control(worker).evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac(port, 0))
        if not saved["ok"] or not await wait_for_armed(worker):
            raise RuntimeError(f"saveUserPac: {saved}")
        pages = [await context.new_page() for _ in range(options.tabs)]
        for tab, tab_page in enumerate(pages):
            await tab_page.goto(f"http://root.test:8080/stress?tab={tab}&g=0")
        stop = asyncio.Event()
        churners = [asyncio.create_task(task) for task in churn(worker, port, options, stop, stats, served, timings)]
        started = time.monotonic()
        events, seen = [], {"id": 0}
        while time.monotonic() - started < options.duration:
            await asyncio.sleep(5)
            if options.log:
                await read_held_log(worker, events, seen)
            with lock:
                print(f"{int(time.monotonic() - started)} s: through the proxy {sum(through_proxy.values())}, direct {sum(direct.values())}, {dict(stats)}", flush=True)
        stop.set()
        await asyncio.gather(*churners)
        for tab_page in pages:
            await tab_page.close()
        # With the traffic over, the held routes drain: one more request moves the event stream past them (4.11).
        held = None
        probe = await context.new_page()
        for _ in range(40):
            await probe.goto("http://root.test:8080/stress?tab=9&g=0", wait_until="commit")
            await asyncio.sleep(0.5)
            held = (await worker.evaluate("chrome.storage.local.get('held')")).get("held")
            if held is None:
                break
        await probe.close()
        if options.log:
            await asyncio.sleep(1.5)  # the log writes in batches every 500 ms
            await read_held_log(worker, events, seen)
        else:
            events = None
        backup = await control(worker).evaluate("rootpac({ type: 'exportState' })")
        groups = backup["backup"]["groups"]
        installed = await control(worker).evaluate("rootpac({ type: 'getPsl' })")
        await context.close()
    backup_path = Path(netlog).with_suffix(".backup.json")
    backup_path.write_text(json.dumps(backup["backup"]), encoding="utf-8")
    records = sum(len(group["hosts"]) for group in groups.values())
    print(f"learned records {records}, installed list {installed['installed']['version']}, conflict {installed['conflict']}")
    print(f"requests through the proxy {sum(through_proxy.values())}, hosts {len(through_proxy)}; {dict(stats)}")
    for name, spent in timings.items():
        if spent:
            print(f"{name}: {len(spent)} transitions, median {sorted(spent)[len(spent) // 2]:.2f} s, longest {max(spent):.2f} s")
    check = subprocess.run([sys.executable, str(ROOT / "tools" / "check_netlog.py"), netlog, "--backup", str(backup_path), "--learned", ZONE], capture_output=True, text=True)
    verdict = check.stdout.strip().splitlines()
    print("netlog:", verdict[-1] if verdict else check.stderr.strip())
    print(f"netlog file {netlog}")
    failures = []
    print(f"held routes after the traffic: {held}")
    if direct:
        failures.append(f"direct connections to origins: {dict(direct)}")
    if held is not None:
        failures.append(f"held routes did not drain after the traffic: {held}")
    if check.returncode != 0:
        failures.append("netlog: " + "; ".join(line.strip() for line in verdict if line.startswith("  "))[:2000])
    if events is not None:
        failures += held_log_report(events, stats)
    if (options.psl_every < options.duration and stats["psl updated"] == 0) or (options.pac_every < options.duration and stats["user PAC saved"] == 0) or records == 0:
        failures.append(f"the stand did not exercise the transitions: {dict(stats)}, records {records}")
    print("RESULT:", "PASS" if not failures else "FAIL")
    for failure in failures:
        print("  - " + failure)
    return not failures


def main():
    parser = argparse.ArgumentParser(description="Heavy root traffic while hosts are learned, the User PAC is saved again and the public suffix list changes: no request may reach an origin directly.")
    parser.add_argument("extension", nargs="?", default=str(ROOT))
    parser.add_argument("--duration", type=int, default=90, help="seconds of traffic")
    parser.add_argument("--tabs", type=int, default=4)
    parser.add_argument("--fresh", type=int, default=8, help="new hosts a page requests")
    parser.add_argument("--interval", type=int, default=40, help="ms between rounds of requests of a page")
    parser.add_argument("--lifetime", type=int, default=2500, help="ms before a page moves on to new hosts")
    parser.add_argument("--psl-every", type=float, default=3.0, help="seconds between public suffix list updates")
    parser.add_argument("--pac-every", type=float, default=5.0, help="seconds between User PAC saves")
    parser.add_argument("--remove-every", type=float, default=9999, help=f"seconds between removals of the site {ZONE}, as Remove site in the viewer")
    parser.add_argument("--netlog")
    parser.add_argument("--log", action="store_true", help="record the diagnostic log and check its held and released routes")
    sys.exit(0 if asyncio.run(run(parser.parse_args())) else 1)


if __name__ == "__main__":
    main()
