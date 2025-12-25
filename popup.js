// AI Bookmark - Popup Script
// Handles bookmark display and navigation

document.addEventListener('DOMContentLoaded', () => {
  const bookmarkList = document.getElementById('bookmark-list');
  const emptyState = document.getElementById('empty-state');
  const bookmarkCount = document.getElementById('bookmark-count');
  const clearAllBtn = document.getElementById('clear-all');

  // Platform display names
  const platformNames = {
    'chatgpt.com': 'ChatGPT',
    'claude.ai': 'Claude',
    'chat.deepseek.com': 'DeepSeek'
  };

  // Platform colors
  const platformColors = {
    'chatgpt.com': '#10a37f',
    'claude.ai': '#cc785c',
    'chat.deepseek.com': '#4a90e2'
  };

  // Load and display bookmarks
  function loadBookmarks() {
    chrome.runtime.sendMessage({ action: 'getBookmarks' }, (response) => {
      if (!response || !response.bookmarks) {
        showEmptyState();
        return;
      }

      const allBookmarks = [];
      Object.keys(response.bookmarks).forEach(platform => {
        response.bookmarks[platform].forEach(bookmark => {
          allBookmarks.push({ ...bookmark, platform });
        });
      });

      if (allBookmarks.length === 0) {
        showEmptyState();
        return;
      }

      // Sort by timestamp (newest first)
      allBookmarks.sort((a, b) => b.timestamp - a.timestamp);

      displayBookmarks(allBookmarks);
      updateCount(allBookmarks.length);
    });
  }

  // Show empty state
  function showEmptyState() {
    emptyState.style.display = 'flex';
    bookmarkList.style.display = 'none';
    updateCount(0);
  }

  // Display bookmarks
  function displayBookmarks(bookmarks) {
    emptyState.style.display = 'none';
    bookmarkList.style.display = 'block';
    bookmarkList.innerHTML = '';

    bookmarks.forEach(bookmark => {
      const item = createBookmarkItem(bookmark);
      bookmarkList.appendChild(item);
    });
  }

  // Create bookmark item element
  function createBookmarkItem(bookmark) {
    const item = document.createElement('div');
    item.className = 'bookmark-item';

    const platformBadge = document.createElement('div');
    platformBadge.className = 'platform-badge';
    platformBadge.textContent = platformNames[bookmark.platform] || bookmark.platform;
    platformBadge.style.backgroundColor = platformColors[bookmark.platform] || '#666';

    const content = document.createElement('div');
    content.className = 'bookmark-content';

    const text = document.createElement('div');
    text.className = 'bookmark-text';
    text.textContent = bookmark.messageText || 'No preview available';

    const meta = document.createElement('div');
    meta.className = 'bookmark-meta';
    const date = new Date(bookmark.timestamp);
    meta.textContent = formatDate(date);

    content.appendChild(text);
    content.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'bookmark-actions';

    const goBtn = document.createElement('button');
    goBtn.className = 'btn-go';
    goBtn.textContent = 'Go';
    goBtn.title = 'Navigate to this bookmark';
    goBtn.addEventListener('click', () => navigateToBookmark(bookmark));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete bookmark';
    deleteBtn.addEventListener('click', () => deleteBookmark(bookmark));

    actions.appendChild(goBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(platformBadge);
    item.appendChild(content);
    item.appendChild(actions);

    return item;
  }

  // Format date
  function formatDate(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  // Navigate to bookmark
  function navigateToBookmark(bookmark) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];

      // Check if we're on the right platform
      if (!currentTab.url.includes(bookmark.platform)) {
        // Open the bookmark URL in new tab
        chrome.tabs.create({ url: bookmark.url });
      } else {
        // Send message to content script to scroll to bookmark
        chrome.tabs.sendMessage(currentTab.id, {
          action: 'scrollToBookmark',
          bookmarkId: bookmark.id,
          messageIndex: bookmark.messageIndex,
          messageText: bookmark.messageText
        }, (response) => {
          if (response && response.success) {
            window.close(); // Close popup after navigation
          } else {
            // Show error message instead of reloading page
            alert('Could not find the bookmarked message on the current page. It may have been deleted or you might be in a different conversation.\n\nClick OK to open the bookmark in a new tab.');
            chrome.tabs.create({ url: bookmark.url });
          }
        });
      }
    });
  }

  // Delete bookmark
  function deleteBookmark(bookmark) {
    if (!confirm('Delete this bookmark?')) {
      return;
    }

    chrome.runtime.sendMessage({
      action: 'deleteBookmark',
      platform: bookmark.platform,
      bookmarkId: bookmark.id
    }, (response) => {
      if (response && response.success) {
        loadBookmarks(); // Reload list
      }
    });
  }

  // Update bookmark count
  function updateCount(count) {
    bookmarkCount.textContent = `${count} bookmark${count !== 1 ? 's' : ''}`;
  }

  // Clear all bookmarks
  clearAllBtn.addEventListener('click', () => {
    if (!confirm('Delete all bookmarks? This cannot be undone.')) {
      return;
    }

    chrome.runtime.sendMessage({ action: 'clearAllBookmarks' }, (response) => {
      if (response && response.success) {
        loadBookmarks();
      }
    });
  });

  // Initial load
  loadBookmarks();
});
