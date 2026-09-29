/*
 * ChatGPT Jump to Prompt — content script.
 *
 * Lets you jump back to your own messages in a long chat:
 *   Alt+J      -> scroll to the most recent prompt
 *   Alt+Up     -> previous prompt
 *   Alt+Down   -> next prompt
 *
 * The shortcuts arrive via background.js (chrome.commands -> tabs.sendMessage).
 * Everything else lives here: message discovery, smooth scroll, highlight,
 * floating badge, toasts, SPA navigation handling and DOM observation.
 */
(() => {
  'use strict';
  if (globalThis.__CJP_LOADED__) return; // guard against double injection
  globalThis.__CJP_LOADED__ = true;

  /* ======================================================================
   * SELECTORS — update this block when ChatGPT's markup changes.
   *
   * Current markup (observed 2025): each conversation turn is an <article>
   * wrapper; the message node inside carries data-message-author-role which
   * is "user" for your own prompts. We try selectors from most to least
   * reliable and normalise every hit up to its enclosing <article> (the
   * visual "turn"), because scrolling to the article top also shows the
   * prompt header and keeps a clean edge under the sticky site header.
   * ==================================================================== */
  const USER_MESSAGE_SELECTORS = [
    // Primary: role attribute on the rendered message node.
    '[data-message-author-role="user"]',
    // Older/alternate builds expose the role on the turn wrapper itself,
    // e.g. <article data-turn="user" data-testid="conversation-turn-3">.
    '[data-turn="user"]',
    'article[data-turn="user"]',
  ];

  // Composer fallback — used when no prompt can be located at all.
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',          // contenteditable div used by ChatGPT
    'form textarea',
    'textarea',
    'form [contenteditable="true"]',
  ];

  const HIGHLIGHT_CLASS = 'cjp-highlight';
  const HIGHLIGHT_MS = 1600;          // breathing-outline duration
  const HEADER_OFFSET_PX = 96;        // scroll-margin under the sticky header
  const OBSERVER_DEBOUNCE_MS = 400;

  /* ================================================================== */
  /*  State                                                              */
  /* ================================================================== */

  // The element of the prompt we last jumped to (index is derived on demand,
  // so insertions/removals from virtualised rendering can't desync us).
  let currentEl = null;
  let lastUrl = location.href;

  let badgeEl = null;      // floating widget root
  let badgeLabel = null;   // span inside the widget
  let badgeHidden = false; // user dismissed it for this session
  let toastEl = null;
  let toastTimer = 0;
  let hlTimer = 0;
  let moTimer = 0;

  /* ================================================================== */
  /*  Message discovery                                                  */
  /* ================================================================== */

  /*
   * Last-ditch heuristic for when the data-* attributes above disappear
   * entirely. A "user turn" is assumed to be an <article> that
   *   - does NOT contain an assistant message node, and
   *   - contains a right-aligned bubble (ChatGPT renders user bubbles in a
   *     flex row aligned to the end; Tailwind utility classes usually
   *     contain justify-end / items-end / self-end / ml-auto).
   * Best-effort only — see README "Maintaining selectors".
   */
  function heuristicUserTurns() {
    const articles = document.querySelectorAll('article');
    const out = [];
    for (const a of articles) {
      if (a.querySelector('[data-message-author-role="assistant"]')) continue;
      if (!((a.innerText || '').trim())) continue;
      if (a.querySelector('[class*="justify-end"], [class*="items-end"], [class*="self-end"], [class*="ml-auto"]')) {
        out.push(a);
      }
    }
    return out;
  }

  /*
   * Collect user-message turn elements in document order.
   * Only messages currently rendered in the DOM are returned — ChatGPT
   * virtualises long histories, and we deliberately do not force-load more.
   */
  function getUserTurns() {
    let nodes = [];
    for (const sel of USER_MESSAGE_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) { nodes = Array.from(found); break; }
    }
    if (!nodes.length) nodes = heuristicUserTurns();

    const seen = new Set();
    const turns = [];
    for (const n of nodes) {
      const root = n.closest('article') || n;
      if (seen.has(root)) continue;
      seen.add(root);
      // Skip zero-height ghosts left by virtualisation.
      if (root.getBoundingClientRect().height > 0) turns.push(root);
    }
    return turns;
  }

  /* ================================================================== */
  /*  Navigation                                                         */
  /* ================================================================== */

  function jumpToIndex(turns, i) {
    const el = turns[i];
    currentEl = el;
    // scroll-margin-top keeps the prompt below the site's sticky header.
    el.style.scrollMarginTop = HEADER_OFFSET_PX + 'px';
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    highlight(el);
    updateBadge(turns);
  }

  /*
   * When we have no established "current" prompt (fresh page, conversation
   * switch, or the target was unmounted by virtualisation), derive a starting
   * index from the viewport: "previous" means the last prompt above the
   * reading line, "next" the first one below it.
   */
  function indexFromViewport(turns, dir) {
    const probe = HEADER_OFFSET_PX + 24; // reading line just under the header
    if (dir < 0) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].getBoundingClientRect().top < probe) return i;
      }
      return 0; // nothing above — the first prompt is the closest thing
    }
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].getBoundingClientRect().top >= probe) return i;
    }
    return turns.length - 1; // nothing below — land on the last prompt
  }

  function jumpLast() {
    const turns = getUserTurns();
    if (!turns.length) return fallbackToComposer();
    jumpToIndex(turns, turns.length - 1);
  }

  function step(dir) {
    const turns = getUserTurns();
    if (!turns.length) return fallbackToComposer();

    const cur = currentEl ? turns.indexOf(currentEl) : -1;
    if (cur < 0) {
      jumpToIndex(turns, indexFromViewport(turns, dir));
      return;
    }
    const i = cur + dir;
    if (i < 0 || i >= turns.length) {
      showToast(dir < 0 ? '已经是第一条提问' : '已经是最后一条提问');
      return;
    }
    jumpToIndex(turns, i);
  }

  /*
   * Guaranteed-never-silent fallback: no prompt found -> scroll to the
   * composer and tell the user what happened.
   */
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
  /*  Visual feedback                                                    */
  /* ================================================================== */

  function highlight(el) {
    // Remove the class everywhere first, then force a reflow so re-jumping to
    // the same element restarts the breathing animation.
    document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((e) => e.classList.remove(HIGHLIGHT_CLASS));
    void el.offsetWidth;
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
  /*  Floating badge (right edge): click = jump to last prompt           */
  /* ================================================================== */

  function ensureBadge() {
    if (badgeEl || badgeHidden) return;
    badgeEl = document.createElement('div');
    badgeEl.className = 'cjp-badge';

    const btn = document.createElement('button');
    btn.className = 'cjp-badge-btn';
    btn.title = '跳到最后一条提问 (Alt+J)';
    btn.innerHTML = '<span class="cjp-badge-arrow">↑</span><span class="cjp-badge-label"></span>';
    btn.addEventListener('click', jumpLast);

    const hide = document.createElement('button');
    hide.className = 'cjp-badge-hide';
    hide.title = '隐藏按钮（刷新页面后恢复）';
    hide.textContent = '×';
    hide.addEventListener('click', () => {
      badgeHidden = true;
      badgeEl.remove();
      badgeEl = badgeLabel = null;
    });

    badgeLabel = btn.querySelector('.cjp-badge-label');
    badgeEl.appendChild(btn);
    badgeEl.appendChild(hide);
    document.documentElement.appendChild(badgeEl);
  }

  function updateBadge(turns) {
    if (!badgeEl) return;
    turns = turns || getUserTurns();
    const total = turns.length;
    const cur = currentEl ? turns.indexOf(currentEl) : -1;
    badgeLabel.textContent =
      total === 0 ? '暂无提问' :
      cur >= 0 ? `第 ${cur + 1}/${total} 条提问` : `共 ${total} 条提问`;
  }

  /* ================================================================== */
  /*  SPA navigation + DOM observation                                   */
  /* ================================================================== */

  // React Router swaps history without a full reload, so watch the URL from
  // several angles: popstate, the Navigation API, and a slow poll as a final
  // safety net (cheap — it's just a string compare).
  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    currentEl = null; // reset navigation state for the new conversation
    updateBadge();
  }

  window.addEventListener('popstate', checkNavigation);
  try { window.navigation.addEventListener('navigate', checkNavigation); } catch (e) {}
  setInterval(checkNavigation, 1000);

  // New messages (streaming replies, virtualised scrolling) change the DOM —
  // debounce a recount so the badge stays accurate without churning.
  const mo = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(() => { checkNavigation(); updateBadge(); }, OBSERVER_DEBOUNCE_MS);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  /* ================================================================== */
  /*  Command entry point (from background.js via chrome.commands)       */
  /* ================================================================== */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'cjp:command') return;
    if (msg.command === 'jump-to-last-prompt') jumpLast();
    else if (msg.command === 'jump-to-prev-prompt') step(-1);
    else if (msg.command === 'jump-to-next-prompt') step(1);
  });

  ensureBadge();
  updateBadge();
})();
