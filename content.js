// AI Bookmark - Content Script
//
// Adds a bookmark star to every message turn, keeps star state in sync with
// storage, and handles "scroll to bookmark" requests from the popup.
//
// Requires lib/core.js to have been loaded first (see manifest content_scripts).

/* global AIBookmarkCore */
(function () {
  'use strict';

  // The service worker can inject this file into tabs that were already open.
  // Bail out if a manifest-injected copy is already running here.
  if (globalThis.__aiBookmarkContentLoaded) return;
  globalThis.__aiBookmarkContentLoaded = true;

  const Core = globalThis.AIBookmarkCore;
  if (!Core) {
    console.error('[AI Bookmark] core library missing; content script disabled.');
    return;
  }

  const platform = Core.detectPlatform(location.hostname);
  if (!platform) return;

  const CLASS = {
    container: 'ai-bm-star-container',
    button: 'ai-bm-star',
    icon: 'ai-bm-star-icon',
    highlight: 'ai-bm-highlight',
    toast: 'ai-bm-toast'
  };

  const SCAN_DEBOUNCE_MS = 200;
  const SCAN_MAX_WAIT_MS = 1000;
  /** Re-scan delay used while a message is still streaming in. */
  const UNSTABLE_RESCAN_MS = 700;
  const HIGHLIGHT_MS = 2000;

  /** Per-element bookmark state; garbage collected with the DOM node. */
  const elementState = new WeakMap();

  let conversationId = Core.getConversationId(location.href, platform);
  let currentUrl = location.href;
  let bookmarkedIds = new Set();
  let activeSelector = platform.messageSelectors[platform.messageSelectors.length - 1];
  let observer = null;
  let scanTimer = null;
  let scanMaxTimer = null;
  let unstableTimer = null;
  let highlightTimer = null;
  let toastTimer = null;
  let disposed = false;

  /* ---------------------------------------------------------------- */
  /* chrome.* safety helpers                                           */
  /* ---------------------------------------------------------------- */

  /**
   * After the extension is reloaded or updated, this script keeps running in
   * the page but every chrome.* call throws "Extension context invalidated".
   */
  function isContextAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_err) {
      return false;
    }
  }

  function iconUrl(name) {
    try {
      return chrome.runtime.getURL(`icons/${name}`);
    } catch (_err) {
      return '';
    }
  }

  /** Promise wrapper that resolves to null instead of throwing on transport errors. */
  function sendMessage(message) {
    return new Promise((resolve) => {
      if (!isContextAlive()) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (_err) {
        resolve(null);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Message discovery                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Platforms change their markup without notice, so each platform ships an
   * ordered list of candidate selectors. Use the most specific one that
   * actually matches; fall back to the broadest.
   */
  function resolveSelector() {
    for (const selector of platform.messageSelectors) {
      try {
        if (document.querySelector(selector)) {
          activeSelector = selector;
          return selector;
        }
      } catch (_err) {
        // Ignore selectors the browser cannot parse.
      }
    }
    return activeSelector;
  }

  function queryMessages() {
    const selector = resolveSelector();
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (_err) {
      return [];
    }
    // Broad selectors (notably DeepSeek's) match nested containers as well as
    // the turn itself, which used to produce a star on every nesting level.
    return Core.filterOutermost(nodes);
  }

  /**
   * `textContent` rather than `innerText`: it does not force layout (cheap to
   * call on every scan) and, unlike innerText, it does not change when the page
   * collapses or virtualizes content - which matters because the text is hashed
   * into the bookmark id.
   */
  function getMessageText(element) {
    // The injected star contributes no text nodes (icon + aria-label only), so
    // it cannot pollute the hash.
    return Core.normalizeText(element.textContent || '');
  }

  /* ---------------------------------------------------------------- */
  /* Star rendering                                                    */
  /* ---------------------------------------------------------------- */

  function applyStarState(state) {
    const bookmarked = bookmarkedIds.has(state.id);
    state.button.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
    state.button.dataset.bookmarked = bookmarked ? 'true' : 'false';
    state.button.title = bookmarked ? 'Remove bookmark' : 'Bookmark this message';
    state.button.setAttribute(
      'aria-label',
      bookmarked ? 'Remove bookmark from this message' : 'Bookmark this message'
    );
    if (state.container) state.container.dataset.bookmarked = bookmarked ? 'true' : 'false';
    const url = iconUrl(bookmarked ? 'star-filled.png' : 'star-empty.png');
    if (url && state.icon.getAttribute('src') !== url) state.icon.setAttribute('src', url);
  }

  function createStar(element) {
    const container = document.createElement('div');
    container.className = CLASS.container;
    // Keep the injected node out of the page's own accessibility/DOM queries
    // as much as possible.
    container.setAttribute('data-ai-bookmark', 'container');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = CLASS.button;
    button.setAttribute('aria-pressed', 'false');

    const icon = document.createElement('img');
    icon.className = CLASS.icon;
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    icon.draggable = false;
    const url = iconUrl('star-empty.png');
    if (url) icon.src = url;

    button.appendChild(icon);
    container.appendChild(button);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      const state = elementState.get(element);
      if (state) toggleBookmark(state);
    });
    // Stop the platform's own row handlers from reacting to our button.
    button.addEventListener('mousedown', (event) => event.stopPropagation());

    try {
      const computed = window.getComputedStyle(element);
      if (computed.position === 'static') {
        element.style.setProperty('position', 'relative', 'important');
      }
      element.appendChild(container);
    } catch (_err) {
      return null;
    }

    return { container, button, icon };
  }

  /* ---------------------------------------------------------------- */
  /* Scanning                                                          */
  /* ---------------------------------------------------------------- */

  function scan() {
    if (disposed) return;
    if (!isContextAlive()) {
      // The extension was reloaded or updated. Stop observing instead of
      // spinning forever against a dead runtime.
      dispose();
      return;
    }
    clearTimeout(scanTimer);
    clearTimeout(scanMaxTimer);
    scanTimer = null;
    scanMaxTimer = null;

    if (detectNavigation()) return; // reset() re-schedules a scan

    const elements = queryMessages();
    const described = Core.describeMessages(elements.map(getMessageText));
    let sawUnstable = false;

    elements.forEach((element, index) => {
      const info = described[index];
      let state = elementState.get(element);

      let firstSight = false;
      if (!state) {
        firstSight = true;
        state = { element, id: null, text: '', textHash: '', occurrence: 0, index, pending: false };
        elementState.set(element, state);
      }

      // A message whose text changed between two scans is still streaming in.
      // Its id would bake in half a response, so leave the star disabled until
      // the text settles. Newly discovered messages get a star immediately and
      // are re-checked on the follow-up scan.
      const settled = firstSight || state.observedHash === info.textHash;
      if (!settled || firstSight) sawUnstable = true;
      state.observedHash = info.textHash;
      state.index = index;

      if (!settled) {
        if (state.button) {
          state.button.disabled = true;
          state.button.title = 'Waiting for the response to finish…';
        }
        return;
      }

      state.text = info.text;
      state.textHash = info.textHash;
      state.occurrence = info.occurrence;
      state.id = Core.makeMessageId({
        platformId: platform.id,
        conversationId,
        textHash: info.textHash,
        occurrence: info.occurrence
      });

      element.dataset.aiBookmarkId = state.id;

      const attached =
        state.container && state.container.isConnected && state.container.parentNode === element;
      if (!attached) {
        const parts = createStar(element);
        if (!parts) return;
        state.container = parts.container;
        state.button = parts.button;
        state.icon = parts.icon;
      }

      if (!state.pending) state.button.disabled = false;
      applyStarState(state);
    });

    clearTimeout(unstableTimer);
    if (sawUnstable) {
      unstableTimer = setTimeout(scan, UNSTABLE_RESCAN_MS);
    }
  }

  /** Trailing debounce with a max wait, so a streaming response cannot starve scans. */
  function scheduleScan() {
    if (disposed) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
    if (!scanMaxTimer) {
      scanMaxTimer = setTimeout(scan, SCAN_MAX_WAIT_MS);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Bookmark toggling                                                 */
  /* ---------------------------------------------------------------- */

  async function toggleBookmark(state) {
    if (!state.id || state.pending) return;
    if (!isContextAlive()) {
      showToast('Reload the page to use AI Bookmark again.');
      return;
    }

    const wasBookmarked = bookmarkedIds.has(state.id);
    state.pending = true;
    state.button.disabled = true;

    // Optimistic update, rolled back if the write fails.
    if (wasBookmarked) bookmarkedIds.delete(state.id);
    else bookmarkedIds.add(state.id);
    applyStarState(state);

    let response;
    if (wasBookmarked) {
      response = await sendMessage({
        action: 'removeBookmark',
        platform: platform.id,
        bookmarkId: state.id
      });
    } else {
      response = await sendMessage({
        action: 'addBookmark',
        bookmark: {
          id: state.id,
          platform: platform.id,
          conversationId,
          url: location.href,
          title: Core.normalizeText(document.title),
          messageText: state.text,
          textHash: state.textHash,
          occurrence: state.occurrence,
          messageIndex: state.index,
          timestamp: Date.now()
        }
      });
    }

    state.pending = false;
    state.button.disabled = false;

    if (!response || response.success === false) {
      if (wasBookmarked) bookmarkedIds.add(state.id);
      else bookmarkedIds.delete(state.id);
      applyStarState(state);
      showToast(
        wasBookmarked ? 'Could not remove the bookmark.' : 'Could not save the bookmark.'
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Storage sync                                                      */
  /* ---------------------------------------------------------------- */

  function idsFromStore(store) {
    const list = (store && store[platform.id]) || [];
    const ids = new Set();
    for (const bookmark of list) {
      if (!bookmark || !bookmark.id) continue;
      // Only track bookmarks belonging to the conversation on screen; ids from
      // other conversations can never match an element here.
      if (bookmark.conversationId && bookmark.conversationId !== conversationId) continue;
      ids.add(bookmark.id);
    }
    return ids;
  }

  function refreshAllStars() {
    for (const element of queryMessages()) {
      const state = elementState.get(element);
      if (state && state.button && state.id) applyStarState(state);
    }
  }

  async function loadBookmarks() {
    const response = await sendMessage({ action: 'getBookmarks' });
    if (!response || !response.bookmarks) return;
    bookmarkedIds = idsFromStore(response.bookmarks);
    refreshAllStars();
  }

  function watchStorage() {
    if (!isContextAlive() || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (disposed || areaName !== 'local') return;
      const change = changes[Core.STORAGE_KEYS.bookmarks];
      if (!change) return;
      bookmarkedIds = idsFromStore(change.newValue);
      refreshAllStars();
    });
  }

  /* ---------------------------------------------------------------- */
  /* SPA navigation                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * These sites are single-page apps: switching conversations never reloads the
   * document, so ids computed for the previous conversation have to be dropped.
   * Returns true when a reset was triggered.
   */
  function detectNavigation() {
    if (location.href === currentUrl) return false;
    currentUrl = location.href;
    const nextConversation = Core.getConversationId(location.href, platform);
    if (nextConversation === conversationId) return false;
    conversationId = nextConversation;
    reset();
    return true;
  }

  function reset() {
    // Remove stale stars; the next scan rebuilds them with fresh ids.
    document.querySelectorAll(`.${CLASS.container}`).forEach((node) => {
      try {
        node.remove();
      } catch (_err) {
        /* node already detached */
      }
    });
    bookmarkedIds = new Set();
    loadBookmarks();
    scheduleScan();
  }

  function watchNavigation() {
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
    // Chrome's Navigation API fires for SPA route changes that never touch
    // popstate. Falls back to the MutationObserver-driven URL check elsewhere.
    if (typeof navigation !== 'undefined' && navigation && navigation.addEventListener) {
      try {
        navigation.addEventListener('navigatesuccess', scheduleScan);
      } catch (_err) {
        /* not supported */
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scroll to bookmark                                                */
  /* ---------------------------------------------------------------- */

  function findMessageElement(target) {
    const elements = queryMessages();
    if (!elements.length) return null;

    // 1. Exact id match (the common case).
    if (target.id) {
      const byId = elements.find((el) => el.dataset.aiBookmarkId === target.id);
      if (byId) return byId;
    }

    const described = Core.describeMessages(elements.map(getMessageText));

    // 2. Content hash + occurrence: recovers bookmarks whose id no longer
    //    matches (an identical message appeared earlier, or the bookmark
    //    predates the current id format).
    if (target.textHash) {
      const occurrence = Number.isInteger(target.occurrence) ? target.occurrence : 0;
      let index = described.findIndex(
        (d) => d.textHash === target.textHash && d.occurrence === occurrence
      );
      if (index === -1) {
        index = described.findIndex((d) => d.textHash === target.textHash);
      }
      if (index !== -1) return elements[index];
    }

    // 3. Preview text match.
    if (target.messageText) {
      const needle = Core.normalizeText(target.messageText);
      const index = described.findIndex((d) => d.text === needle);
      if (index !== -1) return elements[index];
    }

    // 4. Positional fallback - only trustworthy inside the same conversation.
    const sameConversation =
      !target.conversationId ||
      target.conversationId === 'unknown' ||
      target.conversationId === conversationId;
    if (sameConversation && Number.isInteger(target.messageIndex)) {
      const el = elements[target.messageIndex];
      if (el) return el;
    }

    return null;
  }

  function highlight(element) {
    clearTimeout(highlightTimer);
    document
      .querySelectorAll(`.${CLASS.highlight}`)
      .forEach((node) => node.classList.remove(CLASS.highlight));
    element.classList.add(CLASS.highlight);
    highlightTimer = setTimeout(() => {
      element.classList.remove(CLASS.highlight);
    }, HIGHLIGHT_MS);
  }

  /**
   * The popup may ask for a message before the SPA has rendered its history, so
   * retry for a few seconds instead of failing on the first miss.
   */
  function scrollToBookmark(target, sendResponse) {
    const deadline = Date.now() + 6000;

    const attempt = () => {
      if (disposed) {
        sendResponse({ success: false, error: 'Page is no longer available.' });
        return;
      }
      const element = findMessageElement(target);
      if (element) {
        try {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_err) {
          element.scrollIntoView();
        }
        highlight(element);
        sendResponse({ success: true });
        return;
      }
      if (Date.now() >= deadline) {
        sendResponse({ success: false, error: 'Message not found on this page.' });
        return;
      }
      setTimeout(attempt, 400);
    };

    attempt();
  }

  /* ---------------------------------------------------------------- */
  /* Toast                                                             */
  /* ---------------------------------------------------------------- */

  function showToast(message) {
    const host = document.body || document.documentElement;
    if (!host) return;
    let toast = document.querySelector(`.${CLASS.toast}`);
    if (!toast || !toast.isConnected) {
      toast = document.createElement('div');
      toast.className = CLASS.toast;
      toast.setAttribute('role', 'status');
      host.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('ai-bm-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('ai-bm-toast-visible');
    }, 3200);
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  function setupObserver() {
    observer = new MutationObserver((mutations) => {
      if (disposed) return;
      for (const mutation of mutations) {
        // Ignore the mutations we cause ourselves.
        const target = mutation.target;
        if (
          target &&
          target.nodeType === Node.ELEMENT_NODE &&
          typeof target.closest === 'function' &&
          target.closest(`.${CLASS.container}`)
        ) {
          continue;
        }
        scheduleScan();
        return;
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function dispose() {
    disposed = true;
    if (observer) observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(scanMaxTimer);
    clearTimeout(unstableTimer);
    clearTimeout(highlightTimer);
    clearTimeout(toastTimer);
  }

  function onExtensionMessage(request, _sender, sendResponse) {
    if (!request || typeof request.action !== 'string') return false;

    if (request.action === 'ping') {
      sendResponse({ ready: true, platform: platform.id, conversationId });
      return false;
    }

    if (request.action === 'scrollToBookmark') {
      // Accept both the current payload and the legacy flat shape.
      const target = request.bookmark || {
        id: request.bookmarkId,
        messageIndex: request.messageIndex,
        messageText: request.messageText
      };
      scrollToBookmark(target, sendResponse);
      return true; // async response
    }

    // Not ours: close the channel so other listeners can answer.
    return false;
  }

  function init() {
    try {
      chrome.runtime.onMessage.addListener(onExtensionMessage);
    } catch (_err) {
      // Runtime already gone; the stars below simply stay inert.
    }
    watchStorage();
    watchNavigation();
    loadBookmarks();
    scan();
    setupObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
