import asyncio
import base64
import hashlib
import json
import select
import socket
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

from smoke import EXTENSION, control, extension_worker, wait_for_armed

WORK = Path(tempfile.mkdtemp())
CERT, KEY = WORK / "cert.pem", WORK / "key.pem"
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(KEY), "-out", str(CERT), "-days", "2", "-subj", "/CN=root.test", "-addext", "subjectAltName=DNS:root.test,DNS:report.test"], check=True, capture_output=True)
PUBLIC = subprocess.run(["openssl", "x509", "-in", str(CERT), "-pubkey", "-noout"], check=True, capture_output=True).stdout
DER = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "der"], input=PUBLIC, check=True, capture_output=True).stdout
SPKI = base64.b64encode(hashlib.sha256(DER).digest()).decode()
MAP = {"root.test": "127.0.0.2", "report.test": "127.0.0.5"}
log = []
PAGE = b'<html><body>root<script>var x = 1;</script><img src="/missing.png"></body></html>'
HEADERS = {
    "Report-To": json.dumps({"group": "default", "max_age": 86400, "endpoints": [{"url": "https://report.test:8443/r"}]}),
    "NEL": json.dumps({"report_to": "default", "max_age": 86400, "success_fraction": 1.0, "failure_fraction": 1.0}),
    "Content-Security-Policy": "script-src 'none'; report-to default",
}

def origin(name):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def handle_one(self, body, kind, extra):
            log.append((name, self.command, self.path, "proxy" if self.client_address[0] == "127.0.0.9" else "DIRECT"))
            self.send_response(200 if self.path != "/missing.png" else 404)
            for k, v in extra.items(): self.send_header(k, v)
            self.send_header("Content-Type", kind); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        def do_GET(self): self.handle_one(PAGE if name == "root.test" else b"ok", "text/html", HEADERS if name == "root.test" else {})
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(length)
            try: kinds = sorted({r.get("type") for r in json.loads(body)})
            except Exception: kinds = body[:80]
            log.append(("report types", kinds, self.headers.get("Origin"), ""))
            self.handle_one(b"", "text/plain", {})
        def do_OPTIONS(self):
            log.append((name, "OPTIONS", self.path, "proxy" if self.client_address[0] == "127.0.0.9" else "DIRECT"))
            self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Methods", "POST"); self.send_header("Access-Control-Allow-Headers", "content-type"); self.send_header("Content-Length", "0"); self.end_headers()
        def log_message(self, *a): pass
    server = ThreadingHTTPServer((MAP[name], 8443), H)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(CERT, KEY)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()

class Tunnel(BaseHTTPRequestHandler):
    def do_CONNECT(self):
        host, port = self.path.split(":")
        log.append(("proxy", "CONNECT", self.path, ""))
        upstream = socket.socket(); upstream.bind(("127.0.0.9", 0)); upstream.connect((MAP.get(host, host), int(port)))
        self.send_response(200); self.end_headers()
        sockets = [self.connection, upstream]
        while True:
            ready, _, _ = select.select(sockets, [], [], 5)
            if not ready: break
            for s in ready:
                data = s.recv(65536)
                if not data: return
                (upstream if s is self.connection else self.connection).sendall(data)
    def log_message(self, *a): pass

async def main():
    origin("root.test"); origin("report.test")
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Tunnel); threading.Thread(target=proxy.serve_forever, daemon=True).start()
    port = proxy.server_address[1]
    profile = tempfile.mkdtemp()
    base = ["--host-resolver-rules=MAP root.test 127.0.0.2, MAP report.test 127.0.0.5", f"--ignore-certificate-errors-spki-list={SPKI}", "--short-reporting-delay", "--disable-features=LocalNetworkAccessChecks"]
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(profile, channel="chromium", headless=True, args=base)
        page = await ctx.new_page(); await page.goto("https://root.test:8443/"); await asyncio.sleep(6)
        seeded = [entry for entry in log if entry[0] == "report types"]
        print("session A without RootPAC, reports:", seeded); log.clear()
        await ctx.close()
        ctx = await p.chromium.launch_persistent_context(profile, channel="chromium", headless=True, args=[f"--disable-extensions-except={EXTENSION}", f"--load-extension={EXTENSION}", *base])
        w = await extension_worker(ctx)
        pac = f'function FindProxyForURL(url, host) {{\n  if (root(host, "root.test")) return "PROXY 127.0.0.1:{port}";\n  return "DIRECT";\n}}\n'
        saved = await control(w).evaluate("t => rootpac({ type: 'saveUserPac', text: t })", pac)
        print("save", saved["ok"], "armed", await wait_for_armed(w)); log.clear()
        await w.evaluate("""() => { globalThis.__seen = []; chrome.webRequest.onHeadersReceived.addListener((d) => { if (d.url.includes('root.test')) __seen.push(['headers', d.type, d.url, (d.responseHeaders || []).map((h) => h.name.toLowerCase()).filter((n) => ['report-to', 'nel', 'content-security-policy'].includes(n)).join(',')]); }, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']); for (const e of ['onBeforeRequest', 'onErrorOccurred', 'onCompleted']) chrome.webRequest[e].addListener((d) => { if (d.url.includes('report.test')) __seen.push([e, d.type, d.tabId, d.initiator, d.error || '']); }, { urls: ['<all_urls>'] }); }""")
        page = await ctx.new_page()
        for _ in range(2):
            await page.goto("https://root.test:8443/"); await asyncio.sleep(2)
        await asyncio.sleep(8)
        groups = await w.evaluate("chrome.storage.local.get('group:root.test')")
        learned = sorted(groups["group:root.test"]["hosts"])
        reports = [entry for entry in log if entry[0] == "report types"]
        direct = [entry for entry in log if entry[3] == "DIRECT"]
        print("session B with RootPAC: learned", learned, "| reports", reports, "| direct", direct or "none")
        failures = []
        if not seeded:
            failures.append("session A did not seed a Report-To group")
        if "report.test" not in learned:
            failures.append("the report endpoint was not learned")
        if not reports:
            failures.append("no report was sent in session B, the scenario did not run")
        if direct:
            failures.append(f"direct connections in session B: {direct}")
        print("RESULT:", "PASS" if not failures else "FAIL")
        for failure in failures:
            print("  - " + failure)
        await ctx.close()
if __name__ == "__main__":
    asyncio.run(main())
