'use strict';
/**
 * Folding the session list, driven with real input over CDP.
 *
 * What has to hold:
 *   - the toggle folds the rail to a strip and hides its splitter;
 *   - "new session" still works from the strip;
 *   - the fold survives a reload (localStorage), and Ctrl+B toggles it;
 *   - a width the user dragged comes back intact after unfolding — the fold
 *     must not overwrite --rail-w.
 *
 * Usage: node --require ./tools/dev-resolve.js .verify/live-rail-fold.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge, sleep } = require('./cdp.js');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}  ${extra}`); }
}

async function main() {
  console.log('session list folding');
  fs.mkdirSync(OUT, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlfold-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    baseUrl: 'https://api.example.invalid/v1', apiKey: 'sk-placeholder', model: 'placeholder',
  }, null, 2));

  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await openPage({
    edge: findEdge(), profile: path.join(OUT, 'fold-profile'), url: base, port: 9757, window: '1440,900',
  });
  await sleep(900);

  const width = (sel) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.getBoundingClientRect().width : -1; })()`);
  const visible = (sel) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getBoundingClientRect().width > 0; })()`);
  const boxOf = (sel) => page.evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`).then((s) => (s ? JSON.parse(s) : null));
  async function click(sel) {
    const b = await boxOf(sel);
    if (!b) throw new Error('no element for ' + sel);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', clickCount: 0 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(300);
  }
  const sessionCount = async () => (await (await fetch(`${base}/api/sessions`)).json()).sessions.length;

  // ── a dragged width, so unfolding has something to restore ─────────
  await page.evaluate(`localStorage.setItem('tab-agent:columns', JSON.stringify({ '--rail-w': 300 }))`);
  await page.send('Page.reload', {});
  await sleep(900);
  check('open rail starts at the dragged width', Math.abs((await width('#rail')) - 300) < 2, String(await width('#rail')));
  check('the rail has a fold button', !!(await boxOf('.rail__head .rail__toggle')));

  // ── fold ───────────────────────────────────────────────────────────
  await click('.rail__head .rail__toggle');
  const folded = await width('#rail');
  check('folding shrinks the rail to a strip', folded > 20 && folded < 60, `rail=${folded}`);
  check('the rail splitter is hidden when folded', !(await visible('#split-rail')));
  // The first version hid the splitter with display:none, which pulled it out
  // of the auto-placed grid: the pane slid into the 0px track and vanished.
  check('the chat pane takes the freed width', (await width('#pane')) > 600, 'pane=' + (await width('#pane')));
  check('the session list is not rendered when folded', !(await visible('.rail__list')) && !(await visible('.rail__head')));
  check('the fold is persisted', (await page.evaluate(`localStorage.getItem('tab-agent:rail-collapsed')`)) === '1');
  await page.screenshot(path.join(OUT, 'rail-folded.png'));

  // ── new session from the strip ─────────────────────────────────────
  const before = await sessionCount();
  await click('.rail__strip .rail__add');
  await sleep(400);
  check('new session works from the folded strip', (await sessionCount()) === before + 1);

  // ── survives reload ────────────────────────────────────────────────
  await page.send('Page.reload', {});
  await sleep(900);
  check('a reload keeps the rail folded', (await width('#rail')) < 60, String(await width('#rail')));

  // ── unfold restores the dragged width ──────────────────────────────
  await click('.rail__strip .rail__toggle');
  check('unfolding restores the dragged width', Math.abs((await width('#rail')) - 300) < 2, String(await width('#rail')));
  check('the splitter is back after unfolding', await visible('#split-rail'));

  // ── Ctrl+B ─────────────────────────────────────────────────────────
  const key = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', { type, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 2 });
    }
    await sleep(300);
  };
  await key();
  check('Ctrl+B folds', (await width('#rail')) < 60);
  await key();
  check('Ctrl+B unfolds', Math.abs((await width('#rail')) - 300) < 2);

  await closePage(page, { trashProfile: true });
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* scratch */ }

  console.log(failures ? `\n${failures} FAILED` : '\nRAIL FOLD CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
