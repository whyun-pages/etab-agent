'use strict';
/**
 * Delete a session with real mouse events, against the PACKAGED EXE.
 *
 * live-delete.js proves the fix in the SOURCE TREE (it boots createServer from
 * lib/). This one proves it survives packaging: it launches dist\TabAgent.exe
 * with its own --data-dir and --port, then runs the identical click chain over
 * CDP. The two are not redundant -- a fix in public/js/app.js only reaches the
 * user if the exe's embedded assets were rebuilt (see NOTES "stale exe").
 *
 * Steps, one observable at a time:
 *   1. exe boots and serves /api/health
 *   2. embedded /js/app.js carries the fixed import line (openModal/closeModal)
 *   3. rail shows seeded sessions
 *   4. hover reveals the row's trash; it is hit-testable at its own centre
 *   5. clicking it opens a confirm modal naming the session
 *   6. the modal 删除 button round-trips: rail loses the row, API says 404
 *
 * Usage: node .verify/live-delete-exe.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');
const { openPage, closePage, findEdge, sleep } = require('./cdp.js');

const PORT = 59512;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}  ${extra}`); }
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(EXE)) { console.error(`no exe at ${EXE} — run npm run build`); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xldel-exe-'));

  console.log(`  (launching ${path.basename(EXE)} on ${PORT})`);
  const exe = spawn(EXE, ['--port', String(PORT), '--data-dir', dataDir], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });

  let page = null;
  let server = null;
  try {
    const health = await waitForHealth();
    check('packaged exe booted and answered /api/health', !!health, 'no health response');
    if (!health) throw new Error('exe never became healthy');
    check('health reports the tab-agent identity', health.app === 'tab-agent', JSON.stringify(health));

    // 2. the embedded bundle carries the fix, not a stale copy
    const js = await fetch(`${BASE}/js/app.js`).then((r) => r.text());
    check('embedded app.js imports openModal + closeModal (the fix shipped)',
      /openModal\s*,\s*closeModal/.test(js), 'import line missing from the exe bundle');

    // Seed two sessions THROUGH the exe, so the rail has rows.
    const mk = async (title) => {
      const res = await fetch(`${BASE}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      });
      return (await res.json()).session.id;
    };
    const idA = await mk('要删掉的会话');
    const idB = await mk('留下的会话');
    console.log(`  (seeded ${idA}, ${idB})`);

    page = await openPage({
      edge: findEdge(),
      profile: path.join(OUT, 'delete-exe-profile'),
      url: BASE,
      port: 9754,
      window: '1440,900',
    });
    await sleep(1200);

    const rowCount = () => page.evaluate('document.querySelectorAll(".rail__item").length');
    const modalText = () => page.evaluate('(document.querySelector(".modal") || {}).textContent || ""');
    const hitAt = (x, y) => page.evaluate(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return 'null';
      const del = el.closest('.rail__del');
      return el.className + ' | closest(.rail__del)=' + (del ? 'yes' : 'no') + ' | tag=' + el.tagName;
    })()`);

    async function moveTo(x, y) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await sleep(120);
    }
    async function clickAt(x, y) {
      await moveTo(x, y);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(300);
    }
    const rowBoxOf = (title) => page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.rail__item')];
      const row = rows.find((r) => (r.querySelector('.rail__name') || {}).textContent === ${JSON.stringify(title)});
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    const delBoxOf = (title) => page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.rail__item')];
      const row = rows.find((r) => (r.querySelector('.rail__name') || {}).textContent === ${JSON.stringify(title)});
      if (!row) return null;
      const el = row.querySelector('.rail__del');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));

    // 3. rows rendered
    const rows = await rowCount();
    check('rail shows the seeded sessions', rows === 2, `got ${rows}`);

    // 4. hover-reveal + hit-test, targeting by TITLE (rail is newest-first)
    const rowBox = await rowBoxOf('要删掉的会话');
    check('found the row to delete by title', !!rowBox, JSON.stringify(rowBox));
    await moveTo(rowBox.x, rowBox.y);
    const opacity = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.rail__item')];
      const row = rows.find((r) => (r.querySelector('.rail__name') || {}).textContent === '要删掉的会话');
      return row ? getComputedStyle(row.querySelector('.rail__del')).opacity : 'no-row';
    })()`);
    check('hovering the row reveals the trash (opacity -> 1)', Number(opacity) > 0.9, `opacity=${opacity}`);

    const targetDel = await delBoxOf('要删掉的会话');
    const hit = await hitAt(targetDel.x, targetDel.y);
    check('the trash is the element at its own centre (not covered)', /closest\(\.rail__del\)=yes/.test(hit), hit);

    // 5. click opens the confirm modal
    await clickAt(targetDel.x, targetDel.y);
    const modal = await modalText();
    check('clicking the trash opens a confirm modal', modal.includes('删除'), JSON.stringify(modal.slice(0, 80)));
    check('the modal names the session', modal.includes('要删掉的会话'), JSON.stringify(modal.slice(0, 120)));

    // 6. the modal's 删除 button round-trips
    const delBtnBox = await page.evaluate(`(() => {
      const btns = [...document.querySelectorAll('.modal button')];
      const el = btns.find((b) => b.textContent.trim() === '删除');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    check('the modal has a 删除 button', !!delBtnBox, JSON.stringify(delBtnBox));
    if (delBtnBox) { await clickAt(delBtnBox.x, delBtnBox.y); await sleep(800); }

    const rowsAfter = await rowCount();
    check('the rail lost the row', rowsAfter === 1, `got ${rowsAfter}`);
    const gone = await fetch(`${BASE}/api/sessions/${idA}`).then((r) => r.status);
    check('the exe agrees the session is gone (404)', gone === 404, `status ${gone}`);
    const survivor = await fetch(`${BASE}/api/sessions/${idB}`).then((r) => r.status);
    check('the other session survived', survivor === 200, `status ${survivor}`);
  } finally {
    if (page) { try { await closePage(page, { trashProfile: true }); } catch {} }
    try { exe.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(failures === 0 ? '\nPACKAGED DELETE CLICK CHECKS PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
