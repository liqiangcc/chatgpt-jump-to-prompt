/*
 * ChatGPT Jump to Prompt — background service worker.
 *
 * Exists solely because `chrome.commands` events are not delivered to content
 * scripts: this worker receives the keyboard command (registered in
 * manifest.json, remappable at chrome://extensions/shortcuts) and forwards it
 * to the content script in the active ChatGPT tab.
 */
'use strict';

const CHAT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !CHAT_URL.test(tab.url || '')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'cjp:command', command });
  } catch (e) {
    // Content script is not in the page yet — happens when the tab was loaded
    // before the extension was installed/reloaded. Inject it once, then retry.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'cjp:command', command });
    } catch (e2) {
      // Tab is gone or not injectable (e.g. error page) — nothing to do.
    }
  }
});
