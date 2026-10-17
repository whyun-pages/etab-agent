'use strict';
/**
 * Screenshot a RUNNING TabAgent.exe over CDP.
 * Usage: node .verify/shots/shot-exe.js [port] [outName]
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'out');
const PORT = Number(process.argv[2] || 59431);
const NAME = process.argv[3] || '18-exe-live';

const { openPage, closePage } = require('../support/browser.js');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;

  const page = await openPage({
    profile: path.join(OUT, 'shot-exe-profile'),
    url: base,
    window: '1440,900',
  });

  // Wait for the SPA to boot and render, rather than a fixed 1.5 s.
  await page.waitForSelector('.rail__head', { state: 'attached', timeout: 10000 }).catch(() => {});

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

  const file = path.join(OUT, `${NAME}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}  (${fs.statSync(file).size} bytes)`);

  await closePage(page, { trashProfile: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
