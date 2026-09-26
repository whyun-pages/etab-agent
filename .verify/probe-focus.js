'use strict';
/**
 * What exactly happens to focus on one keystroke?
 *
 * prompt-keystroke.js says the node survives but focus still ends on <body>.
 * Two candidate explanations, and they need different fixes:
 *
 *   (a) `replaceChildren` detaches the focused node, so the browser blurs it,
 *       and mount()'s restore does not run or does not stick;
 *   (b) the evaluate-based test itself loses focus, because the CDP evaluation
 *       does not run in a focused window and `execCommand('insertText')` is a
 *       no-op unless the document has focus.
 *
 * (b) is a real possibility and would make the whole test lie. So this walks a
 * single keystroke step by step, printing focus at each stage, and separately
 * checks what `document.hasFocus()` and `execCommand` do here.
 *
 * Usage: node .verify/probe-focus.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findEdge, openPage, closePage, sleep } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const PORT = 3231;
const OUT = path.join(__dirname, 'out');
const PROFILE = path.join(OUT, 'probe-focus-profile');

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)],
    { stdio: 'ignore', cwd: ROOT });
  await sleep(900);

  const page = await openPage({
    edge: findEdge(),
    profile: PROFILE,
    url: `http://127.0.0.1:${PORT}/`,
    port: PORT + 1,
    waitForSelector: '#editor-body',
  });

  try {
    // Load the sample template via the drop handler the app already listens for.
    await page.evaluate(`
      (async () => {
        const r = await fetch('/sample/contract.xlsx');
        const b = await r.blob();
        const f = new File([b], 'sample.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const dt = new DataTransfer();
        dt.items.add(f);
        document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
        return true;
      })()
    `);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (await page.evaluate(`Boolean(document.querySelector('#prompt-input'))`)) break;
    }

    console.log('--- environment ---');
    const env = await page.evaluateJson(`JSON.stringify({
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      promptExists: Boolean(document.querySelector('#prompt-input')),
    })`);
    console.log(`     ${JSON.stringify(env)}`);

    console.log('\n--- step by step through one keystroke ---');
    const steps = await page.evaluateJson(`
      (async () => {
        const q = () => document.activeElement?.id || document.activeElement?.tagName;
        const ta = document.querySelector('#prompt-input');
        const out = {};

        ta.focus();
        out['0 after focus()'] = q();
        out['0 hasFocus'] = document.hasFocus();

        // Does execCommand work at all here?
        const v0 = ta.value;
        const okExec = document.execCommand('insertText', false, 'X');
        out['1 execCommand returned'] = okExec;
        out['1 value changed'] = ta.value !== v0;
        out['1 focus'] = q();

        // Now the real path: focus, then fire the input event the app listens
        // for, with the value already set the way a browser would set it.
        ta.value = 'ab';
        ta.focus();
        out['2 focus before input'] = q();
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'b', inputType: 'insertText' }));
        out['3 focus after input event'] = q();
        out['3 node same'] = document.querySelector('#prompt-input') === ta;
        out['3 node connected'] = ta.isConnected;
        out['3 hasFocus'] = document.hasFocus();

        await new Promise(r => setTimeout(r, 50));
        out['4 focus after settle'] = q();
        out['4 node same'] = document.querySelector('#prompt-input') === ta;
        return JSON.stringify(out);
      })()
    `);
    for (const [k, v] of Object.entries(steps)) console.log(`     ${k.padEnd(26)} ${JSON.stringify(v)}`);

    console.log('\n--- does mount() restore run? ---');
    const restore = await page.evaluateJson(`
      (async () => {
        const ta = document.querySelector('#prompt-input');
        ta.focus();
        const before = document.activeElement === ta;
        // Instrument focus() so we can see whether mount() calls it.
        let focusCalls = 0;
        const orig = ta.focus.bind(ta);
        ta.focus = (...a) => { focusCalls++; return orig(...a); };
        ta.value = 'abc';
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'c', inputType: 'insertText' }));
        await new Promise(r => setTimeout(r, 50));
        const after = document.activeElement === ta;
        return JSON.stringify({ before, focusRestoredViaFocusCall: focusCalls, after });
      })()
    `);
    for (const [k, v] of Object.entries(restore)) console.log(`     ${k.padEnd(26)} ${JSON.stringify(v)}`);

    console.log('\n--- real CDP input, the way a user types ---');
    // Send genuine keystrokes through the browser's input pipeline; this is the
    // closest thing to a person typing, and it does attach focus properly.
    await page.evaluate(`document.querySelector('#prompt-input').focus(); document.querySelector('#prompt-input').value = '';`);
    for (const ch of 'abcdefg') {
      await page.cdp.send('Input.insertText', { text: ch });
      await sleep(30);
    }
    const typed = await page.evaluateJson(`JSON.stringify({
      value: document.querySelector('#prompt-input').value,
      focus: document.activeElement?.id || document.activeElement?.tagName,
      sameNode: document.querySelector('#prompt-input')?.dataset.fprobe === 'x',
    })`);
    console.log(`     ${JSON.stringify(typed)}`);
  } finally {
    await closePage(page, { trashProfile: true });
    try { server.kill(); } catch { /* ignore */ }
    await sleep(300);
    process.exit(0);
  }
}

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
