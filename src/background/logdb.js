import { LOG_LIMIT } from "./log.js";

const NAME = "rootpac-log";
// Old entries go once this many more are past the limit, not on every batch: a delete costs as much as the append it
// follows (measured in Chromium), so the log holds up to LOG_LIMIT + PRUNE_STEP entries and the page shows the last
// LOG_LIMIT.
export const PRUNE_STEP = 1000;
const STORE = "entries";

const complete = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Log transaction aborted"));
  });

// The diagnostic log lives in IndexedDB: appends are cheap, it survives a browser restart and, unlike
// chrome.storage, writing it does not wake every storage.onChanged listener of the extension.
export function createLogDb({ factory = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange, limit = LOG_LIMIT, step = PRUNE_STEP } = {}) {
  let opening = null;
  // The id old entries were last deleted up to; a new worker deletes on its first append.
  let pruned = -Infinity;

  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open(NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        db.onclose = () => {
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  };

  const run = async (mode, work) => {
    const transaction = (await open()).transaction(STORE, mode);
    work(transaction.objectStore(STORE));
    await complete(transaction);
  };

  return {
    append: (entries) =>
      run("readwrite", (store) => {
        let last = null;
        for (const entry of entries) last = store.add(entry);
        if (last === null) return;
        last.onsuccess = () => {
          const cutoff = last.result - limit;
          if (cutoff <= 0 || cutoff - pruned < step) return;
          store.delete(keyRange.upperBound(cutoff));
          pruned = cutoff;
        };
      }),

    async read(after = 0) {
      let request = null;
      await run("readonly", (store) => {
        request = store.getAll(keyRange.lowerBound(after, true));
      });
      return request.result;
    },

    clear: () =>
      run("readwrite", (store) => {
        store.clear();
      }),
  };
}
