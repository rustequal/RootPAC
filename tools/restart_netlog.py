import asyncio
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

from smoke import BYPASS_ORIGIN, EMBEDDER, ENTRY, EXTENSION, direct, open_root, serve, start_network, user_pac_for, wait_for_armed

POLICY_DIR = Path("/etc/opt/chrome_for_testing/policies/managed")
POLICY = POLICY_DIR / "rootpac-restart-netlog.json"
TOOLS = Path(__file__).resolve().parent


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def pack(chrome, work):
    source = work / "rootpac"
    shutil.copytree(EXTENSION, source, ignore=shutil.ignore_patterns("test", "tools", "docs", "__pycache__", "*.md"))
    subprocess.run([chrome, "--no-sandbox", "--headless", f"--pack-extension={source}"], check=True, capture_output=True)
    key = subprocess.run(["openssl", "rsa", "-in", str(work / "rootpac.pem"), "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout
    extension_id = "".join(chr(ord("a") + int(digit, 16)) for digit in hashlib.sha256(key).hexdigest()[:32])
    version = json.loads((source / "manifest.json").read_text())["version"]
    return extension_id, version


def install_policy(work, extension_id, version):
    port = serve(("127.0.0.1", 0), partial(Quiet, directory=str(work))).server_address[1]
    (work / "update.xml").write_text(
        "<?xml version='1.0' encoding='UTF-8'?>"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>"
        f"<app appid='{extension_id}'><updatecheck codebase='http://127.0.0.1:{port}/rootpac.crx' version='{version}' /></app>"
        "</gupdate>"
    )
    POLICY_DIR.mkdir(parents=True, exist_ok=True)
    POLICY.write_text(json.dumps({"ExtensionInstallForcelist": [f"{extension_id};http://127.0.0.1:{port}/update.xml"]}))


async def launch(playwright, chrome, profile, rules, extra):
    port_file = Path(profile) / "DevToolsActivePort"
    port_file.unlink(missing_ok=True)
    process = subprocess.Popen(
        [
            chrome,
            f"--user-data-dir={profile}",
            "--headless",
            "--no-sandbox",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--host-resolver-rules=" + ", ".join(rules),
            "--disable-features=LocalNetworkAccessChecks",
            "--unsafely-treat-insecure-origin-as-secure=http://root.test:8080",
            *extra,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(200):
        if port_file.exists() and port_file.read_text().strip():
            break
        await asyncio.sleep(0.05)
    port = port_file.read_text().split()[0]
    browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
    return process, browser, browser.contexts[0]


async def extension_page(browser, context):
    session = await browser.new_browser_cdp_session()
    for _ in range(300):
        targets = (await session.send("Target.getTargets"))["targetInfos"]
        entry = next((target["url"] for target in targets if target["type"] == "service_worker" and target["url"].endswith(ENTRY)), None)
        if entry is not None:
            page = await context.new_page()
            await page.goto(entry.replace(ENTRY, "/src/ui/viewer/viewer.html"))
            await page.evaluate("globalThis.rootpac = (message) => chrome.runtime.sendMessage(message)")
            return page
        await asyncio.sleep(0.1)
    raise RuntimeError("the installed extension did not start")


async def shut(process, browser):
    session = await browser.new_browser_cdp_session()
    try:
        await session.send("Browser.close")
    except Exception:
        pass
    process.wait(timeout=30)


async def describe(page):
    try:
        text = await page.evaluate("document.body ? document.body.innerText.slice(0, 20) : ''")
    except Exception as error:
        text = str(error).splitlines()[0][:60]
    return f"{page.url} -> {text!r}"


async def main():
    work = Path(tempfile.mkdtemp())
    profile = tempfile.mkdtemp()
    netlog = Path(sys.argv[2] if len(sys.argv) > 2 else work / "restart-netlog.json")
    failures = []
    async with async_playwright() as playwright:
        chrome = playwright.chromium.executable_path
        extension_id, version = pack(chrome, work)
        proxy_port, rules = start_network()
        install_policy(work, extension_id, version)
        try:
            process, browser, context = await launch(playwright, chrome, profile, rules, [])
            extension = await extension_page(browser, context)
            saved = await extension.evaluate("text => rootpac({ type: 'saveUserPac', text })", user_pac_for(proxy_port))
            if not saved["ok"] or not await wait_for_armed(extension):
                raise RuntimeError(f"session 1: {saved}")
            page = await context.new_page()
            for _ in range(3):
                await open_root(page)
                await asyncio.sleep(1)
            embedder = await context.new_page()
            await embedder.goto(f"http://{EMBEDDER}:8080/")
            cached = await context.new_page()
            for _ in range(2):
                await cached.goto("http://root.test:8080/cached")
                await asyncio.sleep(1.5)
            controlled = await cached.evaluate("navigator.serviceWorker.controller !== null")
            print(f"session 1: service worker of root.test controls /cached: {controlled}")
            if not controlled:
                failures.append("session 1: the root site service worker did not take control")
            backup = (await extension.evaluate("rootpac({ type: 'exportState' })"))["backup"]
            (work / "rootpac-backup.json").write_text(json.dumps(backup))
            print(f"session 1: installed {extension_id} {version} by policy, learned {sorted(backup['groups']['root.test']['hosts'])}")
            await asyncio.sleep(2)
            await shut(process, browser)

            contacted = len(direct)
            process, browser, context = await launch(playwright, chrome, profile, rules, ["--restore-last-session", f"--log-net-log={netlog}", "--net-log-capture-mode=Everything"])
            extension = await extension_page(browser, context)
            armed = await wait_for_armed(extension)
            await asyncio.sleep(5)
            level = await extension.evaluate("chrome.proxy.settings.get({}).then((s) => s.levelOfControl + ' ' + s.value.mode)")
            print(f"session 2: armed {armed}, proxy {level}")
            for tab in context.pages:
                if not tab.url.startswith("chrome-extension://"):
                    print("  restored", await describe(tab))
            state = "tabs => rootpac({ type: 'getTabState', tabId: tabs[0].id })"
            query = "chrome.tabs.query({ url: 'http://root.test/cached' })"
            before = await extension.evaluate(f"{query}.then(({state}))")
            print(f"session 2: restored /cached before reload {before}")
            if not before.get("incomplete") or before.get("loaded") or before.get("proxied"):
                failures.append(f"session 2: the restored service worker page is not marked incomplete: {before}")
            await extension.evaluate(f"{query}.then((tabs) => chrome.tabs.reload(tabs[0].id))")
            await asyncio.sleep(3)
            after = await extension.evaluate(f"{query}.then(({state}))")
            print(f"session 2: /cached after reload {after}")
            if after.get("incomplete") or after.get("loaded") != 1 or after.get("proxied") != 1:
                failures.append(f"session 2: the reloaded page is not complete with one proxied host: {after}")
            touched = [name for name in direct[contacted:] if name != BYPASS_ORIGIN]
            print("session 2 direct connections to origins:", touched or "none")
            if touched:
                failures.append(f"session 2: direct connections {touched}")
            await shut(process, browser)
        finally:
            POLICY.unlink(missing_ok=True)
    checked = subprocess.run([sys.executable, str(TOOLS / "check_netlog.py"), str(netlog), "--backup", str(work / "rootpac-backup.json")], capture_output=True, text=True)
    print(checked.stdout.strip())
    if checked.returncode != 0:
        failures.append("check_netlog.py found violations")
    print("NetLog:", netlog)
    print("RESULT:", "PASS" if not failures else "FAIL")
    for failure in failures:
        print("  - " + failure)


if __name__ == "__main__":
    asyncio.run(main())
