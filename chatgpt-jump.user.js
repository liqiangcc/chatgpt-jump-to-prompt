// ==UserScript==
// @name         ChatGPT Jump to Prompt
// @namespace    https://github.com/liqiangcc/chatgpt-jump-to-prompt
// @version      1.1.1
// @description  在 ChatGPT 长对话中快速跳回自己提问的位置：Alt+J 最后一条，Alt+↑/↓ 逐条导航；右侧浮动按钮支持触屏。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

/*
 * ChatGPT Jump to Prompt — single file shared by two runtimes:
 *
 *   1) Chrome extension: this file is the manifest content_scripts entry.
 *      Keyboard commands (Alt+J / Alt+↑ / Alt+↓) are registered in
 *      manifest.json, remappable at chrome://extensions/shortcuts, and reach
 *      us via background.js -> chrome.runtime.onMessage. Styles come from
 *      manifest-injected content.css (immune to the page CSP).
 *
 *   2) Userscript engines (iOS Safari "Userscripts" / "Stay", desktop
 *      Violentmonkey/Tampermonkey): no chrome.* APIs exist here, so keys are
 *      handled by a local keydown listener and styles are injected from the
 *      embedded CJP_CSS string (GM_addStyle preferred — also CSP-immune).
 *
 * NOTE: CJP_CSS below and content.css must be kept in sync (content.css is
 * the extension's CSP-proof copy).
 */
(() => {
  'use strict';
  if (globalThis.__CJP_LOADED__) return; // guard against double injection
  globalThis.__CJP_LOADED__ = true;

  const IS_EXTENSION =
    typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  /* ======================================================================
   * STYLES — keep in sync with content.css.
   * ==================================================================== */
  const CJP_CSS = `
.cjp-highlight {
  outline: 2px solid rgba(16, 163, 127, 0.95) !important;
  outline-offset: 2px;
  border-radius: 10px;
  animation: cjp-breathe 1.5s ease-in-out;
}
@keyframes cjp-breathe {
  0%   { box-shadow: 0 0 0 0 rgba(16, 163, 127, 0); }
  30%  { box-shadow: 0 0 0 6px rgba(16, 163, 127, 0.30), 0 0 18px 2px rgba(16, 163, 127, 0.25); }
  60%  { box-shadow: 0 0 0 3px rgba(16, 163, 127, 0.15); }
  100% { box-shadow: 0 0 0 0 rgba(16, 163, 127, 0); }
}
.cjp-badge {
  position: fixed;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(32, 33, 35, 0.88);
  color: #ececec;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  opacity: 0.55;
  transition: opacity 0.15s ease;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.cjp-badge:hover { opacity: 1; }
.cjp-badge button {
  all: unset;
  cursor: pointer;
  color: inherit;
  font: inherit;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
}
.cjp-badge-nav {
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  font-size: 13px;
}
.cjp-badge-jump {
  padding: 5px 10px;
  white-space: nowrap;
}
.cjp-badge button:hover { background: rgba(255, 255, 255, 0.12); }
.cjp-badge-hide {
  width: 18px;
  height: 18px;
  color: #9b9b9b;
  font-size: 13px;
}
.cjp-badge-hide:hover { color: #fff; }
.cjp-toast {
  position: fixed;
  left: 50%;
  bottom: 90px;
  transform: translateX(-50%) translateY(8px);
  z-index: 2147483647;
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(32, 33, 35, 0.92);
  color: #fff;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.cjp-toast.cjp-show { opacity: 1; transform: translateX(-50%) translateY(0); }
@media (pointer: coarse) {
  .cjp-badge { padding: 5px; opacity: 0.75; }
  .cjp-badge-nav { min-width: 32px; height: 32px; }
  .cjp-badge-jump { padding: 8px 12px; }
}
`;

  /* ======================================================================
   * SELECTORS — update this block when ChatGPT's markup changes.
   *
   * Current markup (verified against other open-source tooling, 2026):
   *   - each turn is an <article data-testid="conversation-turn-N"
   *     data-turn="user|assistant"> wrapper
   *   - the message node inside carries data-message-author-role="user" for
   *     your own prompts (OpenAI has kept this attribute stable for years)
   *   - turns carry a locale-independent screen-reader heading: <h5
   *     class="sr-only"> for user turns, <h6 class="sr-only"> for assistant
   * Detection runs a fallback chain; every hit is normalised up to its
   * enclosing turn root so scrolling lands on the turn boundary.
   * ==================================================================== */

  // Strategy A/B: direct role attributes, most specific first.
  const USER_MESSAGE_SELECTORS = [
    '[data-message-author-role="user"]', // primary — stamped on message nodes
    '[data-testid="user-message"]',      // alternate test-id seen in the wild
    '[data-turn="user"]',                // role on the turn wrapper itself
    '[data-role="user"]',
    '[data-message-author="user"]',
  ];

  // Strategy C: turn wrappers (classified per-element by classifyUserTurn).
  const TURN_ROOT_SELECTORS = [
    'article[data-testid^="conversation-turn"]',
    '[data-testid="conversation-turn"]',
    'article[data-turn-id]',
    '[data-turn-id-container]',          // legacy wrapper name
    '[data-turn]',
  ];

  // Composer fallback — used when no prompt can be located at all.
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',                  // contenteditable composer on chatgpt.com
    'form textarea',
    'textarea',
    'form [contenteditable="true"]',
  ];

  const HIGHLIGHT_CLASS = 'cjp-highlight';
  const HIGHLIGHT_MS = 1600;          // breathing-outline duration
  const HEADER_OFFSET_PX = 96;        // scroll-margin under the sticky header
  const OBSERVER_DEBOUNCE_MS = 400;
  const RETRY_MS = 700;               // one retry before giving up (SPA races)

  /* ================================================================== */
  /*  State                                                              */
  /* ================================================================== */

  // Element (not index) of the prompt we last jumped to — survives
  // insertions/removals caused by virtualised rendering.
  let currentEl = null;
  let lastUrl = location.href;
  // Which command names are actually bound in chrome://extensions/shortcuts
  // (extension mode only; null = unknown → keydown handles everything).
  let boundCommands = null;

  let badgeEl = null;
  let badgeLabel = null;
  let badgeHidden = false;
  let toastEl = null;
  let toastTimer = 0;
  let hlTimer = 0;
  let moTimer = 0;
  let retryTimer = 0;

  /* ================================================================== */
  /*  DOM-write gate                                                     */
  /*                                                                     */
  /*  chatgpt.com hydrates the ENTIRE document (Remix-style              */
  /*  hydrateRoot(document, ...)). Any node we inject while hydration    */
  /*  is still running becomes a hydration mismatch -> React error       */
  /*  #418/#423 and a full client re-render that also wipes our UI.      */
  /*                                                                     */
  /*  So no DOM writes until the page has gone quiet:                    */
  /*    - DOM must see no host mutations for QUIET_MS (covers streaming  */
  /*      SSR / progressive hydration, which churn the document), AND    */
  /*    - React fiber markers must already be present (hydration ran)    */
  /*      OR MIN_WAIT_MS must have elapsed (non-React / SSR-less page).  */
  /*    MAX_WAIT_MS is the hard cap so the UI can never be blocked       */
  /*    forever on a pathological page.                                  */
  /* ================================================================== */

  let domSafe = false;
  const domWriteQueue = [];

  function whenDomSafe(fn) {
    if (domSafe) fn();
    else domWriteQueue.push(fn);
  }

  function isOurNode(n) {
    return n.nodeType === 1 && (
      (n.getAttribute && n.getAttribute('data-cjp') !== null) ||
      (n.classList && Array.prototype.some.call(n.classList, (c) => c.indexOf('cjp') === 0)));
  }

  function reactHydrated() {
    // React stamps an internal __react* expando on every DOM element it has
    // claimed; presence on the document root/body means hydration has run.
    for (const o of [document, document.documentElement, document.body]) {
      if (!o) continue;
      const keys = Object.keys(o);
      for (const k of keys) if (k.indexOf('__react') === 0) return true;
    }
    return false;
  }

  (function armDomGate() {
    const QUIET_MS = 700;
    const MIN_WAIT_MS = 4000; // covers hydrations that start late
    const MAX_WAIT_MS = 8000;
    const t0 = Date.now();
    let quietTimer = 0;

    const open = () => {
      gateObs.disconnect();
      domSafe = true;
      while (domWriteQueue.length) domWriteQueue.shift()();
    };
    const probe = () => {
      if (Date.now() - t0 >= MIN_WAIT_MS || reactHydrated()) open();
      else quietTimer = setTimeout(probe, 300);
    };
    const bump = () => { clearTimeout(quietTimer); quietTimer = setTimeout(probe, QUIET_MS); };

    const gateObs = new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes)
          if (!isOurNode(n)) return bump();
    });
    gateObs.observe(document.documentElement, { childList: true, subtree: true });
    bump();
    setTimeout(open, MAX_WAIT_MS); // never block the UI forever
  })();

  /* ================================================================== */
  /*  Styles (userscript runtimes only — the extension uses content.css)   */
  /* ================================================================== */

  function injectStyles() {
    try {
      if (typeof GM_addStyle === 'function') { GM_addStyle(CJP_CSS); return; }
    } catch (e) { /* fall through to <style> */ }
    const el = document.createElement('style');
    el.setAttribute('data-cjp', '');
    el.textContent = CJP_CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ================================================================== */
  /*  Message discovery                                                  */
  /* ================================================================== */

  function turnRoot(n) {
    return n.closest(TURN_ROOT_SELECTORS.join(',')) || n.closest('article') || n;
  }

  /*
   * Decide whether a turn wrapper is a user turn, using whatever evidence
   * is still present. Ordered from explicit to heuristic:
   *   1. data-turn / data-role attribute on the wrapper
   *   2. descendant role node
   *   3. sr-only heading: user turns -> <h5>, assistant turns -> <h6>
   *      (locale-independent — the text is translated, the tag is not)
   *   4. layout: user bubbles are right-aligned and have no markdown body
   */
  function classifyUserTurn(root) {
    const t = (root.getAttribute('data-turn') || root.getAttribute('data-role') || '').toLowerCase();
    if (t === 'user') return true;
    if (t === 'assistant' || t === 'system') return false;
    if (root.matches('[data-message-author-role="user"], [data-testid="user-message"]')) return true;
    if (root.querySelector('[data-message-author-role="user"], [data-testid="user-message"]')) return true;
    if (root.querySelector('[data-message-author-role="assistant"], h6.sr-only')) return false;
    if (root.querySelector('h5.sr-only')) return true;
    return !root.querySelector('.markdown, .prose')
      && !!root.querySelector('[class*="justify-end"], [class*="items-end"], [class*="self-end"], [class*="ml-auto"]');
  }

  /*
   * Last resort: scan every <article> (ChatGPT renders each turn in one).
   * classifyUserTurn's layout signal does the work when all data-*
   * attributes are gone.
   */
  function heuristicUserTurns() {
    const out = [];
    for (const a of document.querySelectorAll('article')) {
      if (!((a.innerText || a.textContent || '').trim())) continue;
      if (classifyUserTurn(a)) out.push(a);
    }
    return out;
  }

  /*
   * Collect user-turn elements in document order. Only messages currently
   * rendered in the DOM are returned — ChatGPT virtualises long histories
   * and we deliberately do not force-load more.
   */
  function getUserTurns() {
    let nodes = [];
    for (const sel of USER_MESSAGE_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) { nodes = Array.from(found); break; }
    }
    if (!nodes.length) {
      for (const w of document.querySelectorAll(TURN_ROOT_SELECTORS.join(','))) {
        if (classifyUserTurn(w)) nodes.push(w);
      }
    }
    if (!nodes.length) nodes = heuristicUserTurns();

    const seen = new Set();
    const turns = [];
    for (const n of nodes) {
      const root = turnRoot(n);
      if (seen.has(root)) continue;
      seen.add(root);
      if (root.getBoundingClientRect().height > 0) turns.push(root); // skip virtualised ghosts
    }
    return turns;
  }

  /*
   * Every jump goes through here. If nothing is found we retry once after a
   * beat (the SPA may be mid-render), then fall back loudly — never silent.
   */
  function withTurns(cb) {
    const turns = getUserTurns();
    if (turns.length) { cb(turns); return; }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      const again = getUserTurns();
      if (again.length) cb(again);
      else { logDiagnostics(); fallbackToComposer(); }
    }, RETRY_MS);
  }

  /* ================================================================== */
  /*  Navigation                                                         */
  /* ================================================================== */

  function jumpToIndex(turns, i) {
    const el = turns[i];
    currentEl = el;
    el.style.scrollMarginTop = HEADER_OFFSET_PX + 'px'; // clear the sticky header
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    highlight(el);
    updateBadge(turns);
  }

  /*
   * With no established "current" prompt (fresh page, conversation switch,
   * or the target was unmounted), derive a start index from the viewport:
   * "previous" = last prompt above the reading line, "next" = first below.
   */
  function indexFromViewport(turns, dir) {
    const probe = HEADER_OFFSET_PX + 24;
    if (dir < 0) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].getBoundingClientRect().top < probe) return i;
      }
      return 0;
    }
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].getBoundingClientRect().top >= probe) return i;
    }
    return turns.length - 1;
  }

  function jumpLast() {
    withTurns((turns) => jumpToIndex(turns, turns.length - 1));
  }

  function step(dir) {
    withTurns((turns) => {
      const cur = currentEl ? turns.indexOf(currentEl) : -1;
      if (cur < 0) { jumpToIndex(turns, indexFromViewport(turns, dir)); return; }
      const i = cur + dir;
      if (i < 0 || i >= turns.length) {
        showToast(dir < 0 ? '已经是第一条提问' : '已经是最后一条提问');
        return;
      }
      jumpToIndex(turns, i);
    });
  }

  /* Guaranteed-visible fallback: no prompt found -> composer + toast. */
  function fallbackToComposer() {
    let el = null;
    for (const sel of COMPOSER_SELECTORS) {
      el = document.querySelector(sel);
      if (el) break;
    }
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el.focus) try { el.focus({ preventScroll: true }); } catch (e) {}
    } else {
      const scroller = document.scrollingElement || document.documentElement;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    }
    showToast('当前对话未找到提问，已滚动至输入框');
  }

  /* ================================================================== */
  /*  Diagnostics — dumped to the page console on total selector failure  */
  /* ================================================================== */

  function logDiagnostics() {
    try {
      const probes = {};
      for (const sel of USER_MESSAGE_SELECTORS.concat(TURN_ROOT_SELECTORS, ['article'])) {
        try { probes[sel] = document.querySelectorAll(sel).length; }
        catch (e) { probes[sel] = 'ERR'; }
      }
      const sample = document.querySelector('article') || document.querySelector('main [class]');
      console.warn('[ChatGPT Jump to Prompt] 未找到用户提问。请把这段诊断信息发给开发者以更新选择器:', {
        url: location.href,
        probes,
        sample: sample ? sample.outerHTML.slice(0, 500) : '(no article found)',
      });
    } catch (e) {}
  }

  /* ================================================================== */
  /*  Visual feedback                                                    */
  /* ================================================================== */

  function highlight(el) {
    document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((e) => e.classList.remove(HIGHLIGHT_CLASS));
    void el.offsetWidth; // restart the animation when re-jumping to the same node
    el.classList.add(HIGHLIGHT_CLASS);
    clearTimeout(hlTimer);
    hlTimer = setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
  }

  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'cjp-toast';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('cjp-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('cjp-show'), 2200);
  }

  /* ================================================================== */
  /*  Floating badge — the only UI on touch devices                       */
  /*    [↑]  [第 k/N 条提问]  [↓]  [×]                                     */
  /* ================================================================== */

  function ensureBadge() {
    if (badgeEl || badgeHidden) return;
    badgeEl = document.createElement('div');
    badgeEl.className = 'cjp-badge';

    const mk = (cls, text, title, fn) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      badgeEl.appendChild(b);
      return b;
    };

    mk('cjp-badge-nav', '↑', '上一条提问 (Alt+↑)', () => step(-1));
    const jump = mk('cjp-badge-jump', '', '跳到最后一条提问 (Alt+J)', jumpLast);
    badgeLabel = document.createElement('span');
    jump.appendChild(badgeLabel);
    mk('cjp-badge-nav', '↓', '下一条提问 (Alt+↓)', () => step(1));
    mk('cjp-badge-hide', '×', '隐藏按钮（刷新页面后恢复）', () => {
      badgeHidden = true;
      badgeEl.remove();
      badgeEl = badgeLabel = null;
    });

    document.documentElement.appendChild(badgeEl);
  }

  function updateBadge(turns) {
    if (!badgeEl) return;
    turns = turns || getUserTurns();
    const total = turns.length;
    const cur = currentEl ? turns.indexOf(currentEl) : -1;
    badgeLabel.textContent =
      total === 0 ? '暂无提问' :
      cur >= 0 ? `第 ${cur + 1}/${total} 条` : `${total} 条提问`;
  }

  /* ================================================================== */
  /*  SPA navigation + DOM observation                                   */
  /* ================================================================== */

  // React Router swaps history without a reload — watch via popstate, the
  // Navigation API, and a slow poll as a final safety net.
  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    currentEl = null; // reset navigation state for the new conversation
    updateBadge();
  }

  window.addEventListener('popstate', checkNavigation);
  try { window.navigation.addEventListener('navigate', checkNavigation); } catch (e) {}
  setInterval(checkNavigation, 1000);

  // Streaming replies and virtualised scrolling mutate the DOM constantly —
  // debounce a recount so the badge stays accurate without churning. This
  // also self-heals: if a React client re-render wiped our nodes (e.g. after
  // a hydration failure), rebuild them once the DOM is safe.
  const mo = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      checkNavigation();
      if (badgeEl && !badgeEl.isConnected) { badgeEl = badgeLabel = null; }
      if (domSafe && !badgeHidden) ensureBadge();
      updateBadge();
    }, OBSERVER_DEBOUNCE_MS);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  /* ================================================================== */
  /*  Command entry points                                               */
  /* ================================================================== */

  function dispatch(command) {
    // Queue behind the DOM gate: jumping during hydration would write
    // class/style attrs mid-flight (same #418 risk) AND read a half-built
    // message list. No dedup needed — when a command IS bound the browser
    // consumes the keystroke before the page sees it, so the message path
    // and the keydown path can never fire for the same press.
    whenDomSafe(() => {
      if (command === 'jump-to-last-prompt') jumpLast();
      else if (command === 'jump-to-prev-prompt') step(-1);
      else if (command === 'jump-to-next-prompt') step(1);
    });
  }

  // Extension path: commands arrive from background.js.
  if (IS_EXTENSION) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'cjp:command') return;
      dispatch(msg.command);
    });
    // Ask the background which commands are actually bound so the keydown
    // fallback below only covers unbound ones (and respects user-unbound).
    try {
      chrome.runtime.sendMessage({ type: 'cjp:which-commands' }, (res) => {
        boundCommands = new Set(
          !chrome.runtime.lastError && Array.isArray(res) ? res : []
        );
      });
    } catch (e) {
      boundCommands = new Set();
    }
  }

  /*
   * Local keydown fallback — the only keyboard path under userscript
   * engines, and a safety net in extension mode for commands that failed to
   * bind. When a command IS bound the browser consumes the keystroke before
   * the page sees it, so both paths can never fire for the same press.
   */
  const KEY_TO_COMMAND = {
    KeyJ: 'jump-to-last-prompt',
    ArrowUp: 'jump-to-prev-prompt',
    ArrowDown: 'jump-to-next-prompt',
  };
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    const cmd = KEY_TO_COMMAND[e.code];
    if (!cmd) return;
    if (boundCommands && boundCommands.has(cmd)) return; // command pipeline owns it
    e.preventDefault();
    dispatch(cmd);
  }, true);

  /* ================================================================== */
  /*  Init                                                               */
  /* ================================================================== */

  // UI mounts only once the DOM is safe to write (see armDomGate).
  whenDomSafe(() => {
    if (!IS_EXTENSION) injectStyles();
    ensureBadge();
    updateBadge();
  });
})();
