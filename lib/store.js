// AI Bookmark - Storage layer
//
// All writes to chrome.storage go through a single instance of this store,
// owned by the service worker. Read-modify-write cycles are serialized on a
// promise chain, which is what prevents the classic "two tabs bookmark at the
// same time and one write clobbers the other" data loss.
//
// Exposed as `globalThis.AIBookmarkStore` and as a CommonJS module.

(function (root, factory) {
  'use strict';
  const core =
    (typeof module === 'object' && module.exports ? require('./core.js') : null) ||
    root.AIBookmarkCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.AIBookmarkStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Core) {
  'use strict';

  const KEYS = Core.STORAGE_KEYS;

  /**
   * Promisify a `chrome.storage.StorageArea`. Supports both the callback style
   * (Chrome MV3) and the promise style (Firefox / newer Chrome), and surfaces
   * `chrome.runtime.lastError` as a rejection instead of silently continuing.
   */
  function promisifyArea(area, runtime) {
    function lastError() {
      return runtime && runtime.lastError ? new Error(runtime.lastError.message) : null;
    }

    return {
      get(keys) {
        return new Promise((resolve, reject) => {
          let result;
          try {
            result = area.get(keys, (value) => {
              const err = lastError();
              if (err) reject(err);
              else resolve(value || {});
            });
          } catch (err) {
            reject(err);
            return;
          }
          // Promise-style storage APIs return a thenable and ignore the callback.
          if (result && typeof result.then === 'function') {
            result.then((value) => resolve(value || {}), reject);
          }
        });
      },
      set(items) {
        return new Promise((resolve, reject) => {
          let result;
          try {
            result = area.set(items, () => {
              const err = lastError();
              if (err) reject(err);
              else resolve();
            });
          } catch (err) {
            reject(err);
            return;
          }
          if (result && typeof result.then === 'function') {
            result.then(() => resolve(), reject);
          }
        });
      }
    };
  }

  /**
   * @param {object} options
   * @param {object} options.area    chrome.storage.local (or a compatible mock)
   * @param {object} [options.runtime] chrome.runtime, for lastError propagation
   */
  function createStore(options) {
    const opts = options || {};
    if (!opts.area) throw new Error('createStore requires a storage area');
    const area = promisifyArea(opts.area, opts.runtime);

    // Serializes every read-modify-write so concurrent callers cannot interleave.
    let queue = Promise.resolve();

    function enqueue(task) {
      const run = queue.then(task, task);
      // Keep the chain alive even when a task rejects.
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }

    async function readRaw() {
      const result = await area.get([KEYS.bookmarks, KEYS.schemaVersion]);
      return {
        store: Core.normalizeStore(result[KEYS.bookmarks]),
        version: Number.isFinite(result[KEYS.schemaVersion]) ? result[KEYS.schemaVersion] : 1
      };
    }

    /**
     * Read the current store. Queued behind pending writes so that a read
     * issued after a write cannot observe the pre-write value.
     */
    function read() {
      return enqueue(async () => {
        const { store } = await readRaw();
        return store;
      });
    }

    /**
     * Run `mutator(store)` under the write lock. The mutator returns
     * `{ store, changed, result }`; the store is only persisted when `changed`.
     */
    function mutate(mutator) {
      return enqueue(async () => {
        const { store, version } = await readRaw();
        const outcome = (await mutator(store)) || {};
        const nextStore = outcome.store || store;
        const needsVersionWrite = version !== Core.SCHEMA_VERSION;
        if (outcome.changed || needsVersionWrite) {
          const items = {};
          items[KEYS.bookmarks] = nextStore;
          items[KEYS.schemaVersion] = Core.SCHEMA_VERSION;
          await area.set(items);
        }
        return { store: nextStore, changed: Boolean(outcome.changed), result: outcome.result };
      });
    }

    /**
     * Rewrite storage with the sanitized/deduplicated form. Safe to call on
     * every service-worker start; it only writes when something actually
     * changed, so it does not churn storage or spam onChanged listeners.
     */
    function migrate() {
      return enqueue(async () => {
        const result = await area.get([KEYS.bookmarks, KEYS.schemaVersion]);
        const onDisk = result[KEYS.bookmarks];
        const normalized = Core.normalizeStore(onDisk);
        const differs = JSON.stringify(onDisk) !== JSON.stringify(normalized);
        const versionDiffers = result[KEYS.schemaVersion] !== Core.SCHEMA_VERSION;
        if (differs || versionDiffers) {
          const items = {};
          items[KEYS.bookmarks] = normalized;
          items[KEYS.schemaVersion] = Core.SCHEMA_VERSION;
          await area.set(items);
        }
        return normalized;
      });
    }

    async function add(bookmark) {
      const outcome = await mutate((store) => {
        const next = Core.upsertBookmark(store, bookmark);
        return {
          store: next.store,
          changed: next.changed,
          result: { duplicate: next.duplicate, bookmark: next.bookmark }
        };
      });
      return {
        success: Boolean(outcome.result && outcome.result.bookmark),
        duplicate: Boolean(outcome.result && outcome.result.duplicate),
        bookmark: outcome.result ? outcome.result.bookmark : null,
        count: Core.countBookmarks(outcome.store)
      };
    }

    async function remove(platformId, id) {
      const outcome = await mutate((store) => {
        const next = Core.removeBookmark(store, platformId, id);
        return { store: next.store, changed: next.changed };
      });
      return { success: outcome.changed, count: Core.countBookmarks(outcome.store) };
    }

    async function clear() {
      const outcome = await mutate((store) => ({
        store: Core.emptyStore(),
        changed: Core.countBookmarks(store) > 0
      }));
      return { success: true, count: Core.countBookmarks(outcome.store) };
    }

    async function get(id) {
      const store = await read();
      return Core.findBookmark(store, id);
    }

    return { read, mutate, migrate, add, remove, clear, get };
  }

  return { createStore, promisifyArea };
});
