'use strict';
/**
 * Screenshot the settings panel in a window too short to hold it.
 *
 * This is the case the static shots cannot reach: at a comfortable window size
 * the settings form fits, so nothing looks wrong. The bug only appears when the
 * height runs out, and it shows up as the bottom of the form being simply gone.
 *
 * Scrollbars are deliberately NOT hidden here — in a shot meant to show whether
 * the content is reachable, a hidden scrollbar would hide the evidence.
 *
 * What "reachable" means now: the save and test buttons sit in the page's
 * header bar (`.settings__bar`), outside the scrolling part, so they must be
 * on screen at any height; the form scrolls in `.settings__main`, and its last
 * field must come into view when that is scrolled to the bottom. The first
 * version of this probe looked for `.editor__scroll` and a save row at the
 * foot of the form — an earlier UI — found neither, and reported "STILL
 * CLIPPED" with two identical screenshots.
 *
 * Usage: node .verify/shots/shot-settings-short.js [height]
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const { openPage, closePage } = require('../support/browser.js');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3251;
const OUT = path.join(ROOT, '.verify', 'out');
const DATA = path.join(OUT, 'shot-short-data');
const PROFILE = path.join(OUT, 'shot-short-profile');
const HEIGHT = Number(process.argv[2] || 470);

const { createServer } = require(path.join(ROOT, 'src', 'http', 'server.ts'));

/** Is the element's box inside the viewport, top to bottom? */
const IN_VIEW = `(el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
}`;

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const server = createServer({ dataDir: DATA, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const page = await openPage({ profile: PROFILE, window: `1180,${HEIGHT}` });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('.rail__head', { state: 'attached', timeout: 10000 });

  // Open settings the way the user does — unless the app opened on it, which
  // it does when no model is configured (a fresh data folder).
  if (await page.evaluate(`document.getElementById('settings-page').hidden`)) await page.click('#btn-settings');
  await page.waitForSelector('#settings-page:not([hidden]) .settings__main', { timeout: 5000 });

  const state = JSON.parse(
    await page.evaluate(`(() => {
    const inView = ${IN_VIEW};
    const sc = document.querySelector('.settings__main');
    const fields = document.querySelectorAll('.settings__main .settings__field, .settings__main .settings__toggle');
    return JSON.stringify({
      viewport: innerHeight,
      scrollClientH: sc ? sc.clientHeight : -1,
      scrollH: sc ? sc.scrollHeight : -1,
      scrollable: sc ? sc.scrollHeight > sc.clientHeight + 1 : false,
      actionsVisible: inView(document.querySelector('.settings__actions')),
      lastVisibleBeforeScroll: inView(fields[fields.length - 1]),
    });
  })()`),
  );

  console.log(`viewport         ${state.viewport}`);
  console.log(`scroll container ${state.scrollClientH}  content ${state.scrollH}  scrollable ${state.scrollable}`);
  console.log(`save/test buttons on screen: ${state.actionsVisible}`);
  console.log(`last field visible without scrolling: ${state.lastVisibleBeforeScroll}`);

  await page.screenshot({ path: path.join(OUT, '09-settings-short-top.png') });

  // Then scroll to the bottom with the wheel, as the user would. Not by
  // setting scrollTop: an `overflow: hidden` box scrolls from script all the
  // same, so that would report the clipped form as reachable — it did, until
  // this was checked against `.settings__main { overflow: hidden }`.
  const box = await page.locator('.settings__main').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(400);
  }
  const after = JSON.parse(
    await page.evaluate(`(() => {
    const inView = ${IN_VIEW};
    const sc = document.querySelector('.settings__main');
    const fields = document.querySelectorAll('.settings__main .settings__field, .settings__main .settings__toggle');
    return JSON.stringify({
      scrollTop: sc ? sc.scrollTop : -1,
      lastVisible: inView(fields[fields.length - 1]),
      actionsVisible: inView(document.querySelector('.settings__actions')),
    });
  })()`),
  );

  console.log(`after scrolling to bottom: scrollTop ${after.scrollTop}, last field reachable: ${after.lastVisible}`);

  await page.screenshot({ path: path.join(OUT, '10-settings-short-bottom.png') });
  console.log(`saved 09-settings-short-top.png, 10-settings-short-bottom.png`);
  if (errors.length) console.log('front-end errors:', errors);

  await closePage(page, { trashProfile: true });
  server.close();

  // At a height where everything fits there is nothing to scroll, and that is
  // fine too: what must hold is that the end of the form can be seen.
  const ok = state.actionsVisible && after.actionsVisible && after.lastVisible && !errors.length;
  console.log(ok ? '\nSHORT WINDOW: content reachable, buttons on screen.' : '\nSHORT WINDOW: STILL CLIPPED.');
  return ok ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(2);
  });
