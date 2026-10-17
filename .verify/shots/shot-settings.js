'use strict';
/**
 * Screenshot the model settings panel with a real browser.
 *
 * A bad import or a runtime error in the front-end only shows up when a browser
 * actually loads the page, so this drives Edge and reports page errors as well
 * as saving the picture. The panel is the point: the key field, the
 * plaintext-storage warning and the connection-test result all have to be
 * legible, and the key must not be displayed back.
 *
 * The settings page has two tabs now — 模型 (endpoint, key, model, the notice,
 * the connection test) and 会话 (the switches) — and opens from the gear in
 * the title bar. The first version of this probe looked for an activity bar
 * and a single panel from an earlier UI, and died on its first click.
 *
 * Usage: node .verify/shots/shot-settings.js
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../../src/http/server.ts');
const { openPage, closePage } = require('../support/browser.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'out');
const DATA = path.join(OUT, 'shot-settings-data');
const PROFILE = path.join(OUT, 'edge-settings-profile');
const PORT = 3299;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    (ok ? '  ok   ' : '  FAIL ') +
      label +
      (ok ? '' : `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`),
  );
}

async function capture(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log(`  saved ${name}.png (${fs.statSync(file).size} bytes)`);
  return file;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DATA, { recursive: true, force: true });

  const server = createServer({ dataDir: DATA, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`server on http://127.0.0.1:${PORT}`);

  // Seed a saved key so the "already configured" state is what gets shot — that
  // is the state with the most to get wrong (hint shown, no key echoed). The
  // endpoint is unroutable on purpose: 测试连接 tests the SAVED settings, and
  // this makes it fail fast and the same way every run.
  const SECRET = 'sk-shot-abcdef123456';
  await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: SECRET, baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-4o-mini' }),
  });

  const page = await openPage({ profile: PROFILE, window: '1280,900' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('.rail__head', { state: 'attached', timeout: 10000 });

  console.log('\n=== 1) boot with no page errors ===');
  check('the settings button exists', await page.locator('#btn-settings').count(), 1);
  check('no page errors on boot', errors, []);

  console.log('\n=== 2) open the settings page, on the 模型 tab ===');
  if (await page.evaluate(`document.getElementById('settings-page').hidden`)) await page.click('#btn-settings');
  await page.waitForSelector('#settings-page:not([hidden]) .settings__main', { timeout: 5000 });
  const opened = JSON.parse(
    await page.evaluate(`JSON.stringify({
      title: (document.querySelector('.settings__title') || {}).textContent || '',
      fields: document.querySelectorAll('.settings__main input.settings__input').length,
      keyType: (document.querySelectorAll('.settings__main input.settings__input')[1] || {}).type || '',
      notice: !!document.querySelector('.settings__notice'),
    })`),
  );
  console.log('     ' + JSON.stringify(opened));
  check('the 模型 tab is the one shown', opened.title, '模型设置');
  check('three text fields (baseUrl, key, model)', opened.fields, 3);
  check('the key field is a password field', opened.keyType, 'password');
  check('the storage notice is present', opened.notice, true);
  await capture(page, '07-settings-empty');

  console.log('\n=== 3) the saved key is hinted, never shown ===');
  const s = JSON.parse(
    await page.evaluate(`JSON.stringify({
      keyValue: document.querySelectorAll('.settings__main input.settings__input')[1].value,
      hints: Array.from(document.querySelectorAll('.settings__hint')).map((h) => h.textContent),
      bodyHasSecret: document.body.innerHTML.includes(${JSON.stringify(SECRET)}),
    })`),
  );
  check('the key input is empty', s.keyValue, '');
  check('the raw key appears nowhere in the DOM', s.bodyHasSecret, false);
  check(
    'a masked hint is shown',
    s.hints.some((h) => /3456/.test(h)),
    true,
  );

  console.log('\n=== 4) a failing connection test reads as an error ===');
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.waitForSelector('.settings__result', { timeout: 15000 }).catch(() => {});
  const td = JSON.parse(
    await page.evaluate(`JSON.stringify({
      result: !!document.querySelector('.settings__result'),
      bad: !!document.querySelector('.settings__result--bad'),
      text: (document.querySelector('.settings__resultbody') || {}).textContent || '',
    })`),
  );
  console.log('     ' + JSON.stringify(td));
  check('a result box appeared', td.result, true);
  check('it is styled as a failure', td.bad, true);
  check('the reason is shown, not a generic message', td.text.length > 0, true);
  await capture(page, '08-settings-test-failed');

  console.log('\n=== 5) the 会话 tab: every switch that matters, labelled ===');
  // By label, not by count. A count fails on every switch added and passes
  // just as happily when one is swapped for another.
  await page.click('.settings__tab:has-text("会话")');
  await page.waitForFunction(() => /会话设置/.test(document.querySelector('.settings__title')?.textContent || ''));
  const sw = JSON.parse(
    await page.evaluate(`JSON.stringify({
      toggles: document.querySelectorAll('.settings__main .settings__toggle').length,
      labels: Array.from(document.querySelectorAll('.settings__main .settings__toggle .settings__label')).map((n) => n.textContent),
    })`),
  );
  console.log('     labels: ' + JSON.stringify(sw.labels));
  for (const expected of ['允许对话修改字段', '修改前需要确认', '允许对话保存文件', '允许对话联网抓取']) {
    check(
      `the「${expected}」switch is present`,
      sw.labels.some((l) => l.includes(expected)),
      true,
    );
  }
  check('every switch is labelled', sw.labels.length, sw.toggles);

  console.log('\n=== 6) page errors over the whole run ===');
  for (const e of errors) console.log('     ! ' + e);
  check('no uncaught front-end errors', errors.length, 0);

  await closePage(page, { trashProfile: true });
  server.close();

  console.log('\n' + (failures === 0 ? 'SETTINGS PANEL OK' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
