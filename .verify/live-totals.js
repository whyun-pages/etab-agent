'use strict';
/**
 * The totals-row round trip, over real HTTP and a real browser.
 *
 * The bug this pins down
 * ----------------------
 * The user asked for a 合计 row. The assistant replied "已为你添加金额合计行,
 * 120000+85000+230000=435000" — and the preview still showed three rows. The
 * spec on disk read `totals: {enabled: true, sumColumns: [1]}`.
 *
 * Root cause: `normalizeTotals` treated a bare NUMBER as a column NAME.
 * `String(1) === "1"` matched no column key and no header, so the entry was
 * dropped with a note, the resolved list came out empty, and `enabled` was
 * computed as `indices.length > 0` — which made it FALSE. A request to total a
 * column produced no totals row at all.
 *
 * Why this is a live probe and not a unit test
 * -------------------------------------------
 * The unit tests already cover `normalizeTotals` in isolation. What they cannot
 * show is the whole path a user's click travels: model reply -> normalise ->
 * guard -> store -> `writeSpec` -> `sheetPreview` bytes -> JSON -> grid. A break
 * anywhere in that chain (an `await`, a wrong preview function, a stale build)
 * leaves the unit tests green. So: real `createServer`, real socket, real Edge
 * over CDP, and the assertion is on the RENDERED CELLS.
 *
 * The transport is faked at the `transport` seam, so no model is contacted and
 * no key is needed — but everything downstream of the model is real.
 *
 * Usage: node .verify/live-totals.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge, sleep } = require('./cdp.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-totals-'));

function fakeSettings() {
  const record = {
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub-model',
    useForAttachments: false,
    chatCanEdit: true,
    chatConfirmEdits: false, // apply immediately, so one round trip lands a spec
  };
  return {
    load: () => record,
    save: (patch) => ({ ...record, ...patch }),
    secrets: () => ({ baseUrl: record.baseUrl, apiKey: record.apiKey, model: record.model }),
    isConfigured: () => true,
    publicSettings: () => ({
      baseUrl: record.baseUrl, model: record.model, hasKey: true, keyHint: 'sk-…key',
      useForAttachments: false, chatCanEdit: true, chatConfirmEdits: false,
    }),
  };
}

/**
 * Two turns: create the table, then add the totals row the way the model did.
 *
 * The second reply is the one that failed — `sumColumns: [1]` is the exact shape
 * the model emitted, index included, because that is what has to keep working.
 */
function totalsTransport() {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) {
      return JSON.stringify({
        intent: 'action',
        reply: '已为你创建销售台账，包含三个客户的金额和签约日期。',
        spec: {
          title: '销售台账',
          sheets: [{
            name: '销售台账',
            columns: [
              { header: '客户', type: 'text' },
              { header: '金额', type: 'currency' },
              { header: '签约日期', type: 'date' },
            ],
            rows: [['客户A', 120000, '2026-01-15'], ['客户B', 85000, '2026-02-20'], ['客户C', 230000, '2026-03-10']],
          }],
        },
      });
    }
    return JSON.stringify({
      intent: 'action',
      reply: '已为你添加金额合计行，120000+85000+230000=435000。',
      spec: {
        title: '销售台账',
        sheets: [{
          name: '销售台账',
          columns: [
            { header: '客户', type: 'text' },
            { header: '金额', type: 'currency' },
            { header: '签约日期', type: 'date' },
          ],
          rows: [['客户A', 120000, '2026-01-15'], ['客户B', 85000, '2026-02-20'], ['客户C', 230000, '2026-03-10']],
          // BY INDEX, as the model actually emitted it. This is the whole point.
          totals: { enabled: true, label: '合计', sumColumns: [1] },
        }],
      },
    });
  };
}

async function main() {
  console.log('totals row over real HTTP + real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = tmpdir();

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    settingsOverride: fakeSettings(),
    transport: totalsTransport(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const req = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  let page = null;
  try {
    // ── 1. create the table over HTTP ──────────────────────────────────
    const created = await req('POST', '/api/sessions', { title: '' });
    const id = created.json.session.id;
    const t1 = await req('POST', `/api/sessions/${id}/turn`, { message: '做一个销售台账，三个客户，金额和签约日期' });
    check('the create turn is an applied action', t1.json.intent === 'action' && t1.json.applied === true, JSON.stringify(t1.json).slice(0, 160));
    check('the create preview has 4 rows (header + 3)', t1.json.preview && t1.json.preview.rows.length === 4, JSON.stringify(t1.json.preview && t1.json.preview.rows.length));

    // ── 2. the turn that failed: add the totals row ────────────────────
    const t2 = await req('POST', `/api/sessions/${id}/turn`, { message: '我想添加一个所有客户的金额合计的显示' });
    check('the totals turn is an applied action', t2.json.intent === 'action' && t2.json.applied === true, JSON.stringify(t2.json).slice(0, 160));

    // The server-side preview is the authoritative grid the client draws.
    const rows = (t2.json.preview && t2.json.preview.rows) || [];
    check('the preview grew to 5 rows (header + 3 + 合计)', rows.length === 5, `got ${rows.length}: ${JSON.stringify(rows)}`);
    const totalRow = rows[rows.length - 1] || [];
    check('the last row is labelled 合计', totalRow[0] === '合计', JSON.stringify(totalRow));
    check('the last row carries the summed amount 435000', totalRow[1] === 435000, JSON.stringify(totalRow));

    // ── 3. what actually got stored ────────────────────────────────────
    const stored = await req('GET', `/api/sessions/${id}`);
    const storedTotals = stored.json.session.spec.sheets[0].totals;
    check('the stored spec has totals enabled', storedTotals.enabled === true, JSON.stringify(storedTotals));
    check('the stored spec resolved the index to sumColumns [1]', JSON.stringify(storedTotals.sumColumns) === '[1]', JSON.stringify(storedTotals));

    // ── 4. reload it: the same grid must come back ─────────────────────
    const reloaded = await req('GET', `/api/sessions/${id}`);
    check('a reload serves the same 5-row preview', reloaded.json.preview.rows.length === 5, JSON.stringify(reloaded.json.preview.rows.length));

    // ── 5. the rendered DOM, not just the JSON ─────────────────────────
    // Boot may not land on this session (no deep link), so open it the way a
    // person does: hover the rail row and click it, then wait for the grid.
    page = await openPage({
      edge: findEdge(),
      profile: path.join(OUT, 'totals-profile'),
      url: base,
      port: 9761,
      window: '1440,900',
      waitForSelector: '.rail__item',
    });
    await sleep(400);

    const opened = await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.rail__item')]
        .find((r) => (r.querySelector('.rail__name') || {}).textContent === '销售台账')
        || document.querySelector('.rail__item');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    check('a session row was there to open', opened === true);

    // Wait for the grid to actually render rather than sleeping on a hope.
    let haveGrid = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      haveGrid = await page.evaluate('Boolean(document.querySelector(".grid"))');
      if (haveGrid) break;
    }
    check('the preview grid rendered', haveGrid);

    const gridText = await page.evaluate(`(() => {
      const grid = document.querySelector('.grid');
      return grid ? grid.innerText : '';
    })()`);
    check('the rendered grid cells include 合计', /合计/.test(gridText), JSON.stringify(gridText.slice(0, 240)));
    check('the rendered grid cells include 435,000 (formatted)', /435[,，]?000/.test(gridText), JSON.stringify(gridText.slice(0, 240)));

    // The header meta line says how many data rows there are — and it counts the
    // totals row too, which is why it reads 4 here, not 3.
    const headerMeta = await page.evaluate(`(document.querySelector('.chat__meta') || {}).textContent || ''`);
    check('the header row count accounts for the totals row', /4 行/.test(headerMeta), JSON.stringify(headerMeta));

    // ── 6. the download still reflects it ──────────────────────────────
    const dl = await req('GET', `/api/sessions/${id}/workbook.xlsx`);
    check('the download is still a real xlsx', dl.status === 200 && dl.text.length > 0, `status ${dl.status}`);
  } finally {
    if (page) { try { await closePage(page, { trashProfile: true }); } catch {} }
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failed === 0 ? 'TOTALS ROUND-TRIP PASSED' : `${failed} FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
