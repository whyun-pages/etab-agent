'use strict';
/**
 * The preview pages in as it is scrolled, in a real browser.
 *
 * What it covers
 * --------------
 *   1. a 1000-row table is not loaded whole: it opens with the first window
 *      (plus one page when that does not fill the pane), the header counts
 *      the whole table, and the line under the grid counts what is loaded
 *   2. scrolling the preview to the bottom fetches the next page, until every
 *      row is on screen and the line goes away
 *   3. the rows arrive in order, numbered as the sheet numbers them
 *   4. a page arriving does not throw the scroll position back to the top
 *
 * Usage: node .verify/browser/live-preview-paging.js
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'out');
const { createServer } = require(path.join(ROOT, 'src', 'http', 'server.ts'));
const { Settings } = require(path.join(ROOT, 'src', 'store', 'settings.ts'));
const { modelFromTransport } = require('../support/transport-model');
const { openPage, closePage, findEdge, sleep } = require('../support/cdp.js');

const ROWS = 1000;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
}

async function main() {
  console.log('preview paging, real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-paging-'));
  await new Settings(dataDir).save({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-not-a-real-key', model: 'stub', chatConfirmEdits: false });

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    model: await modelFromTransport(async () => JSON.stringify({
      intent: 'action',
      reply: '已生成',
      spec: {
        title: '分页探针表',
        sheets: [{
          name: 'S',
          columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'number' }],
          rows: Array.from({ length: ROWS }, (_, i) => [`客户${i + 1}`, i + 1]),
        }],
      },
    })),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  await fetch(`${base}/api/sessions/${created.session.id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '做一个表' }) });

  let page = null;
  try {
    page = await openPage({
      edge: findEdge(), profile: path.join(OUT, 'paging-profile'), url: base, port: 9764, window: '1440,1000', waitForSelector: '.rail',
    });
    // The app opens the most recent session on its own.
    await sleep(1500);

    const look = () => page.evaluate(`(() => {
      const body = document.querySelector('.preview__body');
      const trs = [...document.querySelectorAll('.preview__body table.grid tbody tr')];
      const last = trs[trs.length - 1];
      return JSON.stringify({
        rows: trs.length,
        lastNo: last ? last.querySelector('.rownum').textContent : '',
        lastCell: last ? last.querySelector('td').textContent : '',
        more: (document.querySelector('.preview__more') || {}).textContent || '',
        stat: (document.querySelector('.preview__stat') || {}).textContent || '',
        top: body ? body.scrollTop : -1,
      });
    })()`).then(JSON.parse);

    // The first window is 40 rows; when they do not fill the pane, the line
    // under them is already in view and one more page follows on its own. No
    // more than that until the user scrolls.
    const first = await look();
    check('the table is not loaded whole up front', first.rows === 40 || first.rows === 240, JSON.stringify(first));
    check('the header counts the whole table', /1000 行/.test(first.stat), first.stat);
    check('the line under the grid counts what is loaded', first.more.includes(`已显示 ${first.rows - 1} / 1000 行`), first.more);

    // Scroll to the bottom until everything is in, the way a user would.
    let now = first;
    let keptScroll = true;
    for (let i = 0; i < 40 && now.rows < ROWS + 1; i++) {
      await page.evaluate(`(() => { const b = document.querySelector('.preview__body'); b.scrollTop = b.scrollHeight; })()`);
      await sleep(400);
      const before = now;
      now = await look();
      // Rows were added under the user; the view must not jump back to row 1.
      if (now.rows > before.rows && now.top === 0) keptScroll = false;
    }
    check('scrolling to the bottom loaded every row', now.rows === ROWS + 1, JSON.stringify(now));
    check('the last row is the sheet\'s last, numbered as the sheet numbers it', now.lastNo === String(ROWS + 1) && now.lastCell === `客户${ROWS}`, JSON.stringify(now));
    check('the loading line is gone once everything is in', now.more === '', now.more);
    check('a page arriving does not reset the scroll position', keptScroll);
    const asked = page.requests('/preview?');
    check('rows came from the paging endpoint, a page at a time', asked.length >= 4 && asked.length <= 8, `requests=${asked.length}`);

    const order = await page.evaluate(`(() => {
      const names = [...document.querySelectorAll('.preview__body table.grid tbody tr')].slice(1).map((tr) => tr.querySelector('td').textContent);
      return names.every((n, i) => n === '客户' + (i + 1));
    })()`);
    check('every row arrived once, in order', order === true);

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'preview-paging.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    if (page) { try { await closePage(page, { trashProfile: true }); } catch {} }
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${failed === 0 ? 'PREVIEW PAGING CHECKS PASSED' : `${failed} FAILED`} (${passed} ok)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
