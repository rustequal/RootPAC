import { rootOf } from "../core/hosts.js";

const MAX_COUNT = 99;
const BACKGROUND = "#e5484d";
const TEXT_COLOR = "#ffffff";
const ICONS = ["active", "pending", "idle", "off"];
const SIZES = [16, 32];
const FIELDS = ["icon", "text"];
const OFF = Object.freeze({ icon: "off", text: "!" });
const IDLE = Object.freeze({ icon: "idle", text: "" });
const PROXY_FAILED = Object.freeze({ icon: "pending", text: "!" });
const UNKNOWN = Symbol("unknown");

export async function decodeIcon(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Icon ${path} is unavailable: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

export function createBadge({ action, runtime, tabs, engine, store, learner, decode }) {
  const setIcon = (details) =>
    new Promise((resolve, reject) => {
      action.setIcon(details, () => {
        const error = runtime.lastError;
        if (error === undefined) resolve();
        else reject(new Error(error.message));
      });
    });

  let images = null;
  const loadImages = () => {
    images ??= Promise.all(
      ICONS.map(async (name) => [name, Object.fromEntries(await Promise.all(SIZES.map(async (size) => [size, await decode(`/icons/${name}-${size}.png`)])))]),
    ).then(Object.fromEntries, (error) => {
      images = null;
      throw error;
    });
    return images;
  };

  const shared = { icon: UNKNOWN, text: UNKNOWN };
  const own = new Map();

  const sharedState = () => {
    const { enabled, analysis, userPacErrors } = store.state;
    return !enabled || analysis === null || userPacErrors !== null || !engine.armed ? OFF : IDLE;
  };

  const stateOf = (tabId, common) => {
    if (common === OFF) return OFF;
    const host = learner.tabHost(tabId);
    if (host === null || rootOf(host, store.state.analysis.roots) === null) return IDLE;
    if (learner.proxyError(tabId) !== null) return PROXY_FAILED;
    const count = learner.proxied(tabId);
    const blocked = learner.newHosts(tabId) > 0 || learner.pending(tabId) > 0 || learner.incomplete(tabId);
    const icon = blocked ? "pending" : learner.loading(tabId) ? "idle" : "active";
    return { icon, text: count === 0 ? "" : count > MAX_COUNT ? `${MAX_COUNT}+` : String(count) };
  };

  const write = (target, field, value, icons) =>
    field === "icon" ? setIcon({ ...target, imageData: icons[value] }) : action.setBadgeText({ ...target, text: value });

  const syncShared = (common, icons) =>
    FIELDS.filter((field) => shared[field] !== common[field]).map((field) => {
      shared[field] = common[field];
      return write({}, field, common[field], icons).catch(() => {
        shared[field] = UNKNOWN;
      });
    });

  const syncTab = (tabId, common, force, icons) => {
    const wanted = stateOf(tabId, common);
    const values = own.get(tabId) ?? {};
    const writes = [];
    for (const field of FIELDS) {
      const shown = Object.hasOwn(values, field) ? values[field] : shared[field];
      if (wanted[field] === shown && (!force || wanted[field] === shared[field])) continue;
      values[field] = wanted[field];
      own.set(tabId, values);
      writes.push(
        write({ tabId }, field, wanted[field], icons).catch(() => {
          values[field] = UNKNOWN;
        }),
      );
    }
    return writes;
  };

  const sync = async (tabIds, force) => {
    const icons = await loadImages();
    const common = sharedState();
    await Promise.all([...syncShared(common, icons), ...tabIds.flatMap((tabId) => syncTab(tabId, common, force, icons))]);
  };

  return {
    update: (tabId, force = false) => sync([tabId], force),

    async refresh() {
      const open = new Set((await tabs.query({})).map(({ id }) => id));
      for (const tabId of own.keys()) {
        if (!open.has(tabId)) own.delete(tabId);
      }
      await sync([...open], false);
    },

    async start() {
      await Promise.all([action.setBadgeBackgroundColor({ color: BACKGROUND }), action.setBadgeTextColor({ color: TEXT_COLOR })]);
      await this.refresh();
    },
  };
}
