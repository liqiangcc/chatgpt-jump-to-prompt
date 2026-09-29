// usage: node run-repro.js <extDir|none>
const { chromium } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const EXT = process.argv[2];
const HTML = fs.readFileSync(require('path').join(__dirname, 'hydrate.mock.html'), 'utf8');
(async () => {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  const opts = { executablePath: process.env.CHROME_BIN || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', headless: false, args };
  if (EXT && EXT !== 'none') {
    opts.ignoreDefaultArgs = ['--disable-extensions'];
    args.push('--load-extension=' + EXT, '--disable-extensions-except=' + EXT);
  }
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'cjp-')), opts);
  await ctx.route('https://chatgpt.com/**', r => r.fulfill({ contentType: 'text/html', body: HTML }));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 140)));
  p.on('console', m => { if (m.type() === 'error') errs.push('con: ' + m.text().slice(0, 140)); });
  await p.goto('https://chatgpt.com/c/repro');
  await p.waitForTimeout(6500);
  const t = await p.evaluate(() => window.__T);
  console.log('TIMING:', JSON.stringify(t));
  console.log('ERRORS:', errs.length ? errs : '(none)');
  await ctx.close();
})();
