#!/usr/bin/env node
'use strict';
//
// Real-browser smoke test (opt-in: `npm run smoke`).
//
// Loads the unpacked extension into headless Chromium, points chatgpt.com at a
// local HTTPS server serving a stand-in conversation, and drives it over the
// DevTools protocol. This is the only check that exercises the actual chrome.*
// APIs, content-script injection, and CSS delivery; `npm test` covers behaviour
// with jsdom and runs anywhere.
//
// Requires: chromium (or CHROME_BIN) and openssl on PATH.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const EXT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bm-smoke-'));
const PORT = Number(process.env.SMOKE_PORT || 8443);
const DEBUG_PORT = Number(process.env.SMOKE_DEBUG_PORT || 9333);

const CHROME =
  process.env.CHROME_BIN ||
  ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].find(
    (bin) => spawnSync('which', [bin]).status === 0
  );

if (!CHROME) {
  console.log('SKIP: no chromium/chrome binary found (set CHROME_BIN to override).');
  process.exit(0);
}

// A throwaway certificate for the stand-in chatgpt.com origin.
const certResult = spawnSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(TMP, 'key.pem'),
    '-out', path.join(TMP, 'cert.pem'),
    '-days', '1', '-nodes',
    '-subj', '/CN=chatgpt.com',
    '-addext', 'subjectAltName=DNS:chatgpt.com'
  ],
  { stdio: 'ignore' }
);
if (certResult.status !== 0) {
  console.log('SKIP: openssl is required to generate a test certificate.');
  process.exit(0);
}

const PAGE = `<!doctype html><html><head><title>Fake ChatGPT</title></head><body>
<main id="thread">
  <article data-testid="conversation-turn-0"><div>What is the capital of France?</div></article>
  <article data-testid="conversation-turn-1"><div>The capital of France is Paris.</div></article>
  <article data-testid="conversation-turn-2"><div>Tell me more about it.</div></article>
</main>
<script>
  window.addMessage = (text) => {
    const a = document.createElement('article');
    a.setAttribute('data-testid', 'conversation-turn-' + document.querySelectorAll('article').length);
    a.textContent = text;
    document.getElementById('thread').appendChild(a);
  };
</script>
</body></html>`;

const server = https.createServer(
  { key: fs.readFileSync(path.join(TMP, 'key.pem')), cert: fs.readFileSync(path.join(TMP, 'cert.pem')) },
  (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  }
);

function get(url) {
  return new Promise((resolve, reject) => {
    require('http')
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bm-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${PORT},MAP * ~NOTFOUND`,
    'about:blank'
  ]);

  let chromeErr = '';
  chrome.stderr.on('data', (d) => (chromeErr += d));

  const results = [];
  const fail = (msg) => {
    results.push(['FAIL', msg]);
  };
  const pass = (msg) => results.push(['ok  ', msg]);

  try {
    // Wait for the devtools endpoint.
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        version = await get(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        break;
      } catch (_e) {
        await sleep(250);
      }
    }
    if (!version) throw new Error('Chromium devtools never came up:\n' + chromeErr);
    pass(`chromium up: ${version.Browser}`);

    // The service worker target proves background.js loaded without throwing.
    let worker = null;
    for (let i = 0; i < 40; i++) {
      const targets = await get(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      worker = targets.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
      if (worker) break;
      await sleep(250);
    }
    if (worker) pass('service worker registered (background.js loaded)');
    else fail('service worker never registered');

    // Open the fake conversation.
    const targets = await get(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    async function connect(wsUrl) {
      const ws = new WebSocket(wsUrl);
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
      });
      let id = 0;
      const pending = new Map();
      const events = new Map();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
          return;
        }
        if (msg.method && events.has(msg.method)) {
          for (const fn of events.get(msg.method)) fn(msg.params || {});
        }
      };
      const on = (method, fn) => {
        if (!events.has(method)) events.set(method, []);
        events.get(method).push(fn);
      };
      const cmd = (method, params = {}) =>
        new Promise((resolve) => {
          const mid = ++id;
          pending.set(mid, resolve);
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      const evaluate = async (expression) => {
        const res = await cmd('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        });
        if (res.result && res.result.exceptionDetails) {
          throw new Error(JSON.stringify(res.result.exceptionDetails.exception || res.result.exceptionDetails));
        }
        return res.result.result.value;
      };
      return { cmd, evaluate, on, close: () => ws.close() };
    }

    const pageSession = await connect(page.webSocketDebuggerUrl);
    const cmd = pageSession.cmd;
    // chrome.* APIs live in the extension's isolated world / worker, not the
    // page's main world, so storage assertions run against the worker target.
    const workerSession = await connect(worker.webSocketDebuggerUrl);

    const consoleErrors = [];
    pageSession.on('Runtime.exceptionThrown', (params) => {
      const text =
        (params.exceptionDetails && params.exceptionDetails.exception &&
          params.exceptionDetails.exception.description) ||
        (params.exceptionDetails && params.exceptionDetails.text) ||
        'unknown';
      consoleErrors.push(text);
    });
    pageSession.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args.map((a) => a.description || a.value).join(' '));
      }
    });

    await cmd('Page.enable');
    await cmd('Runtime.enable');
    const nav = await cmd('Page.navigate', { url: 'https://chatgpt.com/c/smoke-conv-1' });
    if (nav.result && nav.result.errorText) fail('navigate error: ' + nav.result.errorText);
    await sleep(3000);

    const evaluate = pageSession.evaluate;
    const inWorker = workerSession.evaluate;

    const title = await evaluate('document.title');
    if (title === 'Fake ChatGPT') pass('served the fake chatgpt.com page');
    else fail(`unexpected page title: ${title}`);

    const starCount = await evaluate("document.querySelectorAll('.ai-bm-star').length");
    if (starCount === 3) pass('content script added one star per turn (3)');
    else fail(`expected 3 stars, got ${starCount}`);

    const cssLoaded = starCount === 0 ? 'skipped' : await evaluate(
      "getComputedStyle(document.querySelector('.ai-bm-star-container')).position"
    );
    if (cssLoaded === 'absolute') pass('content.css applied');
    else if (cssLoaded === 'skipped') fail('css check skipped');
    else fail(`content.css not applied (position: ${cssLoaded})`);

    const iconOk = await evaluate(
      "document.querySelector('.ai-bm-star-icon').src.startsWith('chrome-extension://')"
    );
    if (iconOk) pass('web-accessible star icon resolves');
    else fail('star icon URL did not resolve');

    // Click the second star and confirm it persists through the service worker.
    await evaluate("document.querySelectorAll('.ai-bm-star')[1].click()");
    await sleep(1200);

    const pressed = await evaluate(
      "document.querySelectorAll('.ai-bm-star')[1].getAttribute('aria-pressed')"
    );
    if (pressed === 'true') pass('star toggled to bookmarked');
    else fail(`aria-pressed after click: ${pressed}`);

    const stored = await inWorker(
      "chrome.storage.local.get(['bookmarks','schemaVersion']).then(JSON.stringify)"
    );
    const parsed = JSON.parse(stored);
    const rows = (parsed.bookmarks && parsed.bookmarks['chatgpt.com']) || [];
    if (rows.length === 1) pass('bookmark persisted via the service worker');
    else fail(`expected 1 stored bookmark, got ${rows.length}: ${stored}`);

    if (rows[0] && rows[0].conversationId === 'smoke-conv-1') {
      pass('bookmark is scoped to the conversation id');
    } else {
      fail(`conversationId: ${rows[0] && rows[0].conversationId}`);
    }
    if (rows[0] && rows[0].messageText === 'The capital of France is Paris.') {
      pass('preview text captured correctly');
    } else {
      fail(`messageText: ${rows[0] && rows[0].messageText}`);
    }
    if (parsed.schemaVersion === 2) pass('schemaVersion written');
    else fail(`schemaVersion: ${parsed.schemaVersion}`);

    // Dynamic content.
    await evaluate("window.addMessage('A brand new streamed reply.')");
    await sleep(1500);
    const after = await evaluate("document.querySelectorAll('.ai-bm-star').length");
    if (after === 4) pass('MutationObserver starred a dynamically added message');
    else fail(`expected 4 stars after adding a message, got ${after}`);

    // Scroll-to-bookmark via the real runtime messaging path.
    const scrollResult = await inWorker(
      `openBookmark(${JSON.stringify(rows[0] || {})}).then(JSON.stringify)`
    );
    const scroll = JSON.parse(scrollResult);
    if (scroll && scroll.success) pass('openBookmark round-tripped through the worker');
    else fail(`openBookmark returned ${scrollResult}`);

    await sleep(800);
    const highlighted = await evaluate(
      "document.querySelectorAll('.ai-bm-highlight').length"
    );
    if (highlighted === 1) pass('target message highlighted');
    else fail(`expected 1 highlighted message, got ${highlighted}`);

    // Unbookmark.
    await evaluate("document.querySelectorAll('.ai-bm-star')[1].click()");
    await sleep(1000);
    const afterRemove = await inWorker(
      "chrome.storage.local.get(['bookmarks']).then((r) => (r.bookmarks['chatgpt.com']||[]).length)"
    );
    if (afterRemove === 0) pass('unbookmark removed the row');
    else fail(`expected 0 rows after unbookmark, got ${afterRemove}`);

    if (consoleErrors.length === 0) pass('no uncaught errors in the page');
    else fail(`page console errors: ${consoleErrors.join(' | ')}`);

    pageSession.close();
    workerSession.close();
  } catch (err) {
    fail(`threw: ${err.message}`);
  } finally {
    chrome.kill();
    server.close();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  }

  console.log('');
  for (const [status, msg] of results) console.log(`${status} ${msg}`);
  const failures = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failures}/${results.length} smoke checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
