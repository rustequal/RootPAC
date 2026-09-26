# RootPAC

[![test](https://github.com/rustequal/RootPAC/actions/workflows/test.yml/badge.svg)](https://github.com/rustequal/RootPAC/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Chrome extension (Manifest V3) that routes a whole site through your proxy — together with every third-party host its pages load: CDNs, APIs, video, fonts, analytics.

A regular PAC file only knows the domains you put in it. A site, however, pulls in dozens of other names, and those go out directly — with your real IP. RootPAC closes that gap: you declare a site a **root**, and the extension learns everything it loads and builds a **System PAC** on top of your own PAC.

The core guarantee: no request from a root's context reaches the target server directly. A host the extension does not know yet is blocked until the page is reloaded; by the next load it has been learned and goes through the proxy.

## How it works

1. You write an ordinary PAC file — the **User PAC** — and mark the sites you want with the `root()` directive.
2. When a root page requests an unknown host, the request is blocked (`declarativeNetRequest`) and the host is recorded in that root's group.
3. The extension builds the **System PAC**: your PAC plus the learned hosts, which follow the same route as their root. The PAC is installed with `mandatory: true`, so if the proxy is unreachable the connection does not fall back to direct.
4. After one to three reloads the site works entirely through the proxy.

Before it is applied, every User PAC goes through parsing, static analysis and a trial run in an isolated sandbox. If the text is invalid, the extension stays in safe mode and never opens direct connections.

## User PAC example

```js
deny("*.doubleclick.net");   // never load, block in root context
bypass("*.local");           // always direct, everywhere

var NL = "SOCKS5 10.1.4.1:9487";

function FindProxyForURL(url, host) {
  if (root(host, "youtube.com")) return NL;   // googlevideo.com etc. are learned
  if (root(host, "x.com")) return NL;
  return "DIRECT";
}
```

| Directive | What it does |
| --- | --- |
| `root(host, "domain")` | declares the domain and all its subdomains a root; your PAC sets the root's route, and learned hosts follow the same route |
| `deny("mask")` | the domain is never learned and is blocked when a root page requests it |
| `bypass("mask")` | the host always goes direct, in every tab |

The resolution order, syntax restrictions and a ready-made recipe for a hundred sites are in the [user guide](docs/USER-GUIDE.md).

## Installation

Requires **Chrome 145** or later.

1. Download the repository (or a release archive) and put it in a permanent local folder, for example `~/.local/share/rootpac` (Linux), `~/Library/Application Support/RootPAC/rootpac` (macOS) or `%LOCALAPPDATA%\RootPAC\rootpac` (Windows). Avoid Downloads, the Desktop and cloud-synced folders.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the folder that contains `manifest.json`.
3. Open the extension's **Options**, paste your User PAC and click **Save**.

Chrome reads an unpacked extension directly from that folder, and the extension id depends on the folder's path. So do not move the folder, and remove write permission from it after installing. How to update while keeping the learned groups (**Export** / **Import**) is described in [section 6 of the user guide](docs/USER-GUIDE.md#6-where-to-keep-the-extension-folder).

## Interface

- **Popup** — the state of the current tab: how many hosts were loaded, how many went through the proxy, how many new ones were blocked for learning (with a **Reload** button).
- **Options** — the User PAC editor with checks on save, backup export and import, and the **Record a diagnostic log** switch.
- **Diagnostic log** — off by default. When on, it records root page loads, new hosts blocked and learned, hosts left out of learning, every proxy failure with the host that failed and its route, request errors in root pages, protection state and configuration changes; proxy failures are also summed up by host. The last 5000 events are kept in the browser (IndexedDB) and can be exported. With the switch off, nothing is recorded.
- **System PAC viewer** — the applied PAC, read-only, and the learned groups by root; single hosts and whole groups can be removed.
- **Icon**: blue-grey — an ordinary tab; green with a badge — a root tab; amber — new hosts were learned, reload needed; grey with `!` — the proxy is not applied (safe mode, or another extension has taken over the proxy setting).

## Development

Requires Node.js 22 or later. No dependencies.

Rules:

- **Push only to `main`.** Do not create new branches: every change is committed and pushed straight to `main`.
- **Always deliver a ZIP archive.** Every change ends with a ZIP of the extension (`rootpac-<version>.zip` with a single `rootpac/` folder inside), ready for **Load unpacked**. It is built from the committed tree: `git archive --format=zip --prefix=rootpac/ -o rootpac-<version>.zip HEAD`.

```sh
npm test
```

The unit tests (`node --test`) cover the core: User PAC analysis, System PAC generation, host grouping, DNR rules, the Public Suffix List and backups.

`tools/` holds extra checks:

| Tool | Purpose | Usage |
| --- | --- | --- |
| `tools/smoke.py` | end-to-end check in a real Chromium: local proxy and origins, learning, blocking, counters, restart. Needs Python 3 and [Playwright](https://playwright.dev/python/) | `python3 tools/smoke.py [extension-folder]` |
| `tools/fuzz_groups.mjs` | fuzzes host grouping, the System PAC and DNR rules with hostile hosts and masks; no browser | `node tools/fuzz_groups.mjs [seeds runs steps]` |
| `tools/check_netlog.py` | finds direct connections that must not happen, in a NetLog recorded at `chrome://net-export`; the backup comes from **Export** in Options | `python3 tools/check_netlog.py netlog.json --backup rootpac-backup.json` |
| `tools/make_icons.py` | rasterizes the PNG icons from `icons/icon.svg` (needs Playwright) | `python3 tools/make_icons.py` |

### Layout

```
manifest.json        extension manifest (version matches package.json)
src/core/            logic without Chrome APIs: analysis, PAC build, groups, rules, PSL
src/background/      service worker: storage, proxy, DNR, learning, badge, messages
src/sandbox/         sandbox for the User PAC trial run
src/offscreen/       offscreen document bridging to the sandbox
src/ui/              popup, options, System PAC viewer, diagnostic log
vendor/              acorn, Chromium's PAC library, Public Suffix List
test/                unit tests and fixtures
tools/               smoke test, fuzzer, NetLog check, icon generator
docs/USER-GUIDE.md   user guide
```

## Known limitations

- `preconnect` and `preload` from an Early Hints (`103`) response are invisible to DNR. Such connections are covered only by the route in your User PAC.
- A `bypass` host sees your real IP, even when a root page requests it. This is a deliberate trade-off.
- There is no off switch in the interface: one click would remove both the proxy and the blocking. Disable the extension in `chrome://extensions`.

## License

[MIT](LICENSE).

Third-party code:

- [acorn](https://github.com/acornjs/acorn) — MIT, see `vendor/acorn.LICENSE`.
- Chromium's PAC function library (`pac_js_library.h`) — BSD, see `vendor/pac-library.LICENSE`.
- [Public Suffix List](https://publicsuffix.org/) — MPL 2.0.
