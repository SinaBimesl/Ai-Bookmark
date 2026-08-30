'use strict';

// A small end-to-end harness: a jsdom page running the real content script,
// talking to the real message handlers and the real storage layer through a
// mock chrome.storage area. Only the chrome.* transport is faked.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { createStore } = require('../../lib/store.js');
const { createHandlers, createListener } = require('../../lib/handlers.js');

const ROOT = path.resolve(__dirname, '../..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** In-memory chrome.storage.local with change notifications. */
function createStorageArea() {
  const data = {};
  const listeners = [];

  const area = {
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
        const oldValue = data[key];
        const newValue = JSON.parse(JSON.stringify(items[key]));
        data[key] = newValue;
        changes[key] = { oldValue, newValue };
      }
      setTimeout(() => {
        callback();
        for (const listener of listeners.slice()) listener(changes, 'local');
      }, 0);
    }
  };

  return { area, data, listeners };
}

/**
 * @param {object} options
 * @param {string} options.url   page URL (drives platform + conversation detection)
 * @param {string} options.html  page body markup
 * @param {object} [options.initialStorage]
 */
async function createExtensionEnv(options) {
  const { url, html, initialStorage } = options;

  const storage = createStorageArea();
  if (initialStorage) Object.assign(storage.data, initialStorage);

  const store = createStore({ area: storage.area });
  const badge = { count: null };
  const handlers = createHandlers({
    store,
    onCountChange: (count) => {
      badge.count = count;
    }
  });
  const backgroundListener = createListener(handlers, { error() {} });

  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // jsdom has no layout engine, so scrollIntoView is unimplemented.
  const scrolledInto = [];
  window.Element.prototype.scrollIntoView = function scrollIntoView() {
    scrolledInto.push(this);
  };

  const contentListeners = [];

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: (file) => `chrome-extension://test-extension-id/${file}`,
      sendMessage(message, callback) {
        const respond = (response) => {
          if (typeof callback === 'function') callback(response);
        };
        const handled = backgroundListener(message, { id: 'test' }, respond);
        if (!handled) respond(undefined);
      },
      onMessage: {
        addListener(fn) {
          contentListeners.push(fn);
        }
      }
    },
    storage: {
      local: storage.area,
      onChanged: {
        addListener(fn) {
          storage.listeners.push(fn);
        }
      }
    }
  };

  window.chrome = chrome;

  // Load exactly what the manifest loads into a content script.
  window.eval(readSource('lib/core.js'));
  window.eval(readSource('content.js'));

  /** Send a message to the page's content-script listeners, as chrome.tabs.sendMessage would. */
  function sendToContent(message) {
    return new Promise((resolve) => {
      let settled = false;
      const respond = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      let async = false;
      for (const listener of contentListeners) {
        if (listener(message, { id: 'test' }, respond) === true) async = true;
      }
      if (!async && !settled) resolve(undefined);
    });
  }

  async function readStore() {
    return store.read();
  }

  function stars() {
    return Array.from(window.document.querySelectorAll('.ai-bm-star'));
  }

  function starFor(element) {
    return element.querySelector(':scope > .ai-bm-star-container .ai-bm-star');
  }

  return {
    dom,
    window,
    document: window.document,
    chrome,
    store,
    storage,
    badge,
    scrolledInto,
    sendToContent,
    readStore,
    stars,
    starFor,
    close() {
      window.close();
    }
  };
}

/** Wait for real timers/microtasks to drain. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(predicate, { timeout = 4000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await wait(interval);
  }
}

module.exports = { createExtensionEnv, wait, waitFor };
