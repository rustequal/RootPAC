# RootPAC — User Guide

The extension routes a root site and every host its pages load through a proxy. In the root context, a host that has not been learned yet is blocked until the page is reloaded, so it never gets a chance to see your real IP. You write an ordinary PAC file (the User PAC); the extension builds a System PAC from it with the learned hosts added and installs it in the browser settings.

## 1. Three directives

The User PAC gets three functions on top of standard PAC. The extension extracts their calls from the text statically, so the syntax is strict.

| Directive | Where it goes | What it does | Learned? | Blocked in root context? |
| --- | --- | --- | --- | --- |
| `root(host, "domain")` | inside `FindProxyForURL` | declares the domain a root — the domain itself and all its subdomains; your PAC chooses the route for the root | — | no |
| `deny("mask")` | on its own line at the top level | the mask's domain and all its subdomains are never learned and are blocked when a root page requests them | no | yes |
| `bypass("mask")` | on its own line at the top level | hosts matching the mask always go direct, in every tab | no | no |

**`root`** is a predicate: "the host is this domain or one of its subdomains". It checks the host and at the same time declares the domain a root: the extension sees the call in the text and creates one group of learned hosts for the domain. `root(host, "youtube.com")` covers `youtube.com`, `www.youtube.com`, `m.youtube.com` and any other subdomain.

**`deny`** means "I never want this domain". Typical targets are analytics and ads. A `deny` mask applies to its whole domain: `deny("*.tracker.com")` and `deny("tracker.com")` both block `tracker.com` and every subdomain of it. In the root context the request is rejected and the host is not added to the group; if it was already there, it is removed. Outside the root context `deny` has no effect: your `FindProxyForURL` decides the route.

**`bypass`** means "this host must never go through the proxy". Typical targets are the local network, a bank, a national zone. Such a host is loaded directly even from a root page, and it is neither learned nor blocked. This is a deliberate trade-off: a bypass host sees your real IP, including when a root page requests it.

The difference in one line: `deny` is "don't let it through", `bypass` is "let it through, but not via the proxy".

### Resolution order

For every request the System PAC checks these conditions in order:

1. **`root` mask** — your `FindProxyForURL` is called and `DIRECT` is stripped from its answer; if no proxy is left, the PAC throws and the request is not sent.
2. **Learned host** — follows the rule of its root. This decision applies to the whole browser, not only to the root tab. A learned entry covers its subdomains; the exception is a public suffix such as `github.io` or `s3.amazonaws.com`: such an entry applies only to that exact host, so it does not pull every site in the zone into the proxy.
3. **`bypass` mask** — `DIRECT` without calling your PAC.
4. **Everything else** — your `FindProxyForURL` as is.

Root wins over bypass: with `bypass("*.ru")` and `root(host, "mail.ru")`, mail.ru itself goes through the proxy and the rest of `.ru` goes direct. The order of directives in the text does not matter; only the order of checks above does.

## 2. Common pitfalls

- **A root is always a whole domain.** There is no narrow "subdomains only" root: browser blocking (DNR) works on whole domains, and a root without its apex would leave navigation to `example.com` unprotected. `root(host, "*.example.com")` is a save error with a hint to write `root(host, "example.com")`.
- **Lowercase only.** `root(host, "Example.com")` is a save error, not an auto-correction.
- **A root mask is a domain** with at least two labels: `example.com`, `cdn.example.com`. A `deny` mask is `domain` or `*.domain`; both block the whole domain. A `bypass` mask is `domain`, `*.domain` or a single-label zone: `*.ru`, `ru`; here `*.` means "subdomains only".
- **A label is at most 63 characters, a name at most 253, and the last label is not a number.** `root(host, "1.2.3.4")` and `deny("cdn.2")` are errors: the browser reads such a name as an IP address, and the mask would never match a host.
- **A root cannot be under `localhost`**: Chrome never sends such names to a proxy.
- **`deny` cannot block the root itself**: `deny("example.com")` together with `root(host, "cdn.example.com")` is an error, otherwise the root site would open empty. `deny` on a subdomain of a root is allowed — that is how you block the site's own tracker.
- **Internationalized zones are written in punycode**, for example `*.xn--p1ai`.
- **`root`, `deny` and `bypass` cannot be redefined or passed around as values.** Only a direct call is allowed. `var f = root`, `typeof root`, `obj.method(root)` are rejected.
- **Reserved names**: `__user` and `__fuel`.
- **`deny` and `bypass` masks must not overlap** — otherwise it is unclear whether to block the host or let it go direct. Here `deny` counts as a whole domain: `deny("x.com")` overlaps `bypass("*.x.com")`. A `bypass` overlapping a `root` is allowed.
- **A proxy string for a root is only `SCHEME host[:port]`.** Schemes are `PROXY`, `HTTPS`, `SOCKS`, `SOCKS4`, `SOCKS5`; the host is a name, IPv4 or `[IPv6]`; the port is 1–65535. Chrome silently drops credentials in the string (`PROXY user:pass@host:port`), a URL scheme (`PROXY http://host:port`) and an out-of-range port, and connects directly, so the System PAC drops such entries itself. If no proxy is left in the probes run on save, it is a save error; if such a string only shows up in a rare branch of your PAC, the request fails instead of going direct.
- **Exactly one `FindProxyForURL`**, a plain function: not `async`, not a generator.
- **No hashbang.**

Any violation is rejected on save with a `line:column` position. The active configuration stays unchanged, so a bad edit cannot break a working proxy.

## 3. Building a User PAC for a hundred sites

A file with a hundred sites stays readable only as long as it has structure. A working layout has four blocks.

**Block 1 — denials and exceptions.** At the top, as one list: first `deny` for trackers, then `bypass` for zones that must never go through the proxy. These lists are shared by all sites; there is no need to repeat them per site.

**Block 2 — proxy constants.** One variable per exit. Meaningful names (`NL`, `DE`, `HOME`) are better than `PROXY1`: the line for a given site shows at a glance where it goes.

**Block 3 — sites grouped by topic.** Sections marked with comments (`// --- social ---`), one line per site inside a section: `root()` with the domain and a trailing comment saying why the site is here and which exit it uses. A hundred lines like that are easy to read and edit; a hundred sites in a single `if` with two hundred `||` are not.

**Block 4 — the default.** `return "DIRECT";` as the last line.

One line per site looks like this:

```javascript
if (root(host, "instagram.com")) return NL;   // personal account, needs a foreign exit
```

To add a site, add such a line. To remove a site, delete it: its group of learned hosts disappears from the System PAC by itself, and its blocking rules are removed too.

A few practical notes. The order of lines does not affect routing as long as masks do not overlap, so sort them however reads best. If two sites share a CDN, it is learned in only one group — the one whose page requested it first; routing is not affected, because both roots go through the proxy anyway. And do not declare a root on a domain already covered by `bypass` unless you know why: the root wins, and you get the proxy where you expected a direct connection.

### Template

```javascript
// --- trackers: never wanted, blocked on root pages ---
deny("*.google-analytics.com");
deny("*.doubleclick.net");
deny("*.scorecardresearch.com");

// --- always direct, never through the proxy ---
bypass("*.local");
bypass("*.ru");

// --- exits ---
var NL = "SOCKS5 10.1.4.1:9487";
var DE = "SOCKS5 10.1.4.2:9487";
var HOME = "PROXY 192.168.1.10:8080";

function FindProxyForURL(url, host) {
  // --- social ---
  if (root(host, "instagram.com")) return NL;      // personal account
  if (root(host, "x.com")) return NL;                      // reading only
  if (root(host, "reddit.com")) return DE;            // NL exit is rate limited here

  // --- media ---
  if (root(host, "youtube.com")) return NL;          // googlevideo is learned on first watch
  if (root(host, "twitch.tv")) return DE;

  // --- work ---
  if (root(host, "github.com")) return HOME;          // same exit as the office VPN
  if (root(host, "atlassian.net")) return HOME;

  // --- link shorteners: same exit as their destination ---
  if (root(host, "youtu.be")) return NL;                                            // youtube.com
  if (root(host, "t.co")) return NL;                                                // x.com
  if (root(host, "redd.it")) return DE;                                             // reddit.com

  // --- exception inside a bypassed zone ---
  if (root(host, "mail.ru")) return NL;                  // the rest of .ru stays direct

  return "DIRECT";
}
```

Keep comments in the PAC itself in English: this text goes into the System PAC and the browser settings as is.

### Link shorteners

`youtu.be`, `t.co`, `redd.it` and other social network stubs are separate domains, and each such line creates a new root with its own group. Their group almost always stays empty: the shortener returns a redirect, and the tab's top-level host changes to the target site before the page loads anything. In the viewer you will see an entry with `no root host yet` and zero hosts — that is expected.

You should still declare them as roots. Without `root()`, the first request to the shortener follows your PAC's default, that is, goes direct, and you hit its server with your real IP — exactly the request that reveals which link you are opening. You can write a plain condition like `if (host === "youtu.be") return NL;` instead: the host goes through the proxy and no group or rules are added. But then there is no blocking in the context of that tab, and if the shortener one day starts showing an interstitial page with ads or a cookie banner, its subresources go direct. There is no way to guess in advance which one will do that, so `root()` is the default.

An extra root is cheap: an empty group and one regex allow rule. There is a single blocking rule for all roots, and it does not grow with new masks. The DNR limit is 1000 regex rules for roots and bypass combined, so a hundred sites plus a dozen shorteners fit with room to spare.

Learning is shared between roots: allow rules for learned hosts are not tied to a root, and the System PAC looks up all groups at once. If a shortener does load a host already learned under the target site, that host is allowed and goes through the proxy without a separate learning cycle.

Three rules in practice. Give a shortener the same exit as its target site, otherwise the redirect crosses exits: the first request from one IP, the target page from another — an extra risk for sites with session pinning and anti-bot checks. A single line `root(host, "youtu.be")` covers both the shortener and its subdomains, should any appear. If the shortener's apex is a real site with content, like bit.ly, the same line makes it learn like any other root.

### Learning after an edit

A new root site is learned within one to three reloads: on the first one its third-party hosts are blocked and recorded in the group, on the second they already go through the proxy. The icon is amber at that point, and the popup shows the line `N new hosts blocked and learned` and a **Reload** button. This is normal operation, not an error.

## 4. Interface

**Popup** (click the icon). On a root tab it shows the root mask and counters since the last page load: how many hosts were loaded, how many went through the proxy, how many new ones were blocked for learning (with a **Reload** button) and how many hosts are in this root's group in total. All counters count only dynamic hosts: the root itself and other hosts under its mask are not included. On any other tab it shows `Not a root tab`. The **Options**, **System PAC** and **Log** buttons open the other pages.

**Options** is the User PAC editor. **Save** runs the checks: parsing, static analysis and a trial run in the sandbox; errors are listed as `line:column message`, and clicking an error moves the cursor there. **Revert** restores the saved text, **Cancel** aborts a check that takes too long. `Ctrl+S` saves from anywhere on the page, Tab inserts two spaces. Below are **Export** and **Import** for backups (the User PAC together with the learned groups), the **Record a diagnostic log** switch and a link to the System PAC viewer.

**Diagnostic log** (the **Log** button in the popup, or **Open the log** in Options). It records only while **Record a diagnostic log** is on; with it off the extension does no logging work. Recorded are: loads of root pages, new hosts blocked and queued for learning, hosts learned into a group, hosts a root page requested that are not learned (`deny`, `bypass`), every request that failed at the proxy — the host, the error, the route (root, learned in which group, `bypass` or the User PAC's own route), the tab and the page that requested it — other errors of requests from root pages, protection turning on and off, and changes made in Options and the viewer. At the top, **Proxy failures by host** sums the failures up: when every host fails at once the proxy itself is unreachable; when a few hosts keep failing while the rest load, the proxy cannot reach those hosts. Click a host to see its events. The events can be filtered by kind and text, exported as a text file and cleared. The last 5000 events are kept; they survive a browser restart. Times are local and in Chrome's own format, which follows the language of the Chrome interface (extensions cannot read the regional format of the OS); the page names the time zone.

**System PAC viewer** shows the generated PAC read-only with **Copy** and **Download** buttons, and the groups by root below it. Click a group to expand it: host, first seen, last seen and **Remove** for a single entry, **Clear group** for the whole group. The filter searches by host substring and expands the matching groups. At the bottom is a link to the User PAC editor.

**Icon.** Blue-grey — an ordinary tab. Green with a red badge — a root tab; the badge shows how many learned hosts went through the proxy on this page. Amber — new hosts were learned on this load, a reload is needed. Grey with `!` — the proxy is off: the extension is in safe mode or another extension has taken over the proxy setting.

**Turning it off.** There is deliberately no off switch in the interface: it would remove both the proxy and the blocking, opening direct connections with one accidental click. Disable the extension in `chrome://extensions`.

## 5. Troubleshooting

- **The root page does not open at all.** Most likely the proxy is unreachable: the PAC is installed with `mandatory: true`, and when the proxy fails the browser does not fall back to a direct connection but shows an error. This is protection, not a malfunction.
- **The site still does not work after several reloads.** Check the new hosts line in the popup: if it never goes away, the site keeps requesting new names. Look in the viewer — the host you need may be covered by `deny`.
- **A resource keeps going direct.** Check your `bypass` masks: one of them may cover its zone.
- **Grey icon with `!`.** Another extension has taken over the proxy setting, or the saved User PAC is invalid and the extension is in safe mode — in that case Options already shows the list of errors.
- **Pages fail with `net::ERR_SOCKS_CONNECTION_FAILED` or another proxy error.** Turn on **Record a diagnostic log** in Options, reproduce the failure and open the log: **Proxy failures by host** shows which hosts failed and how often.
- **You need to see what is actually applied.** The System PAC viewer shows the text currently installed in the browser, and you can save it with **Download**.

## 6. Where to keep the extension folder

RootPAC is installed as an unpacked extension: Chrome does not copy the files into its profile but reads them directly from the folder chosen in "Load unpacked". Whatever happens to that folder happens to the extension:

- **a file is changed** — the changed code runs after the extension is reloaded or the browser is restarted;
- **the folder is deleted, renamed or moved** — on the next start Chrome cannot load the extension, and without it neither its PAC nor its blocking is in effect, so root sites follow the browser's regular settings;
- **the folder is moved and the extension is loaded again** — the id of an unpacked extension depends on its path, so Chrome creates a new extension with empty storage, and the learned groups have to be restored with **Import**.

The state (User PAC, groups, blocking rules) is stored in the Chrome profile, not in the folder, so the folder only needs to be readable.

### Choosing a location

The folder should be permanent, local, and somewhere you do not work in:

| System | Recommended path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\RootPAC\rootpac` (usually `C:\Users\<name>\AppData\Local\RootPAC\rootpac`) |
| macOS | `~/Library/Application Support/RootPAC/rootpac` |
| Linux | `~/.local/share/rootpac` |

Not suitable:
- **Downloads and Desktop.** Other programs write there constantly, people clean them by hand, and Windows Storage Sense, if it is set to clean Downloads, deletes files that have not been opened for a while automatically.
- **Cloud-synced folders** (OneDrive, iCloud Drive, Dropbox, Google Drive). Sync may replace files with a version from another computer or offload them from the local disk.
- **Temporary folders**, and an unpacked archive sitting next to other downloads.

Choose the path once, before installing: all future updates happen in the same place (see "Updating" below).

### Write protection

After unpacking, remove write permission. It does not affect the extension: on Chromium 153 on Linux a full automated run, including a browser restart, passed from a read-only folder, and Chrome wrote nothing to it. On Windows and macOS, run the check at the end of this section.

**Windows** — two levels, the first is enough:

- The read-only attribute on all files (against accidental edits in an editor):
  ```
  attrib +R "%LOCALAPPDATA%\RootPAC\rootpac\*" /S /D
  ```
- Stricter — NTFS permissions: read-only for your account, no delete and no write:
  ```
  icacls "%LOCALAPPDATA%\RootPAC\rootpac" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)RX"
  ```

**macOS:**
```
chmod -R a-w ~/Library/Application\ Support/RootPAC/rootpac
```
Stricter — the immutable flag, which prevents deleting and renaming files even by their owner: `chflags -R uchg <path>`.

**Linux:**
```
chmod -R a-w ~/.local/share/rootpac
```

Check: open `chrome://extensions`, click "Reload" on RootPAC and make sure there are no errors and the icon is green on a root site.

### Updating

1. Close root tabs and click **Export** in Options.
2. Restore write permission:
   - Windows: `attrib -R "<path>\*" /S /D`, and after `icacls` — `icacls "<path>" /reset /T`;
   - macOS: `chflags -R nouchg <path>` (if you set it), then `chmod -R u+w <path>`;
   - Linux: `chmod -R u+w <path>`.
3. Replace the contents of the same folder with the files of the new version. Do not change the path.
4. Remove write permission again, as in the section above.
5. In `chrome://extensions`, click "Reload" on RootPAC.

Keep the archive of the current version separately. If the folder does get damaged, unpack it to the same path: the id stays the same, and the extension picks up its storage from the profile.
