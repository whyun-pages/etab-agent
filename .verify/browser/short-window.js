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
 *   node .verify/browser/short-window.js                 # default 360px viewport
 *   node .verify/browser/short-window.js --height 300
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { openPage, closePage, sleep } = require('../support/browser.js');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3202;
const OUT = path.join(ROOT, '.verify', 'out');
const DATA = path.join(OUT, 'short-window-data');
const PROFILE = path.join(OUT, 'short-window-profile');

// The viewport, not the window: Edge floors a window's height, and we want to
// get well below any floor. browser.js sets the viewport as an override.
const heightArg = process.argv.indexOf('--height');
const HEIGHT = Number(heightArg >= 0 ? process.argv[heightArg + 1] : 360);
// --exe drives the packaged executable instead of a dev server. There the UI
// assets are embedded in the binary, so a fix that only exists on disk would
// pass this check while the shipped app stayed broken.
const USE_EXE = process.argv.includes('--exe');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');

const { createServer } = require(path.join(ROOT, 'src', 'http', 'server.ts'));

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

/**
 * Every element that is, or should be, a scroll container. Reported whether or
 * not it currently overflows, so an empty result and a healthy result look
 * different.
 */
const PROBE = `(() => {
  const targets = [
    ['body',            document.body],
    ['.shell',          document.querySelector('.shell')],
    ['.rail',           document.querySelector('.rail')],
    ['.rail__body',     document.querySelector('.rail__body')],
    ['.pane',           document.querySelector('.pane')],
    ['.pane__body',     document.querySelector('.pane__body')],
    ['.chat__stream',   document.querySelector('.chat__stream')],
    ['.preview',        document.querySelector('.preview')],
    ['.preview__body',  document.querySelector('.preview__body')],
    ['.setpage',        document.querySelector('.setpage')],
    ['.settings__nav',  document.querySelector('.settings__nav')],
    ['.settings__main', document.querySelector('.settings__main')],
    ['.modal__box',     document.querySelector('.modal__box')],
    ['.modal__body',    document.querySelector('.modal__body')],
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
      // Doubled backslash: this is source inside a template string, where a
      // single one is dropped and the browser would split on the letter s.
      const cls = (n.className || '').toString().trim().split(/\\s+/)[0];
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
      try {
        up = JSON.parse((await get('/api/health')).body);
      } catch {
        /* not up yet */
      }
    }
    if (!up) throw new Error('packaged exe never answered /api/health');
    console.log(`packaged exe listening on ${PORT}`);
  } else {
    server = createServer({ dataDir: DATA, staticDir: path.join(ROOT, 'public') });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  }

  const page = await openPage({ profile: PROFILE, window: `1280,${HEIGHT}` });
  await page.goto(`http://127.0.0.1:${PORT}/`);

  // Wait for the app to actually render. Measuring too early silently
  // measures about:blank, which looks like a healthy page with no panels in
  // it — the most misleading possible result for this particular probe.
  // (The first version waited for '.editor__body', a class from an earlier
  // UI: it timed out on every run, and the probe reported "never rendered".)
  const rendered = await page
    .waitForSelector('.rail__head', { state: 'attached', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  console.log('page:', page.url(), '| rendered:', rendered);
  if (!rendered) throw new Error('app never rendered — measured page would be about:blank');

  let failures = 0;

  // Which view is up decides what can be measured: a fresh data folder has no
  // model configured, and the app then opens on settings with the workspace
  // hidden. So each view is reached from wherever the app is, by clicking the
  // gear the way a user would (it toggles), rather than assumed.
  const settingsShown = () => page.evaluate(`!document.getElementById('settings-page').hidden`);
  for (const view of ['workspace', 'settings']) {
    const want = view === 'settings';
    if ((await settingsShown()) !== want) {
      await page.click('#btn-settings');
      await page
        .waitForFunction((on) => !document.getElementById('settings-page').hidden === on, want, { timeout: 5000 })
        .catch(() => {});
    }
    const reached = (await settingsShown()) === want;
    console.log(`\n[${view}] ${reached ? 'shown' : 'NOT reached'}`);
    if (!reached) failures++;

    const rows = JSON.parse(await page.evaluate(PROBE));

    console.log(`\n=== view: ${view}   viewport height: ${HEIGHT} ===`);
    console.log(
      '  ' +
        'selector'.padEnd(15) +
        'clientH'.padStart(8) +
        'scrollH'.padStart(9) +
        '  ' +
        'overflowY'.padEnd(10) +
        ' verdict',
    );
    for (const r of rows) {
      const verdict =
        r.sel === 'viewport'
          ? `innerHeight=${r.clientH}`
          : r.clipped
            ? 'CLIPPED — content unreachable'
            : r.hasMore
              ? 'overflows, scrollable'
              : 'fits';
      if (r.clipped) failures++;
      console.log(
        '  ' +
          r.sel.padEnd(15) +
          String(r.clientH).padStart(8) +
          String(r.scrollH).padStart(9) +
          '  ' +
          r.overflowY.padEnd(10) +
          ' ' +
          verdict,
      );
    }
  }

  // Trashed, so the next run starts unfolded: a profile left behind keeps the
  // last run's splitter widths and folded rail, and the panels measure differently.
  await closePage(page, { trashProfile: true });
  if (server) server.close();
  if (exe) {
    try {
      exe.kill();
    } catch {
      /* ignore */
    }
  }
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
