'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../lib/core.js');

test('detectPlatform matches hosts and subdomains, not substrings', () => {
  assert.equal(Core.detectPlatform('chatgpt.com').id, 'chatgpt.com');
  assert.equal(Core.detectPlatform('chat.openai.com').id, 'chatgpt.com');
  assert.equal(Core.detectPlatform('claude.ai').id, 'claude.ai');
  assert.equal(Core.detectPlatform('CLAUDE.AI').id, 'claude.ai');
  assert.equal(Core.detectPlatform('chat.deepseek.com').id, 'chat.deepseek.com');

  // Regression: the old code used hostname.includes(), which matched attacker
  // controlled hosts such as `claude.ai.evil.test`.
  assert.equal(Core.detectPlatform('claude.ai.evil.test'), null);
  assert.equal(Core.detectPlatform('notchatgpt.com'), null);
  assert.equal(Core.detectPlatform('example.com'), null);
  assert.equal(Core.detectPlatform(''), null);
  assert.equal(Core.detectPlatform(undefined), null);
});

test('getConversationId extracts per-platform conversation ids', () => {
  assert.equal(Core.getConversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(Core.getConversationId('https://chatgpt.com/g/g-x/c/def-456'), 'def-456');
  assert.equal(Core.getConversationId('https://claude.ai/chat/uuid-1?x=1#f'), 'uuid-1');
  assert.equal(Core.getConversationId('https://chat.deepseek.com/a/chat/s/s-77'), 's-77');
});

test('getConversationId falls back to the path for unknown routes', () => {
  assert.equal(Core.getConversationId('https://chatgpt.com/'), 'root');
  assert.equal(Core.getConversationId('https://claude.ai/new'), '/new');
  assert.equal(Core.getConversationId('not a url'), 'unknown');
});

test('isSameConversation compares platform and conversation, not raw URLs', () => {
  assert.equal(
    Core.isSameConversation('https://claude.ai/chat/a?ref=1', 'https://claude.ai/chat/a#top'),
    true
  );
  assert.equal(
    Core.isSameConversation('https://claude.ai/chat/a', 'https://claude.ai/chat/b'),
    false
  );
  // Same platform reached through two different hostnames.
  assert.equal(
    Core.isSameConversation('https://chat.openai.com/c/x', 'https://chatgpt.com/c/x'),
    true
  );
  assert.equal(Core.isSameConversation('https://claude.ai/chat/a', 'https://example.com'), false);
});

test('normalizeText collapses whitespace and truncates to the preview length', () => {
  assert.equal(Core.normalizeText('  hello \n\n world  '), 'hello world');
  assert.equal(Core.normalizeText('a'.repeat(500)).length, Core.PREVIEW_LENGTH);
  assert.equal(Core.normalizeText(null), '');
});

test('hashText is stable, deterministic, and sensitive to content', () => {
  assert.equal(Core.hashText('hello'), Core.hashText('hello'));
  assert.notEqual(Core.hashText('hello'), Core.hashText('hello!'));
  assert.match(Core.hashText('hello'), /^[0-9a-f]{8}$/);
  assert.match(Core.hashText(''), /^[0-9a-f]{8}$/);
  // Non-ASCII must not throw or produce NaN.
  assert.match(Core.hashText('héllo 🌟'), /^[0-9a-f]{8}$/);
});

test('message ids are scoped to a conversation', () => {
  const a = Core.makeMessageId({
    platformId: 'claude.ai',
    conversationId: 'conv-a',
    text: 'same message'
  });
  const b = Core.makeMessageId({
    platformId: 'claude.ai',
    conversationId: 'conv-b',
    text: 'same message'
  });
  // Regression: v1 ids were `${platform}-msg-${index}`, so message #0 of every
  // conversation shared one id - bookmarking one filled the star on all of them.
  assert.notEqual(a, b);
});

test('parseMessageId round-trips v2 ids and rejects legacy ids', () => {
  const id = Core.makeMessageId({
    platformId: 'claude.ai',
    conversationId: 'conv',
    text: 'hi',
    occurrence: 2
  });
  const parsed = Core.parseMessageId(id);
  assert.equal(parsed.platformId, 'claude.ai');
  assert.equal(parsed.conversationId, 'conv');
  assert.equal(parsed.occurrence, 2);

  assert.equal(Core.parseMessageId('claude.ai-msg-3'), null);
  assert.equal(Core.isLegacyId('claude.ai-msg-3'), true);
  assert.equal(Core.isLegacyId(id), false);
});

test('describeMessages disambiguates repeated messages by occurrence', () => {
  const described = Core.describeMessages(['hi', 'bye', 'hi', 'hi']);
  assert.deepEqual(described.map((d) => d.occurrence), [0, 0, 1, 2]);
  assert.equal(described[0].textHash, described[2].textHash);

  const ids = described.map((d) =>
    Core.makeMessageId({
      platformId: 'claude.ai',
      conversationId: 'c',
      textHash: d.textHash,
      occurrence: d.occurrence
    })
  );
  assert.equal(new Set(ids).size, 4, 'identical messages must still get unique ids');
});

test('filterOutermost drops nested matches (ancestor walk)', () => {
  // Regression: DeepSeek's `div[class*="message"]` matches a turn and its
  // children, which produced a star per nesting level.
  const parent = { name: 'parent', parentElement: null };
  const child = { name: 'child', parentElement: parent };
  const grandchild = { name: 'grandchild', parentElement: child };
  const sibling = { name: 'sibling', parentElement: null };

  const kept = Core.filterOutermost([parent, child, grandchild, sibling]);
  assert.deepEqual(kept.map((n) => n.name), ['parent', 'sibling']);
});

test('filterOutermost falls back to contains() without a parent chain', () => {
  const child = { name: 'child', contains: (n) => n === child };
  const parent = { name: 'parent', contains: (n) => n === parent || n === child };
  const sibling = { name: 'sibling', contains: (n) => n === sibling };

  const kept = Core.filterOutermost([parent, child, sibling]);
  assert.deepEqual(kept.map((n) => n.name), ['parent', 'sibling']);
});

test('filterOutermost handles trivial inputs', () => {
  assert.deepEqual(Core.filterOutermost([]), []);
  assert.deepEqual(Core.filterOutermost(null), []);
  assert.equal(Core.filterOutermost([{ name: 'only' }]).length, 1);
});

test('sanitizeBookmark rejects junk and backfills v2 fields', () => {
  assert.equal(Core.sanitizeBookmark(null), null);
  assert.equal(Core.sanitizeBookmark({}), null);
  assert.equal(Core.sanitizeBookmark({ id: 'x' }), null, 'platform is required');

  const legacy = Core.sanitizeBookmark({
    id: 'claude.ai-msg-4',
    platform: 'claude.ai',
    url: 'https://claude.ai/chat/conv-9',
    messageText: '  spaced   out  ',
    timestamp: 1000,
    messageIndex: 4
  });
  assert.equal(legacy.conversationId, 'conv-9', 'derived from the stored URL');
  assert.equal(legacy.messageText, 'spaced out');
  assert.equal(legacy.legacyId, true);
  assert.match(legacy.textHash, /^[0-9a-f]{8}$/);
});

test('normalizeStore repairs corrupt data and removes duplicate ids', () => {
  const store = Core.normalizeStore({
    'claude.ai': [
      { id: 'a', platform: 'claude.ai', messageText: 'first', timestamp: 200 },
      { id: 'a', platform: 'claude.ai', messageText: 'first', timestamp: 100 },
      null,
      'garbage',
      { platform: 'claude.ai' }
    ],
    'not-an-array': 'oops'
  });

  assert.equal(store['claude.ai'].length, 1);
  assert.equal(store['claude.ai'][0].timestamp, 100, 'oldest timestamp wins');
  assert.deepEqual(store['chatgpt.com'], []);
  assert.deepEqual(store['chat.deepseek.com'], []);
});

test('normalizeStore always returns every known platform key', () => {
  for (const raw of [undefined, null, 'nope', 42, []]) {
    const store = Core.normalizeStore(raw);
    assert.deepEqual(Object.keys(store).sort(), Core.PLATFORM_IDS.slice().sort());
  }
});

test('upsertBookmark is idempotent and never appends duplicates', () => {
  const base = Core.emptyStore();
  const bookmark = {
    id: 'v2|claude.ai|c|deadbeef|0',
    platform: 'claude.ai',
    url: 'https://claude.ai/chat/c',
    messageText: 'hello',
    timestamp: 500
  };

  const first = Core.upsertBookmark(base, bookmark);
  assert.equal(first.changed, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.store['claude.ai'].length, 1);

  // Regression: the old addBookmark() pushed unconditionally, so a double click
  // or a re-fired observer produced two rows for one message.
  const second = Core.upsertBookmark(first.store, bookmark);
  assert.equal(second.duplicate, true);
  assert.equal(second.changed, false);
  assert.equal(second.store['claude.ai'].length, 1);

  // The original creation time is preserved on re-bookmark.
  const third = Core.upsertBookmark(
    second.store,
    Object.assign({}, bookmark, { timestamp: 9999, messageText: 'hello again' })
  );
  assert.equal(third.store['claude.ai'][0].timestamp, 500);
  assert.equal(third.store['claude.ai'][0].messageText, 'hello again');
});

test('upsertBookmark does not mutate the input store', () => {
  const base = Core.emptyStore();
  Core.upsertBookmark(base, { id: 'x', platform: 'claude.ai', timestamp: 1 });
  assert.equal(base['claude.ai'].length, 0);
});

test('removeBookmark deletes by id, optionally across platforms', () => {
  let store = Core.emptyStore();
  store = Core.upsertBookmark(store, { id: 'a', platform: 'claude.ai', timestamp: 1 }).store;
  store = Core.upsertBookmark(store, { id: 'b', platform: 'chatgpt.com', timestamp: 2 }).store;

  const scoped = Core.removeBookmark(store, 'claude.ai', 'a');
  assert.equal(scoped.changed, true);
  assert.equal(scoped.store['claude.ai'].length, 0);
  assert.equal(scoped.store['chatgpt.com'].length, 1);

  const wide = Core.removeBookmark(store, null, 'b');
  assert.equal(wide.changed, true);
  assert.equal(wide.store['chatgpt.com'].length, 0);

  assert.equal(Core.removeBookmark(store, 'claude.ai', 'missing').changed, false);
  assert.equal(Core.removeBookmark(store, 'claude.ai', '').changed, false);
});

test('flattenBookmarks sorts newest first and is stable on ties', () => {
  let store = Core.emptyStore();
  store = Core.upsertBookmark(store, { id: 'a', platform: 'claude.ai', timestamp: 1 }).store;
  store = Core.upsertBookmark(store, { id: 'c', platform: 'chatgpt.com', timestamp: 3 }).store;
  store = Core.upsertBookmark(store, { id: 'b', platform: 'chatgpt.com', timestamp: 3 }).store;

  assert.deepEqual(Core.flattenBookmarks(store).map((b) => b.id), ['b', 'c', 'a']);
  assert.equal(Core.countBookmarks(store), 3);
});

test('filterBookmarks matches text, platform label, and url', () => {
  const bookmarks = [
    { id: '1', platform: 'claude.ai', messageText: 'Recipe for bread', url: 'https://claude.ai/chat/x' },
    { id: '2', platform: 'chatgpt.com', messageText: 'Tax advice', url: 'https://chatgpt.com/c/y' }
  ];

  assert.deepEqual(Core.filterBookmarks(bookmarks, 'bread').map((b) => b.id), ['1']);
  assert.deepEqual(Core.filterBookmarks(bookmarks, 'CHATGPT').map((b) => b.id), ['2']);
  assert.equal(Core.filterBookmarks(bookmarks, '   ').length, 2);
  assert.equal(Core.filterBookmarks(bookmarks, 'nothing').length, 0);
});

test('formatRelativeTime buckets correctly', () => {
  const now = 1_700_000_000_000;
  assert.equal(Core.formatRelativeTime(now, now), 'Just now');
  assert.equal(Core.formatRelativeTime(now + 5000, now), 'Just now', 'clock skew clamps');
  assert.equal(Core.formatRelativeTime(now - 5 * 60000, now), '5m ago');
  assert.equal(Core.formatRelativeTime(now - 3 * 3600000, now), '3h ago');
  assert.equal(Core.formatRelativeTime(now - 2 * 86400000, now), '2d ago');
  assert.equal(Core.formatRelativeTime(now - 30 * 86400000, now).includes('ago'), false);
  assert.equal(Core.formatRelativeTime('nope', now), '');
});

test('platform metadata lookups fall back gracefully', () => {
  assert.equal(Core.platformLabel('claude.ai'), 'Claude');
  assert.equal(Core.platformLabel('unknown.example'), 'unknown.example');
  assert.equal(Core.platformColor('claude.ai'), '#cc785c');
  assert.equal(Core.platformColor('unknown.example'), '#666666');
});
