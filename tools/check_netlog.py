import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlsplit

GROUP_ID = re.compile(r"^(?:[a-z]+/)?([a-z]+)://\[?([^\]/ ]+?)\]?(?::\d+)? <(.*)>$")
DIRECT_JOBS = {"TCP_CONNECT_JOB", "SSL_CONNECT_JOB", "TRANSPORT_CONNECT_JOB"}
PUBLIC_SUFFIX_LIST = Path(__file__).resolve().parent.parent / "vendor" / "public_suffix_list.dat"


def public_suffix_test(path=PUBLIC_SUFFIX_LIST):
    rules, wildcards, exceptions = set(), set(), set()
    for line in path.read_text(encoding="utf-8").split("\n"):
        parts = line.strip().split()
        if not parts or parts[0].startswith("//"):
            continue
        rule = parts[0].lower()
        target, rule = (exceptions, rule[1:]) if rule.startswith("!") else (wildcards, rule[2:]) if rule.startswith("*.") else (rules, rule)
        target.add(rule if rule.isascii() else rule.encode("idna").decode())

    def suffix_length(labels):
        for start in range(len(labels)):
            name = ".".join(labels[start:])
            if name in exceptions:
                return len(labels) - start - 1
            if name in rules or (start + 1 < len(labels) and ".".join(labels[start + 1:]) in wildcards):
                return len(labels) - start
        return 1

    def is_public_suffix(name):
        labels = name.split(".")
        return all(labels) and suffix_length(labels) >= len(labels)

    return is_public_suffix


def covered(host, domains):
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def bypassed(host, masks):
    return any(host.endswith(mask[1:]) if mask.startswith("*.") else host == mask for mask in masks)


def site_host(site):
    return urlsplit(site).hostname if site.startswith(("http://", "https://")) else None


def load(path):
    decoded, _ = json.JSONDecoder().raw_decode(open(path, encoding="utf-8").read())
    return decoded


def configuration(arguments):
    roots, learned, bypass = set(arguments.root), set(arguments.learned), set(arguments.bypass)
    if arguments.backup is not None:
        backup = load(arguments.backup)
        for root, group in backup["groups"].items():
            roots.add(root)
            learned.update(group["hosts"])
        bypass.update(re.findall(r'\bbypass\(\s*"([^"]+)"\s*\)', backup["userPac"]))
    if not roots:
        sys.exit("no roots: pass --backup or --root")
    return roots, learned, bypass


def main():
    parser = argparse.ArgumentParser(description="Find direct connections a RootPAC profile must not make.")
    parser.add_argument("netlog")
    parser.add_argument("--backup", help="rootpac-backup.json exported from Options")
    parser.add_argument("--root", action="append", default=[])
    parser.add_argument("--learned", action="append", default=[])
    parser.add_argument("--bypass", action="append", default=[])
    arguments = parser.parse_args()
    roots, learned, bypass = configuration(arguments)
    is_public_suffix = public_suffix_test()
    exact = {host for host in learned if is_public_suffix(host)}
    covering = roots | (learned - exact)

    def protected(host):
        return host in exact or covered(host, covering)

    log = load(arguments.netlog)
    names = {value: key for key, value in log["constants"]["logEventTypes"].items()}
    sources = {value: key for key, value in log["constants"]["logSourceType"].items()}
    requests = {}
    bound = {}
    chains = {}
    jobs = {}
    for event in log["events"]:
        name = names[event["type"]]
        params = event.get("params", {})
        source = event["source"]["id"]
        kind = sources[event["source"]["type"]]
        if kind == "URL_REQUEST" and name == "URL_REQUEST_START_JOB" and "url" in params:
            requests[source] = (params.get("url", ""), params.get("network_isolation_key", ""), params.get("initiator", ""))
        elif kind == "URL_REQUEST" and name == "HTTP_STREAM_JOB_CONTROLLER_BOUND":
            bound[source] = params["source_dependency"]["id"]
        elif kind == "HTTP_STREAM_JOB_CONTROLLER" and name == "HTTP_STREAM_JOB_CONTROLLER" and "url" in params:
            chains.setdefault(source, [params["url"], None])
        elif kind == "HTTP_STREAM_JOB_CONTROLLER" and name == "HTTP_STREAM_JOB_CONTROLLER_PROXY_SERVER_RESOLVED":
            chains.setdefault(source, ["", None])[1] = params["proxy_chain"]
        elif kind in DIRECT_JOBS and name == "SOCKET_POOL_CONNECT_JOB_CREATED" and "group_id" in params:
            jobs[source] = params["group_id"]

    violations = []
    summary = defaultdict(lambda: defaultdict(int))
    for url, chain in chains.values():
        host = urlsplit(url).hostname or ""
        if chain is None or not protected(host):
            continue
        summary[host][chain] += 1
        if chain == "[direct://]":
            violations.append(f"protected host DIRECT: {url}")
    for source, (url, isolation, initiator) in requests.items():
        host = urlsplit(url).hostname or ""
        top = site_host(isolation.split(" ")[0]) if isolation else None
        origin = urlsplit(initiator).hostname if initiator.startswith(("http://", "https://")) else None
        in_context = (top is not None and covered(top, roots)) or (origin is not None and covered(origin, roots))
        chain = chains.get(bound.get(source), [None, None])[1]
        if in_context and chain == "[direct://]" and not bypassed(host, bypass):
            violations.append(f"root context DIRECT: {url} (top site {top}, initiator {origin})")
    for group in jobs.values():
        match = GROUP_ID.match(group)
        if match is None:
            continue
        host, isolation = match.group(2), match.group(3)
        top = site_host(isolation.split(" ")[0])
        if bypassed(host, bypass):
            continue
        if protected(host) or (top is not None and covered(top, roots)):
            violations.append(f"direct socket: {group}")

    for host in sorted(summary):
        print(host, dict(summary[host]))
    print(f"requests {len(requests)}, stream controllers {len(chains)}, direct connect jobs {len(jobs)}")
    if violations:
        print("VIOLATIONS:")
        for line in sorted(set(violations)):
            print("  " + line)
        sys.exit(1)
    print("violations: none")


if __name__ == "__main__":
    main()
