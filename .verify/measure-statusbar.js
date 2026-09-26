'use strict';
/**
 * Measure the status bar.
 *
 * The settings screenshot showed its text clipped at the bottom. Rather than
 * guess a pixel height, ask the browser what the box and its content actually
 * measure — the declared row height, the rendered height, and the content's
 * natural height are three different numbers and only the browser knows them.
 *
 * Usage: node .verify/measure-statusbar.js
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createServer } = require('../lib/server');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const DATA = path.join(OUT, 'measure-data');
const PROFILE = path.join(OUT, 'edge-measure-profile');
const PORT = 3301;
const CDP_PORT = 9335;

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
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(400);
  }
  return null;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(url) {
    const ws = new globalThis.WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timeout')); } }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const server = createServer({
    dataDir: DATA, skillDir: path.join(DATA, 'skills'), staticDir: path.join(ROOT, 'public'),
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  const target = await findPageTarget();
  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2200);

  const report = await cdp.eval(`(() => {
    const sb = document.querySelector('.statusbar');
    const group = sb.querySelector('.status__group');
    const rects = (el) => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), text: (el.textContent||'').trim().slice(0,20) };
    };
    return JSON.stringify({
      sb: rects(sb),
      group: rects(group),
      groupScrollW: group.scrollWidth,
      groupClientW: group.clientWidth,
      groupOverflows: group.scrollWidth > group.clientWidth + 1,
      children: Array.from(group.children).map(rects),
      bodyScrollW: document.body.scrollWidth,
      bodyClientW: document.body.clientWidth,
      bodyOverflows: document.body.scrollWidth > document.body.clientWidth + 1,
    }, null, 1);
  })()`);

  console.log(report);

  edge.kill();
  await sleep(400);
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
