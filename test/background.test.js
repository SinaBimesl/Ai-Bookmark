'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkerEnv } = require('./helpers/worker-env.js');
const { waitFor, wait } = require('./helpers/extension-env.js');

function bookmark(overrides = {}) {
  return Object.assign(
    {
      id: 'v2|claude.ai|conv-1|abcd1234|0',
      platform: 'claude.ai',
      conversationId: 'conv-1',
      url: 'https://claude.ai/chat/conv-1',
      messageText: 'Saved message',
      textHash: 'abcd1234',
      occurrence: 0,
      messageIndex: 2,
      timestamp: 1000
    },
    overrides
  );
}

test('background.js registers exactly one message listener', () => {
  const env = createWorkerEnv();
  assert.equal(env.chrome.runtime.onMessage.listeners.length, 1);
});

test('unknown actions do not keep the message channel open', async () => {
  const env = createWorkerEnv();
  const listener = env.chrome.runtime.onMessage.listeners[0];
  assert.equal(listener({ action: 'unknown' }, {}, () => {}), false);
});

test('openBookmark reuses a tab already on that conversation', async () => {
  const env = createWorkerEnv({
    tabs: [
      { id: 1, url: 'https://claude.ai/chat/other', active: true },
      { id: 2, url: 'https://claude.ai/chat/conv-1?ref=x', active: false }
    ]
  });

  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });

  assert.equal(response.success, true);
  assert.equal(response.pending, false);
  assert.equal(response.tabId, 2);
  assert.equal(env.calls.created.length, 0, 'must not open a duplicate tab');
  assert.ok(env.calls.updated.some((u) => u.id === 2 && u.info.active === true));

  const scrolls = env.calls.messages.filter((m) => m.message.action === 'scrollToBookmark');
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].tabId, 2);
  assert.equal(scrolls[0].message.bookmark.id, bookmark().id);
});

test('openBookmark opens a new tab rather than hijacking the current one', async () => {
  // The active tab is the same platform but a different conversation: navigating
  // it away would throw the user out of whatever they were reading.
  const env = createWorkerEnv({
    tabs: [{ id: 1, url: 'https://claude.ai/chat/something-else', active: true }]
  });

  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });

  assert.equal(response.success, true);
  assert.equal(response.pending, true);
  assert.deepEqual(env.calls.created, ['https://claude.ai/chat/conv-1']);
  assert.equal(
    env.calls.updated.some((u) => u.id === 1 && u.info.url),
    false,
    'the existing tab must not be navigated'
  );
});

test('a freshly opened tab is scrolled once it finishes loading', async () => {
  const env = createWorkerEnv({ tabs: [] });

  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });
  assert.equal(response.pending, true);

  const tabId = response.tabId;
  env.withContentScript.add(tabId);

  await env.onUpdated.emit(tabId, { status: 'complete' }, { id: tabId });

  await waitFor(async () =>
    env.calls.messages.some(
      (m) => m.tabId === tabId && m.message.action === 'scrollToBookmark'
    )
  );
});

test('a pending scroll fires only once', async () => {
  const env = createWorkerEnv({ tabs: [] });
  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });
  const tabId = response.tabId;
  env.withContentScript.add(tabId);

  await env.onUpdated.emit(tabId, { status: 'complete' }, { id: tabId });
  await waitFor(async () =>
    env.calls.messages.some((m) => m.message.action === 'scrollToBookmark')
  );

  const before = env.calls.messages.filter((m) => m.message.action === 'scrollToBookmark').length;
  await env.onUpdated.emit(tabId, { status: 'complete' }, { id: tabId });
  await wait(300);
  const after = env.calls.messages.filter((m) => m.message.action === 'scrollToBookmark').length;
  assert.equal(after, before, 'a second load event must not re-scroll');
});

test('loading events for unrelated tabs are ignored', async () => {
  const env = createWorkerEnv({ tabs: [{ id: 9, url: 'https://example.com/', active: true }] });
  await env.onUpdated.emit(9, { status: 'complete' }, { id: 9 });
  await wait(50);
  assert.equal(env.calls.messages.length, 0);
});

test('the content script is injected into tabs that do not have one', async () => {
  // Regression: tabs opened before the extension was installed had no content
  // script, so navigation just failed with "message not found".
  const env = createWorkerEnv({
    tabs: [{ id: 3, url: 'https://claude.ai/chat/conv-1', active: true }],
    tabsWithContentScript: new Set()
  });

  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });

  assert.equal(response.success, true);
  assert.deepEqual(env.calls.injected, [3]);
});

test('openBookmark reports a failure when the message cannot be found', async () => {
  const env = createWorkerEnv({
    tabs: [{ id: 3, url: 'https://claude.ai/chat/conv-1', active: true }],
    onScroll: () => ({ success: false, error: 'Message not found on this page.' })
  });

  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });
  assert.equal(response.success, false);
  assert.match(response.error, /not found/i);
});

test('openBookmark rejects bookmarks with no usable URL', async () => {
  const env = createWorkerEnv();
  const response = await env.send({
    action: 'openBookmark',
    bookmark: bookmark({ url: '' })
  });
  assert.equal(response.success, false);
  assert.match(response.error, /no saved URL/i);

  const invalid = await env.send({ action: 'openBookmark', bookmark: null });
  assert.equal(invalid.success, false);
});

test('storage operations flow through the worker and update the badge', async () => {
  const env = createWorkerEnv();

  const added = await env.send({ action: 'addBookmark', bookmark: bookmark() });
  assert.equal(added.success, true);
  assert.equal(added.count, 1);

  await waitFor(async () => env.calls.badge.includes('1'));

  const list = await env.send({ action: 'getBookmarks' });
  assert.equal(list.count, 1);

  const removed = await env.send({
    action: 'removeBookmark',
    platform: 'claude.ai',
    bookmarkId: bookmark().id
  });
  assert.equal(removed.count, 0);
  await waitFor(async () => env.calls.badge.includes(''));
});

test('legacy stored data is migrated on worker start', async () => {
  const env = createWorkerEnv({
    initialStorage: {
      bookmarks: {
        'claude.ai': [
          {
            id: 'claude.ai-msg-2',
            url: 'https://claude.ai/chat/legacy',
            messageText: 'old',
            timestamp: 5,
            messageIndex: 2
          }
        ]
      }
    }
  });

  await waitFor(async () => env.local.data.schemaVersion === 2);
  const stored = env.local.data.bookmarks['claude.ai'][0];
  assert.equal(stored.conversationId, 'legacy');
  assert.equal(stored.platform, 'claude.ai');
});

test('closing a tab drops its pending scroll intent', async () => {
  const env = createWorkerEnv({ tabs: [] });
  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });
  const tabId = response.tabId;

  await env.onRemoved.emit(tabId);
  await wait(50);

  await env.onUpdated.emit(tabId, { status: 'complete' }, { id: tabId });
  await wait(300);
  assert.equal(
    env.calls.messages.some((m) => m.message.action === 'scrollToBookmark'),
    false
  );
});

test('navigation still works without chrome.storage.session', async () => {
  const env = createWorkerEnv({ tabs: [], noSessionStorage: true });
  const response = await env.send({ action: 'openBookmark', bookmark: bookmark() });
  assert.equal(response.pending, true);

  const tabId = response.tabId;
  env.withContentScript.add(tabId);
  await env.onUpdated.emit(tabId, { status: 'complete' }, { id: tabId });

  await waitFor(async () =>
    env.calls.messages.some((m) => m.message.action === 'scrollToBookmark')
  );
});
