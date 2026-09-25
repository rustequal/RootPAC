import { TRIAL_TARGET } from "../core/trial.js";

const DOCUMENT = {
  url: "src/offscreen/offscreen.html",
  reasons: ["IFRAME_SCRIPTING"],
  justification: "Runs a candidate PAC script in a sandboxed iframe before it is applied.",
};

export function createChecker({ offscreen, runtime }) {
  let current = null;
  let tail = Promise.resolve();
  let closing = null;

  const closeDocument = () => {
    closing ??= (async () => {
      try {
        const open = await runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
        if (open.length > 0) await offscreen.closeDocument();
      } finally {
        closing = null;
      }
    })();
    return closing;
  };

  const execute = async (job, request) => {
    if (job.cancelled) return null;
    try {
      await closeDocument();
      await offscreen.createDocument(DOCUMENT);
      if (job.cancelled) return null;
      const outcome = await runtime.sendMessage({ target: TRIAL_TARGET, request });
      return job.cancelled ? null : outcome;
    } catch (error) {
      if (job.cancelled) return null;
      throw error;
    } finally {
      await closeDocument();
    }
  };

  const cancel = async () => {
    const job = current;
    if (job === null || job.cancelled) return false;
    job.cancelled = true;
    await closeDocument();
    return true;
  };

  return {
    cancel,
    async run(request) {
      if (current !== null) {
        current.cancelled = true;
        closeDocument().catch(() => undefined);
      }
      const job = { cancelled: false };
      current = job;
      const result = tail.then(() => execute(job, request));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      try {
        const outcome = await result;
        return job.cancelled ? { cancelled: true } : { cancelled: false, outcome };
      } finally {
        if (current === job) current = null;
      }
    },
  };
}
