'use strict';
/**
 * The saving/fetching settings and the download-format picker, in a real
 * browser with real clicks.
 *
 * What it covers
 * --------------
 *   1. the 保存与联网 group renders: save toggle, export directory, fetch toggle
 *   2. the blocklist box is hidden until fetching is switched on, and appears
 *      without a re-render when it is
 *   3. saving round-trips all four fields through the real Settings store,
 *      with the blocklist normalised by the server
 *   4. the preview's format picker downloads CSV and JSON, not just xlsx
 *
 * Settings are a real `Settings` in a throwaway directory (not a stub), so
 * the round trip includes the file. The key is not real and never leaves
 * this process; the model is scripted.
 *
 * Usage: node .verify/browser/live-save-fetch.js
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

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
}

async function main() {
  console.log('save/fetch settings + download formats, real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-save-fetch-'));
  const exportDir = path.join(dataDir, 'exports');
  await new Settings(dataDir).save({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-not-a-real-key', model: 'stub' });

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    model: await modelFromTransport(async () => JSON.stringify({
      intent: 'action',
      reply: '已生成',
      spec: {
        title: '格式探针表',
        sheets: [{ name: 'S', columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'number' }], rows: [['甲', 100], ['乙', 200]] }],
      },
    })),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let page = null;
  try {
    page = await openPage({
      edge: findEdge(), profile: path.join(OUT, 'save-fetch-profile'), url: base, port: 9763, window: '1440,1000', waitForSelector: '.rail',
    });
    await sleep(600);

    const clickAt = async (box) => {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(300);
    };
    /** Scroll an element into view and return its centre, found by a JS expression. */
    const boxOf = (expr) => page.evaluate(`(() => {
      const el = ${expr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    const toggleNamed = (label) => `[...document.querySelectorAll('.settings__toggle')].find((t) => t.textContent.includes(${JSON.stringify(label)}))`;
    const fieldNamed = (label) => `[...document.querySelectorAll('.settings__field')].find((f) => (f.querySelector('.settings__label') || {}).textContent === ${JSON.stringify(label)})`;

    // ── 1. the group renders ──────────────────────────────────────────
    await clickAt(await boxOf(`document.querySelector('#btn-settings')`));
    await sleep(600);
    // These switches live on the 会话 tab; the page opens on 模型.
    await clickAt(await boxOf(`[...document.querySelectorAll('.settings__tab')].find((b) => b.textContent.includes('会话'))`));
    await sleep(300);
    const group = await page.evaluate(`[...document.querySelectorAll('.settings__group')].map((g) => g.textContent).join('|')`);
    check('the 保存与联网 group is there', /保存与联网/.test(group), group);
    const saveOn = await page.evaluate(`(${toggleNamed('允许对话保存文件')} || {}).querySelector?.('input')?.checked`);
    check('saving is on by default', saveOn === true, String(saveOn));
    const fetchOn = await page.evaluate(`(${toggleNamed('允许对话联网抓取')} || {}).querySelector?.('input')?.checked`);
    check('fetching is off by default', fetchOn === false, String(fetchOn));
    const placeholder = await page.evaluate(`((${fieldNamed('导出目录')}) || {}).querySelector?.('input')?.placeholder || ''`);
    check('the export directory shows where saves go by default', /Downloads/i.test(placeholder), placeholder);

    // ── 2. the blocklist appears with fetching ────────────────────────
    const hiddenBefore = await page.evaluate(`(() => { const f = ${fieldNamed('禁止抓取的网站')}; return f ? getComputedStyle(f).display : 'missing'; })()`);
    check('the blocklist is hidden while fetching is off', hiddenBefore === 'none', hiddenBefore);
    await clickAt(await boxOf(`(${toggleNamed('允许对话联网抓取')}).querySelector('input')`));
    const shownAfter = await page.evaluate(`(() => { const f = ${fieldNamed('禁止抓取的网站')}; return f ? getComputedStyle(f).display : 'missing'; })()`);
    check('switching fetching on shows the blocklist', shownAfter !== 'none' && shownAfter !== 'missing', shownAfter);
    const formShot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'save-fetch-settings.png'), Buffer.from(formShot.data, 'base64'));

    // ── 3. type, save, read back ──────────────────────────────────────
    await page.evaluate(`(() => {
      const set = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set((${fieldNamed('导出目录')}).querySelector('input'), ${JSON.stringify(exportDir)});
      set((${fieldNamed('禁止抓取的网站')}).querySelector('textarea'), 'https://Ads.Example.com/x\\n*.tracker.example\\n');
      return true;
    })()`);
    await clickAt(await boxOf(`(${toggleNamed('允许对话保存文件')}).querySelector('input')`));
    await clickAt(await boxOf(`[...document.querySelectorAll('.settings button')].find((b) => /保存/.test(b.textContent))`));
    await sleep(800);
    const saved = (await (await fetch(`${base}/api/settings`)).json()).settings;
    check('chatCanFetch saved', saved.chatCanFetch === true, JSON.stringify(saved));
    check('chatCanSave saved (switched off)', saved.chatCanSave === false);
    check('exportDir saved', saved.exportDir === exportDir, saved.exportDir);
    check('the blocklist was normalised by the server', JSON.stringify(saved.fetchBlocklist) === JSON.stringify(['ads.example.com', 'tracker.example']), JSON.stringify(saved.fetchBlocklist));
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    check('and it reached settings.json', onDisk.chatCanFetch === true && onDisk.exportDir === exportDir);

    // ── 4. download in other formats ──────────────────────────────────
    const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatConfirmEdits: false }) });
    await fetch(`${base}/api/sessions/${created.session.id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '做一个表' }) });
    await page.evaluate('location.reload()');
    await sleep(1600);
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.rail__item')].find((r) => /格式探针表/.test(r.textContent));
      if (row) row.click();
    })()`);
    await sleep(1000);

    const picker = await page.evaluate(`(() => { const s = document.querySelector('.preview__format'); return s ? JSON.stringify({ disabled: s.disabled, options: [...s.options].map((o) => o.value) }) : null; })()`);
    check('the format picker is there and enabled', picker && JSON.parse(picker).disabled === false, picker);
    check('it offers xlsx, csv and json', picker && JSON.parse(picker).options.join() === 'xlsx,csv,json', picker);

    for (const format of ['csv', 'json']) {
      await page.evaluate(`(() => {
        const s = document.querySelector('.preview__format');
        s.value = ${JSON.stringify(format)};
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const before = page.requests(`/workbook.${format}`).length;
      await clickAt(await boxOf(`[...document.querySelectorAll('.preview__tools button')].find((b) => /下载/.test(b.textContent))`));
      await sleep(800);
      const asked = page.requests(`/workbook.${format}`);
      check(`clicking 下载 with ${format} picked requested workbook.${format}`, asked.length > before, `requests=${asked.length}`);
      if (format === 'csv') check('the CSV request names the sheet on screen', asked.some((m) => /sheet=S\b/.test(m.params.request.url)), asked.map((m) => m.params.request.url).join(' '));
    }
    const status = await page.evaluate('(document.querySelector("#status-msg") || {}).textContent || ""');
    check('the status names the downloaded file', /格式探针表\.json/.test(status), status);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'save-fetch-preview.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    if (page) { try { await closePage(page, { trashProfile: true }); } catch {} }
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${failed === 0 ? 'SAVE/FETCH UI CHECKS PASSED' : `${failed} FAILED`} (${passed} ok)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
