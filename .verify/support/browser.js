'use strict';
/**
 * Real Edge for the .verify scripts, driven through playwright-core.
 *
 * This replaced a hand-written CDP client (support/cdp.js, and three more
 * copies inside shots/ scripts). Playwright speaks
 * the same protocol to Edge — CDP is the only one a Chromium browser has —
 * but owns the parts every probe used to get wrong on its own: polling for
 * the debugging endpoint, picking the right target, an exception inside the
 * page arriving as a silent `undefined`, and waiting by sleeping.
 *
 * No browser is downloaded: playwright-core launches the msedge.exe already
 * on this machine (`findEdge`), headless, on a throwaway profile, over a pipe
 * rather than a debugging port — so two probes cannot collide on a port.
 *
 * Usage:
 *   const { openPage, closePage } = require('../support/browser.js');
 *   const page = await openPage({ profile, url, waitForSelector: '#app' });
 *   await page.evaluate('document.title');      // a string expression, as before
 *   await page.mouse.click(x, y);               // Playwright's Page is all there
 *   await closePage(page, { trashProfile: true });
 *
 * The returned page IS a Playwright Page, with the handful of helpers the
 * scripts were written against added on: `evaluate` of a string throws
 * "page threw: ..." as before, `evaluateJson`, `requests(needle)`, and
 * `send(method, params)` for raw CDP where Playwright has no equivalent.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRASH_ROOT = path.join(os.homedir(), '.Trash');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** Path to msedge.exe, or a clear error naming what was checked. */
function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Edge not found; looked in:\n  ' + EDGE_CANDIDATES.join('\n  '));
}

/** Move a directory into the trash. Recursive delete trips the safety guard. */
function moveToTrash(src, label) {
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(TRASH_ROOT, `${label}-${stamp}`, path.basename(src));
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Launch Edge on a scratch profile and open one page.
 *
 * `window` is the viewport, "width,height", exactly. The old `--window-size`
 * was not: headless Edge still took about 44 px of width and 100 px of height
 * off it (1440,900 rendered a 1396x798 page — compare an old screenshot). The
 * layout probes passed the same at both sizes; their expectations are about
 * proportion and reachability, not those pixels.
 *
 * @param {{ edge?: string, profile: string, url?: string, window?: string,
 *           waitForSelector?: string }} opts
 */
async function openPage({ edge, profile, url, window = '1400,900', waitForSelector = null }) {
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  const [width, height] = window.split(',').map(Number);
  // A persistent context, not launch() + newContext(): the profile is a real
  // folder, as it was, so a reload keeps localStorage and a probe can look at
  // what the browser wrote.
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: edge || findEdge(),
    headless: true,
    viewport: { width, height },
    deviceScaleFactor: 1,
    args: ['--disable-gpu', '--disable-features=Translate,MediaRouter'],
  });
  const page = context.pages()[0] || (await context.newPage());
  const cdp = await context.newCDPSession(page);

  /** Every request the page made, for "did the click reach the server". */
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));

  const evaluateExpr = page.evaluate.bind(page);
  Object.assign(page, {
    profile,

    /**
     * Evaluate in the page: a string is an expression, as with CDP's
     * Runtime.evaluate, and a promise is awaited. An exception inside the
     * page throws here with the page's own first line.
     *
     * A string takes no argument. The scripts' old second argument was
     * cdp.js's `{ awaitPromise }`, which Playwright would pass to the page as
     * an argument and refuse — and a polling helper's catch would turn that
     * refusal into "never ready". So for a string it is dropped.
     */
    async evaluate(expression, arg) {
      try {
        return typeof expression === 'string' ? await evaluateExpr(expression) : await evaluateExpr(expression, arg);
      } catch (err) {
        const text = String((err && err.message) || err).replace(/^page\.evaluate:\s*/, '');
        throw new Error('page threw: ' + text.split('\n')[0]);
      }
    },

    /** Evaluate an expression that yields JSON, and parse it. */
    async evaluateJson(expression) {
      const raw = await page.evaluate(expression);
      return raw === undefined || raw === null ? null : JSON.parse(raw);
    },

    /**
     * Load `to` and wait for it. `load` arrives for a local page well before
     * the app's first render, so a caller passes a selector to wait past that.
     */
    async navigate(to = url) {
      await page.goto(to, { waitUntil: 'load' });
      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { state: 'attached', timeout: 8000 }).catch(() => {
          throw new Error('selector never appeared: ' + waitForSelector);
        });
      }
    },

    /** Requests whose URL contains `needle`, in the order they were made. */
    requests(needle) {
      return seen.filter((u) => u.includes(needle));
    },

    /** Raw CDP, for what Playwright does not wrap. */
    send(method, params) {
      return cdp.send(method, params);
    },
  });

  if (url) await page.navigate(url);
  return page;
}

async function closePage(page, { trashProfile = false } = {}) {
  if (!page) return;
  try {
    await page.context().close();
  } catch {
    /* already gone */
  }
  if (trashProfile && page.profile) moveToTrash(page.profile, 'tab-agent-browser');
}

module.exports = { findEdge, openPage, closePage, moveToTrash, sleep };
