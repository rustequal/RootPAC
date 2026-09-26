export const LOG_SETTING = "logEnabled";
export const LOG_LIMIT = 5000;
export const LOG_CHANNEL = "rootpac-log";

const FLUSH_MS = 500;
const MAX_BUFFER = 1000;

// Call sites test `log.on` before building an entry, so a disabled log costs one property read per event.
export const NO_LOG = Object.freeze({ on: false, add() {} });

export function createLog({ sink, now = Date.now, delay = FLUSH_MS, setTimer = setTimeout, notify = () => undefined }) {
  const buffer = [];
  let timer = null;
  let tail = Promise.resolve();

  const write = async () => {
    timer = null;
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      await sink.append(batch);
      notify();
    } catch {
      // A diagnostic log must never break the extension; a lost batch is acceptable.
    }
  };

  const flush = () => {
    tail = tail.then(write);
    return tail;
  };

  const log = {
    on: false,

    set(enabled) {
      log.on = enabled === true;
    },

    add(kind, fields = {}) {
      if (!log.on) return;
      if (buffer.length >= MAX_BUFFER) buffer.shift();
      buffer.push({ time: now(), kind, ...fields });
      timer ??= setTimer(flush, delay);
    },

    flush,
  };
  return log;
}
