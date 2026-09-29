/*
 * ChatGPT Jump to Prompt — background service worker.
 *
 * Exists solely because `chrome.commands` events are not delivered to content
 * scripts: this worker receives the keyboard command (registered in
 * manifest.json, remappable at chrome://extensions/shortcuts) and forwards it
 * to the content script in the active ChatGPT tab.
 *
 * It also answers 'cjp:which-commands' so the content script's local keydown
 * fallback only covers shortcuts that failed to bind — and stays silent for
 * ones the user deliberately unbound.
 */
'use strict';

const CHAT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;
const CONTENT_JS = 'chatgpt-jump.user.js';
const CONTENT_CSS = 'content.css';

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !CHAT_URL.test(tab.url || '')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'cjp:command', command });
  } catch (e) {
    // Content script is not in the page yet — happens when the tab was loaded
    // before the extension was installed/reloaded. Inject it once, then retry.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [CONTENT_CSS] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_JS] });
      await chrome.tabs.sendMessage(tab.id, { type: 'cjp:command', command });
    } catch (e2) {
      // Tab is gone or not injectable (e.g. error page) — nothing to do.
    }
  }
});

// Report which commands currently have a bound shortcut.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'cjp:which-commands') return;
  chrome.commands.getAll((commands) => {
    sendResponse(commands.filter((c) => c.shortcut).map((c) => c.name));
  });
  return true; // async sendResponse
});
