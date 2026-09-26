'use strict';
/**
 * Does generating/downloading a workbook ever write an .xlsx to disk?
 *
 * Claim under test: it does NOT. `writeSpec` builds a Buffer in memory and the
 * route `res.end(buffer)`s it. What persists is the SPEC (inside the session
 * JSON), not a spreadsheet file.
 *
 * This is worth proving rather than reading, because "the file appears in
 * Downloads" makes it easy to assume the app wrote one somewhere. It did not:
 * the browser wrote the bytes it was handed.
 *
 * Usage: node .verify/probe-workbook-on-disk.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createServer } = require(path.join(ROOT, 'lib', 'server.js'));
const { normalizeSpec, writeSpec } = require(path.join(ROOT, 'lib', 'workbook.js'));

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

/** Every .xlsx/.xlsm anywhere under `dir`, recursively. */
function xlsxUnder(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.xls[xm]$/i.test(e.name)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

const SPEC = normalizeSpec({
  title: '磁盘探针',
  sheets: [{ name: '表1', columns: ['名称', '数量'], rows: [['甲', 1], ['乙', 2]] }],
}).spec;

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlwb-'));
  const settings = {
    baseUrl: 'https://api.example.invalid/v1', apiKey: 'sk-x', model: 'p',
    useForAttachments: true, chatCanEdit: true, chatConfirmEdits: true,
  };
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));

  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // A session holding a spec (as a real one would after an action turn).
    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    const id = created.session.id;
    // Write the spec via the store directly, since the turn path needs a model.
    const { SessionStore } = require(path.join(ROOT, 'lib', 'session-store.js'));
    const store = new SessionStore(dataDir);
    await store.update(id, (cur) => ({ ...cur, spec: SPEC }));

    const before = xlsxUnder(dataDir);
    check('no .xlsx on disk before the download', before.length === 0, before.join(', '));

    // THE DOWNLOAD.
    const res = await fetch(`${base}/api/sessions/${id}/workbook.xlsx`);
    const buf = Buffer.from(await res.arrayBuffer());
    check('download returns 200', res.status === 200, `status ${res.status}`);
    check('download is a real zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b, buf.slice(0, 4).toString('hex'));
    check('download has the xlsx content-type',
      /spreadsheetml/.test(res.headers.get('content-type') || ''), res.headers.get('content-type'));
    check('download carries a filename',
      /attachment/.test(res.headers.get('content-disposition') || ''), res.headers.get('content-disposition'));

    const after = xlsxUnder(dataDir);
    check('STILL no .xlsx on disk after the download', after.length === 0, after.join(', '));

    // What DOES persist is the spec, inside the session JSON.
    const sessionFile = path.join(dataDir, 'sessions', `${id}.json`);
    const raw = fs.readFileSync(sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    check('the session JSON exists', fs.existsSync(sessionFile));
    check('the session JSON holds the SPEC, not a spreadsheet', !!parsed.spec && parsed.spec.sheets.length === 1);
    check('session JSON is not a zip', !raw.startsWith('PK'));

    // And twice more, to be sure nothing accumulates.
    await fetch(`${base}/api/sessions/${id}/workbook.xlsx`).then((r) => r.arrayBuffer());
    await fetch(`${base}/api/sessions/${id}/workbook.xlsx`).then((r) => r.arrayBuffer());
    check('repeated downloads still leave nothing on disk', xlsxUnder(dataDir).length === 0);

    // writeSpec itself, called in isolation, writes nothing anywhere.
    const buf2 = writeSpec(SPEC);
    check('writeSpec returns a Buffer', Buffer.isBuffer(buf2) && buf2.length > 0, `${buf2 && buf2.length}`);
  } finally {
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(failures === 0 ? '\nWORKBOOK-ON-DISK PROBE PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
