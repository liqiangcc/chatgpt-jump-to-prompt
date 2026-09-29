// SSR via renderToString -> markup matches client vdom exactly.
const React = require('react');
const { renderToString } = require('react-dom/server');
const e = React.createElement;
const DELAY = parseInt(process.env.HDELAY || '2000', 10);

const INLINE = `window.__T={load:performance.now()};new MutationObserver(function(muts){for(const m of muts)for(const n of m.addedNodes)if(n.nodeType===1&&String(n.className||'').indexOf('cjp')===0)window.__T.badgeAt=performance.now()}).observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){window.__hydrate&&window.__hydrate()},${DELAY})`;

const App = () => e('html', null,
  e('head', null,
    e('title', null, 'ChatGPT'),
    e('script', { src: 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js' }),
    e('script', { src: 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js' }),
    e('script', { dangerouslySetInnerHTML: { __html: INLINE } })),
  e('body', null,
    e('div', { id: 'app' }, e('main', null,
      e('article', { 'data-testid': 'conversation-turn-1', 'data-turn': 'user' }, e('div', { 'data-message-author-role': 'user' }, e('div', { className: 'whitespace-pre-wrap' }, 'question one'))),
      e('article', { 'data-testid': 'conversation-turn-2', 'data-turn': 'assistant' }, e('div', { 'data-message-author-role': 'assistant' }, e('div', { className: 'markdown' }, 'answer one'))),
      e('article', { 'data-testid': 'conversation-turn-3', 'data-turn': 'user' }, e('div', { 'data-message-author-role': 'user' }, e('div', { className: 'whitespace-pre-wrap' }, 'question two'))))),
    e('div', { id: 'prompt-textarea', contentEditable: 'true' })));

const ssr = '<!DOCTYPE html>' + renderToString(e(App));
const driver = `<script>window.__hydrate=function(){window.__T.hydrateStart=performance.now();var e=React.createElement;var App=function(){return e('html',null,e('head',null,e('title',null,'ChatGPT'),e('script',{src:'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js'}),e('script',{src:'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js'}),e('script',{dangerouslySetInnerHTML:{__html:${JSON.stringify(INLINE)}}})),e('body',null,e('div',{id:'app'},e('main',null,e('article',{'data-testid':'conversation-turn-1','data-turn':'user'},e('div',{'data-message-author-role':'user'},e('div',{className:'whitespace-pre-wrap'},'question one'))),e('article',{'data-testid':'conversation-turn-2','data-turn':'assistant'},e('div',{'data-message-author-role':'assistant'},e('div',{className:'markdown'},'answer one'))),e('article',{'data-testid':'conversation-turn-3','data-turn':'user'},e('div',{'data-message-author-role':'user'},e('div',{className:'whitespace-pre-wrap'},'question two'))))),e('div',{id:'prompt-textarea',contentEditable:'true'})))};ReactDOM.hydrateRoot(document,e(App));setTimeout(function(){window.__T.hydrateDone=performance.now()},300)}</script>`;
require('fs').writeFileSync(require('path').join(__dirname, 'hydrate.mock.html'), ssr.replace('</html>', driver + '</html>'));
console.log('written, delay', DELAY);
