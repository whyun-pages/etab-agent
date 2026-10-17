'use strict';
/**
 * Saving and fetching with the REAL model configured on this machine.
 *
 * Unit tests script the model, so they prove the tools work when called. This
 * proves a real model calls them when a user asks in plain Chinese:
 *
 *   1. "import this URL as a table"  -> fetch_url with importAs, the whole CSV
 *      lands, the model did not copy cells by hand
 *   2. "save it as CSV"              -> save_file, a file appears in the export
 *      directory, the reply says where
 *   3. a URL on the blocklist         -> refused, nothing changes
 *
 * Sends the test messages (and a public CSV's contents) to the configured
 * provider, and fetches one public URL from this machine. Data and exports go
 * to a throwaway directory; the credentials are read from the real settings,
 * read-only, and never printed.
 *
 * Usage: node .verify/model/live-save-fetch-model.js
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const LIVE_DATA = path.join(process.env.APPDATA || '', 'ETabAgent');
const { createServer } = require(path.join(ROOT, 'src', 'http', 'server.ts'));
const { Settings } = require(path.join(ROOT, 'src', 'store', 'settings.ts'));

const CSV_URL = 'https://people.sc.fsu.edu/~jburkardt/data/csv/cities.csv';

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
  }
}

async function main() {
  if (!fs.existsSync(path.join(LIVE_DATA, 'settings.json'))) {
    console.error(`no live settings in ${LIVE_DATA}`);
    process.exit(2);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-save-fetch-'));
  const exportDir = path.join(dataDir, 'exports');
  const creds = await new Settings(LIVE_DATA).secrets();

  const settings = {
    isConfigured: async () => true,
    load: async () => ({
      chatCanEdit: true,
      chatConfirmEdits: false,
      useForAttachments: true,
      chatCanFetch: true,
      chatCanSave: true,
      exportDir,
      fetchBlocklist: ['example.com'],
    }),
    publicSettings: async () => ({ model: creds.model, hasKey: true }),
    secrets: async () => creds,
    save: async () => ({}),
  };
  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public'), settingsOverride: settings });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const get = (p) => fetch(base + p).then((r) => r.json());

  console.log('=== live save/fetch ===');
  console.log(`model: ${creds.model}   data: ${dataDir}`);
  try {
    const {
      json: { session },
    } = await post('/api/sessions', {});
    const id = session.id;

    console.log('\n--- 1) import a public CSV ---');
    const t1 = await post(`/api/sessions/${id}/turn`, {
      message: `把 ${CSV_URL} 这个 CSV 导入成表格，工作表叫「城市」`,
    });
    console.log(`  reply: ${String(t1.json.reply).slice(0, 200).replace(/\n/g, ' ')}`);
    check('the turn succeeded', t1.json.ok === true, t1.json.error);
    check('the import landed', t1.json.applied === true, JSON.stringify(t1.json).slice(0, 300));
    const s1 = (await get(`/api/sessions/${id}`)).session.spec;
    const rows = s1 ? s1.sheets.reduce((n, s) => n + s.rows.length, 0) : 0;
    check('the whole CSV is in the table (128 cities)', rows === 128, `rows=${rows}`);
    check(
      'the sheet is named as asked',
      Boolean(s1 && s1.sheets.some((s) => s.name === '城市')),
      s1 && s1.sheets.map((s) => s.name).join(),
    );

    console.log('\n--- 2) save it as CSV ---');
    const t2 = await post(`/api/sessions/${id}/turn`, { message: '把这个表保存成 csv 文件，文件名叫 城市列表' });
    console.log(`  reply: ${String(t2.json.reply).slice(0, 300).replace(/\n/g, ' ')}`);
    check(
      'a file was saved',
      Array.isArray(t2.json.saved) && t2.json.saved.length === 1,
      JSON.stringify(t2.json.saved),
    );
    const files = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
    check('it is the CSV, named as asked', files.includes('城市列表.csv'), files.join());
    if (files.includes('城市列表.csv')) {
      const lines = fs.readFileSync(path.join(exportDir, '城市列表.csv'), 'utf8').trim().split('\r\n');
      check('with a header and every row', lines.length === 129, `lines=${lines.length}`);
    }
    check('the reply says where it went', /已保存：/.test(t2.json.reply), t2.json.reply);

    console.log('\n--- 3) a blocked URL ---');
    const before = JSON.stringify((await get(`/api/sessions/${id}`)).session.spec);
    const t3 = await post(`/api/sessions/${id}/turn`, {
      message: '抓取 https://data.example.com/prices.csv 看看里面有什么',
    });
    console.log(`  reply: ${String(t3.json.reply).slice(0, 200).replace(/\n/g, ' ')}`);
    check('the turn did not fail', t3.json.ok === true, t3.json.error);
    check('nothing changed', JSON.stringify((await get(`/api/sessions/${id}`)).session.spec) === before);
    check(
      'the reply does not pretend it read the page',
      /禁止|不允许|无法|没能|不能|拒绝/.test(t3.json.reply),
      t3.json.reply,
    );
  } finally {
    await new Promise((r) => server.close(r));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
  console.log(`\n${failed === 0 ? 'LIVE SAVE/FETCH PASSED' : `${failed} FAILED`} (${passed} ok)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
