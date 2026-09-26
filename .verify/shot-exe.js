'use strict';
/**
 * Screenshot a RUNNING TabAgent.exe over CDP.
 * Usage: node .verify/shot-exe.js [port] [outName]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.argv[2] || 59431);
const NAME = process.argv[3] || '18-exe-live';

const { openPage, closePage, findEdge } = require('./cdp.js');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const edge = findEdge();
  if (!edge) throw new Error('Edge not found');
  const base = `http://127.0.0.1:${PORT}`;

  const page = await openPage({
    edge,
    profile: path.join(OUT, 'shot-exe-profile'),
    url: base,
    port: 9741,
    window: '1440,900',
  });

  // Give the SPA time to boot and render.
  await page.send('Runtime.evaluate', {
    expression: 'new Promise(r => setTimeout(r, 1500))',
    awaitPromise: true,
  });

  const report = await page.evaluate(`(() => {
    const banner = document.querySelector('#error-banner');
    return JSON.stringify({
      title: document.title,
      url: location.href,
      hasComposer: !!document.querySelector('.composer, .composer__input, textarea'),
      bodyChars: (document.body.innerText || '').length,
      bannerText: banner ? banner.textContent : null,
      bannerHidden: banner ? banner.hasAttribute('hidden') : null,
    });
  })()`);
  console.log('page report:', report);

  const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${NAME}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`wrote ${file}  (${fs.statSync(file).size} bytes)`);

  await closePage(page);
}

main().catch((e) => { console.error(e); process.exit(1); });
