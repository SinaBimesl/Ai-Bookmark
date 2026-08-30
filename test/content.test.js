'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../lib/core.js');
const { createExtensionEnv, wait, waitFor } = require('./helpers/extension-env.js');

/** Markup shaped like a ChatGPT conversation. */
function chatgptHtml(messages) {
  const turns = messages
    .map(
      (text, i) =>
        `<article data-testid="conversation-turn-${i}"><div class="body">${text}</div></article>`
    )
    .join('');
  return `<!doctype html><html><body><main>${turns}</main></body></html>`;
}

/** Markup shaped like DeepSeek, where the message selector matches nested nodes. */
function deepseekHtml(messages) {
  const turns = messages
    .map(
      (text) =>
        `<div class="ds-message"><div class="message-content"><span>${text}</span></div></div>`
    )
    .join('');
  return `<!doctype html><html><body><div id="root">${turns}</div></body></html>`;
}

async function starsReady(env, expected) {
  return waitFor(async () => {
    const stars = env.stars();
    return stars.length === expected ? stars : null;
  });
}

/** Wait until a click has actually been persisted, not just optimistically shown. */
async function storeCount(env, platform, expected) {
  return waitFor(async () => {
    const stored = await env.readStore();
    return (stored[platform] || []).length === expected ? stored : null;
  });
}

test('adds one star per message turn', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['First question', 'First answer', 'Second question'])
  });
  t.after(() => env.close());

  const stars = await starsReady(env, 3);
  assert.equal(stars.length, 3);
  for (const star of stars) {
    assert.equal(star.tagName, 'BUTTON', 'the star must be a real button for keyboard use');
    assert.equal(star.getAttribute('aria-pressed'), 'false');
    assert.ok(star.getAttribute('aria-label'));
  }
});

test('does not put a star on nested matches', async (t) => {
  // Regression: DeepSeek's broad `div[class*="message"]` selector matched both
  // the turn and its inner content div, producing two stars per message.
  const env = await createExtensionEnv({
    url: 'https://chat.deepseek.com/a/chat/s/sess-1',
    html: deepseekHtml(['Hello', 'World'])
  });
  t.after(() => env.close());

  const stars = await starsReady(env, 2);
  assert.equal(stars.length, 2);
  assert.equal(env.document.querySelectorAll('.ai-bm-star-container').length, 2);
});

test('rescans when messages are added dynamically', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['One'])
  });
  t.after(() => env.close());

  await starsReady(env, 1);

  const main = env.document.querySelector('main');
  const article = env.document.createElement('article');
  article.setAttribute('data-testid', 'conversation-turn-1');
  article.textContent = 'Two';
  main.appendChild(article);

  const stars = await starsReady(env, 2);
  assert.equal(stars.length, 2);
});

test('clicking a star persists a bookmark and flips the icon', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Remember this answer'])
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  star.click();

  await waitFor(async () => star.getAttribute('aria-pressed') === 'true');

  const stored = await storeCount(env, 'chatgpt.com', 1);
  const bookmark = stored['chatgpt.com'][0];
  assert.equal(bookmark.messageText, 'Remember this answer');
  assert.equal(bookmark.conversationId, 'conv-1');
  assert.equal(bookmark.platform, 'chatgpt.com');
  assert.equal(bookmark.url, 'https://chatgpt.com/c/conv-1');
  assert.match(star.querySelector('img').src, /star-filled\.png$/);
});

test('clicking twice removes the bookmark', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Toggle me'])
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  star.click();
  await storeCount(env, 'chatgpt.com', 1);

  star.click();
  await waitFor(async () => star.getAttribute('aria-pressed') === 'false');

  assert.equal(Core.countBookmarks(await env.readStore()), 0);
  assert.match(star.querySelector('img').src, /star-empty\.png$/);
});

test('rapid double clicks never create two rows for one message', async (t) => {
  // Regression: the old click handler had no in-flight guard and addBookmark()
  // pushed unconditionally.
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Double click me'])
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  star.click();
  star.click();
  star.click();

  await wait(300);
  const stored = await env.readStore();
  assert.equal(stored['chatgpt.com'].length, 1);
});

test('bookmarks in other conversations do not light up this page', async (t) => {
  // Regression: v1 ids were `${platform}-msg-${index}`, so bookmarking message
  // #0 anywhere made message #0 look bookmarked everywhere.
  const otherId = Core.makeMessageId({
    platformId: 'chatgpt.com',
    conversationId: 'some-other-conversation',
    text: 'A message'
  });

  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['A message']),
    initialStorage: {
      bookmarks: {
        'chatgpt.com': [
          {
            id: otherId,
            platform: 'chatgpt.com',
            conversationId: 'some-other-conversation',
            url: 'https://chatgpt.com/c/some-other-conversation',
            messageText: 'A message',
            timestamp: 1
          }
        ]
      }
    }
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  await wait(200);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
});

test('existing bookmarks are restored as filled stars on load', async (t) => {
  const conversationId = 'conv-1';
  const text = 'Saved earlier';
  const id = Core.makeMessageId({ platformId: 'chatgpt.com', conversationId, text });

  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Something else', text]),
    initialStorage: {
      bookmarks: {
        'chatgpt.com': [
          {
            id,
            platform: 'chatgpt.com',
            conversationId,
            url: 'https://chatgpt.com/c/conv-1',
            messageText: text,
            timestamp: 1
          }
        ]
      }
    }
  });
  t.after(() => env.close());

  const stars = await starsReady(env, 2);
  await waitFor(async () => stars[1].getAttribute('aria-pressed') === 'true');
  assert.equal(stars[0].getAttribute('aria-pressed'), 'false');
});

test('ids survive older messages being prepended', async (t) => {
  // Regression: ids derived from the DOM index changed whenever lazily loaded
  // history shifted every message up, orphaning previously saved bookmarks.
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Newest message'])
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  star.click();
  const idBefore = (await storeCount(env, 'chatgpt.com', 1))['chatgpt.com'][0].id;

  const main = env.document.querySelector('main');
  const older = env.document.createElement('article');
  older.setAttribute('data-testid', 'conversation-turn-older');
  older.textContent = 'Older message loaded by scrolling up';
  main.insertBefore(older, main.firstChild);

  const stars = await starsReady(env, 2);
  await wait(300);

  assert.equal(stars[0].getAttribute('aria-pressed'), 'false', 'older message is not bookmarked');
  assert.equal(stars[1].getAttribute('aria-pressed'), 'true', 'the bookmark stays on its message');
  assert.equal((await env.readStore())['chatgpt.com'][0].id, idBefore);
});

test('deleting a bookmark elsewhere empties the star', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Sync me'])
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  star.click();
  const stored = await storeCount(env, 'chatgpt.com', 1);
  await env.store.remove('chatgpt.com', stored['chatgpt.com'][0].id);

  // Regression: the content script never listened to storage changes, so a
  // deletion from the popup left a filled star behind.
  await waitFor(async () => star.getAttribute('aria-pressed') === 'false');
});

test('SPA navigation to another conversation rebuilds stars with new ids', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Shared message text'])
  });
  t.after(() => env.close());

  const [star] = await starsReady(env, 1);
  star.click();
  await storeCount(env, 'chatgpt.com', 1);

  // Simulate a client-side route change into a different conversation that
  // happens to contain the same text.
  env.window.history.pushState({}, '', '/c/conv-2');
  const main = env.document.querySelector('main');
  main.replaceChildren();
  const article = env.document.createElement('article');
  article.setAttribute('data-testid', 'conversation-turn-0');
  article.textContent = 'Shared message text';
  main.appendChild(article);

  const stars = await starsReady(env, 1);
  await wait(400);
  assert.equal(
    stars[0].getAttribute('aria-pressed'),
    'false',
    'a bookmark from conv-1 must not appear bookmarked in conv-2'
  );
});

test('scrollToBookmark finds the message by id and highlights it', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Alpha', 'Bravo', 'Charlie'])
  });
  t.after(() => env.close());

  const stars = await starsReady(env, 3);
  stars[2].click();
  const bookmark = (await storeCount(env, 'chatgpt.com', 1))['chatgpt.com'][0];
  const response = await env.sendToContent({ action: 'scrollToBookmark', bookmark });

  assert.equal(response.success, true);
  assert.equal(env.scrolledInto.length, 1);
  assert.equal(env.scrolledInto[0].textContent.includes('Charlie'), true);
  assert.equal(env.scrolledInto[0].classList.contains('ai-bm-highlight'), true);
});

test('scrollToBookmark falls back to the content hash when the id is stale', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Alpha', 'Bravo'])
  });
  t.after(() => env.close());

  await starsReady(env, 2);

  const response = await env.sendToContent({
    action: 'scrollToBookmark',
    bookmark: {
      id: 'v2|chatgpt.com|a-conversation-that-no-longer-matches|00000000|0',
      platform: 'chatgpt.com',
      conversationId: 'conv-1',
      textHash: Core.hashText('Bravo'),
      occurrence: 0,
      messageText: 'Bravo'
    }
  });

  assert.equal(response.success, true);
  assert.equal(env.scrolledInto[0].textContent.includes('Bravo'), true);
});

test('scrollToBookmark reports failure instead of scrolling to the wrong message', async (t) => {
  // Regression: strategy 2 used to blindly take messages[messageIndex], which
  // highlighted an unrelated message when the bookmark belonged elsewhere.
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Alpha', 'Bravo'])
  });
  t.after(() => env.close());

  await starsReady(env, 2);

  const response = await env.sendToContent({
    action: 'scrollToBookmark',
    bookmark: {
      id: 'v2|chatgpt.com|conv-99|deadbeef|0',
      platform: 'chatgpt.com',
      conversationId: 'conv-99',
      textHash: 'deadbeef',
      occurrence: 0,
      messageText: 'A message from a different conversation',
      messageIndex: 1
    }
  });

  assert.equal(response.success, false);
  assert.match(response.error, /not found/i);
  assert.equal(env.scrolledInto.length, 0);
});

test('ping answers so the worker can detect an injected content script', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://claude.ai/chat/conv-x',
    html: '<!doctype html><html><body><div data-testid="user-message">Hi</div></body></html>'
  });
  t.after(() => env.close());

  const response = await env.sendToContent({ action: 'ping' });
  assert.equal(response.ready, true);
  assert.equal(response.platform, 'claude.ai');
  assert.equal(response.conversationId, 'conv-x');
});

test('unrelated messages are ignored without hijacking the channel', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Alpha'])
  });
  t.after(() => env.close());

  // Regression: the old listener returned true for every message, leaving the
  // sender's callback hanging until the port was collected.
  const response = await env.sendToContent({ action: 'somethingElse' });
  assert.equal(response, undefined);
});

test('the content script tolerates an unsupported page', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://example.com/',
    html: '<!doctype html><html><body><article data-testid="conversation-turn-0">x</article></body></html>'
  });
  t.after(() => env.close());

  await wait(200);
  assert.equal(env.stars().length, 0);
});

test('a star is re-attached if the page removes it', async (t) => {
  // SPA frameworks re-render turns and throw away injected nodes.
  const env = await createExtensionEnv({
    url: 'https://chatgpt.com/c/conv-1',
    html: chatgptHtml(['Persistent'])
  });
  t.after(() => env.close());

  await starsReady(env, 1);
  env.document.querySelector('.ai-bm-star-container').remove();

  const stars = await starsReady(env, 1);
  assert.equal(stars.length, 1);
});

test('claude selectors fall back when the preferred markup is absent', async (t) => {
  const env = await createExtensionEnv({
    url: 'https://claude.ai/chat/conv-y',
    html:
      '<!doctype html><html><body>' +
      '<div class="mb-1 mt-6 group">Legacy user turn</div>' +
      '<div class="group relative pb-3">Legacy assistant turn</div>' +
      '</body></html>'
  });
  t.after(() => env.close());

  const stars = await starsReady(env, 2);
  assert.equal(stars.length, 2);
});
