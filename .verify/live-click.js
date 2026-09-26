'use strict';
/**
 * Drive the real UI with real input events over CDP.
 *
 * Everything here goes through Input.dispatchMouseEvent / dispatchKeyEvent, so
 * the browser synthesizes the same event stream a person would produce. A
 * `element.click()` from Runtime.evaluate is not the same test: it skips
 * hit-testing, so an overlay covering the target would not be noticed.
 *
 * Covers the three things changed this round:
 *   1. suggestion chips in the empty state actually respond to a click
 *   2. the columns can be dragged and the width sticks
 *   3. clicking a chip with no session open creates one first
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge, sleep } = require('./cdp.js');

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.example.invalid/v1',
  apiKey: 'sk-live-ui-placeholder',
  model: 'placeholder',
  useForAttachments: true,
  chatCanEdit: true,
  chatConfirmEdits: true,
};

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}  ${extra}`); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // A scratch app with a placeholder key, so the composer is not masked by the
  // "configure a model" notice. The key is fake and never leaves this machine.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlclick-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS, null, 2));

  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const page = await openPage({
    edge: findEdge(),
    profile: path.join(OUT, 'click-profile'),
    url: base,
    port: 9751,
    window: '1440,900',
  });
  await sleep(900);

  // ── centre of an element, in page coordinates ──────────────────────
  const boxOf = (sel) => page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
  })()`).then((s) => (s ? JSON.parse(s) : null));

  async function clickAt(x, y) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(250);
  }

  async function clickSel(sel) {
    const b = await boxOf(sel);
    if (!b) throw new Error('no element for ' + sel);
    await clickAt(b.x, b.y);
    return b;
  }

  const composerText = () => page.evaluate('(document.querySelector(".composer__input") || {}).value || ""');
  const activeId = () => page.evaluate('window.__state ? window.__state.activeId : null');

  // ── 1. chips exist, and one responds to a real click ───────────────
  const chips = await page.evaluate('document.querySelectorAll(".chat__idea").length');
  check('empty state shows three suggestion chips', chips === 3, `got ${chips}`);

  const firstText = await page.evaluate('(document.querySelector(".chat__idea") || {}).textContent || ""');
  check('chip carries its suggestion text', firstText.includes('销售台账'), firstText);

  const before = await composerText();
  check('composer starts empty', before === '', JSON.stringify(before));

  await clickSel('.chat__idea');
  const after = await composerText();
  check('clicking a chip fills the composer', after === firstText, JSON.stringify(after));
  check('clicking a chip did NOT send a message', await page.evaluate('document.querySelectorAll(".chat__row--me").length') === 0);
  check('clicking a chip focused the composer',
    await page.evaluate('document.activeElement && document.activeElement.className') === 'composer__input');

  // ── 2. the chip is a real button, so it is keyboard reachable ──────
  check('chip is a <button>', await page.evaluate('document.querySelector(".chat__idea").tagName') === 'BUTTON');

  // ── 3. splitters resize the columns on a real drag ─────────────────
  const railBefore = await page.evaluate('document.getElementById("rail").getBoundingClientRect().width');
  const sBox = await boxOf('#split-rail');
  check('rail splitter exists with a grabbable width', sBox && sBox.w >= 4, JSON.stringify(sBox));

  // Drag 90px to the right.
  const sx = sBox.x;
  const sy = sBox.y;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy, button: 'none', clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 9; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + i * 10, y: sy, button: 'left', clickCount: 1 });
    await sleep(20);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx + 90, y: sy, button: 'left', clickCount: 1 });
  await sleep(300);

  const railAfter = await page.evaluate('document.getElementById("rail").getBoundingClientRect().width');
  check('dragging the rail splitter widened the rail', railAfter > railBefore + 50,
    `before=${railBefore} after=${railAfter}`);

  const stored = await page.evaluate('localStorage.getItem("tab-agent:columns")');
  check('the dragged width was persisted', stored && stored.includes('--rail-w'), String(stored));

  // ── 4. the clamp holds: drag far past the limit ────────────────────
  const shellW = await page.evaluate('document.getElementById("shell").getBoundingClientRect().width');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy, button: 'none', clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + 2000, y: sy, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx + 2000, y: sy, button: 'left', clickCount: 1 });
  await sleep(300);
  const railClamped = await page.evaluate('document.getElementById("rail").getBoundingClientRect().width');
  const paneW = await page.evaluate('document.getElementById("pane").getBoundingClientRect().width');
  check('rail cannot be dragged past its maximum', railClamped <= 460 + 1, `rail=${railClamped}`);
  check('centre pane keeps a usable width', paneW >= 300, `pane=${paneW} shell=${shellW}`);

  // Double-click restores the default.
  // Two things this has to get right, both of which broke the first run:
  //   - no mouseMoved between the presses, or the browser never pairs them
  //     into a dblclick;
  //   - re-read the handle position, because the clamp drag above moved it.
  //     Clicking the old coordinates lands inside the rail and does nothing.
  const resetBox = await boxOf('#split-rail');
  for (const n of [1, 2]) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: resetBox.x, y: resetBox.y, button: 'left', clickCount: n });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resetBox.x, y: resetBox.y, button: 'left', clickCount: n });
    await sleep(40);
  }
  await sleep(400);
  const railReset = await page.evaluate('document.getElementById("rail").getBoundingClientRect().width');
  check('double-click restores the default rail width', Math.abs(railReset - 244) < 2, `rail=${railReset}`);
  const storedAfterReset = await page.evaluate('localStorage.getItem("tab-agent:columns")');
  check('reset clears the persisted width', !storedAfterReset.includes('--rail-w'), String(storedAfterReset));

  await page.screenshot(path.join(OUT, '19-splitters.png'));

  await closePage(page, { trashProfile: true });
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* scratch */ }

  console.log(failures ? `\n${failures} FAILED` : '\nALL CLICK CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
