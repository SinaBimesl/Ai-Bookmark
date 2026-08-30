'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../lib/core.js');
const { createStore } = require('../lib/store.js');
const { createHandlers, createListener } = require('../lib/handlers.js');

function createArea(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    data,
    get(keys, callback) {
      const result = {};
      for (const key of [].concat(keys)) {
        if (key in data) result[key] = JSON.parse(JSON.stringify(data[key]));
      }
      setTimeout(() => callback(result), 0);
    },
    set(items, callback) {
      Object.assign(data, JSON.parse(JSON.stringify(items)));
      setTimeout(callback, 0);
    }
  };
}

function setup(initial) {
  const area = createArea(initial);
  const store = createStore({ area });
  const counts = [];
  const handlers = createHandlers({ store, onCountChange: (c) => counts.push(c) });
  const listener = createListener(handlers, { error() {} });
  return { area, store, handlers, listener, counts };
}

/** Invoke the listener the way chrome.runtime.onMessage would. */
function dispatch(listener, message) {
  return new Promise((resolve, reject) => {
    const keepOpen = listener(message, { id: 'test' }, resolve);
    if (keepOpen !== true) {
      reject(new Error('listener did not keep the channel open'));
    }
  });
}

test('createHandlers requires a store', () => {
  assert.throws(() => createHandlers({}), /requires a store/);
});

test('unknown actions return false so the channel closes', () => {
  const { listener } = setup();
  // Regression: the old listeners returned true unconditionally, which left
  // every unrelated sender's callback hanging.
  assert.equal(listener({ action: 'nope' }, {}, () => {}), false);
  assert.equal(listener(null, {}, () => {}), false);
  assert.equal(listener({}, {}, () => {}), false);
  assert.equal(listener({ action: 'toString' }, {}, () => {}), false, 'no prototype leakage');
});

test('getBookmarks returns a normalized store', async () => {
  const { listener } = setup({
    bookmarks: {
      'claude.ai': [
        { id: 'a', platform: 'claude.ai', messageText: 'hi', timestamp: 1 },
        { id: 'a', platform: 'claude.ai', messageText: 'hi', timestamp: 2 }
      ]
    }
  });

  const response = await dispatch(listener, { action: 'getBookmarks' });
  assert.equal(response.success, true);
  assert.equal(response.count, 1, 'duplicates are collapsed on read');
  assert.deepEqual(Object.keys(response.bookmarks).sort(), Core.PLATFORM_IDS.slice().sort());
});

test('addBookmark / removeBookmark round trip and report counts', async () => {
  const { listener, counts } = setup();
  const bookmark = {
    id: 'v2|claude.ai|c|abcd1234|0',
    platform: 'claude.ai',
    conversationId: 'c',
    url: 'https://claude.ai/chat/c',
    messageText: 'hello',
    timestamp: 10
  };

  const added = await dispatch(listener, { action: 'addBookmark', bookmark });
  assert.equal(added.success, true);
  assert.equal(added.count, 1);

  const removed = await dispatch(listener, {
    action: 'removeBookmark',
    platform: 'claude.ai',
    bookmarkId: bookmark.id
  });
  assert.equal(removed.success, true);
  assert.equal(removed.count, 0);
  assert.deepEqual(counts, [1, 0]);
});

test('deleteBookmark is still accepted for older callers', async () => {
  const { listener } = setup();
  await dispatch(listener, {
    action: 'addBookmark',
    bookmark: { id: 'a', platform: 'claude.ai', timestamp: 1 }
  });
  const response = await dispatch(listener, {
    action: 'deleteBookmark',
    platform: 'claude.ai',
    bookmarkId: 'a'
  });
  assert.equal(response.success, true);
  assert.equal(response.count, 0);
});

test('restoreBookmark brings back a deleted entry with its original timestamp', async () => {
  const { listener } = setup();
  const bookmark = { id: 'a', platform: 'claude.ai', messageText: 'x', timestamp: 4242 };

  await dispatch(listener, { action: 'addBookmark', bookmark });
  await dispatch(listener, {
    action: 'removeBookmark',
    platform: 'claude.ai',
    bookmarkId: 'a'
  });
  const restored = await dispatch(listener, { action: 'restoreBookmark', bookmark });

  assert.equal(restored.success, true);
  const response = await dispatch(listener, { action: 'getBookmarks' });
  assert.equal(response.bookmarks['claude.ai'][0].timestamp, 4242);
});

test('clearAllBookmarks empties everything', async () => {
  const { listener } = setup();
  await dispatch(listener, {
    action: 'addBookmark',
    bookmark: { id: 'a', platform: 'claude.ai', timestamp: 1 }
  });
  const cleared = await dispatch(listener, { action: 'clearAllBookmarks' });
  assert.equal(cleared.success, true);
  assert.equal(cleared.count, 0);
});

test('invalid bookmark payloads fail loudly instead of writing junk', async () => {
  const { listener } = setup();
  const response = await dispatch(listener, { action: 'addBookmark', bookmark: { nope: 1 } });
  assert.equal(response.success, false);

  const stored = await dispatch(listener, { action: 'getBookmarks' });
  assert.equal(stored.count, 0);
});

test('a rejecting handler answers with an error instead of hanging', async () => {
  const store = {
    read: async () => {
      throw new Error('storage exploded');
    }
  };
  const handlers = createHandlers({ store });
  const listener = createListener(handlers, { error() {} });

  const response = await dispatch(listener, { action: 'getBookmarks' });
  assert.equal(response.success, false);
  assert.match(response.error, /storage exploded/);
});

test('extra handlers are merged in', async () => {
  const { store } = setup();
  const handlers = createHandlers({
    store,
    extra: {
      async openBookmark() {
        return { opened: true };
      }
    }
  });
  const listener = createListener(handlers, { error() {} });
  const response = await dispatch(listener, { action: 'openBookmark' });
  assert.equal(response.opened, true);
});
