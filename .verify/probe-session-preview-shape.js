'use strict';
/**
 * What does each session endpoint actually put on the wire?
 *
 * The UI showed a date column as `2026-01-08T00:00:00.000Z` after applying a
 * change, while the same spec rendered as `2026-01-08` BEFORE it was applied.
 * Two endpoints, one spec, two renderings — so the question is which of them
 * serialises a Date as a string, and this prints the raw JSON of each.
 *
 * Usage: node .verify/probe-session-preview-shape.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { Settings } = require(path.join(ROOT, 'lib', 'settings.js'));
const { SessionStore } = require(path.join(ROOT, 'lib', 'session-store.js'));

const SPEC = {
  title: '销售台账',
  sheets: [{
    name: '销售台账',
    columns: [
      { header: '客户名称', type: 'text' },
      { header: '合同金额', type: 'currency' },
      { header: '签约日期', type: 'date' },
    ],
    rows: [['杭州云图', 1250000, '2026-01-08'], ['上海临港', 860000, '2026-01-22']],
  }],
};

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The date cell out of a preview, whichever way it is spelled. */
function dateCells(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return ['(unparseable)']; }
  const rows = (parsed.preview && parsed.preview.rows) || [];
  return rows.slice(1).map((r) => JSON.stringify(r[2]));
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlshape-'));
  new Settings(dataDir).save({
    apiUrl: undefined,
    baseUrl: 'https://api.example.invalid/v1',
    apiKey: 'sk-probe-not-real-0000',
    model: 'demo-model',
  });

  const store = new SessionStore(dataDir);
  const session = store.create('');

  // A model that proposes the spec once, then proposes nothing.
  let turn = 0;
  const server = createServer({
    dataDir,
    staticDir: path.join(ROOT, 'public'),
    transport: async () => {
      turn += 1;
      return JSON.stringify(turn === 1
        ? { intent: 'action', reply: '建好了。', spec: SPEC }
        : { intent: 'answer', reply: '好。' });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  console.log('--- POST /turn (held, so `proposed` carries the preview) ---');
  const t = await request(port, 'POST', `/api/sessions/${session.id}/turn`, { message: '做一个销售台账' });
  const tp = JSON.parse(t.body);
  console.log('  pending:', tp.pending, ' applied:', tp.applied);
  console.log('  proposed date cell:', JSON.stringify(((tp.proposed || {}).preview || {}).rows?.[1]?.[2]));
  console.log('  top-level preview date cell:', JSON.stringify((tp.preview || {}).rows?.[1]?.[2]));

  console.log('\n--- POST /apply (the click) ---');
  const a = await request(port, 'POST', `/api/sessions/${id_or(session.id)}/apply`, { accept: true });
  const ap = JSON.parse(a.body);
  console.log('  applied:', ap.applied);
  console.log('  apply preview date cell:', JSON.stringify((ap.preview || {}).rows?.[1]?.[2]));
  console.log('  apply preview formats row 1:', JSON.stringify(((ap.preview || {}).formats || [])[1]));

  console.log('\n--- GET /sessions/:id (what a reload shows) ---');
  const g = await request(port, 'GET', `/api/sessions/${session.id}`);
  const gp = JSON.parse(g.body);
  console.log('  get preview date cell:', JSON.stringify((gp.preview || {}).rows?.[1]?.[2]));
  console.log('  get preview formats row 1:', JSON.stringify(((gp.preview || {}).formats || [])[1]));
  console.log('  stored spec date cell:', JSON.stringify(((gp.session.spec || {}).sheets?.[0]?.rows || [])[0]?.[2]));

  console.log('\n--- what reached disk ---');
  console.log('  ', fs.readFileSync(path.join(dataDir, 'sessions', `${session.id}.json`), 'utf8')
    .split('\n').filter((l) => l.includes('2026')).join('\n   ').trim() || '(no date line?)');

  console.log('\n--- /turn again with the applied spec in place ---');
  const t2 = await request(port, 'POST', `/api/sessions/${session.id}/turn`, { message: '好' });
  const t2p = JSON.parse(t2.body);
  console.log('  turn preview date cell:', JSON.stringify((t2p.preview || {}).rows?.[1]?.[2]));

  server.close();
  void dateCells;
}

function id_or(v) { return v; }

main().catch((err) => { console.error('FAILED:', err && err.stack || err); process.exit(2); });
