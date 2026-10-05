'use strict';
/**
 * Attachment upload, end to end: picker -> upload -> chip -> message -> model.
 *
 * Why this probe exists
 * ---------------------
 * The upload endpoints had unit tests, and they passed — while the feature was
 * completely unreachable from the UI. `initDragDrop` was defined but never
 * called, `api.js` had no upload method, and `runTurn` never received an
 * attachment at all. A green server test suite said nothing about any of that.
 *
 * So this drives the real browser and then checks the thing that actually
 * matters to the user: that the file's content reaches the model. It captures
 * the outgoing message with a recording transport and asserts the CSV's own
 * bytes appear inside it.
 *
 * What it covers
 * --------------
 *   1. The paperclip opens the real file picker (`#file-input` exists, is a
 *      file input, and the browser will take files into it).
 *   2. A picked file uploads and becomes a chip with the file's name.
 *   3. The uploaded file's content is folded into the NEXT turn's message —
 *      i.e. the model can actually read it. This is the load-bearing check.
 *   4. The chip's × removes it.
 *   5. A drag-and-drop upload shows the overlay on dragenter and lands a chip
 *      on drop (synthesized DragEvents with a real DataTransfer).
 *
 * Usage: node .verify/live-attach.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { openPage, closePage, findEdge, sleep } = require('./cdp.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-attach-'));

function fakeSettings() {
  const record = {
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub-model',
    useForAttachments: false,   // rule-based reading only; no model round-trip
    chatCanEdit: true,
    chatConfirmEdits: false,
  };
  return {
    load: () => ({ ...record }),
    save: (patch) => Object.assign(record, patch),
    secrets: () => ({ baseUrl: record.baseUrl, apiKey: record.apiKey, model: record.model }),
    isConfigured: () => true,
    publicSettings: () => ({
      baseUrl: record.baseUrl, model: record.model, hasKey: true, keyHint: 'sk-…key',
      useForAttachments: false, chatCanEdit: true, chatConfirmEdits: false,
    }),
  };
}

/** Poll a page expression until it is truthy, or give up. */
async function waitFor(page, expr, ms = 8000, step = 200) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await page.evaluate(expr, { awaitPromise: false })) return true; } catch { /* not ready */ }
    await sleep(step);
  }
  return false;
}

const CSV = '客户名称,数量,单价\n北京甲公司的,10,250\n上海乙,5,300\n';

async function main() {
  console.log('attachment upload over real HTTP + real browser');
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = tmpdir();

  // A transport that records every outgoing message, so we can prove the file
  // content reached the model rather than merely reaching the server.
  const seen = [];
  const transport = async (args) => {
    seen.push(String(args.messages ? args.messages.map((m) => m.content).join('\n') : args.prompt || ''));
    return JSON.stringify({ intent: 'answer', reply: '收到附件。' });
  };

  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    settingsOverride: fakeSettings(),
    transport,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let page = null;
  try {
    page = await openPage({
      edge: findEdge(),
      profile: path.join(OUT, 'attach-profile'),
      url: base,
      port: 9764,
      window: '1440,900',
      waitForSelector: '.rail',
    });
    await sleep(600);

    // A session is required: attachments follow the open conversation.
    await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    await page.evaluate('location.reload()');
    await sleep(1500);
    // Open the session so the composer is live.
    const opened = await page.evaluate(`(() => {
      const row = document.querySelector('.rail__item');
      if (row) { row.click(); return true; }
      return false;
    })()`);
    check('a session could be opened', opened === true);
    await sleep(800);

    // ── 1. the paperclip exists and is hit-testable ────────────────────
    const clipBox = await page.evaluate(`(() => {
      const b = document.querySelector('.composer__clip');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    check('the paperclip button is present and sized', !!clipBox, JSON.stringify(clipBox));

    const inputOk = await page.evaluate(`(() => {
      const inp = document.querySelector('#file-input');
      return Boolean(inp && inp.type === 'file' && inp.multiple);
    })()`);
    check('a hidden multiple file input exists', inputOk === true);

    // Clicking the paperclip must not throw (it calls input.click()). A real
    // headless picker cannot be completed, so we assert the click is wired by
    // checking no exception surfaced and the element stayed.
    await page.evaluate(`(() => { document.querySelector('.composer__clip').click(); return true; })()`);
    await sleep(200);
    check('clicking the paperclip does not throw', await page.evaluate('Boolean(document.querySelector(".composer__clip"))'));

    // ── 2. a picked file uploads and becomes a chip ────────────────────
    const csvPath = path.join(OUT, '附件探针.csv');
    fs.writeFileSync(csvPath, CSV, 'utf8');

    // Drive the REAL input element the same way a picker would: set files and
    // fire `change`. This is the path the paperclip opens, not a parallel one.
    const injected = await page.evaluate(`(() => {
      const inp = document.querySelector('#file-input');
      if (!inp) return 'no-input';
      return 'ready';
    })()`);
    check('the file input is queryable', injected === 'ready', injected);

    // CDP DOM.setFileInputFiles is the browser-level way to fill a file input.
    await page.send('DOM.enable');
    const doc = await page.send('DOM.getDocument', { depth: -1 });
    const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-input' });
    check('the file input has a DOM node', node.nodeId > 0, `nodeId=${node.nodeId}`);
    await page.send('DOM.setFileInputFiles', { files: [csvPath], nodeId: node.nodeId });

    const gotChip = await waitFor(page, `Boolean(document.querySelector('.chip .chip__name'))`);
    check('uploading a file renders a chip', gotChip === true);
    const chipName = await page.evaluate(`(() => {
      const n = document.querySelector('.chip .chip__name');
      return n ? n.textContent : '';
    })()`);
    check('the chip carries the file name', /附件探针/.test(chipName), JSON.stringify(chipName));

    const listed = await (await fetch(`${base}/api/attachments`)).json();
    check('the server holds one attachment after upload', listed.attachments && listed.attachments.length === 1,
      JSON.stringify(listed.attachments && listed.attachments.length));
    check('the parsed kind is a table', listed.attachments && listed.attachments[0] && listed.attachments[0].kind === 'table',
      JSON.stringify(listed.attachments && listed.attachments[0] && listed.attachments[0].kind));

    // ── 3. the content reaches the model ───────────────────────────────
    // Type a message and send; the outgoing model message must contain the CSV.
    await page.evaluate(`(() => {
      const ta = document.querySelector('.composer__input');
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '照着这个做一个表');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    })()`);
    await sleep(150);
    const sendBox = await page.evaluate(`(() => {
      const b = document.querySelector('.composer__send');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    check('the send button is enabled', sendBox && sendBox.disabled === false, JSON.stringify(sendBox));
    if (sendBox) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sendBox.x, y: sendBox.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sendBox.x, y: sendBox.y, button: 'left', clickCount: 1 });
      // Poll for the turn to actually leave, rather than a fixed sleep. A fixed
      // wait is a timing bet: it passes alone and loses when other probes have
      // just finished and the box is still warm. The bet has no upside — the
      // transport call is observable, so observe it.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !seen.length) await sleep(200);
    }

    const reached = seen.some((m) => /北京甲公司/.test(m) && /附件探针/.test(m));
    check('the attachment content reached the model message', reached,
      seen.length ? `messages=${seen.length}, first=${JSON.stringify(seen[0].slice(0, 120))}` : 'transport never called');
    check('the user text is still in the message', seen.some((m) => /照着这个做一个表/.test(m)));

    // The content is context for the model, not something the user said: the
    // bubble shows what was typed plus the file's name, never the block.
    await sleep(800);
    const bubbleText = await page.evaluate(`[...document.querySelectorAll('.chat__row--me .chat__text')].map((n) => n.textContent).join('|')`);
    check('the chat bubble does not show the attachment block', !/附件资料/.test(bubbleText), JSON.stringify(bubbleText.slice(0, 120)));
    const bubbleFiles = await page.evaluate(`[...document.querySelectorAll('.chat__row--me .chat__file')].map((n) => n.textContent).join('|')`);
    check('the chat bubble names the attached file', /附件探针/.test(bubbleFiles), JSON.stringify(bubbleFiles));

    // ── 4. removing the chip clears it ─────────────────────────────────
    const removeX = await page.evaluate(`(() => {
      const b = document.querySelector('.chip__x');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then((s) => (s ? JSON.parse(s) : null));
    check('the chip has a remove button', !!removeX, JSON.stringify(removeX));
    if (removeX) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: removeX.x, y: removeX.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: removeX.x, y: removeX.y, button: 'left', clickCount: 1 });
      await sleep(800);
    }
    const chipsGone = await page.evaluate('document.querySelectorAll(".chip").length');
    check('removing the file leaves no chips', chipsGone === 0, `chips=${chipsGone}`);
    const cleared = await (await fetch(`${base}/api/attachments`)).json();
    check('the server has no attachments after removal', cleared.attachments.length === 0);

    // ── 5. drag-and-drop ───────────────────────────────────────────────
    // Build a DataTransfer with a real File and dispatch dragenter -> dragover
    // -> drop, exactly the events a file drag produces.
    const dragResult = await page.evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(CSV)}], '拖入的表.csv', { type: 'text/csv' }));
      const fire = (type) => window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      const on = document.querySelector('#drag-overlay').classList.contains('is-on');
      fire('dragover');
      fire('drop');
      return JSON.stringify({ overlayOn: on });
    })()`).then((s) => JSON.parse(s));
    check('dragenter shows the drop overlay', dragResult.overlayOn === true, JSON.stringify(dragResult));
    await sleep(800);
    const afterDrop = await (await fetch(`${base}/api/attachments`)).json();
    check('dropping a file uploads it', afterDrop.attachments.length === 1, JSON.stringify(afterDrop.attachments.length));
    const droppedChip = await page.evaluate(`(() => {
      const n = document.querySelector('.chip .chip__name');
      return n ? n.textContent : '';
    })()`);
    check('the dropped file shows as a chip', /拖入的表/.test(droppedChip), JSON.stringify(droppedChip));
    const overlayOff = await page.evaluate(`document.querySelector('#drag-overlay').classList.contains('is-on')`);
    check('the overlay hides after drop', overlayOff === false);
  } finally {
    if (page) { try { await closePage(page, { trashProfile: true }); } catch {} }
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failed === 0 ? 'ATTACHMENT UPLOAD CHECKS PASSED' : `${failed} FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
