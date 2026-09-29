/* E2E test: real Chrome + real extension + mocked chatgpt.com pages.
 *
 * Reproduces the React #418 hydration crash: the mock page hydrates the
 * whole document (like Remix does) ~900ms after load, while the content
 * script injects its badge at document_idle. If the badge lands during the
 * hydration window, React throws a minified hydration error.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = require('path').join(__dirname, '..');
const CHROME_BIN = process.env.CHROME_BIN || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

/* Mock page A: delayed whole-document hydration (Remix-style), generated
 * by gen-page.js so SSR markup matches the client vdom exactly. */
const HYDRATE_PAGE = fs.readFileSync(require('path').join(__dirname, 'hydrate.mock.html'), 'utf8');

/* Mock page B: plain chatgpt-like DOM for functional checks. */
const FUNCTIONAL_PAGE = `<!DOCTYPE html><html><head><title>ChatGPT</title><style>
  article{display:block;margin:600px 0;min-height:80px}
  #prompt-textarea{margin-top:600px}
</style></head><body><main>
<article data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">q1</div></div></article>
<article data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">a1</div></div></article>
<article data-testid="conversation-turn-3" data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">q2</div></div></article>
</main><div id="prompt-textarea" contenteditable="true">composer</div></body></html>`;

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjp-prof-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME_BIN,
    headless: false, // under xvfb
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      '--disable-dev-shm-usage',
    ],
  });

  const results = [];
  const check = (name, ok) => { results.push([name, ok]); console.log((ok ? '  PASS ' : '  FAIL ') + name); };

  // ---- service worker up? commands bound? ----
  let sw;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes('background.js'));
    if (!sw) await new Promise(r => setTimeout(r, 200));
  }
  check('service worker registered', !!sw);
  if (sw) {
    const cmds = await sw.evaluate(() => new Promise(res => chrome.commands.getAll(res)));
    console.log('    commands:', JSON.stringify(cmds));
    check('Alt+J bound', cmds.some(c => c.name === 'jump-to-last-prompt' && c.shortcut));
  }

  await context.route('https://chatgpt.com/**', (route) => {
    const html = route.request().url().includes('hydrate') ? HYDRATE_PAGE : FUNCTIONAL_PAGE;
    route.fulfill({ contentType: 'text/html', body: html });
  });

  // ---- Test 1: hydration repro ----
  console.log('== hydration repro ==');
  const p1 = await context.newPage();
  const reactErrors = [];
  p1.on('console', m => { if (m.type() === 'error') reactErrors.push(m.text()); });
  p1.on('pageerror', e => reactErrors.push(String(e)));
  await p1.goto('https://chatgpt.com/hydrate-test', { waitUntil: 'load' });
  await p1.waitForSelector('.cjp-badge', { timeout: 10000 }).catch(() => {});
  await p1.waitForTimeout(500);
  const hydrationErr = reactErrors.filter(t => /418|423|425|Hydration/i.test(t));
  check('no React hydration error', hydrationErr.length === 0);
  if (hydrationErr.length) console.log('    errors:', hydrationErr.slice(0, 2));
  const badgeOnP1 = await p1.$('.cjp-badge');
  check('badge injected after hydration', !!badgeOnP1);

  // ---- Test 2: functional on static mock ----
  console.log('== functional ==');
  const p2 = await context.newPage();
  await p2.goto('https://chatgpt.com/c/test', { waitUntil: 'load' });
  await p2.waitForSelector('.cjp-badge', { timeout: 8000 });

  // Real production path: command -> service worker -> tabs.sendMessage
  if (sw) {
    await sw.evaluate(async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(t.id, { type: 'cjp:command', command: 'jump-to-last-prompt' });
    });
  }
  await p2.waitForTimeout(300);
  let info = await p2.evaluate(() => ({
    highlighted: document.querySelectorAll('.cjp-highlight').length,
    hlText: (document.querySelector('.cjp-highlight') || {}).innerText,
    badge: document.querySelector('.cjp-badge') ? document.querySelector('.cjp-badge').innerText : null,
    scrollY: window.scrollY,
  }));
  console.log('    ', JSON.stringify(info));
  check('jump-to-last highlights turn-3', info.highlighted === 1 && /q2/.test(info.hlText || ''));
  check('badge shows 第 2/2 条', /第 2\/2 条/.test(info.badge || ''));
  check('page scrolled', info.scrollY > 0);

  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(t.id, { type: 'cjp:command', command: 'jump-to-prev-prompt' });
  });
  await p2.waitForTimeout(300);
  info = await p2.evaluate(() => ({
    hlText: (document.querySelector('.cjp-highlight') || {}).innerText,
    badge: document.querySelector('.cjp-badge').innerText,
  }));
  check('prev highlights turn-1 (q1)', /q1/.test(info.hlText || ''));

  // userscript-style keydown path: command is bound -> keydown must NOT double-fire
  await p2.keyboard.press('Alt+j');
  await p2.waitForTimeout(250);
  info = await p2.evaluate(() => ({ hl: (document.querySelector('.cjp-highlight') || {}).innerText }));
  check('bound command not double-fired via keydown', /q1/.test(info.hl || ''));

  // ---- Test 3: SPA navigation resets state ----
  console.log('== SPA reset ==');
  await p2.evaluate(() => history.pushState({}, '', '/c/other'));
  await p2.waitForTimeout(1400); // poll interval is 1s
  info = await p2.evaluate(() => ({ badge: document.querySelector('.cjp-badge').innerText }));
  check('badge resets to total count', /2 条提问/.test(info.badge || ''));

  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  await context.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
