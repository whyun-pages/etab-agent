'use strict';
/**
 * Click-test the PACKAGED exe: start it, drive the real UI over CDP, screenshot.
 * Usage: node .verify/click-exe.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUT = path.join(__dirname, 'out');
const EXE = path.join(__dirname, '..', 'dist', 'TabAgent.exe');
const { openPage, closePage, findEdge, sleep } = require('./cdp.js');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}  ${extra}`); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlclickexe-'));
  // A placeholder key so the composer is not replaced by the setup notice.
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    baseUrl: 'https://api.example.invalid/v1', apiKey: 'sk-placeholder', model: 'placeholder',
    useForAttachments: true, chatCanEdit: true, chatConfirmEdits: true,
  }, null, 2));

  const port = 59531;
  const proc = spawn(EXE, ['--headless', '--port', String(port), '--data-dir', dataDir], { stdio: 'ignore' });
  await sleep(8000);

  const page = await openPage({
    edge: findEdge(), profile: path.join(OUT, 'click-exe-profile'),
    url: `http://127.0.0.1:${port}`, port: 9755, window: '1440,900',
  });
  await sleep(1000);

  const boxOf = (sel) => page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2, w: r.width });
  })()`).then((s) => (s ? JSON.parse(s) : null));

  async function clickAt(x, y) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(300);
  }

  check('packaged: settings-free crash (page booted)', await page.evaluate('document.title') === 'Tab Agent');

  const chips = await page.evaluate('document.querySelectorAll(".chat__idea").length');
  check('packaged: three suggestion chips render', chips === 3, `got ${chips}`);

  const firstText = await page.evaluate('(document.querySelector(".chat__idea")||{}).textContent||""');
  const b = await boxOf('.chat__idea');
  await clickAt(b.x, b.y);
  const filled = await page.evaluate('(document.querySelector(".composer__input")||{}).value||""');
  check('packaged: clicking a chip fills the composer', filled === firstText, JSON.stringify(filled));

  // Splitters: drag the rail wider.
  const railBefore = await page.evaluate('document.getElementById("rail").getBoundingClientRect().width');
  const s = await boxOf('#split-rail');
  check('packaged: splitter has a grabbable width', s && s.w >= 4, JSON.stringify(s));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x, y: s.y, button: 'none', clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x + i * 10, y: s.y, button: 'left', clickCount: 1 });
    await sleep(20);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x + 80, y: s.y, button: 'left', clickCount: 1 });
  await sleep(300);
  const railAfter = await page.evaluate('document.getElementById("rail").getBoundingClientRect().width');
  check('packaged: dragging widens the rail', railAfter > railBefore + 40, `${railBefore} -> ${railAfter}`);

  await page.screenshot(path.join(OUT, '20-exe-splitters.png'));
  console.log('  wrote .verify/out/20-exe-splitters.png');

  await closePage(page, { trashProfile: true });
  proc.kill();
  await sleep(500);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* scratch */ }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PACKAGED CLICK CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
