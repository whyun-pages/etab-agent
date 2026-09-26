'use strict';
/**
 * Screenshot proof for the session UI.
 *
 * Starts the real server against a scratch data dir, drives the real page, and
 * writes PNGs. Nothing is stubbed: the point is to see what the user sees, and
 * a fixture that renders differently from the app would defeat that.
 *
 * Usage:
 *   node .verify/shot-ui.js                # empty state (no sessions yet)
 *   node .verify/shot-ui.js --seed         # with a generated session
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

const SEED = process.argv.includes('--seed');

const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge } = require('./cdp.js');

/** Start the app on a free port, against a scratch data dir. */
async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlui-'));
  // `staticDir` is required, not optional: without it every asset 404s and the
  // page comes up blank, which looks like a broken app rather than a broken
  // harness. The real entry resolves the same path.
  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, dataDir };
}

/** Talk to the app's own API, so the seed goes through the real code path. */
function call(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Write a session straight to disk: the transport is not what this proves. */
function seedSession(dataDir) {
  const { SessionStore } = require(path.join(ROOT, 'lib', 'session-store.js'));
  const store = new SessionStore(dataDir);
  const spec = {
    title: '销售台账',
    sheets: [{
      name: '销售台账',
      columns: [
        { header: '客户名称', type: 'text' },
        { header: '合同金额', type: 'currency' },
        { header: '签约日期', type: 'date' },
        { header: '税率', type: 'percent' },
        { header: '负责人', type: 'text' },
      ],
      rows: [
        // ISO strings, not Date objects: this is the shape that reaches the
        // server (the model emits JSON), and seeding the wrong one produced a
        // screenshot whose date column rendered as a raw ISO string. The
        // preview was fine; the fixture was not.
        ['杭州云图科技有限公司', 1250000, '2026-01-08', 0.06, '陈默'],
        ['上海临港数据服务', 860000, '2026-01-22', 0.06, '林一舟'],
        ['深圳前海智算中心', 880000, '2026-02-03', 0.13, '赵启'],
      ],
      totals: { enabled: true, sumColumns: [1] },
    }],
  };
  const s = store.create('销售台账');
  store.save({
    ...s,
    spec,
    messages: [
      { role: 'user', content: '做一个销售台账，三个客户：杭州云图、上海临港、深圳前海，金额分别是125万、86万、88万，签约日期分别是2026年1月8日、1月22日、2月3日，再加一列税率，百分之六、百分之六、百分之十三。', at: new Date().toISOString() },
      { role: 'assistant', content: '已创建销售台账，5 列 3 行。金额按元存储，税率按百分比格式；合计行只汇总金额。', at: new Date().toISOString(), intent: 'action' },
      { role: 'user', content: '把杭州云图那行的金额改成 150 万，再加一列负责人。', at: new Date().toISOString() },
      { role: 'assistant', content: '改好了。金额已改为 150 万，负责人列也加上了。', at: new Date().toISOString(), intent: 'action' },
    ],
  });
  return s.id;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, port, dataDir } = await startApp();
  const base = `http://127.0.0.1:${port}`;

  if (SEED) {
    // A placeholder key, in a scratch directory that is thrown away. Without
    // one the app opens straight on settings — correct behaviour, but it means
    // the chat screen would never appear in a screenshot, and the chat screen
    // is most of what there is to look at.
    const { Settings } = require(path.join(ROOT, 'lib', 'settings.js'));
    new Settings(dataDir).save({
      baseUrl: 'https://api.example.invalid/v1',
      apiKey: 'sk-not-a-real-key-0000',
      model: 'demo-model',
    });
    seedSession(dataDir);
  }

  const page = await openPage({
    edge: findEdge(),
    profile: path.join(OUT, 'shot-ui-profile'),
    url: base,
    port: 9731,
    window: '1440,900',
    // Not `.composer`: with no key configured the app opens on settings, so a
    // composer wait would time out on exactly the fresh-install case this
    // harness is most useful for.
    waitForSelector: '.shell',
  });

  // Give the first render + the session fetch time to settle.
  await page.send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 1800))', awaitPromise: true });

  const shots = [];
  const shot = async (name, expr) => {
    if (expr) await page.evaluate(expr);
    await page.send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 500))', awaitPromise: true });
    const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    shots.push([name, fs.statSync(file).size]);
  };

  // What the page actually did, so a blank screenshot is explainable.
  const report = await page.evaluate(`(() => {
    const err = document.querySelector('#error-banner');
    return JSON.stringify({
      title: document.title,
      rail: document.querySelectorAll('.rail__item').length,
      bubbles: document.querySelectorAll('.chat__row').length,
      gridCells: document.querySelectorAll('table.grid td').length,
      previewTitle: (document.querySelector('.preview__stat') || {}).textContent || '',
      bannerHidden: err ? err.hidden : null,
      bannerComputed: err ? getComputedStyle(err).display : null,
      bannerText: err ? err.textContent : null,
    });
  })()`);
  console.log('page report:', report);

  await shot(SEED ? '13-ui-seeded' : '13-ui-empty');

  // The settings screen is the other surface worth looking at.
  await shot('14-ui-settings', `document.querySelector('#btn-settings').click()`);

  await closePage(page, { trashProfile: true });
  server.close();
  for (const [name, size] of shots) console.log(`wrote ${name}.png (${size} bytes)`);

  void call;
}

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
