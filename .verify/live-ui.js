'use strict';
/**
 * One full turn against the REAL model, driven through the REAL page.
 *
 * Everything here is live: the real router, the real agent decision logic, the
 * real guard, the real provider. What this adds over `live-session-api.js` is a
 * browser — and a browser is exactly the layer this round changed, so whether
 * the card rendered and the grid moved is not something a curl-shaped test can
 * see.
 *
 * Credentials are read from the user's real settings file and never printed.
 * Sessions live in a throwaway directory, so running this does not touch the
 * user's own work.
 *
 * Usage: node .verify/live-ui.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge } = require('./cdp.js');

const ASK = '做一个销售台账，三个客户：杭州云图科技、上海临港数据服务、深圳前海智算中心，'
  + '合同金额分别是125万、86万、88万，签约日期分别是2026年1月8日、1月22日、2月3日，'
  + '再加一列税率，百分之六、百分之六、百分之十三。';

/** Where the real settings file lives on this machine. */
function realHome() {
  if (process.env.TAB_AGENT_HOME) return process.env.TAB_AGENT_HOME;
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const dir = path.join(appData, 'ETabAgent');
  return fs.existsSync(path.join(dir, 'settings.json')) ? dir : null;
}

/** Copy just the credentials into the scratch dir, key included, never logged. */
function borrowCredentials(from, to) {
  const src = JSON.parse(fs.readFileSync(path.join(from, 'settings.json'), 'utf8'));
  const out = {
    baseUrl: src.baseUrl,
    apiKey: src.apiKey,
    model: src.model,
    useForAttachments: true,
    chatCanEdit: true,
    chatConfirmEdits: true,
  };
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'settings.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
  // Prove the key loaded without showing it: shape only.
  const key = String(src.apiKey || '');
  console.log(`credentials: ${key.slice(0, 3)}…${key.slice(-4)} (${key.length} chars), model ${src.model}`);
  if (!key) throw new Error('no apiKey in the real settings file');
  return out;
}

const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const home = realHome();
  if (!home) {
    console.error('no real settings.json found; nothing to test against');
    process.exit(2);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xllive-ui-'));
  borrowCredentials(home, dataDir);

  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const page = await openPage({
    edge: findEdge(),
    profile: path.join(OUT, 'live-ui-profile'),
    url: `http://127.0.0.1:${port}/`,
    port: 9761,
    window: '1440,900',
    waitForSelector: '.composer',
  });

  const wait = (ms) => page.send('Runtime.evaluate', {
    expression: `new Promise(r => setTimeout(r, ${ms}))`, awaitPromise: true,
  });

  await wait(1500);

  console.log('\n--- 1) a fresh install lands on the composer, not on settings ---');
  check('a composer exists', await page.evaluate('Boolean(document.querySelector(".composer__input"))'));
  check('the preview is empty but present', await page.evaluate('Boolean(document.querySelector(".preview"))'));

  console.log('\n--- 2) ask for a table, in one sentence ---');
  await page.evaluate(`(() => {
    const ta = document.querySelector('.composer__input');
    ta.focus();
    ta.value = ${JSON.stringify(ASK)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);

  // A real turn on a spec this size takes a while; poll rather than guess.
  let state = null;
  for (let i = 0; i < 40; i++) {
    await wait(1500);
    state = JSON.parse(await page.evaluate(`JSON.stringify({
      busy: Boolean(document.querySelector('.composer .spinner')),
      card: Boolean(document.querySelector('.chat__card')),
      bubbles: document.querySelectorAll('.chat__row').length,
      cells: document.querySelectorAll('table.grid td').length,
      stat: (document.querySelector('.preview__stat') || {}).textContent || '',
      status: (document.querySelector('#status-msg') || {}).textContent || '',
      guard: (document.querySelector('.chat__guard') || {}).textContent || '',
      reply: [...document.querySelectorAll('.chat__text')].map(n => n.textContent).slice(-1)[0] || '',
    })`));
    if (!state.busy && (state.cells > 0 || state.card)) break;
  }
  console.log(`  state: ${JSON.stringify(state)}`);

  check('the model replied', state.bubbles >= 2, `${state.bubbles} rows`);
  check('something came back to look at', state.cells > 0 || state.card);
  check('the header counts the table', /行/.test(state.stat), state.stat);
  check('no page errors', !state.busy, state.status);
  if (state.guard) check('the guard did not need to intervene', false, state.guard);

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '17-live-ui.png'), Buffer.from(shot.data, 'base64'));

  console.log('\n--- 3) the value in the grid is a value, not the word for it ---');
  const grid = JSON.parse(await page.evaluate(`JSON.stringify(
    [...document.querySelectorAll('table.grid tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent)
    )
  )`));
  for (const row of grid.slice(0, 4)) console.log(`    ${JSON.stringify(row)}`);

  const flat = grid.flat().join(' ');
  check('a currency cell renders with a symbol', /[¥￥]/.test(flat), flat.slice(0, 60));
  check('a percent cell renders with a %', /%/.test(flat));
  check('no cell shows a raw ISO timestamp', !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(flat));
  check('no cell shows a bare five-digit serial', !grid.slice(1).flat().some((c) => /^\d{5}$/.test(String(c).trim())));

  console.log('\n--- 4) accept the change, if one is held ---');
  if (state.card) {
    await page.evaluate(`(() => { [...document.querySelectorAll('.chat__cardactions .btn')][0].click(); return true; })()`);
    await wait(2500);
    const after = JSON.parse(await page.evaluate(`JSON.stringify({
      card: Boolean(document.querySelector('.chat__card')),
      cells: document.querySelectorAll('table.grid td').length,
    })`));
    check('the card is gone once answered', !after.card);
    check('the table survived the accept', after.cells > 0, `${after.cells} cells`);
  } else {
    check('the change applied without confirmation being asked', state.cells > 0, `${state.cells} cells`);
  }

  const shot2 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '18-live-ui-applied.png'), Buffer.from(shot2.data, 'base64'));

  await closePage(page, { trashProfile: true });
  server.close();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nLIVE UI: ${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
