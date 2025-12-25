// Message Bookmark Navigator - Background Service Worker
// Handles message passing and storage coordination

chrome.runtime.onInstalled.addListener(() => {
  console.log('Message Bookmark Navigator installed');

  // Initialize storage if needed
  chrome.storage.local.get(['bookmarks'], (result) => {
    if (!result.bookmarks) {
      chrome.storage.local.set({
        bookmarks: {
          'chatgpt.com': [],
          'claude.ai': [],
          'chat.deepseek.com': []
        }
      });
    }
  });
});

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getBookmarks') {
    chrome.storage.local.get(['bookmarks'], (result) => {
      sendResponse({ bookmarks: result.bookmarks || {} });
    });
    return true; // Keep channel open for async response
  }

  if (request.action === 'deleteBookmark') {
    const { platform, bookmarkId } = request;
    chrome.storage.local.get(['bookmarks'], (result) => {
      const bookmarks = result.bookmarks || {};
      if (bookmarks[platform]) {
        bookmarks[platform] = bookmarks[platform].filter(b => b.id !== bookmarkId);
        chrome.storage.local.set({ bookmarks }, () => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false });
      }
    });
    return true;
  }

  if (request.action === 'clearAllBookmarks') {
    chrome.storage.local.set({
      bookmarks: {
        'chatgpt.com': [],
        'claude.ai': [],
        'chat.deepseek.com': []
      }
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Monitor storage changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.bookmarks) {
    console.log('Bookmarks updated:', changes.bookmarks.newValue);
  }
});
