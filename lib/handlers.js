// AI Bookmark - Message handlers
//
// The storage-facing half of the service worker's message router, kept separate
// from background.js so it can be exercised directly by tests.
//
// Exposed as `globalThis.AIBookmarkHandlers` and as a CommonJS module.

(function (root, factory) {
  'use strict';
  const core =
    (typeof module === 'object' && module.exports ? require('./core.js') : null) ||
    root.AIBookmarkCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.AIBookmarkHandlers = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Core) {
  'use strict';

  /**
   * @param {object} options
   * @param {object} options.store    an AIBookmarkStore instance
   * @param {function} [options.onCountChange] called with the new total after writes
   * @param {object} [options.extra]  additional handlers (e.g. tab navigation)
   */
  function createHandlers(options) {
    const opts = options || {};
    const store = opts.store;
    if (!store) throw new Error('createHandlers requires a store');
    const notify = typeof opts.onCountChange === 'function' ? opts.onCountChange : () => {};

    const handlers = {
      async ping() {
        return { ready: true };
      },

      async getBookmarks() {
        const bookmarks = await store.read();
        return { bookmarks, count: Core.countBookmarks(bookmarks) };
      },

      async addBookmark(request) {
        const outcome = await store.add(request && request.bookmark);
        notify(outcome.count);
        return outcome;
      },

      async removeBookmark(request) {
        const outcome = await store.remove(
          request && request.platform,
          request && request.bookmarkId
        );
        notify(outcome.count);
        return outcome;
      },

      async clearAllBookmarks() {
        const outcome = await store.clear();
        notify(outcome.count);
        return outcome;
      },

      async restoreBookmark(request) {
        const outcome = await store.add(request && request.bookmark);
        notify(outcome.count);
        return outcome;
      }
    };

    // Backwards compatibility with the pre-1.1 message name.
    handlers.deleteBookmark = handlers.removeBookmark;

    return Object.assign(handlers, opts.extra || {});
  }

  /**
   * Build a `chrome.runtime.onMessage` listener from a handler map.
   *
   * Unknown actions return false so the channel closes immediately - the old
   * code returned true unconditionally, which left every other listener's
   * callback hanging until the port was garbage collected.
   */
  function createListener(handlers, logger) {
    const log = logger || console;
    return function onMessage(request, sender, sendResponse) {
      const action = request && request.action;
      const handler =
        action && Object.prototype.hasOwnProperty.call(handlers, action)
          ? handlers[action]
          : null;
      if (!handler) return false;

      Promise.resolve()
        .then(() => handler(request, sender))
        .then((result) => sendResponse(Object.assign({ success: true }, result)))
        .catch((err) => {
          if (log && log.error) log.error(`[AI Bookmark] ${action} failed:`, err);
          sendResponse({
            success: false,
            error: err && err.message ? err.message : String(err)
          });
        });

      return true;
    };
  }

  return { createHandlers, createListener };
});
