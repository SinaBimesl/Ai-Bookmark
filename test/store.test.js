'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../lib/core.js');
const { createStore } = require('../lib/store.js');

/**
 * Minimal chrome.storage.StorageArea stand-in.
 * `latency` makes the get/set round trip interleavable, which is what exposes
 * lost-update bugs in read-modify-write code.
 */
function createMockArea(initial, options = {}) {
  const state = { data: JSON.parse(JSON.stringify(initial || {})) };
  const latency = options.latency || 0;
  state.reads = 0;
  state.writes = 0;

  state.get = (keys, callback) => {
    state.reads++;
    const result = {};
    for (const key of [].concat(keys)) {
      if (key in state.data) result[key] = JSON.parse(JSON.stringify(state.data[key]));
    }
    setTimeout(() => callback(result), latency);
  };

  state.set = (items, callback) => {
    state.writes++;
    setTimeout(() => {
      Object.assign(state.data, JSON.parse(JSON.stringify(items)));
      callback();
    }, latency);
  };

  return state;
}

function bookmark(id, overrides = {}) {
  return Object.assign(
    {
      id,
      platform: 'claude.ai',
      conversationId: 'conv-1',
      url: 'https://claude.ai/chat/conv-1',
      messageText: `message ${id}`,
      timestamp: 1000
    },
    overrides
  );
}

test('createStore requires a storage area', () => {
  assert.throws(() => createStore({}), /requires a storage area/);
});

test('add persists a bookmark and reports the new count', async () => {
  const area = createMockArea({});
  const store = createStore({ area });

  const result = await store.add(bookmark('a'));
  assert.equal(result.success, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.count, 1);

  const persisted = await store.read();
  assert.equal(persisted['claude.ai'][0].id, 'a');
  assert.equal(area.data.schemaVersion, Core.SCHEMA_VERSION);
});

test('add is idempotent - no duplicate rows for the same message', async () => {
  const area = createMockArea({});
  const store = createStore({ area });

  await store.add(bookmark('a'));
  const second = await store.add(bookmark('a'));

  assert.equal(second.duplicate, true);
  assert.equal(second.count, 1);
  assert.equal((await store.read())['claude.ai'].length, 1);
});

test('concurrent writes are serialized and none are lost', async () => {
  // Regression: content.js used to do get() -> mutate -> set() with no lock, so
  // two tabs bookmarking at once would clobber each other's write.
  const area = createMockArea({}, { latency: 5 });
  const store = createStore({ area });

  await Promise.all([
    store.add(bookmark('a')),
    store.add(bookmark('b')),
    store.add(bookmark('c')),
    store.add(bookmark('d')),
    store.add(bookmark('e'))
  ]);

  const persisted = await store.read();
  assert.deepEqual(
    persisted['claude.ai'].map((b) => b.id).sort(),
    ['a', 'b', 'c', 'd', 'e']
  );
});

test('interleaved adds and removes keep a consistent final state', async () => {
  const area = createMockArea({}, { latency: 3 });
  const store = createStore({ area });

  await store.add(bookmark('a'));
  await Promise.all([
    store.add(bookmark('b')),
    store.remove('claude.ai', 'a'),
    store.add(bookmark('c'))
  ]);

  const persisted = await store.read();
  assert.deepEqual(persisted['claude.ai'].map((b) => b.id).sort(), ['b', 'c']);
});

test('remove reports whether anything changed', async () => {
  const area = createMockArea({});
  const store = createStore({ area });
  await store.add(bookmark('a'));

  assert.equal((await store.remove('claude.ai', 'missing')).success, false);
  assert.equal((await store.remove('claude.ai', 'a')).success, true);
  assert.equal((await store.read())['claude.ai'].length, 0);
});

test('clear empties every platform', async () => {
  const area = createMockArea({});
  const store = createStore({ area });
  await store.add(bookmark('a'));
  await store.add(bookmark('b', { platform: 'chatgpt.com' }));

  const result = await store.clear();
  assert.equal(result.count, 0);
  assert.equal(Core.countBookmarks(await store.read()), 0);
});

test('a failing write does not wedge the queue', async () => {
  const area = createMockArea({});
  let failNext = true;
  const originalSet = area.set;
  area.set = (items, callback) => {
    if (failNext) {
      failNext = false;
      throw new Error('storage full');
    }
    originalSet(items, callback);
  };

  const store = createStore({ area });
  await assert.rejects(() => store.add(bookmark('a')), /storage full/);

  // The next operation must still go through.
  const second = await store.add(bookmark('b'));
  assert.equal(second.success, true);
  assert.equal((await store.read())['claude.ai'][0].id, 'b');
});

test('lastError from chrome.storage surfaces as a rejection', async () => {
  const area = createMockArea({});
  const runtime = { lastError: null };
  area.set = (items, callback) => {
    runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
    callback();
    runtime.lastError = null;
  };

  const store = createStore({ area, runtime });
  await assert.rejects(() => store.add(bookmark('a')), /QUOTA_BYTES/);
});

test('promise-style storage areas are supported (Firefox)', async () => {
  const data = {};
  const area = {
    get: (keys) => {
      const result = {};
      for (const key of [].concat(keys)) if (key in data) result[key] = data[key];
      return Promise.resolve(result);
    },
    set: (items) => {
      Object.assign(data, items);
      return Promise.resolve();
    }
  };

  const store = createStore({ area });
  await store.add(bookmark('a'));
  assert.equal((await store.read())['claude.ai'][0].id, 'a');
});

test('migrate upgrades legacy v1 records in place', async () => {
  const area = createMockArea({
    bookmarks: {
      'claude.ai': [
        {
          id: 'claude.ai-msg-3',
          url: 'https://claude.ai/chat/legacy-conv',
          messageText: 'old   entry',
          timestamp: 42,
          messageIndex: 3
        },
        // A duplicate row created by the old unconditional push().
        {
          id: 'claude.ai-msg-3',
          url: 'https://claude.ai/chat/legacy-conv',
          messageText: 'old entry',
          timestamp: 99,
          messageIndex: 3
        }
      ]
    }
  });

  const store = createStore({ area });
  const migrated = await store.migrate();

  assert.equal(migrated['claude.ai'].length, 1, 'duplicates collapse');
  assert.equal(migrated['claude.ai'][0].conversationId, 'legacy-conv');
  assert.equal(migrated['claude.ai'][0].platform, 'claude.ai');
  assert.equal(migrated['claude.ai'][0].messageText, 'old entry');
  assert.equal(migrated['claude.ai'][0].timestamp, 42);
  assert.equal(area.data.schemaVersion, Core.SCHEMA_VERSION);
});

test('migrate is a no-op write when data is already normalized', async () => {
  const area = createMockArea({});
  const store = createStore({ area });
  await store.add(bookmark('a'));

  const writesBefore = area.writes;
  await store.migrate();
  assert.equal(area.writes, writesBefore, 'must not churn storage on every worker start');
});

test('migrate survives a completely corrupt value', async () => {
  const area = createMockArea({ bookmarks: 'not an object' });
  const store = createStore({ area });
  const migrated = await store.migrate();
  assert.equal(Core.countBookmarks(migrated), 0);
  assert.deepEqual(Object.keys(migrated).sort(), Core.PLATFORM_IDS.slice().sort());
});

test('get finds a bookmark on any platform', async () => {
  const area = createMockArea({});
  const store = createStore({ area });
  await store.add(bookmark('a', { platform: 'chatgpt.com' }));
  assert.equal((await store.get('a')).platform, 'chatgpt.com');
  assert.equal(await store.get('nope'), null);
});
