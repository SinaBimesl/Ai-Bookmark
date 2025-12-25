// Message Bookmark Navigator - Content Script
// Detects platform, adds bookmark stars, handles storage

(function() {
  'use strict';

  // Platform detection
  const hostname = window.location.hostname;
  let platform = '';
  let messageSelector = '';

  if (hostname.includes('openai.com') || hostname.includes('chatgpt.com')) {
    platform = 'chatgpt.com';
    messageSelector = 'article[data-testid^="conversation-turn"]';
  } else if (hostname.includes('claude.ai')) {
    platform = 'claude.ai';
    messageSelector = 'div[data-testid*="message"], div.font-claude-message';
  } else if (hostname.includes('deepseek.com')) {
    platform = 'chat.deepseek.com';
    messageSelector = 'div.message, div[class*="message"]';
  }

  // Store processed messages to avoid duplicates
  const processedMessages = new WeakSet();
  let bookmarkedIds = new Set();

  // Load existing bookmarks from storage
  function loadBookmarks() {
    chrome.storage.local.get(['bookmarks'], (result) => {
      if (result.bookmarks && result.bookmarks[platform]) {
        bookmarkedIds = new Set(result.bookmarks[platform].map(b => b.id));
        updateExistingStars();
      }
    });
  }

  // Update stars for already bookmarked messages
  function updateExistingStars() {
    const messages = document.querySelectorAll(messageSelector);
    messages.forEach(msg => {
      const star = msg.querySelector('.bookmark-star');
      if (star) {
        const messageId = msg.dataset.bookmarkId;
        if (bookmarkedIds.has(messageId)) {
          star.src = chrome.runtime.getURL('icons/star-filled.png');
          star.dataset.bookmarked = 'true';
        }
      }
    });
  }

  // Generate unique ID for message
  function generateMessageId(element, index) {
    return `${platform}-${index}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Extract message text
  function getMessageText(element) {
    const text = element.innerText || element.textContent || '';
    return text.trim().substring(0, 200);
  }

  // Add bookmark functionality to a message
  function addStarButton(messageElement, index) {
    if (processedMessages.has(messageElement)) {
      return;
    }
    processedMessages.add(messageElement);

    // Generate or retrieve message ID
    if (!messageElement.dataset.bookmarkId) {
      messageElement.dataset.bookmarkId = generateMessageId(messageElement, index);
    }
    const messageId = messageElement.dataset.bookmarkId;

    // Create star button
    const star = document.createElement('img');
    star.className = 'bookmark-star';
    star.src = chrome.runtime.getURL('icons/star-empty.png');
    star.dataset.bookmarked = 'false';
    star.dataset.messageId = messageId;

    // Check if already bookmarked
    if (bookmarkedIds.has(messageId)) {
      star.src = chrome.runtime.getURL('icons/star-filled.png');
      star.dataset.bookmarked = 'true';
    }

    // Click handler
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBookmark(star, messageElement);
    });

    // Position the star
    messageElement.style.position = 'relative';
    messageElement.appendChild(star);
  }

  // Toggle bookmark state
  function toggleBookmark(star, messageElement) {
    const messageId = star.dataset.messageId;
    const isBookmarked = star.dataset.bookmarked === 'true';

    if (isBookmarked) {
      // Remove bookmark
      removeBookmark(messageId);
      star.src = chrome.runtime.getURL('icons/star-empty.png');
      star.dataset.bookmarked = 'false';
      bookmarkedIds.delete(messageId);
    } else {
      // Add bookmark
      const bookmark = {
        id: messageId,
        url: window.location.href,
        messageText: getMessageText(messageElement),
        timestamp: Date.now(),
        messageIndex: Array.from(document.querySelectorAll(messageSelector)).indexOf(messageElement)
      };
      addBookmark(bookmark);
      star.src = chrome.runtime.getURL('icons/star-filled.png');
      star.dataset.bookmarked = 'true';
      bookmarkedIds.add(messageId);
    }
  }

  // Add bookmark to storage
  function addBookmark(bookmark) {
    chrome.storage.local.get(['bookmarks'], (result) => {
      const bookmarks = result.bookmarks || {};
      if (!bookmarks[platform]) {
        bookmarks[platform] = [];
      }
      bookmarks[platform].push(bookmark);
      chrome.storage.local.set({ bookmarks }, () => {
        console.log('Bookmark added:', bookmark);
      });
    });
  }

  // Remove bookmark from storage
  function removeBookmark(messageId) {
    chrome.storage.local.get(['bookmarks'], (result) => {
      const bookmarks = result.bookmarks || {};
      if (bookmarks[platform]) {
        bookmarks[platform] = bookmarks[platform].filter(b => b.id !== messageId);
        chrome.storage.local.set({ bookmarks }, () => {
          console.log('Bookmark removed:', messageId);
        });
      }
    });
  }

  // Process existing messages
  function processExistingMessages() {
    const messages = document.querySelectorAll(messageSelector);
    messages.forEach((msg, index) => {
      addStarButton(msg, index);
    });
  }

  // Set up MutationObserver for dynamic content
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldProcess = false;

      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches && node.matches(messageSelector)) {
              shouldProcess = true;
            } else if (node.querySelectorAll) {
              const messages = node.querySelectorAll(messageSelector);
              if (messages.length > 0) {
                shouldProcess = true;
              }
            }
          }
        });
      });

      if (shouldProcess) {
        setTimeout(processExistingMessages, 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Listen for navigation requests from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scrollToBookmark') {
      const messageElement = document.querySelector(`[data-bookmark-id="${request.bookmarkId}"]`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Highlight effect
        messageElement.classList.add('bookmark-highlight');
        setTimeout(() => {
          messageElement.classList.remove('bookmark-highlight');
        }, 2000);

        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Message not found' });
      }
    }
    return true;
  });

  // Initialize
  function init() {
    console.log(`Message Bookmark Navigator loaded on ${platform}`);
    loadBookmarks();

    // Wait for initial content to load
    setTimeout(() => {
      processExistingMessages();
      setupObserver();
    }, 1000);
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
