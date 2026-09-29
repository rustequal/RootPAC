import { proxiesOf, rootHostOf, unchecked } from "../core/routes.js";
import { probePlan, trialAnswers, trialErrors } from "../core/trial.js";
import { NO_LOG } from "./log.js";

const RETRY_MS = 2000;
const MAX_RETRIES = 3;

// Asks the System PAC, in the sandbox, which proxy each root's rootHost goes through. A root gets its rootHost when
// it learns its first host, and until its answer is known every record it shares with another root stays blocked
// for it (core/routes.js), so the check runs as soon as a rootHost appears.
export function createResolver({ store, engine, checker, log = NO_LOG, setTimer = setTimeout }) {
  let running = false;
  let again = false;
  let retries = 0;

  const ready = (state) => state.enabled && state.appliedPac !== null && state.analysis !== null && state.userPacErrors === null;

  const resolve = async () => {
    const state = store.state;
    if (!ready(state)) return false;
    const masks = unchecked(state);
    if (masks.length === 0) return false;
    const hosts = [...new Set(masks.map((mask) => rootHostOf(mask, state.groups)))];
    const { request, shifts } = probePlan(state.appliedPac, hosts);
    const outcome = await checker.probe(request);
    const [error] = trialErrors(outcome, { systemPac: state.appliedPac, userPac: state.userPac, shifts });
    if (error !== undefined) throw new Error(error.line === null ? error.message : `${error.message} (User PAC line ${error.line})`);
    const answers = trialAnswers(outcome);
    return store.run(async (current) => {
      if (current.userPac !== state.userPac || !ready(current)) return true;
      const found = proxiesOf(current.groups, answers) ?? {};
      const proxies = { ...current.proxies };
      const changed = {};
      for (const [mask, item] of Object.entries(found)) {
        if (proxies[mask]?.host === item.host && proxies[mask]?.answer === item.answer) continue;
        proxies[mask] = item;
        changed[mask] = item.answer;
      }
      if (Object.keys(changed).length === 0) return unchecked(current).length > 0;
      await engine.commit({ ...current, proxies });
      if (log.on) log.add("proxiesChecked", { answers: changed });
      return false;
    });
  };

  const run = async () => {
    running = true;
    try {
      do {
        again = false;
        let failed = false;
        try {
          failed = await resolve();
        } catch (error) {
          failed = true;
          if (log.on) log.add("proxyCheckError", { message: error instanceof Error ? error.message : String(error) });
        }
        if (failed && retries < MAX_RETRIES) {
          retries += 1;
          setTimer(schedule, RETRY_MS);
        } else if (!failed) {
          retries = 0;
        }
      } while (again);
    } finally {
      running = false;
    }
  };

  function schedule() {
    if (running) {
      again = true;
      return undefined;
    }
    return run();
  }

  return {
    schedule,
    get running() {
      return running;
    },
  };
}
