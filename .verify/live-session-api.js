'use strict';
/**
 * The session API against the REAL model, over real HTTP.
 *
 * `live-agent.js` drives `runTurn` directly. This drives the same thing through
 * the HTTP surface the UI actually uses, because the last round of this project
 * produced bugs that lived exactly there — a route that 500'd on a shape it did
 * not expect, a JSON body slightly different from what the handler assumed.
 *
 * ===
 * Sends real content to a third party and spends real quota. Not part of the
 * normal test run. The key is never printed and never written to a file.
 * ===
 *
 * Usage: node .verify/live-session-api.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

const LIVE_DATA = path.join(process.env.APPDATA || '', 'ETabAgent');
const HAS_LIVE = fs.existsSync(path.join(LIVE_DATA, 'settings.json'));

const { createServer } = require(path.join(ROOT, 'lib', 'server'));
const { Settings } = require(path.join(ROOT, 'lib', 'settings'));

let pass = 0, fail = 0;
const notes = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}
const scrub = (s) => String(s == null ? '' : s)
  .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
  .replace(/\b[\w-]{40,}\b/g, '<long-token>');

async function main() {
  if (!HAS_LIVE) { console.error('no live settings in ' + LIVE_DATA); process.exit(2); }
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  // A THROWAWAY data directory, so a live run never writes into the user's own
  // session list. The credentials come from the real one, read-only.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-'));
  const real = new Settings(LIVE_DATA);
  const creds = real.secrets();

  const settings = {
    isConfigured: () => true,
    load: () => ({ chatCanEdit: true, chatConfirmEdits: true, useForAttachments: true }),
    publicSettings: () => ({ model: creds.model, hasKey: true }),
    secrets: () => creds,
    save: () => ({}),
  };

  const server = createServer({ dataDir, staticDir: path.join(ROOT, 'public'), settingsOverride: settings });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('=== live session API test ===');
  console.log(`model : ${creds.model}   session store: ${dataDir}`);
  console.log('(real requests; the key is never printed)');

  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  try {
    // ── 1. a fresh session
    console.log('\n--- 1) create a session ---');
    const created = await post('/api/sessions', {});
    check('session created', created.status === 200 && Boolean(created.json.session.id), JSON.stringify(created.json).slice(0, 160));
    const id = created.json.session.id;
    if (!id) throw new Error('no session id');

    // ── 2. an answer turn must not produce a preview
    console.log('\n--- 2) a question ---');
    const q = await post(`/api/sessions/${id}/turn`, { message: '你能做什么？' });
    console.log(`  status ${q.status}  intent=${q.json && q.json.intent}`);
    console.log(`  reply: ${scrub(q.json && q.json.reply).slice(0, 140)}`);
    check('turn succeeded', q.status === 200 && q.json.ok === true, scrub(q.json && q.json.error));
    check('judged as an answer', q.json && q.json.intent === 'answer', q.json && q.json.intent);
    check('nothing applied', q.json && q.json.applied === false);
    check('nothing proposed', q.json && q.json.proposed === null);
    check('no preview', q.json && q.json.preview === null);

    // ── 3. build a table
    console.log('\n--- 3) build a table ---');
    const build = await post(`/api/sessions/${id}/turn`, {
      message: '做一个销售台账：杭州云图 125万、上海临港 86万、深圳前海 88万，'
        + '签约日期分别是2026年1月8日、1月22日、2月3日，加一列税率，前两个6%，最后一个13%。',
    });
    console.log(`  status ${build.status}  intent=${build.json && build.json.intent}  applied=${build.json && build.json.applied}  pending=${build.json && build.json.pending}`);
    console.log(`  reply: ${scrub(build.json && build.json.reply).slice(0, 160)}`);
    check('turn succeeded', build.status === 200 && build.json.ok === true, scrub(build.json && build.json.error));
    check('judged as an action', build.json && build.json.intent === 'action', build.json && build.json.intent);
    check('held for confirmation', build.json && build.json.pending === true, `applied=${build.json && build.json.applied}`);
    check('the proposal is shown before it exists', Boolean(build.json && build.json.proposed), 'proposed');

    const prop = build.json && build.json.proposed && build.json.proposed.preview;
    if (prop) {
      console.log('  proposed grid:');
      for (const row of prop.rows) console.log('    ' + JSON.stringify(row));
      check('the grid has a header and three rows', prop.rows.length === 4, `${prop.rows.length} rows`);
      check('formats travelled with the values', Array.isArray(prop.formats) && prop.formats.length === prop.rows.length);
      // The grid carries stored values, which is what a spreadsheet holds: a date
      // IS the number 46030 and a percent IS 0.06. What makes them readable is
      // the format code beside them. The first version of this check looked for
      // the serial and called it a bug — that was the assertion being wrong, not
      // the data. Assert the format instead.
      const dateCol = prop.rows[0].findIndex((h) => /日期|签约/.test(String(h)));
      const dateFmt = dateCol >= 0 ? prop.formats[1][dateCol] : null;
      check('a date column carries a date format', /[yd]/i.test(String(dateFmt)), `col ${dateCol} fmt ${JSON.stringify(dateFmt)}`);
      const serial = dateCol >= 0 ? prop.rows[1][dateCol] : null;
      check('and the stored value is a serial number, not a string',
        typeof serial === 'number' && serial > 40000 && serial < 60000, JSON.stringify(serial));
      check('no date column is left unformatted',
        !prop.rows[0].some((h, i) => /日期|签约/.test(String(h)) && !/[yd]/i.test(String(prop.formats[1][i]))),
        JSON.stringify(prop.formats[1]));
    } else {
      check('the proposal carries a preview', false);
    }

    // ── 4. confirm it
    console.log('\n--- 4) apply the held change ---');
    const applied = await post(`/api/sessions/${id}/apply`, {});
    console.log(`  status ${applied.status}  applied=${applied.json && applied.json.applied}`);
    check('the change applied', applied.status === 200 && applied.json.applied === true, scrub(applied.json && applied.json.error));
    check('the session now holds a spec', Boolean(applied.json.session && applied.json.session.spec));
    if (applied.json.session && applied.json.session.spec) {
      const st = applied.json.session.stats;
      console.log(`  stored spec: ${JSON.stringify(st)}`);
      check('the spec has rows', st && st.rows >= 3, JSON.stringify(st));
    }

    // ── 5. the workbook endpoint
    console.log('\n--- 5) download the workbook ---');
    const dl = await fetch(`${base}/api/sessions/${id}/workbook.xlsx`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    console.log(`  status ${dl.status}  ${bytes.length} bytes`);
    check('it is a real xlsx', dl.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes.length} bytes`);
    if (bytes.length > 100) {
      const f = path.join(OUT, 'live-session-workbook.xlsx');
      fs.writeFileSync(f, bytes);
      console.log(`  wrote ${f}`);
    }

    // ── 6. an edit must keep the rows it was not asked about
    console.log('\n--- 6) edit one value ---');
    const edit = await post(`/api/sessions/${id}/turn`, { message: '把杭州云图那行的金额改成 150 万' });
    console.log(`  status ${edit.status}  intent=${edit.json && edit.json.intent}  guarded=${edit.json && edit.json.guarded}`);
    console.log(`  reply: ${scrub(edit.json && edit.json.reply).slice(0, 160)}`);
    check('turn succeeded', edit.status === 200 && edit.json.ok === true, scrub(edit.json && edit.json.error));
    check('judged as an action', edit.json && edit.json.intent === 'action', edit.json && edit.json.intent);
    check('the guard did not have to fire', edit.json && edit.json.guarded !== true);
    if (edit.json && edit.json.proposed) {
      const rows = edit.json.proposed.preview.rows;
      console.log('  proposed grid:');
      for (const row of rows) console.log('    ' + JSON.stringify(row));
      check('no rows were lost', rows.length === 4, `${rows.length} rows`);
      check('the new amount is there', JSON.stringify(rows).includes('1500000'), JSON.stringify(rows).slice(0, 200));
    }

    // ── 7. the transcript is on disk and survives
    console.log('\n--- 7) the transcript persisted ---');
    const back = await get(`/api/sessions/${id}`);
    check('the session reloads', back.status === 200 && back.json.ok === true);
    check('the conversation is recorded', back.json.session.messages.length >= 6, `${back.json.session.messages.length} messages`);
    check('the spec survived too', Boolean(back.json.session.spec));
    check('a preview is rebuilt from the stored spec', Boolean(back.json.preview));
    check('no key material in any response', !/sk-[A-Za-z0-9]{6,}/.test(JSON.stringify(back.json)));
  } catch (err) {
    check('the run completed without throwing', false, scrub(err && err.message));
    if (err && err.stack) notes.push(scrub(err.stack).split('\n').slice(0, 3).join(' | '));
  } finally {
    await new Promise((done) => server.close(done));
  }

  console.log('');
  console.log(`LIVE SESSION API: ${pass} passed, ${fail} failed`);
  for (const n of notes) console.log('  note: ' + n);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('FAILED:', scrub(err && err.stack || err)); process.exit(2); });
