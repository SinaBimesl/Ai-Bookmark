// AI Bookmark - Background Service Worker
//
// Responsibilities:
//   * own the single writer to chrome.storage (see lib/store.js)
//   * route messages from the popup and content scripts
//   * orchestrate "go to bookmark" navigation, which has to survive the popup
//     closing and the service worker being torn down mid-flight

/* global importScripts, AIBookmarkCore, AIBookmarkStore, AIBookmarkHandlers */
'use strict';

importScripts('lib/core.js', 'lib/store.js', 'lib/handlers.js');

const Core = AIBookmarkCore;
const store = AIBookmarkStore.createStore({
  area: chrome.storage.local,
  runtime: chrome.runtime
});

/** Session key holding per-tab "scroll here once the page is ready" intents. */
const PENDING_KEY = 'pendingScroll';
/** Intents older than this are considered abandoned. */
const PENDING_TTL_MS = 60000;

/* ------------------------------------------------------------------ */
/* Small promise wrappers around callback-style chrome APIs            */
/* ------------------------------------------------------------------ */

function lastError() {
  return chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : null;
}

function callAsync(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        const err = lastError();
        if (err) reject(err);
        else resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

const tabsQuery = (info) => callAsync(chrome.tabs.query.bind(chrome.tabs), info);
const tabsCreate = (info) => callAsync(chrome.tabs.create.bind(chrome.tabs), info);
const tabsUpdate = (id, info) => callAsync(chrome.tabs.update.bind(chrome.tabs), id, info);
const tabsGet = (id) => callAsync(chrome.tabs.get.bind(chrome.tabs), id);

function sendTabMessage(tabId, message) {
  return callAsync(chrome.tabs.sendMessage.bind(chrome.tabs), tabId, message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

async function refreshBadge(count) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  try {
    const total = Number.isFinite(count) ? count : Core.countBookmarks(await store.read());
    await chrome.action.setBadgeText({ text: total > 0 ? String(Math.min(total, 999)) : '' });
    if (chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: '#667eea' });
    }
  } catch (_err) {
    // Badge updates are cosmetic; never let them break a storage operation.
  }
}

/* ------------------------------------------------------------------ */
/* Content script availability                                         */
/* ------------------------------------------------------------------ */

/**
 * Tabs that were already open when the extension was installed or reloaded do
 * not have a content script. Ping first, and inject on demand rather than
 * telling the user "message not found".
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await sendTabMessage(tabId, { action: 'ping' });
    if (pong && pong.ready) return true;
  } catch (_err) {
    // No receiver yet - fall through to injection.
  }

  if (!chrome.scripting) return false;

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (_err) {
    // CSS may already be present; not fatal.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/core.js', 'content.js']
    });
  } catch (_err) {
    return false;
  }

  try {
    const pong = await sendTabMessage(tabId, { action: 'ping' });
    return Boolean(pong && pong.ready);
  } catch (_err) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Pending scroll intents (survive service-worker restarts)            */
/* ------------------------------------------------------------------ */

// In-memory mirror, used when chrome.storage.session is unavailable (older
// Chrome, some Chromium forks). Session storage is still preferred because it
// survives the service worker being suspended mid-navigation.
let memoryPending = {};

async function readPending() {
  if (!chrome.storage.session) return memoryPending;
  try {
    const result = await chrome.storage.session.get([PENDING_KEY]);
    return result[PENDING_KEY] || {};
  } catch (_err) {
    return memoryPending;
  }
}

async function writePending(map) {
  memoryPending = map;
  if (!chrome.storage.session) return;
  try {
    await chrome.storage.session.set({ [PENDING_KEY]: map });
  } catch (_err) {
    // Session storage is best-effort; the in-memory mirror still applies.
  }
}

async function setPendingScroll(tabId, bookmark) {
  const map = await readPending();
  const now = Date.now();
  // Drop stale entries so the map cannot grow without bound.
  for (const key of Object.keys(map)) {
    if (!map[key] || now - map[key].createdAt > PENDING_TTL_MS) delete map[key];
  }
  map[String(tabId)] = { bookmark, createdAt: now };
  await writePending(map);
}

async function takePendingScroll(tabId) {
  const map = await readPending();
  const entry = map[String(tabId)];
  if (!entry) return null;
  delete map[String(tabId)];
  await writePending(map);
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
  return entry.bookmark;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function scrollPayload(bookmark) {
  return {
    action: 'scrollToBookmark',
    bookmark: {
      id: bookmark.id,
      platform: bookmark.platform,
      conversationId: bookmark.conversationId,
      url: bookmark.url,
      messageText: bookmark.messageText,
      textHash: bookmark.textHash,
      occurrence: bookmark.occurrence,
      messageIndex: bookmark.messageIndex
    }
  };
}

/** Deliver a scroll request, injecting the content script if necessary. */
async function deliverScroll(tabId, bookmark, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ready = await ensureContentScript(tabId);
    if (ready) {
      try {
        const response = await sendTabMessage(tabId, scrollPayload(bookmark));
        if (response && response.success) return { success: true };
        if (response && response.error) return { success: false, error: response.error };
      } catch (_err) {
        // Receiver went away mid-navigation; retry.
      }
    }
    await delay(400 * (attempt + 1));
  }
  return { success: false, error: 'Could not reach the page.' };
}

/**
 * Find the best tab for a bookmark:
 *   1. a tab already showing that exact conversation (reuse + focus)
 *   2. otherwise a new tab (never hijack the tab the user is reading)
 */
async function resolveTargetTab(bookmark) {
  const targetUrl = bookmark.url;
  const platform = Core.detectPlatformFromUrl(targetUrl);
  if (!platform || !targetUrl) return { tab: null, freshNavigation: false };

  const patterns = platform.hosts.map((host) => `*://${host}/*`);
  let candidates = [];
  try {
    candidates = await tabsQuery({ url: patterns });
  } catch (_err) {
    candidates = [];
  }

  const existing = candidates.find((tab) => Core.isSameConversation(tab.url, targetUrl));
  if (existing) {
    try {
      await tabsUpdate(existing.id, { active: true });
      if (chrome.windows && existing.windowId != null) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    } catch (_err) {
      // Focusing is best-effort.
    }
    return { tab: existing, freshNavigation: false };
  }

  const created = await tabsCreate({ url: targetUrl, active: true });
  return { tab: created, freshNavigation: true };
}

async function openBookmark(rawBookmark) {
  const bookmark = Core.sanitizeBookmark(rawBookmark);
  if (!bookmark) return { success: false, error: 'Invalid bookmark.' };
  if (!bookmark.url) return { success: false, error: 'This bookmark has no saved URL.' };

  const { tab, freshNavigation } = await resolveTargetTab(bookmark);
  if (!tab || tab.id == null) {
    return { success: false, error: 'Could not open the conversation.' };
  }

  if (freshNavigation) {
    // The page is still loading. Record the intent so tabs.onUpdated can finish
    // the job even if this service worker is suspended in the meantime.
    await setPendingScroll(tab.id, bookmark);
    return { success: true, pending: true, tabId: tab.id };
  }

  const outcome = await deliverScroll(tab.id, bookmark);
  if (!outcome.success) {
    // The tab is on the right conversation but the message never showed up
    // (collapsed history, deleted message). Leave the tab focused and report.
    return { success: false, error: outcome.error || 'Message not found on the page.' };
  }
  return { success: true, pending: false, tabId: tab.id };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const bookmark = await takePendingScroll(tabId);
  if (!bookmark) return;

  try {
    const tab = await tabsGet(tabId);
    if (!tab || !Core.isSameConversation(tab.url, bookmark.url)) return;
  } catch (_err) {
    return;
  }
  // Give the SPA a moment to render its message list before asking for a scroll.
  await delay(600);
  await deliverScroll(tabId, bookmark, 5);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await readPending();
  if (map[String(tabId)]) {
    delete map[String(tabId)];
    await writePending(map);
  }
});

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

const handlers = AIBookmarkHandlers.createHandlers({
  store,
  onCountChange: refreshBadge,
  extra: {
    async openBookmark(request) {
      return openBookmark(request && request.bookmark);
    }
  }
});

chrome.runtime.onMessage.addListener(AIBookmarkHandlers.createListener(handlers, console));

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  try {
    const migrated = await store.migrate();
    await refreshBadge(Core.countBookmarks(migrated));
  } catch (err) {
    console.error('[AI Bookmark] storage migration failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[Core.STORAGE_KEYS.bookmarks]) return;
  refreshBadge();
});

// Run once when the worker spins up, so the badge is correct even if neither
// onInstalled nor onStartup fires in this session.
bootstrap();
