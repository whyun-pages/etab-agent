'use strict';
/**
 * Ctrl+V in the composer attaches files, in a real browser.
 *
 * What it covers
 * --------------
 *   1. a pasted screenshot becomes an attachment, named by the time of the
 *      paste rather than the browser's `image.png`
 *   2. two screenshots pasted at once get two different names
 *   3. a file copied from disk keeps its own name
 *   4. a paste that carries text as well (cells copied from Excel) is a text
 *      paste: nothing is uploaded and the browser's own paste goes ahead
 *   5. a plain text paste is untouched
 *
 * The paste is a synthetic ClipboardEvent carrying a real DataTransfer: a
 * headless run has no clipboard to put a screenshot on, and the handler only
 * reads `clipboardData`, which this fills exactly as the browser would.
 *
 * Usage: node .verify/browser/live-paste.js
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
const { openPage, closePage, sleep } = require('../support/browser.js');

// A 1x1 PNG, so the server parses a real image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  console.log('paste to attach, real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-paste-'));
  // Attachments are parsed locally; no model is asked to read them.
  await new Settings(dataDir).save({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub',
    useForAttachments: false,
  });

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    model: await modelFromTransport(async () => JSON.stringify({ intent: 'answer', reply: '好' })),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ).json();
  const attUrl = `${base}/api/sessions/${encodeURIComponent(created.session.id)}/attachments`;

  let page = null;
  try {
    page = await openPage({
      profile: path.join(OUT, 'paste-profile'),
      url: base,
      window: '1200,800',
      waitForSelector: '.rail',
    });
    await sleep(1500);

    /** Paste into the composer; `items` are {name, type, b64} files and/or {text}. */
    const paste = (items) =>
      page.evaluate(`(() => {
      const ta = document.querySelector('.composer__input');
      ta.focus();
      const dt = new DataTransfer();
      for (const it of ${JSON.stringify(items)}) {
        if (it.text !== undefined) { dt.setData('text/plain', it.text); continue; }
        const bytes = Uint8Array.from(atob(it.b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], it.name, { type: it.type }));
      }
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    const chips = () =>
      page
        .evaluate(`JSON.stringify([...document.querySelectorAll('.chip .chip__name')].map((n) => n.textContent))`)
        .then(JSON.parse);
    const onServer = async () => (await (await fetch(attUrl)).json()).attachments.map((a) => a.name);
    const clear = () => fetch(attUrl, { method: 'DELETE' });

    const shot = { name: 'image.png', type: 'image/png', b64: PNG };
    const took = await paste([shot]);
    await sleep(1000);
    const one = await chips();
    check('a pasted screenshot is taken over from the browser', took === true);
    check(
      'it becomes an attachment named by the time',
      one.length === 1 && /^截图-\d{6}\.png$/.test(one[0]),
      JSON.stringify(one),
    );
    check(
      'the server has it',
      JSON.stringify(await onServer()) === JSON.stringify(one),
      JSON.stringify(await onServer()),
    );

    await clear();
    await paste([shot, shot]);
    await sleep(1000);
    const two = await onServer();
    check(
      'two screenshots at once get two names',
      two.length === 2 && two[0] !== two[1] && two.every((n) => /^截图-\d{6}-[12]\.png$/.test(n)),
      JSON.stringify(two),
    );

    await clear();
    await paste([{ name: '客户名单.csv', type: 'text/csv', b64: Buffer.from('客户,金额\n甲,1\n').toString('base64') }]);
    await sleep(1000);
    check(
      'a file copied from disk keeps its name',
      JSON.stringify(await onServer()) === JSON.stringify(['客户名单.csv']),
      JSON.stringify(await onServer()),
    );

    await clear();
    const excel = await paste([{ text: '甲\t1\n乙\t2' }, shot]);
    await sleep(800);
    check('cells copied from Excel (text plus a picture) paste as text', excel === false);
    check('and upload nothing', (await onServer()).length === 0, JSON.stringify(await onServer()));

    const text = await paste([{ text: '你好' }]);
    check('a plain text paste is left to the browser', text === false);
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

  console.log(`\n${failed === 0 ? 'PASTE CHECKS PASSED' : `${failed} FAILED`} (${passed} ok)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
