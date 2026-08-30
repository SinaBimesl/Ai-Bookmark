// AI Bookmark - Shared core logic
//
// This file is deliberately free of DOM and chrome.* dependencies so that it can
// be loaded in three different places without modification:
//   * content script (via manifest content_scripts, before content.js)
//   * service worker  (via importScripts)
//   * popup           (via <script src>)
//   * node tests      (via require)
//
// It exposes itself as `globalThis.AIBookmarkCore` and as a CommonJS module.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.AIBookmarkCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /** Bump when the stored shape changes and a migration is required. */
  const SCHEMA_VERSION = 2;

  /** Preview text is truncated to this many characters before hashing/storing. */
  const PREVIEW_LENGTH = 200;

  const STORAGE_KEYS = {
    bookmarks: 'bookmarks',
    schemaVersion: 'schemaVersion'
  };

  /**
   * Platform registry.
   *
   * `messageSelectors` is an ordered list of candidate selector groups. The
   * content script uses the first group that actually matches something in the
   * live document, which keeps the extension working when a platform ships a
   * markup change that only breaks the most specific selector.
   */
  const PLATFORMS = [
    {
      id: 'chatgpt.com',
      label: 'ChatGPT',
      color: '#10a37f',
      hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'],
      messageSelectors: [
        'article[data-testid^="conversation-turn"]',
        '[data-message-author-role]',
        'div[data-testid^="conversation-turn"]'
      ],
      // https://chatgpt.com/c/<uuid>  and  /g/<gpt>/c/<uuid>
      conversationPatterns: [/\/c\/([^/?#]+)/, /\/chat\/([^/?#]+)/]
    },
    {
      id: 'claude.ai',
      label: 'Claude',
      color: '#cc785c',
      hosts: ['claude.ai'],
      messageSelectors: [
        '[data-testid="user-message"], .font-claude-message, .font-claude-response',
        'div[data-test-render-count] > div',
        'div.mb-1.mt-6.group, div.group.relative.pb-3'
      ],
      // https://claude.ai/chat/<uuid>
      conversationPatterns: [/\/chat\/([^/?#]+)/, /\/project\/([^/?#]+)/]
    },
    {
      id: 'chat.deepseek.com',
      label: 'DeepSeek',
      color: '#4a90e2',
      hosts: ['chat.deepseek.com', 'deepseek.com'],
      messageSelectors: [
        'div[class*="_message"]',
        'div.message, div[class*="message"]'
      ],
      // https://chat.deepseek.com/a/chat/s/<id>
      conversationPatterns: [/\/chat\/s\/([^/?#]+)/, /\/a\/chat\/([^/?#]+)/]
    }
  ];

  const PLATFORMS_BY_ID = PLATFORMS.reduce((acc, p) => {
    acc[p.id] = p;
    return acc;
  }, Object.create(null));

  /** All platform ids, in registry order. */
  const PLATFORM_IDS = PLATFORMS.map((p) => p.id);

  function getPlatformById(id) {
    return PLATFORMS_BY_ID[id] || null;
  }

  function platformLabel(id) {
    const p = getPlatformById(id);
    return p ? p.label : id;
  }

  function platformColor(id) {
    const p = getPlatformById(id);
    return p ? p.color : '#666666';
  }

  /**
   * Resolve a hostname to a platform definition.
   * Matches the exact host or any subdomain of a registered host, never a
   * substring (so `notchatgpt.com.evil.test` does not match).
   */
  function detectPlatform(hostname) {
    if (typeof hostname !== 'string' || !hostname) return null;
    const host = hostname.toLowerCase().replace(/\.$/, '');
    for (const platform of PLATFORMS) {
      for (const candidate of platform.hosts) {
        if (host === candidate || host.endsWith('.' + candidate)) {
          return platform;
        }
      }
    }
    return null;
  }

  function parseUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
      return new URL(url);
    } catch (_err) {
      return null;
    }
  }

  function detectPlatformFromUrl(url) {
    const parsed = parseUrl(url);
    return parsed ? detectPlatform(parsed.hostname) : null;
  }

  /**
   * Extract a stable conversation identifier from a URL.
   *
   * Message ids are scoped by this value, which is what stops "message #3" in
   * one chat from colliding with "message #3" in another chat.
   */
  function getConversationId(url, platform) {
    const parsed = parseUrl(url);
    if (!parsed) return 'unknown';
    const def = platform || detectPlatform(parsed.hostname);
    const patterns = (def && def.conversationPatterns) || [];
    for (const pattern of patterns) {
      const match = parsed.pathname.match(pattern);
      if (match && match[1]) return decodeURIComponent(match[1]);
    }
    // No known conversation route: fall back to the normalized path so that at
    // least distinct pages stay distinct. `/` maps to "root".
    const path = parsed.pathname.replace(/\/+$/, '');
    return path ? path : 'root';
  }

  /** True when both URLs point at the same conversation on the same platform. */
  function isSameConversation(urlA, urlB) {
    const a = detectPlatformFromUrl(urlA);
    const b = detectPlatformFromUrl(urlB);
    if (!a || !b || a.id !== b.id) return false;
    return getConversationId(urlA, a) === getConversationId(urlB, b);
  }

  /** Collapse whitespace and truncate to the preview length. */
  function normalizeText(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
  }

  /** FNV-1a 32-bit, rendered as 8 lowercase hex chars. Stable across runtimes. */
  function hashText(text) {
    const input = typeof text === 'string' ? text : String(text == null ? '' : text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      // hash *= 16777619, kept in 32-bit range without overflowing the mantissa
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * Build a stable message id.
   *
   * Format: `v2|<platform>|<conversation>|<textHash>|<occurrence>`
   *
   * Content-derived rather than position-derived, so lazily loading older
   * messages (which shifts every DOM index) does not invalidate bookmarks.
   * `occurrence` disambiguates messages whose preview text is identical.
   */
  function makeMessageId(parts) {
    const platformId = parts.platformId || 'unknown';
    const conversationId = parts.conversationId || 'unknown';
    const textHash = parts.textHash || hashText(normalizeText(parts.text || ''));
    const occurrence = Number.isInteger(parts.occurrence) ? parts.occurrence : 0;
    return ['v2', platformId, conversationId, textHash, occurrence].join('|');
  }

  /** Legacy (v1) ids looked like `claude.ai-msg-4`. */
  function isLegacyId(id) {
    return typeof id === 'string' && /-msg-\d+$/.test(id) && id.indexOf('|') === -1;
  }

  /** Parse a v2 id back into its parts, or null if it is not a v2 id. */
  function parseMessageId(id) {
    if (typeof id !== 'string') return null;
    const parts = id.split('|');
    if (parts.length !== 5 || parts[0] !== 'v2') return null;
    const occurrence = Number(parts[4]);
    return {
      platformId: parts[1],
      conversationId: parts[2],
      textHash: parts[3],
      occurrence: Number.isFinite(occurrence) ? occurrence : 0
    };
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  /**
   * Validate + normalize one stored record. Returns null for unusable entries so
   * that a single corrupt row cannot break the whole popup.
   */
  function sanitizeBookmark(raw, platformId) {
    if (!raw || typeof raw !== 'object') return null;
    const id = isNonEmptyString(raw.id) ? raw.id : null;
    if (!id) return null;

    const platform = isNonEmptyString(raw.platform)
      ? raw.platform
      : isNonEmptyString(platformId)
        ? platformId
        : null;
    if (!platform) return null;

    const url = isNonEmptyString(raw.url) ? raw.url : '';
    const messageText = normalizeText(raw.messageText || '');
    const timestamp = Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();
    const parsedId = parseMessageId(id);

    const conversationId = isNonEmptyString(raw.conversationId)
      ? raw.conversationId
      : parsedId
        ? parsedId.conversationId
        : url
          ? getConversationId(url)
          : 'unknown';

    const textHash = isNonEmptyString(raw.textHash)
      ? raw.textHash
      : parsedId
        ? parsedId.textHash
        : hashText(messageText);

    const occurrence = Number.isInteger(raw.occurrence)
      ? raw.occurrence
      : parsedId
        ? parsedId.occurrence
        : 0;

    const messageIndex = Number.isInteger(raw.messageIndex) ? raw.messageIndex : null;

    return {
      id,
      platform,
      conversationId,
      url,
      title: isNonEmptyString(raw.title) ? raw.title.slice(0, PREVIEW_LENGTH) : '',
      messageText,
      textHash,
      occurrence,
      messageIndex,
      role: isNonEmptyString(raw.role) ? raw.role : '',
      timestamp,
      legacyId: isLegacyId(id)
    };
  }

  /** An empty, well-formed store keyed by every known platform. */
  function emptyStore() {
    const store = {};
    for (const id of PLATFORM_IDS) store[id] = [];
    return store;
  }

  /**
   * Coerce whatever is in storage into a valid store: drops junk, fills in
   * missing v2 fields on legacy records, and removes duplicate ids (the oldest
   * timestamp wins so that re-bookmarking never resets the original date).
   */
  function normalizeStore(raw) {
    const store = emptyStore();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;

    for (const platformId of Object.keys(raw)) {
      const list = raw[platformId];
      if (!Array.isArray(list)) continue;
      if (!store[platformId]) store[platformId] = [];

      const seen = new Map();
      for (const entry of list) {
        const bookmark = sanitizeBookmark(entry, platformId);
        if (!bookmark) continue;
        const existing = seen.get(bookmark.id);
        if (existing) {
          // Keep the earliest creation time, prefer the richer preview text.
          existing.timestamp = Math.min(existing.timestamp, bookmark.timestamp);
          if (!existing.messageText && bookmark.messageText) {
            existing.messageText = bookmark.messageText;
          }
          if (!existing.url && bookmark.url) existing.url = bookmark.url;
          continue;
        }
        seen.set(bookmark.id, bookmark);
      }
      store[platformId] = Array.from(seen.values());
    }
    return store;
  }

  /** Deep-ish clone of a store (records are flat objects). */
  function cloneStore(store) {
    const next = {};
    for (const key of Object.keys(store)) {
      next[key] = store[key].map((b) => Object.assign({}, b));
    }
    return next;
  }

  /**
   * Insert or update a bookmark. Idempotent: bookmarking the same message twice
   * (double click, duplicate message from a racing observer) updates the
   * existing record instead of appending a second copy.
   */
  function upsertBookmark(store, rawBookmark) {
    const bookmark = sanitizeBookmark(rawBookmark);
    if (!bookmark) return { store, changed: false, duplicate: false, bookmark: null };

    const next = cloneStore(store);
    if (!next[bookmark.platform]) next[bookmark.platform] = [];

    const list = next[bookmark.platform];
    const index = list.findIndex((b) => b.id === bookmark.id);
    if (index === -1) {
      list.push(bookmark);
      return { store: next, changed: true, duplicate: false, bookmark };
    }

    const merged = Object.assign({}, list[index], bookmark, {
      timestamp: list[index].timestamp
    });
    const unchanged = JSON.stringify(merged) === JSON.stringify(list[index]);
    list[index] = merged;
    return { store: next, changed: !unchanged, duplicate: true, bookmark: merged };
  }

  /** Remove one bookmark. When `platformId` is falsy, every platform is searched. */
  function removeBookmark(store, platformId, id) {
    if (!isNonEmptyString(id)) return { store, changed: false };
    const next = cloneStore(store);
    const targets = platformId && next[platformId] ? [platformId] : Object.keys(next);
    let changed = false;
    for (const key of targets) {
      const before = next[key].length;
      next[key] = next[key].filter((b) => b.id !== id);
      if (next[key].length !== before) changed = true;
    }
    return { store: next, changed };
  }

  function findBookmark(store, id) {
    for (const key of Object.keys(store)) {
      const found = store[key].find((b) => b.id === id);
      if (found) return found;
    }
    return null;
  }

  function countBookmarks(store) {
    return Object.keys(store).reduce((total, key) => total + store[key].length, 0);
  }

  /** All bookmarks across platforms, newest first (ties broken by id for stability). */
  function flattenBookmarks(store) {
    const all = [];
    for (const key of Object.keys(store)) {
      for (const bookmark of store[key]) all.push(bookmark);
    }
    all.sort((a, b) => (b.timestamp - a.timestamp) || a.id.localeCompare(b.id));
    return all;
  }

  /** Case-insensitive substring filter over preview text, title, and platform label. */
  function filterBookmarks(bookmarks, query) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!needle) return bookmarks.slice();
    return bookmarks.filter((b) => {
      const haystack = [b.messageText, b.title, platformLabel(b.platform), b.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  const MINUTE = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;

  /** Human-friendly relative time. Future timestamps clamp to "Just now". */
  function formatRelativeTime(timestamp, now) {
    const then = Number(timestamp);
    if (!Number.isFinite(then)) return '';
    const reference = Number.isFinite(now) ? now : Date.now();
    const diff = reference - then;
    if (diff < MINUTE) return 'Just now';
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
    if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
    if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
    return new Date(then).toLocaleDateString();
  }

  /**
   * Given DOM elements matched by a selector group, keep only the outermost
   * ones. Nested matches are the main source of duplicate stars on DeepSeek,
   * whose `div[class*="message"]` selector matches both a turn and its children.
   *
   * Elements only need a `contains(other)` method, which keeps this testable.
   */
  function filterOutermost(elements) {
    const list = Array.from(elements || []);
    if (list.length < 2) return list;
    const set = new Set(list);

    // Walking ancestors is O(n * depth); the contains() fallback below is
    // O(n^2) and only used for objects without a parent chain.
    if (list.every((el) => el && 'parentElement' in Object(el))) {
      return list.filter((el) => {
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (set.has(parent)) return false;
        }
        return true;
      });
    }

    return list.filter(
      (el, i) =>
        !list.some(
          (other, j) =>
            j !== i && other !== el && typeof other.contains === 'function' && other.contains(el)
        )
    );
  }

  /**
   * Assign occurrence numbers to a list of message texts in document order, so
   * that two identical messages in the same conversation get distinct ids.
   * Returns an array of `{ text, textHash, occurrence }`.
   */
  function describeMessages(texts) {
    const counts = new Map();
    return (texts || []).map((raw) => {
      const text = normalizeText(raw);
      const textHash = hashText(text);
      const occurrence = counts.get(textHash) || 0;
      counts.set(textHash, occurrence + 1);
      return { text, textHash, occurrence };
    });
  }

  return {
    SCHEMA_VERSION,
    PREVIEW_LENGTH,
    STORAGE_KEYS,
    PLATFORMS,
    PLATFORM_IDS,
    getPlatformById,
    platformLabel,
    platformColor,
    detectPlatform,
    detectPlatformFromUrl,
    parseUrl,
    getConversationId,
    isSameConversation,
    normalizeText,
    hashText,
    makeMessageId,
    parseMessageId,
    isLegacyId,
    sanitizeBookmark,
    emptyStore,
    normalizeStore,
    cloneStore,
    upsertBookmark,
    removeBookmark,
    findBookmark,
    countBookmarks,
    flattenBookmarks,
    filterBookmarks,
    formatRelativeTime,
    filterOutermost,
    describeMessages
  };
});
