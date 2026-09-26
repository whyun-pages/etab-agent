'use strict';
/**
 * Shared CDP plumbing for the .verify scripts.
 *
 * Several probes drive real Edge: take a screenshot, measure a short window,
 * count keystroke cost. Each of them had grown its own copy of "find Edge,
 * launch it headless on a throwaway profile, attach over CDP, navigate, clean
 * up" — including the same three gotchas:
 *
 *   1. Edge writes its CDP endpoint a moment after the process starts, so the
 *      port has to be polled, not read once.
 *   2. The first target is not always the one you want; pick by type.
 *   3. `Runtime.evaluate` with `awaitPromise` is needed for anything async, and
 *      an exception inside the page otherwise looks like a silent `undefined`.
 *
 * Usage:
 *   const { findEdge, openPage, closePage, sleep } = require('./cdp.js');
 *   const page = await openPage({ edge: findEdge(), profile, url, port: 4401 });
 *   await page.evaluate('document.title');
 *   await closePage(page, { trashProfile: true });
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRASH_ROOT = path.join(process.env.USERPROFILE || 'C:\\Users\\cola-', '.Trash');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** Path to msedge.exe, or a clear error naming what was checked. */
function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Edge not found; looked in:\n  ' + EDGE_CANDIDATES.join('\n  '));
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`bad JSON from ${urlPath}: ${text.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── CDP client ──────────────────────────────────────────────────────

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    /** Network.* events, for counting what actually hit the wire. */
    this.net = [];
    /** Every non-response frame, for diagnostics that need to see failures. */
    this.events = [];
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP socket failed to open: ' + wsUrl));
    });
    const client = new CDP(ws);
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.id) {
        const slot = client.pending.get(msg.id);
        if (!slot) return;
        client.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
        return;
      }
      if (msg.method && msg.method.startsWith('Network.')) client.net.push(msg);
      if (msg.method) {
        client.events.push(msg);
        const fns = client.listeners && client.listeners.get(msg.method);
        if (fns) for (const fn of fns) { try { fn(msg.params || {}); } catch { /* a listener must not kill the socket */ } }
      }
    };
    return client;
  }

  /**
   * Register a handler for one CDP event method.
   *
   * Added for a page that rendered nothing: `Page.navigate` resolves whether or
   * not the app booted, so without the browser's own error stream a blank screen
   * is indistinguishable from a slow one.
   */
  on(method, fn) {
    if (!this.listeners) this.listeners = new Map();
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return this;
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out after ' + timeoutMs + ' ms'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

// ── pids ────────────────────────────────────────────────────────────

function findBrowserProcesses() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq msedge.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const pids = String(stdout).split(/\r?\n/)
          .map((line) => (line.match(/^"[^"]+","(\d+)"/) || [])[1])
          .filter(Boolean).map(Number);
        resolve(pids);
      });
  });
}

/** Kill every Edge process. Guarded: an empty pid list means "do nothing". */
async function killBrowsers() {
  const pids = await findBrowserProcesses();
  if (!pids.length) return 0;
  await new Promise((resolve) => {
    execFile('taskkill', ['/F', ...pids.flatMap((p) => ['/PID', String(p)]), '/T'],
      { windowsHide: true }, () => resolve());
  });
  return pids.length;
}

/** Move a directory into the trash. Recursive delete trips the safety guard. */
function moveToTrash(src, label) {
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(TRASH_ROOT, `${label}-${stamp}`, path.basename(src));
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}

// ── page ────────────────────────────────────────────────────────────

/**
 * Launch Edge on a scratch profile and attach to its first page target.
 *
 * @param {{ edge: string, profile: string, url: string, port: number,
 *           window?: string, waitForSelector?: string }} opts
 */
async function openPage({ edge, profile, url, port, window = '1400,900', waitForSelector = null }) {
  if (!edge) edge = findEdge();
  fs.mkdirSync(path.dirname(profile), { recursive: true });

  const proc = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--force-device-scale-factor=1',
    `--window-size=${window}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await getJson(port, '/json/list');
      target = list.find((t) => t.type === 'page') || null;
    } catch { /* endpoint not up yet */ }
  }
  if (!target) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error('Edge CDP endpoint never came up on port ' + port);
  }

  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const page = {
    cdp,
    port,
    proc,
    profile,
    net: cdp.net,

    async send(method, params) { return cdp.send(method, params); },

    /** Evaluate in the page. Throws with the page's own message on error. */
    async evaluate(expression, { awaitPromise = true } = {}) {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      });
      if (r.exceptionDetails) {
        const text = (r.exceptionDetails.exception && r.exceptionDetails.exception.description)
          || r.exceptionDetails.text || 'unknown page error';
        throw new Error('page threw: ' + text.split('\n')[0]);
      }
      return r.result.value;
    },

    /** Evaluate an expression that yields JSON, and parse it. */
    async evaluateJson(expression) {
      const raw = await page.evaluate(expression);
      return raw === undefined || raw === null ? null : JSON.parse(raw);
    },

    async navigate(to = url) {
      await cdp.send('Page.navigate', { url: to });
      // Poll for the document to settle. `readyState` reaches 'complete' for
      // local pages well before the app has finished its first render, so the
      // caller can pass a selector to wait past that.
      for (let i = 0; i < 80; i++) {
        await sleep(100);
        try {
          const ready = await page.evaluate('document.readyState', { awaitPromise: false });
          if (ready !== 'complete' && ready !== 'interactive') continue;
          if (!waitForSelector) { if (ready === 'complete') return; continue; }
          const found = await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(waitForSelector)}))`, { awaitPromise: false });
          if (found) return;
        } catch { /* navigation in flight */ }
      }
      if (waitForSelector) throw new Error('selector never appeared: ' + waitForSelector);
    },

    /** Requests whose URL contains `needle`, from the Network.* stream. */
    requests(needle) {
      return cdp.net.filter((m) => m.method === 'Network.requestWillBeSent'
        && m.params && m.params.request && String(m.params.request.url).includes(needle));
    },

    screenshot(file) {
      return cdp.send('Page.captureScreenshot', { format: 'png' })
        .then((r) => { fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; });
    },
  };

  if (url) await page.navigate(url);
  return page;
}

async function closePage(page, { trashProfile = false } = {}) {
  if (!page) return;
  try { page.cdp.close(); } catch { /* ignore */ }
  await killBrowsers();
  try { if (page.proc) page.proc.kill(); } catch { /* ignore */ }
  await sleep(500);
  if (trashProfile && page.profile) moveToTrash(page.profile, 'tab-agent-cdp');
}

/** Discard every Edge process. For a probe's final teardown. */
async function closeAllBrowsers() {
  const n = await killBrowsers();
  await sleep(400);
  return n;
}

module.exports = {
  findEdge, openPage, closePage, closeAllBrowsers,
  killBrowsers, moveToTrash, sleep, CDP,
};
