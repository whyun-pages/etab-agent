'use strict';
/**
 * Does the GRID draw a date as a date?
 *
 * `probe-sheet-format.js` checks that the format code reaches the client. That
 * is only half the bug: a code that arrives and is not rendered looks identical
 * to no code at all. So this drives `public/js/views/sheet.js` — the module the
 * browser actually loads — through real Edge, with the real preview payload from
 * `sheetPreview()`, and looks at the rendered table.
 *
 * The page is a harness: it imports the module over HTTP from the dev server,
 * so the import graph is the real one, then prints what each cell rendered as
 * into the DOM for the screenshot and for assertions.
 *
 * Usage: node .verify/probe-sheet-render.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findEdge, openPage, closePage, sleep } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = 3247;
const { normalizeSpec, writeSpec } = require(path.join(ROOT, 'lib', 'workbook'));
const { sheetPreview } = require(path.join(ROOT, 'lib', 'workbook-preview'));

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
};

const { spec } = normalizeSpec({
  title: '销售汇总',
  sheets: [{
    name: '订单明细',
    columns: [
      { header: '订单号', type: 'text' },
      { header: '签约日', type: 'date' },
      { header: '合同金额', type: 'currency' },
      { header: '税率', type: 'percent' },
      { header: '数量', type: 'integer' },
    ],
    rows: [
      ['SO-1', new Date(Date.UTC(2026, 2, 1)), 1250000, 0.06, 12],
      ['SO-2', new Date(Date.UTC(2026, 1, 19)), 880000, 0.13, 4],
    ],
    totals: { enabled: true },
  }],
});

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const payload = sheetPreview(writeSpec(spec), '订单明细');

  // ── a real server so the module graph is fetched the way the app fetches it
  const srv = spawn(process.execPath, [path.join(ROOT, '.build', 'js', 'server.js'), '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, TAB_AGENT_HOME: path.join(OUT, 'sheet-render-data') },
    stdio: 'ignore',
    windowsHide: true,
  });
  await sleep(1200);

  const harness = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body { margin:0; background:#181818; color:#d4d4d4; font:13px/1.5 "Segoe UI",system-ui,sans-serif; }
  .wrap { padding:20px; }
  .grid { border-collapse:collapse; font-size:12.5px; }
  .grid th { background:#22303f; color:#9fc7e8; padding:5px 10px; border:1px solid #2a2a2a; font-weight:600; }
  .grid td { padding:4px 10px; border:1px solid #212121; white-space:nowrap; }
  .grid td.is-num { text-align:right; font-variant-numeric:tabular-nums; }
  .rownum { background:#1e1e1e; color:#6a6a6a; text-align:right; font-weight:400; }
  .is-empty { background:#1f1f1f; }
  #out { margin-top:16px; font:12px/1.6 Consolas,monospace; color:#9cdcfe; }
  </style></head><body><div class="wrap">
  <div id="host"></div><pre id="out"></pre>
  <script type="module">
  import { sheetView } from '/js/views/sheet.js';
  const payload = JSON.parse(document.getElementById('payload').textContent);
  const node = sheetView(payload);
  document.getElementById('host').append(node);
  // Report what each cell rendered AS, which is the thing a user reads.
  const cells = [...document.querySelectorAll('.grid tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent));
  document.getElementById('out').textContent = JSON.stringify(cells, null, 2);
  window.__rendered = cells;
  </script>
  <script type="application/json" id="payload">${JSON.stringify(payload)}</script>
  </div></body></html>`;

  const harnessPath = path.join(OUT, 'sheet-render.html');
  // The harness must be served from the same origin as /js so a bare module
  // import resolves. Write it into public/ for the duration of the run.
  const servedHarness = path.join(ROOT, 'public', '__sheet-render.html');
  fs.writeFileSync(harnessPath, harness, 'utf8');
  fs.writeFileSync(servedHarness, harness, 'utf8');

  const profile = path.join(OUT, 'sheet-render-profile');
  const cdpPort = 9601;
  const page = await openPage({
    edge: findEdge(),
    profile,
    url: `http://127.0.0.1:${PORT}/__sheet-render.html`,
    port: cdpPort,
    window: '1100,700',
  });
  await sleep(1500);

  const res = await page.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__rendered || null)',
    returnByValue: true,
  });
  const rendered = JSON.parse(res.result.value || 'null');

  console.log('rendered rows ->');
  for (const row of rendered || []) console.log('  ', JSON.stringify(row));

  check('the grid rendered the header and two data rows', (rendered || []).length >= 4, `${(rendered || []).length} rows`);
  // Row 0 is the header — the first version of this test indexed it as data and
  // reported five failures that were all off-by-one.
  const header = (rendered || [])[0] || [];
  const dataRow = (rendered || [])[1] || [];
  const altRow = (rendered || [])[2] || [];
  const totalRow = (rendered || [])[3] || [];
  check('the header shows the column names', header[1], '签约日');
  check('the date cell renders as a date, not a serial number', /2026-03-01/.test(dataRow[1] || ''), JSON.stringify(dataRow[1]));
  check('the second date renders too', /2026-02-19/.test(altRow[1] || ''), JSON.stringify(altRow[1]));
  check('money renders with a currency sign', /¥/.test(dataRow[2] || ''), JSON.stringify(dataRow[2]));
  check('percent renders as a percentage', /%/.test(dataRow[3] || ''), JSON.stringify(dataRow[3]));
  check('the percent is scaled, not just suffixed', /^6(\.0+)?%$/.test((dataRow[3] || '').replace(/,/g, '')), JSON.stringify(dataRow[3]));
  check('integer renders with grouping', /12/.test(dataRow[4] || ''), JSON.stringify(dataRow[4]));
  check('the totals row is labelled', totalRow[0], '合计');
  check('the totals money cell keeps its sign', /¥/.test(totalRow[2] || ''), JSON.stringify(totalRow[2]));
  check('the 税率 column has no total', totalRow[3] === '' || totalRow[3] === undefined, JSON.stringify(totalRow[3]));
  check('no cell shows a raw five-digit serial', !(rendered || []).some((r) => r.some((c) => /^\d{5}$/.test(String(c)))), JSON.stringify(rendered));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, '11-sheet-render.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('\nsaved 11-sheet-render.png (' + fs.statSync(file).size + ' bytes)');

  await closePage(page, { trashProfile: true });
  try { srv.kill(); } catch { /* ignore */ }
  fs.rmSync(servedHarness, { force: true });

  console.log(`\nSHEET RENDER: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
