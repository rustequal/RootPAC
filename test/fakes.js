export class FakeArea {
  constructor(items = {}) {
    this.items = structuredClone(items);
    this.calls = [];
  }

  async get(keys) {
    this.calls.push(["get", keys]);
    if (keys === null) return structuredClone(this.items);
    const list = Array.isArray(keys) ? keys : [keys];
    return structuredClone(Object.fromEntries(list.filter((key) => Object.hasOwn(this.items, key)).map((key) => [key, this.items[key]])));
  }

  async set(items) {
    this.calls.push(["set", Object.keys(items).sort()]);
    Object.assign(this.items, structuredClone(items));
  }

  async remove(keys) {
    this.calls.push(["remove", [...keys].sort()]);
    for (const key of keys) delete this.items[key];
  }

  writes() {
    return this.calls.filter(([op]) => op !== "get");
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class Journal {
  constructor() {
    this.entries = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.gate = null;
    this.failures = new Map();
  }

  async enter(name, detail) {
    this.entries.push([name, detail]);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate !== null) await this.gate.promise;
      const failure = this.failures.get(name);
      if (typeof failure === "function") {
        const error = failure(detail);
        if (error !== null) throw error;
      } else if (failure !== undefined) {
        this.failures.delete(name);
        throw failure;
      }
    } finally {
      this.inFlight--;
    }
  }

  names() {
    return this.entries.map(([name]) => name);
  }

  clear() {
    this.entries.length = 0;
  }
}

class FakeSetting {
  constructor(journal, name, level) {
    this.journal = journal;
    this.name = name;
    this.level = level;
    this.value = null;
    this.incognito = null;
  }

  async set(details) {
    await this.journal.enter(`${this.name}.set`, details);
    if (this.level === "controlled_by_other_extensions") return;
    this.value = details.value;
    if (this.level === "controllable_by_this_extension") this.level = "controlled_by_this_extension";
    this.onChange?.();
  }

  async clear(details) {
    await this.journal.enter(`${this.name}.clear`, details);
    if (this.level === "controlled_by_other_extensions") return;
    this.value = null;
    if (this.level === "controlled_by_this_extension") this.level = "controllable_by_this_extension";
    this.onChange?.();
  }

  async get({ incognito }) {
    if (incognito && this.incognito !== null) return { levelOfControl: this.incognito.level, value: this.incognito.value };
    return { levelOfControl: this.level, value: this.value };
  }
}

export class FakeBrowser {
  constructor(journal = new Journal(), level = "controllable_by_this_extension") {
    this.journal = journal;
    this.snapshots = [];
    this.proxy = { settings: new FakeSetting(journal, "proxy", level) };
    this.privacy = {
      network: {
        networkPredictionEnabled: new FakeSetting(journal, "prediction", level),
        webRTCIPHandlingPolicy: new FakeSetting(journal, "webrtc", level),
      },
    };
    this.incognitoAllowed = false;
    this.extension = { isAllowedIncognitoAccess: async () => this.incognitoAllowed };
    this.rules = new Map();
    this.sessionRules = new Map();
    const self = this;
    this.proxy.settings.onChange = () => self.snapshot();
    const ruleSet = (rules, name) => ({
      async get() {
        return [...rules.values()].map((rule) => structuredClone(rule));
      },
      async update({ removeRuleIds = [], addRules = [] }) {
        await journal.enter(name, { removeRuleIds, addRules });
        for (const id of removeRuleIds) rules.delete(id);
        for (const rule of addRules) {
          if (rules.has(rule.id)) throw new Error(`Duplicate rule id ${rule.id}`);
          rules.set(rule.id, structuredClone(rule));
        }
        self.snapshot();
      },
    });
    const dynamic = ruleSet(this.rules, "dnr.update");
    const session = ruleSet(this.sessionRules, "dnr.session");
    this.dnr = {
      getDynamicRules: dynamic.get,
      updateDynamicRules: dynamic.update,
      getSessionRules: session.get,
      updateSessionRules: session.update,
    };
  }

  allRules() {
    return [...this.rules.values(), ...this.sessionRules.values()].map((rule) => structuredClone(rule));
  }

  snapshot() {
    this.snapshots.push({ pac: this.pac(), rules: this.allRules() });
  }

  restart() {
    this.sessionRules.clear();
  }

  takeOver(level = "controlled_by_other_extensions") {
    for (const setting of [this.proxy.settings, this.privacy.network.networkPredictionEnabled, this.privacy.network.webRTCIPHandlingPolicy]) setting.level = level;
  }

  pac() {
    return this.proxy.settings.value?.pacScript?.data ?? null;
  }

  ruleIds() {
    return [...this.rules.keys(), ...this.sessionRules.keys()].sort((a, b) => a - b);
  }
}
