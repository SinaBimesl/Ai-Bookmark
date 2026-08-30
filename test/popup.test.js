'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { createStore } = require('../lib/store.js');
const { createHandlers, createListener } = require('../lib/handlers.js');
const { waitFor, wait } = require('./helpers/extension-env.js');

const ROOT = path.resolve(__dirname, '..');
const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const coreSource = fs.readFileSync(path.join(ROOT, 'lib/core.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

function createArea(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  const listeners = [];
  return {
    data,
    listeners,
    get(keys, callback) {
      const result = {};
      for (const key of [].concat(keys)) {
        if (key in data) result[key] = JSON.parse(JSON.stringify(data[key]));
      }
      setTimeout(() => callback(result), 0);
    },
    set(items, callback) {
      const changes = {};
      for (const key of Object.keys(items)) {
        changes[key] = {
          oldValue: data[key],
          newValue: JSON.parse(JSON.stringify(items[key]))
        };
        data[key] = changes[key].newValue;
      }
      setTimeout(() => {
        callback();
        for (const listener of listeners.slice()) listener(changes, 'local');
      }, 0);
    }
  };
}

async function openPopup(options = {}) {
  const area = createArea(options.initialStorage);
  const store = createStore({ area });
  const opened = [];
  const handlers = createHandlers({
    store,
    extra: {
      async openBookmark(request) {
        opened.push(request.bookmark);
        if (options.openFails) return { success: false, error: 'Message not found on the page.' };
        return { success: true };
      }
    }
  });
  const listener = createListener(handlers, { error() {} });

  const dom = new JSDOM(popupHtml, {
    url: 'chrome-extension://test/popup.html',
    runScripts: 'outside-only'
  });
  const { window } = dom;

  let closed = false;
  window.close = () => {
    closed = true;
  };

  window.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      sendMessage(message, callback) {
        const respond = (response) => callback && callback(response);
        if (listener(message, { id: 'test' }, respond) !== true) respond(undefined);
      }
    },
    storage: {
      local: area,
      onChanged: { addListener: (fn) => area.listeners.push(fn) }
    }
  };

  window.eval(coreSource);
  window.eval(popupSource);

  const $ = (selector) => window.document.querySelector(selector);
  const items = () => Array.from(window.document.querySelectorAll('.bookmark-item'));

  return {
    window,
    document: window.document,
    store,
    area,
    opened,
    $,
    items,
    isClosed: () => closed,
    close: () => window.close()
  };
}

function bookmark(id, overrides = {}) {
  return Object.assign(
    {
      id,
      platform: 'claude.ai',
      conversationId: 'conv-1',
      url: 'https://claude.ai/chat/conv-1',
      messageText: `Message ${id}`,
      timestamp: 1000
    },
    overrides
  );
}

test('shows the empty state with no bookmarks', async (t) => {
  const popup = await openPopup();
  t.after(() => popup.close());

  await waitFor(async () => popup.$('#empty-state').hidden === false);
  assert.equal(popup.$('#bookmark-list').hidden, true);
  assert.equal(popup.$('#bookmark-count').textContent, '0 bookmarks');
  assert.equal(popup.$('#clear-all').disabled, true);
});

test('renders bookmarks newest first with platform badges', async (t) => {
  const popup = await openPopup({
    initialStorage: {
      bookmarks: {
        'claude.ai': [bookmark('a', { timestamp: 1000, messageText: 'Older' })],
        'chatgpt.com': [
          bookmark('b', { platform: 'chatgpt.com', timestamp: 2000, messageText: 'Newer' })
        ]
      }
    }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 2);
  const items = popup.items();
  assert.equal(items[0].querySelector('.bookmark-text').textContent, 'Newer');
  assert.equal(items[0].querySelector('.platform-badge').textContent, 'ChatGPT');
  assert.equal(items[1].querySelector('.platform-badge').textContent, 'Claude');
  assert.equal(popup.$('#bookmark-count').textContent, '2 bookmarks');
});

test('singular wording for exactly one bookmark', async (t) => {
  const popup = await openPopup({
    initialStorage: { bookmarks: { 'claude.ai': [bookmark('a')] } }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 1);
  assert.equal(popup.$('#bookmark-count').textContent, '1 bookmark');
});

test('preview text is inserted as text, never as markup', async (t) => {
  const popup = await openPopup({
    initialStorage: {
      bookmarks: {
        'claude.ai': [bookmark('a', { messageText: '<img src=x onerror=alert(1)>' })]
      }
    }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 1);
  const text = popup.$('.bookmark-text');
  assert.equal(text.querySelector('img'), null);
  assert.equal(text.textContent, '<img src=x onerror=alert(1)>');
});

test('search filters the list without touching storage', async (t) => {
  const popup = await openPopup({
    initialStorage: {
      bookmarks: {
        'claude.ai': [
          bookmark('a', { messageText: 'bread recipe' }),
          bookmark('b', { messageText: 'tax advice' })
        ]
      }
    }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 2);

  const search = popup.$('#search');
  search.value = 'bread';
  search.dispatchEvent(new popup.window.Event('input'));

  assert.equal(popup.items().length, 1);
  assert.equal(popup.$('.bookmark-text').textContent, 'bread recipe');
  assert.equal(popup.$('#bookmark-count').textContent, '2 bookmarks', 'count reflects the total');

  search.value = 'nothing matches';
  search.dispatchEvent(new popup.window.Event('input'));
  assert.equal(popup.items().length, 0);
  assert.equal(popup.$('#no-results').hidden, false);
  assert.equal(popup.$('#empty-state').hidden, true, 'never claim there are no bookmarks at all');
});

test('Go asks the worker to open the bookmark and closes the popup', async (t) => {
  const popup = await openPopup({
    initialStorage: { bookmarks: { 'claude.ai': [bookmark('a')] } }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 1);
  popup.$('.btn-go').click();

  await waitFor(async () => popup.isClosed());
  assert.equal(popup.opened.length, 1);
  assert.equal(popup.opened[0].id, 'a');
});

test('a failed navigation shows an inline message and keeps the popup open', async (t) => {
  // Regression: the old popup called alert() and then unconditionally opened a
  // second tab, which is both blocked in some browsers and disorienting.
  const popup = await openPopup({
    initialStorage: { bookmarks: { 'claude.ai': [bookmark('a')] } },
    openFails: true
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 1);
  popup.$('.btn-go').click();

  await waitFor(async () => popup.$('#status').hidden === false);
  assert.match(popup.$('#status').textContent, /not found/i);
  assert.equal(popup.isClosed(), false);
});

test('delete removes the row and offers an undo', async (t) => {
  const popup = await openPopup({
    initialStorage: { bookmarks: { 'claude.ai': [bookmark('a'), bookmark('b')] } }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 2);
  popup.items()[0].querySelector('.btn-delete').click();

  await waitFor(async () => popup.items().length === 1);
  assert.equal(popup.$('#toast').hidden, false);
  assert.equal(popup.$('#toast-action').hidden, false);

  popup.$('#toast-action').click();
  await waitFor(async () => popup.items().length === 2);
  assert.equal(popup.$('#toast').hidden, true);
});

test('Clear All requires an in-popup confirmation', async (t) => {
  const popup = await openPopup({
    initialStorage: { bookmarks: { 'claude.ai': [bookmark('a')] } }
  });
  t.after(() => popup.close());

  await waitFor(async () => popup.items().length === 1);

  popup.$('#clear-all').click();
  assert.equal(popup.$('#confirm-bar').hidden, false);
  assert.equal(popup.$('#clear-all').hidden, true);

  popup.$('#cancel-clear').click();
  assert.equal(popup.$('#confirm-bar').hidden, true);
  assert.equal(popup.items().length, 1, 'cancel must not delete anything');

  popup.$('#clear-all').click();
  popup.$('#confirm-clear').click();
  await waitFor(async () => popup.items().length === 0);
  assert.equal(popup.$('#empty-state').hidden, false);
});

test('the list reacts to bookmarks added by a page while the popup is open', async (t) => {
  const popup = await openPopup();
  t.after(() => popup.close());

  await waitFor(async () => popup.$('#empty-state').hidden === false);
  await popup.store.add(bookmark('live'));

  await waitFor(async () => popup.items().length === 1);
  assert.equal(popup.$('.bookmark-text').textContent, 'Message live');
});

test('a broken storage response surfaces an error instead of a blank popup', async (t) => {
  const dom = new JSDOM(popupHtml, {
    url: 'chrome-extension://test/popup.html',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.close = () => {};
  window.chrome = {
    runtime: {
      id: 'test',
      lastError: { message: 'Could not establish connection.' },
      sendMessage(message, callback) {
        callback(undefined);
      }
    },
    storage: { local: {}, onChanged: { addListener() {} } }
  };

  window.eval(coreSource);
  window.eval(popupSource);

  await wait(50);
  const status = window.document.querySelector('#status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Could not establish connection/);
  window.close();
});
