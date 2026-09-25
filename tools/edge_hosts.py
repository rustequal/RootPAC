import asyncio
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import smoke
from playwright.async_api import async_playwright
from smoke import EXTENSION, control, direct, extension_worker, origin_handler, proxied_all, serve, start_network, wait_for_armed

LOOPBACK = []
SECOND_PROXY = []
DOTS = 200000
STALL_LIMIT = 1.0


class Loopback(BaseHTTPRequestHandler):
    def setup(self):
        LOOPBACK.append(self.client_address[0])
        super().setup()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


class SecondProxy(smoke.Proxy):
    def do_GET(self):
        SECOND_PROXY.append(self.path)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


smoke.PAGE = (
    b'<html><body>root<img src="http://x.localhost:8081/a.png"><img src="http://github.io:8080/p.png">'
    b'<img src="http://a_b.zone.byp:8080/u.png"></body></html>'
)


def user_pac(first, second):
    return (
        'bypass("*.byp");\n'
        f'var P1 = "PROXY 127.0.0.1:{first}";\nvar P2 = "PROXY 127.0.0.1:{second}";\n'
        "function FindProxyForURL(url, host) {\n"
        '  if (root(host, "root.test")) return P1;\n'
        '  if (root(host, "site.github.io")) return P2;\n'
        '  return "DIRECT";\n'
        "}"
    )


async def main():
    first, rules = start_network()
    serve(("127.0.0.1", 8081), Loopback)
    second = serve(("127.0.0.1", 0), SecondProxy).server_address[1]
    for address, name in (("127.0.5.1", "github.io"), ("127.0.5.2", "someone.github.io"), ("127.0.5.3", "site.github.io"), ("127.0.3.2", "a_b.zone.byp")):
        serve((address, 8080), origin_handler(name))
        rules.append(f"MAP {name} {address}")
    failures = []
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            tempfile.mkdtemp(),
            channel="chromium",
            headless=True,
            args=[f"--disable-extensions-except={EXTENSION}", f"--load-extension={EXTENSION}", "--host-resolver-rules=" + ", ".join(rules), "--disable-features=LocalNetworkAccessChecks"],
        )
        worker = await extension_worker(context)
        saved = await control(worker).evaluate("t => rootpac({ type: 'saveUserPac', text: t })", user_pac(first, second))
        if not saved["ok"] or not await wait_for_armed(worker):
            failures.append(f"saveUserPac: {saved}")
        page = await context.new_page()
        for _ in range(3):
            await page.goto("http://root.test:8080/")
            await page.wait_for_timeout(1000)
        hosts = (await control(worker).evaluate("rootpac({ type: 'exportState' })"))["backup"]["groups"]["root.test"]["hosts"]
        print(f"learned: {sorted(hosts)}")
        if LOOPBACK:
            failures.append(f"root page reached loopback directly {len(LOOPBACK)} times")
        if "x.localhost" in hosts:
            failures.append("x.localhost was learned")
        if "github.io" not in hosts:
            failures.append("github.io was not learned")
        if "a_b.zone.byp" not in direct or "a_b.zone.byp" in hosts:
            failures.append("a bypass host with an underscore did not load directly from the root page")
        direct.clear()
        other = await context.new_page()
        await other.goto("http://someone.github.io:8080/")
        await other.goto("http://site.github.io:8080/")
        if "someone.github.io" not in direct or any("someone.github.io" in path for path in proxied_all):
            failures.append("an exact public suffix record took over another site of its zone")
        if not any("site.github.io" in path for path in SECOND_PROXY) or any("site.github.io" in path for path in proxied_all):
            failures.append("root site.github.io did not go through its own proxy")
        if "site.github.io" in direct:
            failures.append("root site.github.io connected directly")
        await other.goto(f"http://{smoke.EMBEDDER}:8080/")
        started = time.monotonic()
        waited = await other.evaluate(
            "n => new Promise((done) => { const t = performance.now(); const image = new Image(); image.onerror = image.onload = () => done(performance.now() - t); image.src = 'http://a' + '.'.repeat(n) + 'b.test/x.png'; })",
            DOTS,
        )
        await control(worker).evaluate("() => rootpac({ type: 'getTabState', tabId: 1 })")
        stalled = time.monotonic() - started
        print(f"a host with {DOTS} dots: request settled in {waited / 1000:.2f} s, service worker answered after {stalled:.2f} s")
        if stalled > STALL_LIMIT:
            failures.append(f"a host with {DOTS} dots stalled the browser for {stalled:.2f} s")
        await context.close()
    for failure in failures:
        print(f"  - {failure}")
    print("RESULT: " + ("FAIL" if failures else "PASS"))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
