'use strict';
/**
 * Measure the status bar.
 *
 * The settings screenshot showed its text clipped at the bottom. Rather than
 * guess a pixel height, ask the browser what the box and its content actually
 * measure — the declared row height, the rendered height, and the content's
 * natural height are three different numbers and only the browser knows them.
 *
 * Usage: node .verify/shots/measure-statusbar.js
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../../src/http/server.ts');
const { openPage, closePage } = require('../support/browser.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'out');
const DATA = path.join(OUT, 'measure-data');
const PROFILE = path.join(OUT, 'edge-measure-profile');
const PORT = 3301;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DATA, { recursive: true, force: true });

  const server = createServer({ dataDir: DATA, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const page = await openPage({ profile: PROFILE, window: '1280,900' });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('.statusbar .status__group', { state: 'attached', timeout: 10000 });

  const report = await page.evaluate(`(() => {
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

  await closePage(page, { trashProfile: true });
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
