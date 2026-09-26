'use strict';
/**
 * Why is the page blank?
 *
 * `shot-ui.js` waited for `.shell` and never saw it. That means either the HTML
 * never arrived, a module failed to load, or boot() threw before the first
 * render — and those three need different fixes. This dumps what the browser
 * actually got, plus every console message and page error.
 *
 * Usage: node .verify/probe-ui-boot.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge } = require('./cdp.js');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlprobe-'));
  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const page = await openPage({
    edge: findEdge(),
    profile: path.join(OUT, 'probe-boot-profile'),
    url: 'about:blank',
    port: 9741,
  });

  // Collect everything the page says.
  page.cdp.on('Runtime.consoleAPICalled', (m) => {
    const args = (m.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console.log(`[console.${m.type}] ${args}`);
  });
  page.cdp.on('Runtime.exceptionThrown', (m) => {
    const d = m.exceptionDetails || {};
    const text = (d.exception && d.exception.description) || d.text || '(no detail)';
    console.log(`[page error] ${String(text).split('\n').slice(0, 3).join(' | ')}`);
  });
  page.cdp.on('Network.loadingFailed', (m) => console.log(`[load failed] ${m.errorText}`));
  page.cdp.on('Network.responseReceived', (m) => {
    const r = m.response || {};
    if (r.status >= 400) console.log(`[http ${r.status}] ${r.url}`);
  });

  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await page.send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 2500))', awaitPromise: true });

  const dump = await page.evaluate(`JSON.stringify({
    readyState: document.readyState,
    title: document.title,
    bodyLength: document.body ? document.body.innerHTML.length : -1,
    hasShell: Boolean(document.querySelector('.shell')),
    hasRail: Boolean(document.querySelector('#rail')),
    hasComposer: Boolean(document.querySelector('.composer')),
    hasPaneBody: Boolean(document.querySelector('#pane-body')),
    paneBodyHtml: (document.querySelector('#pane-body') || {}).innerHTML ? document.querySelector('#pane-body').innerHTML.slice(0, 200) : '',
    scripts: [...document.querySelectorAll('script')].map(s => s.src || s.type),
    statusMsg: (document.querySelector('#status-msg') || {}).textContent || '',
  })`, { awaitPromise: false });
  console.log('\nDOM:', dump);

  // Fetch the module directly: a 404 or a syntax error here explains the rest.
  const mod = await page.evaluate(`fetch('/js/app.js').then(r => r.text()).then(t => JSON.stringify({status: 200, head: t.slice(0, 80), len: t.length})).catch(e => 'fetch failed: ' + e.message)`);
  console.log('module fetch:', mod);

  await closePage(page, { trashProfile: true });
  server.close();
}

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
