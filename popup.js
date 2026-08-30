// AI Bookmark - Popup Script
//
// Renders the bookmark list, delegates every mutation to the service worker,
// and stays in sync with storage while it is open.

/* global AIBookmarkCore */
(function () {
  'use strict';

  const Core = window.AIBookmarkCore;

  const el = {
    list: document.getElementById('bookmark-list'),
    emptyState: document.getElementById('empty-state'),
    noResults: document.getElementById('no-results'),
    count: document.getElementById('bookmark-count'),
    search: document.getElementById('search'),
    status: document.getElementById('status'),
    clearAll: document.getElementById('clear-all'),
    confirmBar: document.getElementById('confirm-bar'),
    confirmClear: document.getElementById('confirm-clear'),
    cancelClear: document.getElementById('cancel-clear'),
    toast: document.getElementById('toast'),
    toastText: document.getElementById('toast-text'),
    toastAction: document.getElementById('toast-action')
  };

  let allBookmarks = [];
  let query = '';
  let statusTimer = null;
  let toastTimer = null;
  let undoHandler = null;

  /* ---------------------------------------------------------------- */
  /* Messaging                                                         */
  /* ---------------------------------------------------------------- */

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false, error: 'No response from the extension.' });
        });
      } catch (err) {
        resolve({ success: false, error: err && err.message ? err.message : String(err) });
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Status + toast                                                    */
  /* ---------------------------------------------------------------- */

  function showStatus(message) {
    el.status.textContent = message;
    el.status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      el.status.hidden = true;
    }, 6000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    el.toast.hidden = true;
    el.toastAction.hidden = true;
    undoHandler = null;
  }

  function showToast(message, onUndo) {
    el.toastText.textContent = message;
    el.toast.hidden = false;
    undoHandler = onUndo || null;
    el.toastAction.hidden = !undoHandler;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  el.toastAction.addEventListener('click', () => {
    const handler = undoHandler;
    hideToast();
    if (handler) handler();
  });

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function updateCount(count) {
    el.count.textContent = `${count} bookmark${count === 1 ? '' : 's'}`;
  }

  function conversationLabel(bookmark) {
    if (bookmark.title) return bookmark.title;
    const parsed = Core.parseUrl(bookmark.url);
    return parsed ? parsed.hostname + parsed.pathname : '';
  }

  function createBookmarkItem(bookmark) {
    const item = document.createElement('li');
    item.className = 'bookmark-item';
    item.dataset.id = bookmark.id;

    const badge = document.createElement('span');
    badge.className = 'platform-badge';
    badge.textContent = Core.platformLabel(bookmark.platform);
    badge.style.backgroundColor = Core.platformColor(bookmark.platform);

    const content = document.createElement('div');
    content.className = 'bookmark-content';

    const text = document.createElement('div');
    text.className = 'bookmark-text';
    text.textContent = bookmark.messageText || 'No preview available';
    text.title = bookmark.messageText || '';

    const meta = document.createElement('div');
    meta.className = 'bookmark-meta';
    meta.textContent = Core.formatRelativeTime(bookmark.timestamp);
    const context = conversationLabel(bookmark);
    if (context) {
      const separator = document.createElement('span');
      separator.className = 'meta-sep';
      separator.textContent = '·';
      const source = document.createElement('span');
      source.className = 'meta-source';
      source.textContent = context;
      source.title = bookmark.url || '';
      meta.appendChild(separator);
      meta.appendChild(source);
    }

    content.appendChild(text);
    content.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'bookmark-actions';

    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'btn-go';
    goBtn.textContent = 'Go';
    goBtn.title = 'Open this message';
    goBtn.setAttribute('aria-label', 'Open this bookmarked message');
    goBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      navigateToBookmark(bookmark, goBtn);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete bookmark';
    deleteBtn.setAttribute('aria-label', 'Delete this bookmark');
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteBookmark(bookmark);
    });

    actions.appendChild(goBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(badge);
    item.appendChild(content);
    item.appendChild(actions);

    // The whole row is a click target, which matches what people expect from a
    // bookmark list.
    content.addEventListener('click', () => navigateToBookmark(bookmark, goBtn));

    return item;
  }

  function render() {
    const visible = Core.filterBookmarks(allBookmarks, query);
    updateCount(allBookmarks.length);

    const hasAny = allBookmarks.length > 0;
    const hasVisible = visible.length > 0;

    el.emptyState.hidden = hasAny;
    el.noResults.hidden = !hasAny || hasVisible;
    el.list.hidden = !hasVisible;
    el.clearAll.disabled = !hasAny;

    const fragment = document.createDocumentFragment();
    for (const bookmark of visible) fragment.appendChild(createBookmarkItem(bookmark));
    el.list.replaceChildren(fragment);
  }

  async function loadBookmarks() {
    const response = await sendMessage({ action: 'getBookmarks' });
    if (!response || response.success === false || !response.bookmarks) {
      allBookmarks = [];
      render();
      showStatus(
        (response && response.error) || 'Could not read bookmarks. Try reloading the extension.'
      );
      return;
    }
    allBookmarks = Core.flattenBookmarks(Core.normalizeStore(response.bookmarks));
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  async function navigateToBookmark(bookmark, button) {
    if (button) button.disabled = true;
    const response = await sendMessage({ action: 'openBookmark', bookmark });
    if (button) button.disabled = false;

    if (response && response.success) {
      window.close();
      return;
    }
    showStatus(
      (response && response.error) ||
        'Could not find that message. The conversation may have changed.'
    );
  }

  async function deleteBookmark(bookmark) {
    const response = await sendMessage({
      action: 'removeBookmark',
      platform: bookmark.platform,
      bookmarkId: bookmark.id
    });

    if (!response || response.success === false) {
      showStatus((response && response.error) || 'Could not delete that bookmark.');
      return;
    }

    // Optimistic local update; the storage listener will reconcile.
    allBookmarks = allBookmarks.filter((b) => b.id !== bookmark.id);
    render();

    showToast('Bookmark deleted.', async () => {
      const restore = await sendMessage({ action: 'restoreBookmark', bookmark });
      if (!restore || restore.success === false) {
        showStatus('Could not restore that bookmark.');
        return;
      }
      loadBookmarks();
    });
  }

  el.search.addEventListener('input', () => {
    query = el.search.value;
    render();
  });

  el.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.search.value) {
      event.stopPropagation();
      el.search.value = '';
      query = '';
      render();
    }
  });

  el.clearAll.addEventListener('click', () => {
    el.confirmBar.hidden = false;
    el.clearAll.hidden = true;
    el.confirmClear.focus();
  });

  el.cancelClear.addEventListener('click', () => {
    el.confirmBar.hidden = true;
    el.clearAll.hidden = false;
    el.clearAll.focus();
  });

  el.confirmClear.addEventListener('click', async () => {
    const snapshot = allBookmarks.slice();
    el.confirmBar.hidden = true;
    el.clearAll.hidden = false;

    const response = await sendMessage({ action: 'clearAllBookmarks' });
    if (!response || response.success === false) {
      showStatus((response && response.error) || 'Could not clear bookmarks.');
      return;
    }

    allBookmarks = [];
    render();
    showToast(`Deleted ${snapshot.length} bookmark${snapshot.length === 1 ? '' : 's'}.`, async () => {
      for (const bookmark of snapshot) {
        await sendMessage({ action: 'restoreBookmark', bookmark });
      }
      loadBookmarks();
    });
  });

  // Keep the list correct when a page adds or removes a bookmark while the
  // popup is open.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[Core.STORAGE_KEYS.bookmarks]) return;
      allBookmarks = Core.flattenBookmarks(
        Core.normalizeStore(changes[Core.STORAGE_KEYS.bookmarks].newValue)
      );
      render();
    });
  }

  loadBookmarks();
})();
