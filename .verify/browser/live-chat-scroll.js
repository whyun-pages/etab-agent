'use strict';
/**
 * The transcript follows new output, unless the user scrolled up to read.
 *
 * What it covers
 * --------------
 *   1. a long conversation opens scrolled to the bottom, with no ↓ button
 *   2. sending from the bottom: the reply lands in view
 *   3. scrolled up when the reply arrives: the offset is kept, and the ↓
 *      button appears
 *   4. clicking ↓ goes to the bottom and the button goes away
 *   5. sending while scrolled up follows the new turn — sending is asking to
 *      see the answer
 *
 * Usage: node .verify/browser/live-chat-scroll.js
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'out');
const { createServer } = require(path.join(ROOT, 'src', 'http', 'server.ts'));
const { Settings } = require(path.join(ROOT, 'src', 'store', 'settings.ts'));
const { modelFromTransport } = require('../support/transport-model');
const { openPage, closePage, findEdge, sleep } = require('../support/cdp.js');

// Long enough that a few replies overflow the pane.
const REPLY = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行说明`).join('\n');
// The UI turns are slow, so there is time to scroll away before they answer.
let delay = 0;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

async function main() {
  console.log('chat scroll, real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-chat-scroll-'));
  await new Settings(dataDir).save({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub',
    chatConfirmEdits: false,
  });

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    model: await modelFromTransport(async () => {
      if (delay) await sleep(delay);
      return JSON.stringify({ intent: 'answer', reply: REPLY });
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await (
    await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ).json();
  for (let i = 0; i < 6; i++) {
    await fetch(`${base}/api/sessions/${created.session.id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `问题 ${i + 1}` }),
    });
  }

  let page = null;
  try {
    page = await openPage({
      edge: findEdge(),
      profile: path.join(OUT, 'chat-scroll-profile'),
      url: base,
      port: 9765,
      window: '1200,700',
      waitForSelector: '.rail',
    });
    await sleep(1500);

    const look = () =>
      page
        .evaluate(`(() => {
      const b = document.querySelector('.chat__stream');
      const j = document.querySelector('.chat__jump');
      return JSON.stringify({
        top: b.scrollTop,
        gap: b.scrollHeight - b.scrollTop - b.clientHeight,
        overflow: b.scrollHeight > b.clientHeight,
        rows: b.querySelectorAll('.chat__row').length,
        jump: Boolean(j && !j.hidden),
      });
    })()`)
        .then(JSON.parse);
    const sendText = (t) =>
      page.evaluate(`(() => {
      const ta = document.querySelector('.composer__input');
      ta.value = ${JSON.stringify(t)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.composer__send').click();
    })()`);
    const scrollTo = (top) =>
      page.evaluate(`(() => { document.querySelector('.chat__stream').scrollTop = ${top}; })()`);
    const settle = async (rows) => {
      for (let i = 0; i < 50; i++) {
        const now = await look();
        if (now.rows >= rows && !(await page.evaluate(`Boolean(document.querySelector('.chat__thinking'))`)))
          return now;
        await sleep(200);
      }
      return look();
    };

    const open = await look();
    check('the transcript overflows the pane', open.overflow, JSON.stringify(open));
    check('a conversation opens at the bottom', open.gap <= 2, JSON.stringify(open));
    check('no ↓ button while at the bottom', !open.jump, JSON.stringify(open));

    delay = 1500;
    await sendText('从底部发送');
    const followed = await settle(open.rows + 2);
    check('a reply sent from the bottom lands in view', followed.gap <= 2, JSON.stringify(followed));
    check('still no ↓ button', !followed.jump, JSON.stringify(followed));

    // Send, then scroll up while the model is still thinking.
    await sendText('发送后往上翻');
    await sleep(400);
    await scrollTo(100);
    await sleep(100);
    const away = await look();
    check('no ↓ button before anything new arrives', !away.jump, JSON.stringify(away));
    const kept = await settle(followed.rows + 2);
    check('the reply does not move a scrolled-up transcript', kept.top === 100, JSON.stringify(kept));
    check('the ↓ button appears for output below', kept.jump, JSON.stringify(kept));

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'chat-scroll.png'), Buffer.from(shot.data, 'base64'));

    await page.evaluate(`document.querySelector('.chat__jump').click()`);
    await sleep(200);
    const back = await look();
    check('clicking ↓ goes to the bottom', back.gap <= 2, JSON.stringify(back));
    check('and the button goes away', !back.jump, JSON.stringify(back));

    // A repaint at the bottom after clicking must stay there, not fall back
    // to the old offset.
    await scrollTo(0);
    await sleep(100);
    await sendText('翻到顶部再发送');
    const sent = await settle(back.rows + 2);
    check('sending while scrolled up follows the new turn', sent.gap <= 2, JSON.stringify(sent));
    check('no ↓ button after following', !sent.jump, JSON.stringify(sent));
  } finally {
    if (page) {
      try {
        await closePage(page, { trashProfile: true });
      } catch {}
    }
    await new Promise((r) => server.close(r));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n${failed === 0 ? 'CHAT SCROLL CHECKS PASSED' : `${failed} FAILED`} (${passed} ok)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
