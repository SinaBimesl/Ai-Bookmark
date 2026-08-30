# AI Bookmark

A lightweight browser extension that lets you bookmark important messages on AI chat platforms and jump straight back to them.

## Features

- **Multi-Platform Support**: ChatGPT, Claude, and DeepSeek
- **One-Click Bookmarking**: Click the star on any message to bookmark it
- **Stable Bookmarks**: Bookmarks are anchored to message content and the conversation they belong to, so they survive page reloads and lazily loaded history
- **Smart Navigation**: Reuses a tab already showing the conversation, otherwise opens it, waits for it to load, then scrolls and highlights the message
- **Search**: Filter bookmarks by message text, platform, or URL
- **Undo**: Deleting a bookmark (or clearing them all) can be undone from the popup
- **Live Sync**: Stars, the popup list, and the toolbar badge all stay in sync
- **Keyboard Accessible**: Stars are real buttons with `aria-pressed` state
- **Dark Mode**: The popup follows the system colour scheme

## Supported Platforms

- **ChatGPT** (chat.openai.com, chatgpt.com)
- **Claude** (claude.ai)
- **DeepSeek** (chat.deepseek.com)

## Installation

### Chrome / Edge

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the extension directory

> **Firefox note:** the manifest uses `background.service_worker`, which Firefox does not yet support in MV3. Firefox needs a `background.scripts` variant of the manifest.

## Usage

### Bookmarking

Hover a message and click the star in its top-right corner. A filled star means the message is bookmarked; click again to remove it. While a response is still streaming the star is temporarily disabled, so a bookmark never captures half an answer.

### Viewing and searching

Click the toolbar icon. Bookmarks are listed newest first with a platform badge, preview text, and relative timestamp. The badge on the toolbar icon shows the total count. Type in the search box to filter.

### Navigating

Click **Go** (or the row itself):

1. If a tab is already open on that conversation, it is focused and scrolled to the message.
2. Otherwise the conversation opens in a new tab; once it finishes loading the extension scrolls to and highlights the message.
3. If the message genuinely cannot be found, the popup says so instead of guessing.

### Managing

- **Delete**: the **×** button, with an **Undo** in the toast that follows
- **Clear all**: **Clear All**, confirmed inline in the popup (also undoable)

## Technical Details

### Architecture

```
lib/core.js        Pure logic: platform registry, id generation, store
                   normalization, formatting. No DOM, no chrome.* calls.
lib/store.js       Storage layer. Serializes every read-modify-write on a
                   promise queue so concurrent writes cannot clobber each other.
lib/handlers.js    Message-router handlers, shared by the worker and the tests.
background.js      Service worker: owns storage, routes messages, orchestrates
                   navigation, keeps the badge current.
content.js         Injects stars, tracks SPA navigation, answers scroll requests.
popup.js           List UI, search, undo, live storage sync.
```

`lib/core.js` is a UMD module: it is loaded as a content script, via `importScripts` in the worker, via `<script>` in the popup, and via `require` in tests — one implementation everywhere.

**The service worker is the only writer to `chrome.storage`.** Content scripts and the popup send messages instead of writing directly, which removes the read-modify-write races that lose bookmarks when two tabs act at the same time.

### Message ids

An id looks like:

```
v2|claude.ai|<conversationId>|<textHash>|<occurrence>
```

- **conversationId** is parsed from the URL, so message #3 in one chat never collides with message #3 in another.
- **textHash** is an FNV-1a hash of the normalized first 200 characters, so ids do not shift when older messages load in above.
- **occurrence** disambiguates messages whose preview text is identical.

v1 ids (`claude.ai-msg-3`) are migrated automatically on first run: the conversation id is recovered from the stored URL and duplicate rows are collapsed.

### Storage format

```javascript
{
  "schemaVersion": 2,
  "bookmarks": {
    "claude.ai": [
      {
        "id": "v2|claude.ai|conv-1|1a2b3c4d|0",
        "platform": "claude.ai",
        "conversationId": "conv-1",
        "url": "https://claude.ai/chat/conv-1",
        "title": "Conversation title",
        "messageText": "preview text…",
        "textHash": "1a2b3c4d",
        "occurrence": 0,
        "messageIndex": 5,
        "timestamp": 1703502000000
      }
    ],
    "chatgpt.com": [],
    "chat.deepseek.com": []
  }
}
```

Anything malformed in storage is dropped on read rather than breaking the popup.

### Finding messages

Each platform declares an ordered list of candidate selectors; the content script uses the most specific one that actually matches the live page, so a markup change on one platform degrades instead of breaking. Nested matches are reduced to the outermost element, which is what keeps DeepSeek from getting a star per nesting level.

When scrolling to a bookmark, the content script tries, in order: exact id → content hash + occurrence → preview text → DOM index (only within the same conversation), retrying for a few seconds while the SPA renders. It never falls back to a positional guess across conversations.

## Development

```bash
npm install     # jsdom, for the DOM tests
npm run lint    # syntax, manifest integrity, asset references
npm test        # 90 tests
npm run check   # both
npm run smoke   # optional: real headless Chromium end-to-end run
```

Tests are `node:test` + jsdom, with no build step:

| File | Covers |
| --- | --- |
| `test/core.test.js` | platform detection, ids, store normalization, formatting |
| `test/store.test.js` | write serialization, migration, storage error propagation |
| `test/handlers.test.js` | message-router contract |
| `test/content.test.js` | the real content script against simulated ChatGPT / Claude / DeepSeek DOMs |
| `test/popup.test.js` | the real popup against the real handlers |
| `test/background.test.js` | the real service worker in a VM with a mock `chrome` API |
| `test/smoke/browser-smoke.js` | opt-in: the packed extension in headless Chromium against a stand-in chatgpt.com (needs `chromium` and `openssl`; skips cleanly without them) |

## Privacy

- **No Data Collection**: nothing is collected or transmitted
- **Local Storage Only**: bookmarks live in `chrome.storage.local` on your device
- **No External Servers**
- **Open Source**

## Permissions

- `storage` — save bookmarks locally
- `activeTab` — interact with the current tab
- `scripting` — inject the content script into tabs that were open before the extension was installed
- `host_permissions` — run on the supported chat domains only

Extension resources are exposed only to the supported chat domains, not to every site.

## Limitations

- Bookmarks are anchored to message content; heavily edited or regenerated messages may need re-bookmarking
- If a conversation is deleted on the platform, its bookmarks remain but cannot be navigated to
- Platform markup changes may still require selector updates
- Firefox needs a manifest variant (see Installation)

## Contributing

Issues and pull requests are welcome. Please run `npm run check` before submitting.

## License

See the LICENSE file.

## Changelog

### Version 1.1.0

- Conversation-scoped, content-derived message ids; v1 bookmarks are migrated automatically
- All storage writes serialized through the service worker; duplicate bookmarks are no longer possible
- Navigation reuses an existing tab, waits for load, and retries instead of guessing at a message
- Stars are keyboard-accessible buttons and stay in sync with storage changes
- SPA route changes are detected and stars rebuilt for the new conversation
- Popup gains search, undo, inline confirmation, dark mode, and inline error reporting
- Extension resources restricted to the supported domains
- Added a lint script and a 90-test suite

### Version 1.0.0

- Initial release
