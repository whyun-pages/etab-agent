'use strict';
/**
 * Screenshot the settings panel in a window too short to hold it.
 *
 * This is the case the static shots cannot reach: at a comfortable window size
 * the settings form fits, so nothing looks wrong. The bug only appears when the
 * height runs out, and it shows up as the bottom of the form (the margin note
 * and the save row) being simply gone.
 *
 * Scrollbars are deliberately NOT hidden here — in a shot meant to show whether
 * the content is reachable, a hidden scrollbar would hide the evidence.
 *
 * Usage: node .verify/shot-settings-short.js [height]
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3251;
const CDP_PORT = 4251;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, '.verify', 'out');
const DATA = path.join(OUT, 'shot-short-data');
const PROFILE = path.join(OUT, 'shot-short-profile');
const HEIGHT = Number(process.argv[2] || 470);

const { createServer } = require(path.join(ROOT, 'lib', 'server'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(urlPath, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP websocket failed to open'));
    });
    const client = new CDP(ws);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        client.errors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
      }
      const slot = client.pending.get(msg.id);
      if (!slot) return;
      client.pending.delete(msg.id);
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
    };
    return client;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 20000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const server = createServer({ dataDir: DATA, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  edge.unref();

  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    await sleep(250);
    try {
      const res = await get('/json/list', CDP_PORT);
      page = JSON.parse(res.body).find((t) => t.type === 'page') || null;
    } catch { /* not up yet */ }
  }
  if (!page) throw new Error('Edge CDP never came up');

  const cdp = await CDP.attach(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1180, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await cdp.eval('!!document.querySelector(".editor__body")')) break;
  }

  // Open settings the way the user does.
  await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.activity__item')].find(x => x.dataset.activity === 'settings');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(700);

  const state = JSON.parse(await cdp.eval(`(() => {
    const sc = document.querySelector('.editor__scroll');
    const panel = document.querySelector('.settings');
    const foot = document.querySelector('.settings__actions');
    const rect = foot ? foot.getBoundingClientRect() : null;
    return JSON.stringify({
      viewport: innerHeight,
      scrollClientH: sc ? sc.clientHeight : -1,
      scrollH: sc ? sc.scrollHeight : -1,
      panelH: panel ? panel.offsetHeight : -1,
      // Is the save button inside the visible band before scrolling?
      footVisibleBeforeScroll: rect ? (rect.top >= 0 && rect.bottom <= innerHeight) : null,
      scrollable: sc ? sc.scrollHeight > sc.clientHeight + 1 : false,
    });
  })()`));

  console.log(`viewport         ${state.viewport}`);
  console.log(`scroll container ${state.scrollClientH}  content ${state.scrollH}  scrollable ${state.scrollable}`);
  console.log(`panel height     ${state.panelH}`);
  console.log(`save row visible without scrolling: ${state.footVisibleBeforeScroll}`);

  const a = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, '09-settings-short-top.png'), Buffer.from(a.data, 'base64'));

  // Then scroll to the bottom, which is only possible if the fix is in place.
  await cdp.eval(`(() => {
    const sc = document.querySelector('.editor__scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
    return sc ? sc.scrollTop : -1;
  })()`);
  await sleep(400);

  const after = JSON.parse(await cdp.eval(`(() => {
    const foot = document.querySelector('.settings__actions');
    const r = foot ? foot.getBoundingClientRect() : null;
    return JSON.stringify({ scrollTop: document.querySelector('.editor__scroll')?.scrollTop ?? -1,
      footVisible: r ? (r.top >= 0 && r.bottom <= innerHeight) : null });
  })()`));

  console.log(`after scrolling to bottom: scrollTop ${after.scrollTop}, save row reachable: ${after.footVisible}`);

  const b = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, '10-settings-short-bottom.png'), Buffer.from(b.data, 'base64'));

  console.log(`saved 09-settings-short-top.png, 10-settings-short-bottom.png`);
  if (cdp.errors.length) console.log('front-end errors:', cdp.errors);

  cdp.close();
  server.close();
  try { edge.kill(); } catch { /* ignore */ }
  await sleep(400);

  const ok = state.scrollable && after.footVisible;
  console.log(ok ? '\nSHORT WINDOW: content scrollable, save row reachable.' : '\nSHORT WINDOW: STILL CLIPPED.');
  return ok ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => { console.error('FAILED:', err.message); process.exit(2); });
