'use strict';

// Loads the real background.js into a fresh VM realm with a mock chrome API,
// so the navigation orchestration can be tested end to end.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');

function createEventTarget() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) {
      listeners.push(fn);
    },
    async emit(...args) {
      for (const listener of listeners.slice()) await listener(...args);
    }
  };
}

function createStorageArea(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    data,
    get(keys, callback) {
      const result = {};
      for (const key of [].concat(keys)) {
        if (key in data) result[key] = JSON.parse(JSON.stringify(data[key]));
      }
      if (typeof callback === 'function') {
        setTimeout(() => callback(result), 0);
        return undefined;
      }
      return Promise.resolve(result);
    },
    set(items, callback) {
      Object.assign(data, JSON.parse(JSON.stringify(items)));
      if (typeof callback === 'function') {
        setTimeout(callback, 0);
        return undefined;
      }
      return Promise.resolve();
    }
  };
}

/**
 * @param {object} options
 * @param {Array}  [options.tabs]  initial tabs: { id, url, windowId }
 * @param {object} [options.initialStorage]
 * @param {Set}    [options.tabsWithContentScript] tab ids that already answer `ping`
 */
function createWorkerEnv(options = {}) {
  const tabs = (options.tabs || []).map((tab) => Object.assign({ windowId: 1 }, tab));
  const withContentScript = options.tabsWithContentScript || new Set(tabs.map((t) => t.id));
  const local = createStorageArea(options.initialStorage);
  const session = createStorageArea();

  const calls = {
    created: [],
    updated: [],
    injected: [],
    messages: [],
    badge: [],
    windowsFocused: []
  };

  let nextTabId = Math.max(0, ...tabs.map((t) => t.id)) + 1;

  const onUpdated = createEventTarget();
  const onRemoved = createEventTarget();
  const onMessage = createEventTarget();
  const onInstalled = createEventTarget();
  const onStartup = createEventTarget();
  const onChanged = createEventTarget();

  const chrome = {
    runtime: {
      id: 'test-worker',
      lastError: null,
      onMessage,
      onInstalled,
      onStartup
    },
    storage: {
      local,
      session: options.noSessionStorage
        ? undefined
        : {
            get: (keys) => session.get(keys),
            set: (items) => session.set(items)
          },
      onChanged
    },
    action: {
      setBadgeText: async (details) => {
        calls.badge.push(details.text);
      },
      setBadgeBackgroundColor: async () => {}
    },
    windows: {
      update: async (windowId) => {
        calls.windowsFocused.push(windowId);
      }
    },
    scripting: {
      insertCSS: async () => {},
      executeScript: async ({ target }) => {
        calls.injected.push(target.tabId);
        withContentScript.add(target.tabId);
      }
    },
    tabs: {
      onUpdated,
      onRemoved,
      query(info, callback) {
        let result = tabs.slice();
        if (info.active) result = result.filter((t) => t.active);
        if (info.url) {
          const patterns = [].concat(info.url).map((pattern) => {
            const escaped = pattern
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/^\\?\*:\/\//, 'https?://')
              .replace(/\*/g, '.*');
            return new RegExp(`^${escaped}`);
          });
          result = result.filter((t) => patterns.some((re) => re.test(t.url)));
        }
        callback(result);
      },
      create(info, callback) {
        const tab = { id: nextTabId++, url: info.url, active: true, windowId: 1 };
        tabs.push(tab);
        calls.created.push(info.url);
        callback(tab);
      },
      update(id, info, callback) {
        const tab = tabs.find((t) => t.id === id);
        if (tab) Object.assign(tab, info);
        calls.updated.push({ id, info });
        callback(tab);
      },
      get(id, callback) {
        callback(tabs.find((t) => t.id === id));
      },
      sendMessage(tabId, message, callback) {
        calls.messages.push({ tabId, message });
        if (!withContentScript.has(tabId)) {
          chrome.runtime.lastError = { message: 'Could not establish connection.' };
          callback(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        if (message.action === 'ping') {
          callback({ ready: true });
          return;
        }
        if (message.action === 'scrollToBookmark') {
          const handler = options.onScroll || (() => ({ success: true }));
          callback(handler(tabId, message));
          return;
        }
        callback(undefined);
      }
    }
  };

  const sandbox = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    importScripts(...files) {
      for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {
          filename: file
        });
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, {
    filename: 'background.js'
  });

  /** Send a message to the worker's onMessage listener, as the popup would. */
  function send(message) {
    return new Promise((resolve, reject) => {
      const listener = onMessage.listeners[0];
      if (!listener) {
        reject(new Error('background.js registered no message listener'));
        return;
      }
      const keepOpen = listener(message, { id: 'test' }, resolve);
      if (keepOpen !== true) resolve(undefined);
    });
  }

  return { chrome, tabs, calls, local, session, send, onUpdated, onRemoved, withContentScript };
}

module.exports = { createWorkerEnv };
