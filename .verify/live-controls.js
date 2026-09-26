'use strict';
/**
 * The clicks that had no end-to-end test, with real mouse events.
 *
 * What it covers
 * --------------
 * `live-click.js` and `click-exe.js` drive the suggestion chips and the
 * splitters. `live-delete.js` drives the delete path. That left four controls a
 * user touches on the first run and a regression could quietly break:
 *
 *   1. 新建会话  (`.rail__head .iconbtn`)  — makes a fresh session
 *   2. 设置      (`#btn-settings`)          — opens the settings panel
 *   3. 保存      (settings save)            — writes settings, shows a status
 *   4. 下载      (`.preview__tools button`) — fetches the .xlsx
 *
 * Why CDP mouse events, not `.click()`
 * ------------------------------------
 * They are not the same thing. `element.click()` fires a synthetic event that
 * ignores hit-testing: an element under an invisible overlay, or with zero
 * size, still "clicks". CDP `Input.dispatchMouseEvent` goes through the real
 * hit test, which is how the delete bug's hover-only control was found. If a
 * button is covered or laid out wrong, this fails and `.click()` would not.
 *
 * Usage: node .verify/live-controls.js
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

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-controls-'));

function fakeSettings() {
  const record = {
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub-model',
    useForAttachments: false,
    chatCanEdit: true,
    chatConfirmEdits: false,
  };
  return {
    load: () => ({ ...record }),
    save: (patch) => Object.assign(record, patch),
    secrets: () => ({ baseUrl: record.baseUrl, apiKey: record.apiKey, model: record.model }),
    isConfigured: () => true,
    publicSettings: () => ({
      baseUrl: record.baseUrl, model: record.model, hasKey: true, keyHint: 'sk-…key',
      useForAttachments: false, chatCanEdit: true, chatConfirmEdits: false,
    }),
  };
}

/** One turn that lands a two-row table, so there is something to download. */
function specTransport() {
  return async () => JSON.stringify({
    intent: 'action',
    reply: '已生成',
    spec: {
      title: '控制探针表',
      sheets: [{
        name: 'S',
        columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'number' }],
        rows: [['甲', 100], ['乙', 200]],
      }],
    },
  });
}

async function main() {
  console.log('controls over real HTTP + real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = tmpdir();

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    settingsOverride: fakeSettings(),
    transport: specTransport(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let page = null;
  try {
    page = await openPage({
      edge: findEdge(),
      profile: path.join(OUT, 'controls-profile'),
      url: base,
      port: 9762,
      window: '1440,900',
      waitForSelector: '.rail',
    });
    await sleep(500);

    // ── helpers: real mouse, hit-tested ────────────────────────────────
    const boxOf = (sel) => page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    const hitIs = (sel, x, y) => page.evaluate(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return 'null';
      const target = el.closest(${JSON.stringify(sel)});
      return (target ? 'yes' : 'no') + ' | ' + el.tagName + '.' + (el.className || '');
    })()`);
    async function clickSel(sel) {
      const box = await boxOf(sel);
      if (!box) return false;
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 });
      await sleep(80);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(300);
      return true;
    }

    // ── 1. new session ─────────────────────────────────────────────────
    const railBefore = await page.evaluate('document.querySelectorAll(".rail__item").length');
    const addBtn = await boxOf('.rail__head .iconbtn');
    check('the 新建会话 button is present and sized', !!addBtn, JSON.stringify(addBtn));
    if (addBtn) {
      const hit = await hitIs('.rail__head .iconbtn', addBtn.x, addBtn.y);
      check('the 新建会话 button is the element at its own centre', /^yes/.test(hit), hit);
    }
    await clickSel('.rail__head .iconbtn');
    await sleep(700);
    // A new session is created on the server the moment it is opened, so the
    // count is not the signal; an empty transcript and the new-session status is.
    const msgAfterNew = await page.evaluate('document.querySelectorAll(".chat__row--me").length');
    check('新建会话 clears the transcript', msgAfterNew === 0, `rows=${msgAfterNew}`);
    const newStatus = await page.evaluate('(document.querySelector("#status-msg") || {}).textContent || ""');
    check('新建会话 resets the status to a new session', /新会话|就绪/.test(newStatus), JSON.stringify(newStatus));
    void railBefore;

    // ── 2. settings panel opens ────────────────────────────────────────
    const gear = await boxOf('#btn-settings');
    check('the 设置 button is present and sized', !!gear, JSON.stringify(gear));
    if (gear) {
      const hit = await hitIs('#btn-settings', gear.x, gear.y);
      check('the 设置 button is hit-testable at its centre', /^yes/.test(hit), hit);
    }
    await clickSel('#btn-settings');
    await sleep(700);
    const settingsOpen = await page.evaluate('Boolean(document.querySelector(".settings__input"))');
    check('clicking 设置 opens the settings form', settingsOpen === true);
    const btns = await page.evaluate(`(() => {
      return [...document.querySelectorAll('.settings button')].map((b) => b.textContent.trim()).join('|');
    })()`);
    check('the settings form has its action buttons', /保存|测试|清除/.test(btns), JSON.stringify(btns));

    // ── 3. the settings save round-trips ───────────────────────────────
    // Type a baseUrl into the FIRST text input and save; the settings object is
    // the server's, so a successful save is observable by re-reading it.
    const typed = await page.evaluate(`(() => {
      const inp = document.querySelector('.settings__input');
      if (!inp) return false;
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'http://127.0.0.1:9/v1');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return inp.value;
    })()`);
    check('an input was typeable', typed === 'http://127.0.0.1:9/v1', JSON.stringify(typed));

    const saveBox = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.settings button')].find((x) => /保存/.test(x.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    check('the 保存 button exists', !!saveBox, JSON.stringify(saveBox));
    if (saveBox) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: saveBox.x, y: saveBox.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: saveBox.x, y: saveBox.y, button: 'left', clickCount: 1 });
      await sleep(800);
    }
    const saved = await (await fetch(`${base}/api/settings`)).json();
    check('the saved baseUrl reached the server', saved.settings && saved.settings.baseUrl === 'http://127.0.0.1:9/v1',
      JSON.stringify(saved.settings));
    check('GET /api/settings never echoes the key', !JSON.stringify(saved).includes('sk-not-a-real-key'));

    // Close settings back to the chat.
    await clickSel('#btn-settings');
    await sleep(500);

    // ── 4. download button ─────────────────────────────────────────────
    // Seed a session with a table so the download is enabled.
    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    await fetch(`${base}/api/sessions/${created.session.id}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '做一个表' }),
    });
    await sleep(400);
    // Reload so the app opens the session that now has a table.
    await page.evaluate('location.reload()');
    await sleep(1600);
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.rail__item')]
        .find((r) => /控制探针表/.test((r.querySelector('.rail__name') || {}).textContent || ''));
      if (row) row.click();
    })()`);
    await sleep(1000);

    const dlBox = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.preview__tools button')].find((x) => /下载/.test(x.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    check('the 下载 button exists', !!dlBox, JSON.stringify(dlBox));
    check('the 下载 button is enabled with a table present', dlBox && dlBox.disabled === false, JSON.stringify(dlBox));

    if (dlBox && !dlBox.disabled) {
      // The click triggers a fetch to the workbook route; watch for it rather
      // than trusting that a blob appeared in a headless window.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dlBox.x, y: dlBox.y, button: 'none', clickCount: 0 });
      await sleep(80);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dlBox.x, y: dlBox.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dlBox.x, y: dlBox.y, button: 'left', clickCount: 1 });
      await sleep(900);
      const asked = page.requests('/workbook.xlsx');
      check('clicking 下载 requested the workbook bytes', asked.length >= 1, `requests=${asked.length}`);
    }

    // And the route itself answers with a real file.
    const xl = await fetch(`${base}/api/sessions/${created.session.id}/workbook.xlsx`);
    check('the workbook route serves a 200 xlsx', xl.status === 200, `status ${xl.status}`);
  } finally {
    if (page) { try { await closePage(page, { trashProfile: true }); } catch {} }
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failed === 0 ? 'CONTROLS CLICK CHECKS PASSED' : `${failed} FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
