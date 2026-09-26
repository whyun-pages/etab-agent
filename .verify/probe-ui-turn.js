'use strict';
/**
 * Drive one full conversation turn through the real UI.
 *
 * What this proves that a unit test cannot: the WIRE between the pieces —
 * that a message typed into the composer reaches the turn endpoint, that a
 * held change renders as a card rather than as prose, and that the preview
 * moves to the proposed spec so the user can see what they are approving.
 *
 * Only the model call is faked, and it is faked at the server's `transport`
 * seam so the real router, the real agent decision logic and the real guard
 * all run. Faking `fetch` in the page would test the stub instead.
 *
 * Usage: node .verify/probe-ui-turn.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { SessionStore } = require(path.join(ROOT, 'lib', 'session-store.js'));
const { Settings } = require(path.join(ROOT, 'lib', 'settings.js'));
const { openPage, closePage, findEdge } = require('./cdp.js');

const SPEC = {
  title: '销售台账',
  sheets: [{
    name: '销售台账',
    columns: [
      { header: '客户名称', type: 'text' },
      { header: '合同金额', type: 'currency' },
      { header: '签约日期', type: 'date' },
    ],
    rows: [
      ['杭州云图科技有限公司', 1250000, '2026-01-08'],
      ['上海临港数据服务', 860000, '2026-01-22'],
    ],
    totals: { enabled: true, sumColumns: [1] },
  }],
};

/**
 * A model that always proposes this spec.
 *
 * The signature matters: `transport` stands in for `llm.chat`, which takes one
 * options object and returns the assistant's RAW TEXT — not a response object.
 * The first version of this returned `{ content }` and the turn came back as
 * "模型返回了空内容", which looks like a model problem and is a harness problem.
 */
function fakeTransport() {
  return async () => JSON.stringify({
    intent: 'action',
    reply: '已创建销售台账，3 列 2 行，金额带货币格式，签约日期是日期格式。',
    spec: SPEC,
  });
}

const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlturn-'));

  // A configured model, in a directory that is thrown away. The key is not
  // real and never leaves this process.
  new Settings(dataDir).save({
    baseUrl: 'https://api.example.invalid/v1',
    apiKey: 'sk-probe-not-real-0000',
    model: 'demo-model',
  });

  const store = new SessionStore(dataDir);
  const session = store.create('');

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    transport: fakeTransport(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const page = await openPage({
    edge: findEdge(),
    profile: path.join(OUT, 'probe-turn-profile'),
    url: `http://127.0.0.1:${port}/`,
    port: 9751,
    window: '1440,900',
    waitForSelector: '.composer',
  });

  const wait = (ms) => page.send('Runtime.evaluate', {
    expression: `new Promise(r => setTimeout(r, ${ms}))`, awaitPromise: true,
  });

  await wait(1200);

  console.log('\n--- 1) the composer is there before anything is said ---');
  check('a composer exists', await page.evaluate('Boolean(document.querySelector(".composer__input"))'));

  // ── type and send, the way a user does ─────────────────────────────
  console.log('\n--- 2) type a sentence and press Enter ---');
  await page.evaluate(`(() => {
    const ta = document.querySelector('.composer__input');
    ta.focus();
    ta.value = '做一个销售台账，两个客户，金额带货币格式，还有签约日期。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);

  // The turn is a round trip; give it room.
  await wait(2500);

  const afterSend = await page.evaluate(`JSON.stringify({
    bubbles: document.querySelectorAll('.chat__row').length,
    card: Boolean(document.querySelector('.chat__card')),
    cardButtons: [...document.querySelectorAll('.chat__cardactions .btn')].map(b => b.textContent.trim()),
    gridCells: document.querySelectorAll('table.grid td').length,
    stat: (document.querySelector('.preview__stat') || {}).textContent || '',
    composerValue: (document.querySelector('.composer__input') || {}).value || '',
  })`);
  console.log(`  state: ${afterSend}`);
  const s1 = JSON.parse(afterSend);

  check('the message went in', s1.bubbles >= 2, `${s1.bubbles} rows`);
  check('a held change shows as a card, not prose', s1.card);
  check('the card offers a way to accept it', s1.cardButtons.length === 2, s1.cardButtons.join(' / '));
  // The preview shows what it WOULD be: that is what makes the decision answerable.
  check('the preview moved to the proposed table', s1.gridCells >= 9, `${s1.gridCells} cells`);
  check('the header says how big it is', /行/.test(s1.stat), s1.stat);
  check('the composer cleared', s1.composerValue === '', JSON.stringify(s1.composerValue));

  const shot1 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '15-ui-pending.png'), Buffer.from(shot1.data, 'base64'));

  // ── accept it ──────────────────────────────────────────────────────
  console.log('\n--- 3) click 写进表格 ---');
  await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.chat__cardactions .btn')][0];
    btn.click();
    return true;
  })()`);
  await wait(2000);

  const afterApply = await page.evaluate(`JSON.stringify({
    card: Boolean(document.querySelector('.chat__card')),
    railRows: [...document.querySelectorAll('.rail__sub')].map(n => n.textContent),
    gridCells: document.querySelectorAll('table.grid td').length,
  })`);
  console.log(`  state: ${afterApply}`);
  const s2 = JSON.parse(afterApply);

  check('the card is gone once answered', !s2.card);
  check('the table is still on screen', s2.gridCells >= 9, `${s2.gridCells} cells`);
  check('the session list learned the row count', s2.railRows.some((t) => /行/.test(t)), s2.railRows.join(' | '));

  // The stored spec is the real proof: the click had to reach disk.
  const saved = store.load(session.id);
  check('the change reached the stored spec', Boolean(saved && saved.spec), saved && saved.spec ? saved.spec.title : 'no spec');
  check('the transcript has both turns', saved.messages.length === 2, `${saved.messages.length} messages`);

  const shot2 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '16-ui-applied.png'), Buffer.from(shot2.data, 'base64'));

  await closePage(page, { trashProfile: true });
  server.close();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nUI TURN: ${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
