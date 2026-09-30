import { routeCovers } from "../core/held.js";
import { hostFromUrl } from "../core/hosts.js";

// Requests on their way (4.11). A request is on its way from `onBeforeRequest` to the first event that comes only after
// Chrome chose its route: `onHeadersReceived`, `onBeforeRedirect`, `onCompleted` or `onErrorOccurred`. `onSendHeaders`
// does not mark it: it comes before the route is chosen (measured in Chrome 153). A held route is drained when no request
// under it is on its way and the event stream has passed the moment it was held: `webRequest` events arrive in the order
// they fire (measured), so an event stamped later proves that every earlier start has been counted.
export function createTraffic({ onDrained = () => undefined } = {}) {
  const flights = new Map();
  const hosts = new Map();
  const held = new Map();
  let latest = -Infinity;
  let waiting = Infinity;
  let notified = false;

  const keyOf = ({ mask, name, kind }) => `${kind} ${mask} ${name}`;

  const busy = (route) => {
    for (const host of hosts.keys()) {
      if (routeCovers(route, host)) return true;
    }
    return false;
  };

  const isDrained = (entry) => latest >= entry.since && (!entry.adopted || entry.seen) && !busy(entry.route);

  // One release at a time: the commit it starts brings the next `hold`.
  const review = () => {
    if (notified) return;
    for (const entry of held.values()) {
      if (isDrained(entry)) {
        notified = true;
        onDrained();
        return;
      }
    }
  };

  const stamp = (timeStamp) => {
    if (!(timeStamp > latest)) return;
    latest = timeStamp;
    if (latest >= waiting) {
      waiting = Infinity;
      review();
    }
  };

  return {
    start({ requestId, url, timeStamp }) {
      const host = hostFromUrl(url);
      if (host !== null && !flights.has(requestId)) {
        flights.set(requestId, host);
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
      }
      stamp(timeStamp);
    },

    end({ requestId, timeStamp }) {
      const host = flights.get(requestId);
      if (host !== undefined) {
        flights.delete(requestId);
        const left = hosts.get(host) - 1;
        if (left === 0) hosts.delete(host);
        else hosts.set(host, left);
      }
      stamp(timeStamp);
      if (host === undefined || held.size === 0) return;
      let under = false;
      for (const entry of held.values()) {
        if (!routeCovers(entry.route, host)) continue;
        under = true;
        if (entry.adopted) entry.seen = true;
      }
      if (under) review();
    },

    drained(route) {
      const entry = held.get(keyOf(route));
      return entry !== undefined && isDrained(entry);
    },

    // The routes held by the PAC in force, after every commit: a new one waits from `now`, a known one keeps its moment.
    hold(routes, now) {
      const next = new Map();
      for (const route of routes) {
        const key = keyOf(route);
        next.set(key, held.get(key) ?? { route, since: now, adopted: false, seen: false });
      }
      held.clear();
      waiting = Infinity;
      for (const [key, entry] of next) {
        held.set(key, entry);
        if (entry.since > latest) waiting = Math.min(waiting, entry.since);
      }
      notified = false;
      review();
    },

    // Routes an earlier service worker held: it counted requests this one never saw, so each waits for a request of
    // its own to finish before it can drain.
    adopt(routes, now) {
      for (const route of routes) held.set(keyOf(route), { route, since: now, adopted: true, seen: false });
      if (routes.length > 0) waiting = Math.min(waiting, now);
    },
  };
}
