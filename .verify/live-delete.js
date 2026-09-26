'use strict';
/**
 * Delete a session with real mouse events, and find exactly where it breaks.
 *
 * The user reports "clicking delete does nothing". This walks the chain one
 * observable step at a time, so a failure names the step instead of just
 * saying "not deleted":
 *
 *   1. a session row exists
 *   2. the trash control is HIT-TESTABLE (elementFromPoint returns it, or a
 *      descendant) — `.rail__del` is `opacity: 0` until hover, and an
 *      invisible-but-present element can still swallow the row's click
 *   3. reachable at all: hover first (it is hover-revealed), then click
 *   4. a confirm modal opens
 *   5. the modal's 删除 button is hit-testable and clickable
 *   6. the DELETE round-trips: the rail loses the row and the API agrees
 *
 * Usage: node .verify/live-delete.js
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
  apiKey: 'sk-live-delete-placeholder',
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xldel-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS, null, 2));

  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Seed two sessions over HTTP so the rail has rows and a "next" to fall to.
  const mk = async (title) => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    return (await res.json()).session.id;
  };
  const idA = await mk('要删掉的会话');
  const idB = await mk('留下的会话');
  console.log(`  (seeded ${idA}, ${idB})`);

  const page = await openPage({
    edge: findEdge(),
    profile: path.join(OUT, 'delete-profile'),
    url: base,
    port: 9753,
    window: '1440,900',
  });
  await sleep(1000);

  const boxOf = (sel) => page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top });
  })()`).then((s) => (s ? JSON.parse(s) : null));

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
  /** What the browser would actually hit at (x,y) — the real hit test. */
  const hitAt = (x, y) => page.evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (!el) return 'null';
    const del = el.closest('.rail__del');
    return el.className + ' | closest(.rail__del)=' + (del ? 'yes' : 'no') + ' | tag=' + el.tagName;
  })()`);
  const rowCount = () => page.evaluate('document.querySelectorAll(".rail__item").length');
  const modalText = () => page.evaluate('(document.querySelector(".modal") || {}).textContent || ""');

  // ── 1. rows rendered ───────────────────────────────────────────────
  const rows = await rowCount();
  check('rail shows the seeded sessions', rows === 2, `got ${rows}`);

  // ── 2. the trash control is hover-revealed and hit-testable ────────
  const delBox = await boxOf('.rail__del');
  check('.rail__del exists in the DOM', !!delBox, JSON.stringify(delBox));
  if (!delBox) { await finish(page, server, dataDir); return; }

  // The rail is NEWEST-FIRST, so `.rail__item` #1 is the most recently created
  // session, not the one seeded first. Target rows by TITLE: otherwise this
  // clicks a different row than it names, deletes the wrong session, and then
  // reports the product at fault for the test's own mistake.
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

  // Without hover it is opacity:0. Hover the target ROW first (the CSS reveals
  // on .rail__item:hover), then measure THAT row's trash.
  const rowBox = await rowBoxOf('要删掉的会话');
  check('found the row to delete by title', !!rowBox, JSON.stringify(rowBox));
  await moveTo(rowBox.x, rowBox.y);
  // Read the TARGET row's trash: `document.querySelector('.rail__del')` returns
  // the first one in document order, which is a DIFFERENT row.
  const opacity = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.rail__item')];
    const row = rows.find((r) => (r.querySelector('.rail__name') || {}).textContent === '要删掉的会话');
    return row ? getComputedStyle(row.querySelector('.rail__del')).opacity : 'no-row';
  })()`);
  check('hovering the row reveals the trash (opacity -> 1)', Number(opacity) > 0.9, `opacity=${opacity}`);

  const targetDel = await delBoxOf('要删掉的会话');
  const hit = await hitAt(targetDel.x, targetDel.y);
  check('the trash is the element at its own centre (not covered)', /closest\(\.rail__del\)=yes/.test(hit), hit);

  // ── 3. clicking the trash opens a confirm modal ────────────────────
  await clickAt(targetDel.x, targetDel.y);
  const modal = await modalText();
  check('clicking the trash opens a confirm modal', modal.includes('删除'), JSON.stringify(modal.slice(0, 80)));
  check('the modal names the session', modal.includes('要删掉的会话'), JSON.stringify(modal.slice(0, 120)));
  check('the modal warns it is irreversible', modal.includes('不可撤销'), JSON.stringify(modal.slice(0, 120)));

  // ── 4. the modal's 删除 button works ───────────────────────────────
  const delBtnBox = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.modal button')];
    const el = btns.find((b) => b.textContent.trim() === '删除');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`).then((s) => (s ? JSON.parse(s) : null));
  check('the modal has a 删除 button', !!delBtnBox, JSON.stringify(delBtnBox));

  if (delBtnBox) {
    const hitBtn = await hitAt(delBtnBox.x, delBtnBox.y);
    check('the modal 删除 button is hit-testable', /BUTTON/.test(hitBtn), hitBtn);
    await clickAt(delBtnBox.x, delBtnBox.y);
    await sleep(700);
  }

  // ── 5. it actually deleted ─────────────────────────────────────────
  const rowsAfter = await rowCount();
  check('the rail lost the row', rowsAfter === 1, `got ${rowsAfter}`);

  const stillThere = await fetch(`${base}/api/sessions/${idA}`).then((r) => r.status);
  check('the server agrees the session is gone (404)', stillThere === 404, `status ${stillThere}`);

  const survivor = await fetch(`${base}/api/sessions/${idB}`).then((r) => r.status);
  check('the other session survived', survivor === 200, `status ${survivor}`);

  await finish(page, server, dataDir);
}

async function finish(page, server, dataDir) {
  try { await closePage(page, { trashProfile: true }); } catch {}
  await new Promise((r) => server.close(r));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  console.log(failures === 0 ? '\nDELETE CLICK CHECKS PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
