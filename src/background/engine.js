import { buildRules, closedPolicy, intersectPolicies, policyOf } from "../core/rules.js";

const configured = (state) => state.enabled && state.appliedPac !== null;

export function createEngine({ store, proxy, dnr, session, now = Date.now }) {
  let effective = null;
  let armed = null;
  let openedAt = null;

  const install = async (policy) => {
    await dnr.replace(buildRules(policy));
    effective = policy;
  };

  const arm = async (value, since = null) => {
    if (armed === value) return;
    armed = value;
    openedAt = value ? (since ?? now()) : null;
    await session.set({ armed, openedAt });
  };

  const settle = async (state) => {
    const target = policyOf(state, store.psl);
    await install(intersectPolicies(effective, target));
    const control = configured(state) ? await proxy.apply(state.appliedPac) : await proxy.clear();
    await install(control.armed ? target : closedPolicy(target));
    await arm(control.armed);
    return control;
  };

  const check = async (state) => {
    if (configured(state)) {
      const control = await proxy.control(state.appliedPac);
      const target = policyOf(state, store.psl);
      if (control.armed && (await dnr.matches(buildRules(target)))) {
        effective = target;
        const { openedAt: since } = await session.get(["openedAt"]);
        await arm(true, since);
        return control;
      }
    }
    effective = null;
    return settle(state);
  };

  const recheck = async (state) => {
    if (!configured(state)) return null;
    const control = await proxy.control(state.appliedPac);
    if (control.armed === armed) return control;
    if (control.armed) return settle(state);
    await install(closedPolicy(policyOf(state, store.psl)));
    await arm(false);
    return control;
  };

  return {
    get armed() {
      return armed === true;
    },
    blockedBeforeOpen: (time) => armed !== true || time < openedAt,
    async commit(next) {
      const prev = store.state;
      await store.commit(next);
      try {
        return await settle(next);
      } catch (error) {
        await store
          .commit(prev)
          .then(() => settle(prev))
          .catch(() => undefined);
        throw error;
      }
    },
    check: () => store.run(check),
    recheck: () => store.run(recheck),
  };
}
