'use strict';
/**
 * Does the content actually scroll when the window is short?
 *
 * "No scrollbar when the height is not enough" cannot be settled by reading
 * CSS. A container can look correct in the source and still clip, because the
 * real question is whether some ancestor between it and the viewport is itself
 * constrained. So measure the live page under a short viewport.
 *
 * For each candidate panel this reports:
 *   clientH    — the visible height
 *   scrollH    — the content height
 *   canScroll  — scrollH > clientH, i.e. there is more content than fits
 *   overflowY  — the computed overflow-y
 *
 * The bug shape is: canScroll is true while overflowY is 'hidden' — content
 * extends past the bottom and there is no way to reach it.
 *
 * Usage:
 *   node .verify/short-window.js                 # default 360px viewport
 *   node .verify/short-window.js --height 300
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3202;
const CDP_PORT = 4202;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, '.verify', 'out');
const DATA = path.join(OUT, 'short-window-data');
const PROFILE = path.join(OUT, 'short-window-profile');

// Go through the viewport rather than --window-size: Edge floors the window
// height, and we want to get well below any floor.
const heightArg = process.argv.indexOf('--height');
const HEIGHT = Number(heightArg >= 0 ? process.argv[heightArg + 1] : 360);
// --exe drives the packaged executable instead of a dev server. There the UI
// assets are embedded in the binary, so a fix that only exists on disk would
// pass this check while the shipped app stayed broken.
const USE_EXE = process.argv.includes('--exe');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');

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

/** Minimal DevTools client over the global WebSocket (Node 22+). */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 20000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/**
 * Every element that is, or should be, a scroll container. Reported whether or
 * not it currently overflows, so an empty result and a healthy result look
 * different.
 */
const PROBE = `(() => {
  const targets = [
    ['body',            document.body],
    ['.editor',         document.querySelector('.editor')],
    ['.editor__body',   document.querySelector('.editor__body')],
    ['.editor__scroll', document.querySelector('.editor__scroll')],
    ['.settings',       document.querySelector('.settings')],
    ['.welcome',        document.querySelector('.welcome')],
    ['.work',           document.querySelector('.work')],
    ['.work__main',     document.querySelector('.work__main')],
    ['.work__aside',    document.querySelector('.work__aside')],
    ['.sidebar',        document.querySelector('.sidebar')],
    ['.modal__box',     document.querySelector('.modal__box')],
    ['.modal__body',    document.querySelector('.modal__body')],
    ['.palette__list',  document.querySelector('.palette__list')],
  ];
  const out = [];
  for (const [sel, node] of targets) {
    if (!node) continue;
    const cs = getComputedStyle(node);
    const clientH = node.clientHeight;
    const scrollH = node.scrollHeight;
    const hasMore = scrollH > clientH + 1;
    out.push({
      sel,
      clientH,
      scrollH,
      hasMore,
      overflowY: cs.overflowY,
      // More content than fits, and it is not reachable => the reported bug.
      clipped: hasMore && cs.overflowY === 'hidden',
    });
  }

  // body overflowing is a symptom, not a diagnosis: something inside it is
  // taller than its track. Name that child so a failure points at a cause.
  const b = document.body;
  if (b.scrollHeight > b.clientHeight + 1) {
    const kids = [...b.children].map((n) => {
      const tag = n.tagName.toLowerCase();
      const cls = (n.className || '').toString().trim().split(/\s+/)[0];
      const r = n.getBoundingClientRect();
      return { name: tag + (cls ? '.' + cls : ''), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
    });
    for (const k of kids) {
      if (k.bottom > b.clientHeight + 1) {
        out.push({
          sel: '  ↳ overflows: ' + k.name,
          clientH: k.h,
          scrollH: k.bottom,
          hasMore: true,
          overflowY: 'bottom=' + k.bottom,
          clipped: true,
        });
      }
    }
  }

  out.push({ sel: 'viewport', clientH: innerHeight, scrollH: 0, hasMore: false, overflowY: '-', clipped: false });
  return JSON.stringify(out);
})()`;

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  // `staticDir` has no default in createServer — the packaged build serves
  // assets from inside the executable and passes nothing. A development
  // checkout must pass it explicitly or every asset 404s.
  let server = null;
  let exe = null;
  if (USE_EXE) {
    exe = spawn(EXE, ['--headless', `--port=${PORT}`, `--data-dir=${DATA}`], { stdio: 'ignore' });
    let up = null;
    for (let i = 0; i < 80 && !up; i++) {
      await sleep(250);
      try { up = JSON.parse((await get('/api/health')).body); } catch { /* not up yet */ }
    }
    if (!up) throw new Error('packaged exe never answered /api/health');
    console.log(`packaged exe listening on ${PORT}`);
  } else {
    server = createServer({ dataDir: DATA, staticDir: path.join(ROOT, 'public') });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  }

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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // The viewport is the whole point: the app lays out from it.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

  // Wait for the app to actually render. Evaluating too early silently measures
  // about:blank, which looks like a healthy page with no panels in it — the most
  // misleading possible result for this particular probe.
  let ready = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ href: location.href, hasEditor: !!document.querySelector('.editor__body'), activities: document.querySelectorAll('.activity__item').length })`,
      returnByValue: true,
    });
    ready = JSON.parse(r.result.value);
    if (ready.hasEditor) break;
  }
  console.log('page:', ready.href, '| editor:', ready.hasEditor, '| activity items:', ready.activities);
  if (!ready.hasEditor) throw new Error('app never rendered — measured page would be about:blank');

  let failures = 0;

  for (const view of ['workspace', 'settings']) {
    if (view === 'settings') {
      // Click the gear the way a user would, rather than setting state directly.
      const clicked = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const items = [...document.querySelectorAll('.activity__item')];
          const gear = items.find(b => b.dataset.view === 'settings' || /设置|模型/.test(b.textContent));
          if (gear) { gear.click(); return gear.dataset.view || gear.textContent.trim(); }
          return 'NOT FOUND: ' + items.map(b => b.dataset.view || b.textContent.trim()).join(' | ');
        })()`,
        returnByValue: true,
      });
      console.log(`\n[${view}] gear click → ${clicked.result.value}`);
      await sleep(700);
    }

    const res = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const rows = JSON.parse(res.result.value);

    console.log(`\n=== view: ${view}   viewport height: ${HEIGHT} ===`);
    console.log('  ' + 'selector'.padEnd(15) + 'clientH'.padStart(8) + 'scrollH'.padStart(9)
      + '  ' + 'overflowY'.padEnd(10) + ' verdict');
    for (const r of rows) {
      const verdict = r.sel === 'viewport' ? `innerHeight=${r.clientH}`
        : r.clipped ? 'CLIPPED — content unreachable'
        : r.hasMore ? 'overflows, scrollable' : 'fits';
      if (r.clipped) failures++;
      console.log('  ' + r.sel.padEnd(15) + String(r.clientH).padStart(8) + String(r.scrollH).padStart(9)
        + '  ' + r.overflowY.padEnd(10) + ' ' + verdict);
    }
  }

  cdp.close();
  if (server) server.close();
  if (exe) { try { exe.kill(); } catch { /* ignore */ } }
  try { edge.kill(); } catch { /* ignore */ }
  await sleep(400);

  console.log('');
  if (failures) {
    console.log(`RESULT: ${failures} panel(s) clip their content with no way to scroll.`);
  } else {
    console.log('RESULT: no panel clips unreachable content at this height.');
  }
  return failures;
}

main()
  .then((n) => process.exit(n ? 1 : 0))
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(2);
  });
