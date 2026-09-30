import { systemPacOf } from "../core/build.js";
import { droppedRoutes, heldOf, heldRoutes, pacRoutes, sameHeld } from "../core/held.js";
import { buildRules, closedPolicy, intersectPolicies, policyOf } from "../core/rules.js";
import { NO_LOG } from "./log.js";

const configured = (state) => state.enabled && state.appliedPac !== null;

// Without requests to count (unit tests of other parts), nothing is on its way and no route is held.
export const NO_TRAFFIC = Object.freeze({ drained: () => true, hold() {} });

export function createEngine({ store, proxy, dnr, session, traffic = NO_TRAFFIC, now = Date.now, log = NO_LOG }) {
  // The policy of the DNR rules in force and the routes of the PAC in force.
  let effective = null;
  let routes = [];
  let armed = null;
  let openedAt = null;

  const install = async (policy) => {
    await dnr.replace(buildRules(policy));
    effective = policy;
  };

  const arm = async (value, since = null) => {
    if (armed === value) return;
    if (log.on) log.add("protection", { armed: value });
    armed = value;
    openedAt = value ? (since ?? now()) : null;
    await session.set({ armed, openedAt });
  };

  const settle = async (state) => {
    const target = policyOf(state, store.psl);
    await install(intersectPolicies(effective, target));
    const control = configured(state) ? await proxy.apply(state.appliedPac) : await proxy.clear();
    routes = configured(state) ? pacRoutes(state, store.psl) : [];
    await install(control.armed ? target : closedPolicy(target));
    await arm(control.armed);
    return control;
  };

  // A new PAC never drops a route a request may still be on its way to (4.11): the routes of the PAC in force that the
  // next one drops stay in it, held, until the requests to them are drained; the DNR rules narrow at once. With the
  // proxy off nothing goes through it to hold; in safe mode the PAC is not rebuilt, and keeps what it holds.
  const withHeld = (next) => {
    if (next.userPacErrors !== null || next.appliedPac === null) return next;
    const held = configured(next) ? heldOf(droppedRoutes(routes, next, store.psl).filter((route) => !traffic.drained(route))) : null;
    return sameHeld(held, next.held) ? next : { ...next, held, appliedPac: systemPacOf({ ...next, held }, store.psl) };
  };

  // The held routes the traffic may release: only those a later commit can take out of the PAC.
  const releasable = (state) => (configured(state) && state.userPacErrors === null ? heldRoutes(state.held) : []);

  const check = async (state) => {
    if (configured(state)) {
      const control = await proxy.control(state.appliedPac);
      const target = policyOf(state, store.psl);
      if (control.armed && (await dnr.matches(buildRules(target)))) {
        effective = target;
        routes = pacRoutes(state, store.psl);
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
    async commit(proposed) {
      const prev = store.state;
      const next = withHeld(proposed);
      await store.commit(next);
      try {
        const control = await settle(next);
        traffic.hold(releasable(next), now());
        return control;
      } catch (error) {
        if (log.on) log.add("applyError", { message: error instanceof Error ? error.message : String(error) });
        await store
          .commit(prev)
          .then(() => settle(prev))
          .then(() => traffic.hold(releasable(prev), now()))
          .catch(() => undefined);
        throw error;
      }
    },
    check: () => store.run(check),
    recheck: () => store.run(recheck),
  };
}
