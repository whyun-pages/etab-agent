'use strict';
/**
 * Dragging a column edge in the preview, in a real browser.
 *
 * What it covers
 * --------------
 *   1. the grid draws each column at the width the file gives it
 *   2. dragging a column letter's right edge widens it live, and the release
 *      saves it to the session — in Excel units, the unit the file uses
 *   3. the downloaded xlsx has the dragged width
 *   4. rows already paged in, and the scroll position, survive the save
 *   5. a width survives reopening the session
 *
 * Usage: node .verify/browser/live-column-width.js
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
const { readWorkbook } = require(path.join(ROOT, 'src', 'formats', 'xlsx.ts'));
const { modelFromTransport } = require('../support/transport-model');
const { openPage, closePage, findEdge, sleep } = require('../support/cdp.js');

const ROWS = 2000;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

async function main() {
  console.log('column width, real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-colwidth-'));
  await new Settings(dataDir).save({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub',
    chatConfirmEdits: false,
  });

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    model: await modelFromTransport(async () =>
      JSON.stringify({
        intent: 'action',
        reply: '已生成',
        spec: {
          title: '列宽探针表',
          sheets: [
            {
              name: 'S',
              columns: [
                { header: '客户', type: 'text' },
                { header: '金额', type: 'number' },
                { header: '备注', type: 'text', width: 30 },
              ],
              rows: Array.from({ length: ROWS }, (_, i) => [`客户${i + 1}`, i + 1, `第 ${i + 1} 行的备注`]),
            },
          ],
        },
      }),
    ),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await (
    await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ).json();
  const id = created.session.id;
  await fetch(`${base}/api/sessions/${id}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '做一个表' }),
  });
  const stored = () =>
    JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8')).spec.sheets[0].columns;

  let page = null;
  try {
    page = await openPage({
      edge: findEdge(),
      profile: path.join(OUT, 'colwidth-profile'),
      url: base,
      port: 9766,
      window: '1440,900',
      waitForSelector: '.rail',
    });
    await sleep(1500);

    const look = () =>
      page
        .evaluate(`(() => {
      const ths = [...document.querySelectorAll('.preview__body table.grid thead th:not(.rownum)')];
      const body = document.querySelector('.preview__body');
      return JSON.stringify({
        widths: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
        rows: document.querySelectorAll('.preview__body table.grid tbody tr').length,
        top: body.scrollTop,
        handles: document.querySelectorAll('.grid__resize').length,
      });
    })()`)
        .then(JSON.parse);

    const first = await look();
    // 10 chars (the auto width for a short header) is 75px, 30 chars is 215px.
    check(
      "columns are drawn at the file's widths",
      first.widths[0] === 75 && first.widths[2] === 215,
      JSON.stringify(first.widths),
    );
    check('every column has a drag handle', first.handles === 3, JSON.stringify(first));

    // Page in more rows and scroll down, so the save has something to lose.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(
        `(() => { const b = document.querySelector('.preview__body'); b.scrollTop = b.scrollHeight; })()`,
      );
      await sleep(500);
    }
    await page.evaluate(`document.querySelector('.preview__body').scrollTop = 900`);
    await sleep(200);
    const before = await look();
    check('rows were paged in before the drag', before.rows > 41, JSON.stringify(before));

    // Drag column B's right edge 70px to the right with real mouse events.
    const at = await page
      .evaluate(`(() => {
      const r = document.querySelectorAll('.grid__resize')[1].getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`)
      .then(JSON.parse);
    const mouse = (type, x, buttons) =>
      page.send('Input.dispatchMouseEvent', { type, x, y: at.y, button: 'left', buttons, clickCount: 1 });
    await mouse('mouseMoved', at.x, 0);
    await mouse('mousePressed', at.x, 1);
    for (let dx = 10; dx <= 70; dx += 10) await mouse('mouseMoved', at.x + dx, 1);
    const live = await look();
    check('the column widens while dragging', live.widths[1] === first.widths[1] + 70, JSON.stringify(live.widths));
    await mouse('mouseReleased', at.x + 70, 0);
    await sleep(800);

    const after = await look();
    check('the width holds after the save', after.widths[1] === first.widths[1] + 70, JSON.stringify(after.widths));
    check(
      'the other columns did not move',
      after.widths[0] === first.widths[0] && after.widths[2] === first.widths[2],
      JSON.stringify(after.widths),
    );
    check('the paged-in rows are still there', after.rows === before.rows, `${before.rows} -> ${after.rows}`);
    check('the scroll position is kept', after.top === before.top, `${before.top} -> ${after.top}`);

    const cols = stored();
    // 75px + 70px = 145px = (145 - 5) / 7 = 20 characters.
    check('the session stores the width in Excel units', cols[1].width === 20, JSON.stringify(cols));
    check('only that column was stored', cols[0].width === null && cols[2].width === 30, JSON.stringify(cols));

    const bytes = Buffer.from(await (await fetch(`${base}/api/sessions/${id}/workbook.xlsx`)).arrayBuffer());
    const sheet = readWorkbook(bytes).sheets[0];
    const colB = (sheet.cols || []).find((c) => c.min <= 2 && 2 <= c.max);
    check('the downloaded xlsx has the dragged width', colB && colB.width === 20, JSON.stringify(sheet.cols));

    // More rows still page in under the new key.
    await page.evaluate(
      `(() => { const b = document.querySelector('.preview__body'); b.scrollTop = b.scrollHeight; })()`,
    );
    await sleep(800);
    const more = await look();
    check('paging carries on after the save', more.rows > after.rows, `${after.rows} -> ${more.rows}`);

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'column-width.png'), Buffer.from(shot.data, 'base64'));

    await page.evaluate('location.reload()');
    await sleep(2000);
    const reopened = await look();
    check(
      'the width survives reopening the session',
      reopened.widths[1] === first.widths[1] + 70,
      JSON.stringify(reopened.widths),
    );
  } finally {
    if (page) {
      try {
        await closePage(page, { trashProfile: true });
      } catch {}
    }
    await new Promise((r) => server.close(r));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n${failed === 0 ? 'COLUMN WIDTH CHECKS PASSED' : `${failed} FAILED`} (${passed} ok)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
