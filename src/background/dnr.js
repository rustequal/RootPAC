function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function withoutDefaults({ priority, condition, ...rest }) {
  const { isUrlFilterCaseSensitive, ...filter } = condition ?? {};
  return {
    ...rest,
    ...(priority === undefined || priority === 1 ? {} : { priority }),
    ...(condition === undefined ? {} : { condition: isUrlFilterCaseSensitive === true ? condition : filter }),
  };
}

const fingerprint = (rule) => JSON.stringify(canonical(withoutDefaults(rule)));

function ruleSet(read, write) {
  let current = null;
  const load = async () => {
    current = new Map((await read()).map((rule) => [rule.id, fingerprint(rule)]));
  };
  return {
    load,
    matches(rules) {
      return current.size === rules.length && rules.every((rule) => current.get(rule.id) === fingerprint(rule));
    },
    async replace(rules) {
      if (current === null) await load();
      const desired = new Map(rules.map((rule) => [rule.id, fingerprint(rule)]));
      const removeRuleIds = [...current].filter(([id, print]) => desired.get(id) !== print).map(([id]) => id);
      const addRules = rules.filter((rule) => current.get(rule.id) !== desired.get(rule.id));
      if (removeRuleIds.length === 0 && addRules.length === 0) return false;
      await write({ removeRuleIds, addRules });
      current = desired;
      return true;
    },
  };
}

export function createDnr(api) {
  const dynamic = ruleSet(
    () => api.getDynamicRules(),
    (update) => api.updateDynamicRules(update),
  );
  const session = ruleSet(
    () => api.getSessionRules(),
    (update) => api.updateSessionRules(update),
  );
  return {
    async replace(rules) {
      const blocks = await dynamic.replace(rules.dynamic);
      const allows = await session.replace(rules.session);
      return blocks || allows;
    },
    async matches(rules) {
      await Promise.all([dynamic.load(), session.load()]);
      return dynamic.matches(rules.dynamic) && session.matches(rules.session);
    },
  };
}
