# AI Bookmark

A lightweight browser extension that allows you to bookmark important messages on AI chat platforms and easily navigate between them.

## Features

- **Multi-Platform Support**: Works seamlessly with ChatGPT, Claude, and DeepSeek
- **One-Click Bookmarking**: Click the star icon on any message to bookmark it
- **Visual Feedback**: Outlined star for unbookmarked messages, filled star for bookmarked ones
- **Persistent Storage**: All bookmarks are saved locally and persist across browser sessions
- **Easy Navigation**: Browse all bookmarks in the popup and jump to any message
- **Smart Highlighting**: Automatically highlights the target message when navigating
- **Dynamic Content Support**: Works with dynamically loaded messages
- **Clean UI**: Modern, intuitive interface with platform badges

## Supported Platforms

- **ChatGPT** (chat.openai.com, chatgpt.com)
- **Claude** (claude.ai)
- **DeepSeek** (chat.deepseek.com)

## Installation

### For Developers (Chrome/Edge)

1. Clone or download this repository
2. Open Chrome/Edge and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right corner)
4. Click "Load unpacked"
5. Select the extension directory (`ai-bookmark`)
6. The extension is now installed and ready to use

### For Developers (Firefox)

1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select the `manifest.json` file from the extension directory
5. The extension is now installed temporarily

## Usage

### Bookmarking Messages

1. Visit any supported platform (ChatGPT, Claude, or DeepSeek)
2. Hover over any message to see the star icon in the top-right corner
3. Click the star to bookmark the message (it will turn filled)
4. Click again to remove the bookmark (it will turn outlined)

### Viewing Bookmarks

1. Click the extension icon in your browser toolbar
2. All bookmarks will be displayed, grouped by recency
3. Each bookmark shows:
   - Platform badge (ChatGPT, Claude, or DeepSeek)
   - Message preview (first 200 characters)
   - Timestamp (e.g., "2h ago", "3d ago")

### Navigating to Bookmarks

1. Open the extension popup
2. Click the "Go" button next to any bookmark
3. The page will scroll to that message and highlight it briefly
4. If you're on a different platform, it will open the bookmark URL in a new tab

### Managing Bookmarks

- **Delete a bookmark**: Click the "×" button next to any bookmark
- **Clear all bookmarks**: Click the "Clear All" button at the bottom of the popup

## Technical Details

### Architecture

- **Manifest V3**: Modern Chrome extension architecture
- **Content Script** (`content.js`): Injects bookmark functionality into pages
- **Background Service Worker** (`background.js`): Handles message passing and storage
- **Popup** (`popup.html`, `popup.js`): User interface for managing bookmarks
- **Storage**: Uses `chrome.storage.local` for persistent bookmark data

### Storage Format

```javascript
{
  "bookmarks": {
    "chatgpt.com": [
      {
        "id": "unique-id",
        "url": "conversation-url",
        "messageText": "preview text...",
        "timestamp": 1703502000000,
        "messageIndex": 5
      }
    ],
    "claude.ai": [...],
    "chat.deepseek.com": [...]
  }
}
```

### Dynamic Content Handling

The extension uses `MutationObserver` to detect when new messages are added to the page, ensuring that bookmark functionality is available even for dynamically loaded content.

### Platform Detection

The extension automatically detects which platform you're on and uses the appropriate selectors:
- **ChatGPT**: `article[data-testid^="conversation-turn"]`
- **Claude**: `div[data-testid*="message"]`
- **DeepSeek**: `div.message` or `div[class*="message"]`

## File Structure

```
ai-bookmark/
├── manifest.json          # Extension configuration
├── content.js            # Content script for message detection
├── content.css           # Styles for bookmark stars
├── background.js         # Service worker for storage
├── popup.html           # Popup UI structure
├── popup.js             # Popup functionality
├── popup.css            # Popup styling
├── icons/
│   ├── star-empty.png   # Outlined star icon
│   └── star-filled.png  # Filled star icon
├── GS128.png            # Extension icon
├── README.md            # This file
├── LICENSE              # License information
└── .gitignore          # Git ignore rules
```

## Privacy

- **No Data Collection**: This extension does not collect or transmit any user data
- **Local Storage Only**: All bookmarks are stored locally on your device
- **No External Servers**: No communication with external servers
- **Open Source**: Full source code is available for review

## Permissions

The extension requires the following permissions:
- `storage`: To save bookmarks locally
- `activeTab`: To interact with the current tab
- `scripting`: To inject bookmark functionality
- `host_permissions`: To work on ChatGPT, Claude, and DeepSeek domains

## Limitations

- Bookmarks are tied to message IDs generated by the extension, not the platform
- If a conversation is deleted on the platform, the bookmark will still exist but won't navigate correctly
- Platform UI changes may require selector updates
- Temporary Firefox installation requires reload after browser restart

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the terms specified in the LICENSE file.

## Support

If you encounter any issues or have suggestions:
1. Check if the platform's UI has changed (may require selector updates)
2. Try reloading the extension
3. Open an issue on GitHub with details about the problem

## Changelog

### Version 1.0.0
- Initial release
- Support for ChatGPT, Claude, and DeepSeek
- Bookmark functionality with star icons
- Popup UI for navigation
- Persistent storage
- Dynamic content support
