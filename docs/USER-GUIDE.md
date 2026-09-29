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
2. **Learned host** — follows the rule of the root that owns its site (see [Shared sites and proxy conflicts](#shared-sites-and-proxy-conflicts)). This decision applies to the whole browser, not only to the root tab. A learned entry covers its subdomains; the exception is a public suffix such as `github.io` or `s3.amazonaws.com`: such an entry applies only to that exact host, so it does not pull every site in the zone into the proxy.
3. **`bypass` mask** — `DIRECT` without calling your PAC.
4. **Everything else** — your `FindProxyForURL` as is.

Root wins over bypass: with `bypass("*.ru")` and `root(host, "mail.ru")`, mail.ru itself goes through the proxy and the rest of `.ru` goes direct. The order of directives in the text does not matter; only the order of checks above does.

## 2. Common pitfalls

- **A root is always a whole domain.** There is no narrow "subdomains only" root: browser blocking (DNR) works on whole domains, and a root without its apex would leave navigation to `example.com` unprotected. `root(host, "*.example.com")` is a save error with a hint to write `root(host, "example.com")`.
- **Lowercase only.** `root(host, "Example.com")` is a save error, not an auto-correction.
- **A root mask is a domain** with at least two labels: `example.com`, `cdn.example.com`. A `deny` mask is `domain` or `*.domain`; both block the whole domain. A `bypass` mask is `domain`, `*.domain` or a single-label zone: `*.ru`, `ru`; here `*.` means "subdomains only".
- **A label is at most 63 characters, a name at most 253, and the last label is not a number.** `root(host, "1.2.3.4")` and `deny("cdn.2")` are errors: the browser reads such a name as an IP address, and the mask would never match a host.
- **A root cannot be under `localhost`**: Chrome never sends such names to a proxy.
- **One site, one root.** A site is a registrable domain: `instagram.com`, `bbc.co.uk`, `user.github.io`. Two roots that overlap (`instagram.com` and `www.instagram.com`) or share a site (`mail.google.com` and `docs.google.com`) are a save error, and so is a root on a public suffix such as `github.io`. A service sees every host of its site as one user, so a site must never reach it through two proxies.
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

A few practical notes. Roots never overlap, so the order of lines does not affect routing: sort them however reads best. If two sites share a CDN, each of them learns it into its own group; with one proxy for all roots, as in the template below, that is all there is to it. With several proxies, read the next section. And do not declare a root on a domain already covered by `bypass` unless you know why: the root wins, and you get the proxy where you expected a direct connection.

### Shared sites and proxy conflicts

A PAC sees only the host of a request, never the tab that makes it. So a host has one route for the whole browser, however many roots need it. RootPAC decides the route per **site** (registrable domain): every learned host of a site goes through one proxy, because the service behind the site would otherwise see you from two addresses. Take two roots on two proxies that both load `fbcdn.net`:

```js
if (root(host, "facebook.com")) return PROXY1;
if (root(host, "instagram.com")) return PROXY2;
```

Each site has an **owner** root. A root owns its own site: `instagram.com` owns `instagram.com`. Any other site goes to the first root that learns one of its hosts, say `instagram.com` for `fbcdn.net`, and keeps that owner: a root that learns the site later does not take it. Every root still learns the hosts it needs itself, so `facebook.com` learns `fbcdn.net` into its own group too, but the site goes through PROXY2. For `facebook.com` that would mean its pages talking to `fbcdn.net` through the other proxy, so the extension blocks the site in `facebook.com` pages instead. That is a **proxy conflict**: the icon turns amber with `!`, the popup names the host, both roots and both proxies, the System PAC viewer marks the host in the root's group, and the diagnostic log records a **Proxy conflict** error. A reload does not help. The same holds for another root's own domain: a `facebook.com` page may load `www.instagram.com` only while both roots use the same proxy.

Which proxy a root uses is found by a trial run of your User PAC, on every save and whenever a root learns its first host. Until it is known the root's shared sites are blocked for it, and the page asks for a reload. Two roots whose PAC gives the same answer share their sites freely.

The System PAC viewer shows both sides: in the owner's group the route of the host reads `own proxy · blocked for facebook.com`; in the other group it is red, `blocked here · via instagram.com · PROXY2`.

A conflict cannot disappear while both roots need the site on different proxies; you choose which root gets it. Give both roots the same proxy, or press **Route here**: in the popup of the blocked root's tab it takes the sites of every host the page is blocked from and reloads the page; in the System PAC viewer it is next to the host in the group of the root that should get it. **Route here** hands over the whole site: every host of it goes through that root's proxy, the other roots keep their hosts learned and are blocked from them now. It works for a root's own site too: **Route here** on `instagram.com` in a `facebook.com` page sends all of `instagram.com` through PROXY1, and `instagram.com` pages are then closed, until you press **Route here** for `instagram.com` again (the viewer shows `site routed by facebook.com` with the button). The owners go into backups.

Removing a root from the User PAC takes its sites with it: every root forgets the hosts of those sites, and the first root that needs one again learns it and owns the site. Declaring a root takes its site back from whoever owned it.

A request belongs to the root of the tab's page, whatever frame makes it: a `facebook.com` frame embedded in an `instagram.com` page learns and loads its hosts as `instagram.com`, so a root learns only from its own pages. Only a frame or a worker of a root outside root pages, say an `instagram.com` embed on a news site, works as that root.

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

Learning is per root: allow rules for learned hosts are tied to their root, while the System PAC looks up all groups at once. If a shortener does load a host already learned under the target site, the shortener learns it too, with one extra reload.

Three rules in practice. Give a shortener the same exit as its target site, otherwise the redirect crosses exits: the first request from one IP, the target page from another — an extra risk for sites with session pinning and anti-bot checks. A single line `root(host, "youtu.be")` covers both the shortener and its subdomains, should any appear. If the shortener's apex is a real site with content, like bit.ly, the same line makes it learn like any other root.

### Learning after an edit

A new root site is learned within one to three reloads: on the first one its third-party hosts are blocked and recorded in the group, on the second they already go through the proxy. The icon is amber at that point, and the popup shows the line `N new hosts blocked and learned` and a **Reload** button. This is normal operation, not an error.

## 4. Interface

**Popup** (click the icon). On a root tab it shows the root mask and counters since the last page load: how many hosts were loaded, how many went through the proxy, how many new ones were blocked for learning, how many a proxy conflict blocks, and how many hosts this root knows in total, itself included; a **Reload** button appears when a reload would help. Proxy conflicts are listed by the root whose proxy carries the hosts. When the messages would not fit, the popup shortens them to a line or two; hover a message to read it in full. The counters include the page itself, the root's other hosts and learned hosts; the hosts of roots and learned hosts count as routed through the proxy. On any other tab it shows `Not a root tab`. The **Options**, **System PAC** and **Log** buttons open the other pages.

**Options** is the User PAC editor. **Save** runs the checks: parsing, static analysis and a trial run in the sandbox; errors are listed as `line:column message`, and clicking an error moves the cursor there. **Revert** restores the saved text, **Cancel** aborts a check that takes too long. `Ctrl+S` saves from anywhere on the page, Tab inserts two spaces. Below are **Export** and **Import** for backups (the User PAC together with the learned groups), the **Record a diagnostic log** switch and a link to the System PAC viewer.

**Diagnostic log** (the **Log** button in the popup, or **Open the log** in Options). It records only while **Record a diagnostic log** is on; with it off the extension does no logging work. Recorded are: loads of root pages, new hosts blocked and queued for learning, hosts learned into a group, hosts a root page requested that are not learned (`deny`, `bypass`), proxy conflicts between roots and the proxy each root was checked to use, every request that failed at the proxy — the host, the error, the route (root, learned in which group, `bypass` or the User PAC's own route), the tab and the page that requested it — other errors of requests from root pages, protection turning on and off, and changes made in Options and the viewer. At the top, **Proxy failures by host** sums the failures up: when every host fails at once the proxy itself is unreachable; when a few hosts keep failing while the rest load, the proxy cannot reach those hosts. Click a host to see its events. The events can be filtered by kind and text, exported as a text file and cleared. The last 5000 events are kept; they survive a browser restart. The filter kinds are **Errors**, **Learning** (new hosts blocked, learned or left out of learning), **Pages** (loads of root pages) and **State and configuration**. Times are local and in Chrome's own format, which follows the language of the Chrome interface (extensions cannot read the regional format of the OS); an exported log names the time zone in its first line.

**System PAC viewer** shows the generated PAC read-only with **Copy** and **Download** buttons, and the groups by root below it. Each group shows its root host and the proxy the User PAC gives it. Click a group to expand it: a row per site, with its route, **Route here** and **Remove** for the whole site, and under it the learned hosts of that site with their times and **Remove** for a single host; **Clear group** clears the whole group. The first row is the root's own site; if another root routes it, it has **Route here** to take it back. The route is `own proxy` (this root owns the site), `same proxy as` the root that owns the site, or `blocked here` in red with that root and its proxy — a proxy conflict, with a **Route here** button that hands the whole site to this root. On the owner's side the route reads `own proxy` in amber with the roots the site is blocked for. A root whose own site another root routes shows `site routed by` that root in its summary, with **Route here** to take it back. The filter searches by host substring and expands the matching groups. At the bottom is a link to the User PAC editor.

**Icon.** Blue-grey — an ordinary tab. Green with a red badge — a root tab; the badge shows how many learned hosts went through the proxy on this page. Amber — new hosts were learned on this load, a reload is needed. Amber with `!` — a proxy conflict or a proxy failure on this page; the popup says which. Grey with `!` — the proxy is off: the extension is in safe mode or another extension has taken over the proxy setting.

**Turning it off.** There is deliberately no off switch in the interface: it would remove both the proxy and the blocking, opening direct connections with one accidental click. Disable the extension in `chrome://extensions`.

## 5. Troubleshooting

- **The root page does not open at all.** Most likely the proxy is unreachable: the PAC is installed with `mandatory: true`, and when the proxy fails the browser does not fall back to a direct connection but shows an error. This is protection, not a malfunction.
- **The site still does not work after several reloads.** Check the new hosts line in the popup: if it never goes away, the site keeps requesting new names. Look in the viewer — the host you need may be covered by `deny`.
- **Amber icon with `!` and a proxy conflict in the popup.** Two roots on different proxies need the same site, and the site goes through the other root's proxy, so it is blocked for this one. See [Shared sites and proxy conflicts](#shared-sites-and-proxy-conflicts).
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
