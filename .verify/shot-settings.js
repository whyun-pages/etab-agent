'use strict';
/**
 * Screenshot the model settings panel with a real browser.
 *
 * A bad import or a runtime error in the front-end only shows up when a browser
 * actually loads the page, so this drives Edge over CDP and reports console
 * errors as well as saving the picture. The panel is the point: the key field,
 * the plaintext-storage warning and the connection-test result all have to be
 * legible, and the key must not be displayed back.
 *
 * Usage: node .verify/shot-settings.js
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createServer } = require('../lib/server');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const DATA = path.join(OUT, 'shot-settings-data');
const PROFILE = path.join(OUT, 'edge-settings-profile');
const PORT = 3299;
const CDP_PORT = 9333;

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    const list = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/list' }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve([]); } });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(1000, () => { req.destroy(); resolve([]); });
    });
    const page = (list || []).find((t) => t.type === 'page');
    if (page && page.webSocketDebuggerUrl) return page;
    await sleep(400);
  }
  return null;
}

/** Minimal CDP session over the page websocket. */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.consoleErrors = []; }

  static async attach(wsUrl) {
    const WebSocket = globalThis.WebSocket;
    if (!WebSocket) throw new Error('global WebSocket unavailable in this Node build');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        cdp.consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        cdp.consoleErrors.push(msg.params.exceptionDetails.text
          + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    };
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timed out')); }
      }, 20000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 90));
    return r.result.value;
  }
}

async function capture(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  saved ${name}.png (${fs.statSync(file).size} bytes)`);
  return file;
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
    (ok ? '' : `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const server = createServer({
    dataDir: DATA,
    skillDir: path.join(DATA, 'skills'),
    staticDir: path.join(ROOT, 'public'),
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`server on http://127.0.0.1:${PORT}`);

  // Seed a saved key so the "already configured" state is what gets shot — that
  // is the state with the most to get wrong (hint shown, no key echoed).
  const SECRET = 'sk-shot-abcdef123456';
  await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: SECRET, baseUrl: 'https://api.example.test/v1', model: 'gpt-4o-mini' }),
  });

  if (!EDGE) { console.log('no Edge found'); server.close(); process.exit(1); }

  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  const target = await findPageTarget();
  if (!target) { console.error('no CDP page target'); edge.kill(); server.close(); process.exit(1); }

  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('\n=== 1) boot with no console errors ===');
  const booted = await cdp.eval(
    'JSON.stringify({activity: document.querySelectorAll(".activity__item").length,'
    + ' hasSettingsBtn: !!document.querySelector(\'.activity__item[data-activity="settings"]\'),'
    + ' title: document.title})',
  );
  console.log('     ' + booted);
  check('the settings activity button exists', JSON.parse(booted).hasSettingsBtn, true);
  check('no console errors on boot', cdp.consoleErrors, []);

  console.log('\n=== 2) open the settings panel ===');
  await cdp.eval('document.querySelector(\'.activity__item[data-activity="settings"]\').click()');
  await sleep(900);
  const opened = await cdp.eval(
    'JSON.stringify({panel: !!document.querySelector(".settings"),'
    + ' fields: document.querySelectorAll(".settings__input").length,'
    + ' toggles: document.querySelectorAll(".settings__toggle").length,'
    + ' notice: !!document.querySelector(".settings__notice")})',
  );
  console.log('     ' + opened);
  const o = JSON.parse(opened);
  check('the panel rendered', o.panel, true);
  check('three text fields (baseUrl, key, model)', o.fields, 3);
  // Assert the toggles that MATTER, by their labels, not by count.
  //
  // This used to check `toggles === 2`. Adding the two chat switches (edit, and
  // confirm-before-edit) made it fail — but nothing was broken; the assertion
  // was about the shape of the form at a moment in time. A count is a bad test
  // for a form that is expected to grow: it fails on every addition, and it
  // passes just as happily if a switch is replaced by a different one.
  const labels = JSON.parse(await cdp.eval(
    'JSON.stringify({labels: Array.from(document.querySelectorAll(".settings__label")).map(n => n.textContent)})',
  ));
  console.log('     labels: ' + JSON.stringify(labels.labels));
  for (const expected of ['让模型解析提示词', '让模型读取附件', '允许对话修改字段', '修改前需要确认']) {
    check(`the「${expected}」switch is present`,
      labels.labels.some((l) => l.includes(expected)), true);
  }
  check('every switch is labelled', labels.labels.length >= o.toggles, true);
  check('the storage notice is present', o.notice, true);
  await capture(cdp, '07-settings-empty');

  console.log('\n=== 3) the saved key is hinted, never shown ===');
  const shown = await cdp.eval(
    'JSON.stringify({keyValue: document.querySelectorAll(".settings__input")[1].value,'
    + ' hints: Array.from(document.querySelectorAll(".settings__hint")).map(h=>h.textContent),'
    + ' bodyHasSecret: document.body.innerHTML.includes("sk-shot-abcdef123456")})',
  );
  console.log('     ' + shown);
  const s = JSON.parse(shown);
  check('the key input is empty', s.keyValue, '');
  check('the raw key appears nowhere in the DOM', s.bodyHasSecret, false);
  check('a masked hint is shown', s.hints.some((h) => /3456/.test(h)), true);

  console.log('\n=== 4) a failing connection test reads as an error ===');
  // Point at an unroutable host so the test fails fast and deterministically.
  await cdp.eval(`(() => {
    const inputs = document.querySelectorAll('.settings__input');
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs[0], 'http://127.0.0.1:1/v1');
    set(inputs[2], 'gpt-4o-mini');
    return true;
  })()`);
  await sleep(300);
  await cdp.eval(
    'Array.from(document.querySelectorAll(".settings__actions .btn"))'
    + '.find(b => b.textContent.includes("测试")).click()',
  );
  await sleep(3500);
  const tested = await cdp.eval(
    'JSON.stringify({result: !!document.querySelector(".settings__result"),'
    + ' bad: !!document.querySelector(".settings__result--bad"),'
    + ' text: (document.querySelector(".settings__resultbody")||{}).textContent || ""})',
  );
  console.log('     ' + tested);
  const td = JSON.parse(tested);
  check('a result box appeared', td.result, true);
  check('it is styled as a failure', td.bad, true);
  check('the reason is shown, not a generic message', td.text.length > 0, true);
  await capture(cdp, '08-settings-test-failed');

  console.log('\n=== 5) console errors over the whole run ===');
  if (cdp.consoleErrors.length) {
    for (const e of cdp.consoleErrors) console.log('     ! ' + e);
  }
  check('no uncaught front-end errors', cdp.consoleErrors.length, 0);

  edge.kill();
  await sleep(500);
  server.close();

  console.log('\n' + (failures === 0 ? 'SETTINGS PANEL OK' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
