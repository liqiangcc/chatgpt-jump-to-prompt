const { JSDOM } = require('jsdom');
const fs = require('fs');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'chatgpt-jump.user.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

function makeDom(innerHtml) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${innerHtml}</body></html>`, {
    url: 'https://chatgpt.com/c/test',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  let i = 0;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.__top === undefined) this.__top = 100 + (i++) * 200;
    return { top: this.__top, bottom: this.__top + 50, height: 50, left: 0, right: 800, width: 800 };
  };
  window.Element.prototype.scrollIntoView = function () { this.__scrolled = (this.__scrolled || 0) + 1; };
  window.scrollTo = () => {};
  // pretend hydration already ran -> DOM gate opens after the quiet window
  window.document.documentElement.__reactFiber$test = {};
  window.eval(code);
  return window;
}

const press = (w, code) =>
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { code, altKey: true, bubbles: true, cancelable: true }));

const NORMAL = `
<main>
  <article data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user">Q1</div></article>
  <article data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">A1</div></div></article>
  <article data-testid="conversation-turn-3" data-turn="user"><div data-message-author-role="user">Q2</div></article>
  <article data-testid="conversation-turn-4" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">A2</div></div></article>
</main>
<div id="prompt-textarea" contenteditable="true"></div>`;

(async () => {
  console.log('== normal markup (data-message-author-role) ==');
  {
    const w = makeDom(NORMAL);
    await sleep(900); // DOM gate: 700ms quiet window
    const arts = w.document.querySelectorAll('article');
    press(w, 'KeyJ'); await sleep(150);
    check('last user turn scrolled', arts[2].__scrolled === 1);
    check('last user turn highlighted', arts[2].classList.contains('cjp-highlight'));
    check('assistant not scrolled', !arts[3].__scrolled);
    const badge = w.document.querySelector('.cjp-badge');
    check('badge exists', !!badge);
    check('badge shows 第 2/2 条', badge.textContent.includes('第 2/2 条'));

    press(w, 'ArrowUp'); await sleep(150);
    check('prev -> first user turn', arts[0].classList.contains('cjp-highlight'));
    check('badge 第 1/2 条', badge.textContent.includes('第 1/2 条'));

    press(w, 'ArrowUp'); await sleep(150);
    check('boundary keeps highlight on arts[0]', arts[0].classList.contains('cjp-highlight'));
    const toast = w.document.querySelector('.cjp-toast');
    check('toast shown', toast && toast.classList.contains('cjp-show') && toast.textContent.includes('第一条'));

    press(w, 'ArrowDown'); await sleep(150);
    check('next -> second user turn', arts[2].classList.contains('cjp-highlight'));
  }

  console.log('== wrapper-only markup (no data-message-author-role) ==');
  {
    const w = makeDom(`
    <main>
      <article data-testid="conversation-turn-1" data-turn="user"><h5 class="sr-only">你说：</h5><div><div class="whitespace-pre-wrap">Q1</div></div></article>
      <article data-testid="conversation-turn-2" data-turn="assistant"><h6 class="sr-only">ChatGPT 说：</h6><div class="markdown">A1</div></article>
      <article data-testid="conversation-turn-3" data-turn="user"><h5 class="sr-only">你说：</h5><div><div class="whitespace-pre-wrap">Q2</div></div></article>
    </main>
    <div id="prompt-textarea"></div>`);
    await sleep(900);
    const arts = w.document.querySelectorAll('article');
    press(w, 'KeyJ'); await sleep(150);
    check('data-turn=user detected', arts[2].__scrolled === 1);
  }

  console.log('== degraded markup (no role attrs; h5.sr-only + bubble layout) ==');
  {
    const w = makeDom(`
    <main>
      <article><h5 class="sr-only">你说：</h5><div class="flex justify-end"><div class="rounded-3xl">Q1</div></div></article>
      <article><h6 class="sr-only">ChatGPT 说：</h6><div class="markdown prose">A1</div></article>
      <article><h5 class="sr-only">你说：</h5><div class="flex justify-end"><div class="rounded-3xl">Q2</div></div></article>
    </main>
    <div id="prompt-textarea"></div>`);
    await sleep(900);
    const arts = w.document.querySelectorAll('article');
    press(w, 'KeyJ'); await sleep(150);
    check('heuristic finds last user article', arts[2].__scrolled === 1);
    check('assistant skipped', !arts[1].__scrolled);
  }

  console.log('== DOM gate: writes are deferred while "hydrating" ==');
  {
    const w = makeDom(NORMAL);
    w.document.documentElement.__reactFiber$test = undefined;
    delete w.document.documentElement.__reactFiber$test;
    await sleep(300);
    press(w, 'KeyJ'); // queued behind the gate
    const arts = w.document.querySelectorAll('article');
    check('no write during gate window', !arts[2].__scrolled);
    await sleep(4800); // gate opens via MIN_WAIT fallback (4000ms + probe)
    check('queued jump executed after gate', arts[2].__scrolled === 1);
  }

  console.log('== empty conversation -> composer fallback ==');
  {
    const w = makeDom(`<main></main><div id="prompt-textarea" contenteditable="true"></div>`);
    await sleep(900);
    press(w, 'KeyJ');
    await sleep(1200); // 700ms retry + execution
    const ta = w.document.querySelector('#prompt-textarea');
    check('composer scrolled after retry', (ta.__scrolled || 0) >= 1);
    const toast = w.document.querySelector('.cjp-toast');
    check('toast shown', toast && toast.textContent.includes('未找到'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
