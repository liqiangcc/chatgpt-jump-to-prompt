# Tests

Not part of the extension — dev-only harness used to verify selector logic,
navigation behaviour and the hydration-safety gate.

## Setup

```bash
cd test
npm install
```

## Unit (jsdom, no browser)

```bash
node unit-jsdom.test.js
```

Covers: selector fallback chain (role attr / data-turn / h5+h6.sr-only /
layout heuristic), navigation, boundary toasts, composer fallback, DOM gate.

## E2E (real Chrome)

Needs a Chrome/Chromium build that still honours `--load-extension`
(Google Chrome 137+ ignores it — use **Chrome for Testing** or Chromium).
Set `CHROME_BIN` to the binary, then:

```bash
node gen-hydration-page.js   # SSR-matched mock page (renderToString)
xvfb-run -a node e2e.test.js # full path: commands -> SW -> sendMessage
```

`repro-hydration.js` is the React #418 regression check:

```bash
xvfb-run -a node repro-hydration.js <ext-dir|none>
```

It loads a mock page that hydrates the whole `document` ~2s after load
(mimicking chatgpt.com's Remix-style hydration) and reports console errors.
On the pre-gate code it throws `Minified React error #418/#423`; current
code injects only after hydration and stays clean.
