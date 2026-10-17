'use strict';
/**
 * The session API over real HTTP: sessions as documents.
 *
 * Creating, listing and deleting them; what survives a restart; downloading
 * the workbook; paging the preview; column widths.
 *
 * Real sockets rather than a function-level test, because the bugs this layer
 * has produced before were all at the boundary: a route that answered 500 on a
 * shape it did not expect, a static guard that 404'd everything, a JSON body
 * that arrived as something slightly different from what the handler assumed.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { listenLocal } from '../helpers/listen.ts';
import { createServer } from '../../src/http/server.ts';

import {
  tmpdir,
  loadFaux,
  step,
  startServer,
  settingsStub,
  post,
  get,
  SPEC,
  ACTION,
} from '../helpers/session-server.ts';

// ── sessions ────────────────────────────────────────────────────────

test('a session can be created, listed, and deleted', async (t) => {
  const { base } = await startServer(t);

  const created = await post(base, '/api/sessions', {});
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.json.ok, true);
  const id = created.json.session.id;
  assert.ok(id, 'an id came back');
  assert.strictEqual(created.json.session.spec, null);

  const list = await get(base, '/api/sessions');
  assert.strictEqual(list.json.sessions.length, 1);
  assert.strictEqual(list.json.sessions[0].id, id);

  const del = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const after = await get(base, '/api/sessions');
  assert.strictEqual(after.json.sessions.length, 0);
});

test('deleting twice reports 404 the second time, not a crash', async (t) => {
  const { base } = await startServer(t);
  const { json: created } = await post(base, '/api/sessions', {});
  const url = `${base}/api/sessions/${created.session.id}`;
  assert.strictEqual((await fetch(url, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await get(base, `/api/sessions/${created.session.id}`)).status, 404);
  const again = await fetch(url, { method: 'DELETE' });
  assert.strictEqual(again.status, 404);
  // Shaped like every other failure: the client shows `error`.
  assert.deepStrictEqual(await again.json(), { ok: false, error: '会话不存在' });
});

test('concurrent creates over HTTP all land, with distinct ids', async (t) => {
  // The store has its own version of this; here it is the route that must
  // await the create before answering, or the list misses some.
  const { base } = await startServer(t);
  const many = await Promise.all(
    Array.from({ length: 10 }, (_, i) => post(base, '/api/sessions', { title: `批量-${i}` })),
  );
  assert.ok(
    many.every((m) => m.status === 200),
    many.map((m) => m.status).join(','),
  );
  assert.strictEqual(new Set(many.map((m) => m.json.session.id)).size, 10, 'a duplicate id');
  assert.strictEqual((await get(base, '/api/sessions')).json.sessions.length, 10);
});

test("a title the user gave is kept; an untitled session takes the first table's", async (t) => {
  const { base } = await startServer(t, { replies: [ACTION, ACTION], chatConfirmEdits: false });

  const { json: named } = await post(base, '/api/sessions', { title: '我的台账' });
  await post(base, `/api/sessions/${named.session.id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual((await get(base, `/api/sessions/${named.session.id}`)).json.session.title, '我的台账');

  const { json: untitled } = await post(base, '/api/sessions', { title: '' });
  await post(base, `/api/sessions/${untitled.session.id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual((await get(base, `/api/sessions/${untitled.session.id}`)).json.session.title, SPEC.title);
});

test('an unknown session is 404, not a crash', async (t) => {
  const { base } = await startServer(t);
  assert.strictEqual((await get(base, '/api/sessions/none-0000')).status, 404);
  assert.strictEqual((await post(base, '/api/sessions/none-0000/turn', { message: 'hi' })).status, 404);
});

// ── the workbook endpoint ───────────────────────────────────────────

test('the workbook endpoint returns real xlsx bytes', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION], chatConfirmEdits: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const r = await fetch(`${base}/api/sessions/${id}/workbook.xlsx`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(bytes[0], 0x50, 'PK zip magic');
  assert.strictEqual(bytes[1], 0x4b);
  assert.ok(bytes.length > 1000, `${bytes.length} bytes`);
});

test('downloading writes no workbook file: the spec is what persists', async (t) => {
  // "The file appears in Downloads" makes it easy to assume the app wrote one
  // somewhere. It does not: writeSpec builds a Buffer and the route sends it;
  // the browser writes the bytes it was handed. Worth proving rather than
  // reading, so a cache or a temp copy cannot creep in unnoticed.
  const { base, dataDir } = await startServer(t, { replies: [ACTION], chatConfirmEdits: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const xlsxUnder = (dir) => fs.readdirSync(dir, { recursive: true }).filter((p) => /\.xls[xm]$/i.test(String(p)));
  assert.deepStrictEqual(xlsxUnder(dataDir), [], 'a workbook file exists before any download');

  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/api/sessions/${id}/workbook.xlsx`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /attachment/);
    await r.arrayBuffer();
  }
  assert.deepStrictEqual(xlsxUnder(dataDir), [], 'a download left a workbook file behind');

  const raw = fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8');
  assert.ok(!raw.startsWith('PK'), 'the session file is a zip');
  assert.ok(JSON.parse(raw).spec.sheets.length >= 1, 'the session file holds no spec');
});

test('no workbook before there is a spec', async (t) => {
  const { base } = await startServer(t);
  const { json: created } = await post(base, '/api/sessions', {});
  const r = await fetch(`${base}/api/sessions/${created.session.id}/workbook.xlsx`);
  assert.strictEqual(r.status, 404);
});

// ── persistence ─────────────────────────────────────────────────────

test('a session survives a server restart', async (t) => {
  // The point of storing sessions at all: "昨天那单改成 40 万" needs yesterday.
  const dataDir = tmpdir();
  const { ai, faux } = await loadFaux();
  faux.setResponses(ACTION.map((s) => (context) => step(ai, s, context)));
  const opts = {
    dataDir,
    staticDir: path.join(__dirname, '..', '..', 'public'),
    model: faux.getModel(),
    settingsOverride: settingsStub({ chatConfirmEdits: false }),
  };

  const first = createServer(opts);
  await new Promise((done) => listenLocal(first).then(done));
  const base1 = `http://127.0.0.1:${first.address().port}`;
  const { json: created } = await post(base1, '/api/sessions', {});
  const id = created.session.id;
  await post(base1, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  await new Promise((done) => first.close(done));

  const second = createServer(opts);
  await new Promise((done) => listenLocal(second).then(done));
  t.after(() => new Promise((done) => second.close(done)));
  const base2 = `http://127.0.0.1:${second.address().port}`;

  const back = await get(base2, `/api/sessions/${id}`);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.session.spec.title, '销售台账');
  assert.strictEqual(back.json.session.messages.length, 2);
  assert.ok(back.json.preview, 'the preview is rebuilt from the stored spec');
});

test('the workbook downloads as CSV and JSON too', async (t) => {
  const { base } = await startServer(t, { chatConfirmEdits: false, replies: [ACTION] });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表' });

  const csv = await fetch(`${base}/api/sessions/${session.id}/workbook.csv`);
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /%E9%94%80%E5%94%AE%E5%8F%B0%E8%B4%A6\.csv/);
  assert.match(await csv.text(), /客户名称,金额/);

  const json = await fetch(`${base}/api/sessions/${session.id}/workbook.json?sheet=${encodeURIComponent('明细')}`);
  assert.strictEqual(json.status, 200);
  assert.strictEqual((await json.json()).sheets[0].rows[1]['客户名称'], '乙');

  const missing = await fetch(`${base}/api/sessions/${session.id}/workbook.csv?sheet=nope`);
  assert.strictEqual(missing.status, 404);
  const xlsx = await fetch(`${base}/api/sessions/${session.id}/workbook.xlsx`);
  assert.strictEqual(xlsx.status, 200);
});

// ── preview paging ──────────────────────────────────────────────────

/** SPEC with `n` data rows, numbered so a row's position can be checked. */
const bigSpec = (n) => ({
  ...SPEC,
  sheets: [{ ...SPEC.sheets[0], rows: Array.from({ length: n }, (_, i) => [`客户${i + 1}`, (i + 1) * 100]) }],
});

test('the preview comes in a first window, and the rest pages in by key', async (t) => {
  const { base } = await startServer(t, {
    replies: [[{ tool: 'create_workbook', args: bigSpec(300) }, '好']],
    chatConfirmEdits: false,
  });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '做一个 300 行的表' });

  const first = turn.json.preview;
  assert.strictEqual(first.rows.length, 40, 'the first window only');
  assert.strictEqual(first.startRow, 1);
  assert.strictEqual(first.totalRows, 301, 'header + 300 data rows');
  assert.ok(first.key, 'a key to page against');

  // Page by page to the end; every row arrives once, in order, with formats.
  let rows = first.rows.slice();
  while (rows.length < first.totalRows) {
    const page = await get(base, `/api/sessions/${id}/preview?key=${first.key}&from=${rows.length + 1}&count=200`);
    assert.strictEqual(page.json.stale, false);
    assert.strictEqual(page.json.startRow, rows.length + 1);
    assert.strictEqual(page.json.formats.length, page.json.rows.length);
    rows = rows.concat(page.json.rows);
  }
  assert.strictEqual(rows.length, 301);
  assert.deepStrictEqual(rows[300], ['客户300', 30000]);
  assert.deepStrictEqual(
    rows.slice(1).map((r) => r[0]),
    Array.from({ length: 300 }, (_, i) => `客户${i + 1}`),
  );

  // The same key is what reloading the session hands out.
  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.preview.key, first.key);
});

test('a page request is capped, and a changed table answers stale', async (t) => {
  const { base } = await startServer(t, {
    replies: [[{ tool: 'create_workbook', args: bigSpec(800) }, '好']],
    chatConfirmEdits: false,
  });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  const { json: turn } = await post(base, `/api/sessions/${id}/turn`, { message: '做表' });

  const big = await get(base, `/api/sessions/${id}/preview?key=${turn.preview.key}&from=41&count=100000`);
  assert.strictEqual(big.json.rows.length, 500, 'capped at MAX_PAGE_ROWS');

  // A key from another version of the table gets no rows to stitch on.
  const wrong = await get(base, `/api/sessions/${id}/preview?key=0000000000000000&from=41&count=10`);
  assert.deepStrictEqual(wrong.json, { ok: true, stale: true });
  // Nothing is held, so there is no proposal to page.
  const none = await get(base, `/api/sessions/${id}/preview?key=${turn.preview.key}&from=41&count=10&proposed=1`);
  assert.strictEqual(none.json.stale, true);

  const missing = await get(base, '/api/sessions/nope/preview?key=x&from=1');
  assert.strictEqual(missing.status, 404);
});

test('a held proposal pages its own rows, not the stored table', async (t) => {
  const { base } = await startServer(t, {
    replies: [[{ tool: 'create_workbook', args: bigSpec(120) }, '好']],
    chatConfirmEdits: true,
  });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  const { json: turn } = await post(base, `/api/sessions/${id}/turn`, { message: '做表' });
  assert.strictEqual(turn.pending, true);
  const key = turn.proposed.preview.key;

  const page = await get(base, `/api/sessions/${id}/preview?key=${key}&from=41&count=200&proposed=1`);
  assert.strictEqual(page.json.stale, false);
  assert.strictEqual(page.json.rows.length, 81, 'rows 41..121');
  assert.deepStrictEqual(page.json.rows[80], ['客户120', 12000]);

  // Once answered, the proposal is gone and its key goes stale.
  await post(base, `/api/sessions/${id}/apply`, { accept: false });
  const after = await get(base, `/api/sessions/${id}/preview?key=${key}&from=41&count=10&proposed=1`);
  assert.strictEqual(after.json.stale, true);
});

// ── column widths ────────────────────────────────────────────────────

test('a column width dragged in the preview is stored, exported and previewed', async (t) => {
  const { base, dataDir } = await startServer(t, { replies: [ACTION], chatConfirmEdits: false });
  const id = (await post(base, '/api/sessions', {})).json.session.id;
  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const r = await post(base, `/api/sessions/${id}/column-width`, {
    sheet: '明细',
    index: 1,
    header: '金额',
    width: 31.5,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.notStrictEqual(r.json.key, turn.json.preview.key, 'the file changed, so the key did');
  assert.ok(
    r.json.cols.some((c) => c.min <= 2 && 2 <= c.max && c.width === 31.5),
    JSON.stringify(r.json.cols),
  );

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
  assert.strictEqual(stored.spec.sheets[0].columns[1].width, 31.5);
  assert.strictEqual(stored.changes.length, 1, 'a width is not logged as a change the model is told about');
  assert.strictEqual(stored.messages.length, 2, 'nor said in the transcript');

  // The page endpoint accepts the new key: rows already loaded stay valid.
  const page = await get(base, `/api/sessions/${id}/preview?key=${r.json.key}&from=2&count=10`);
  assert.strictEqual(page.json.stale, false);
});

test('a column width aimed at a column that has moved is refused, and nothing is written', async (t) => {
  const { base, dataDir } = await startServer(t, { replies: [ACTION], chatConfirmEdits: false });
  const id = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  const file = path.join(dataDir, 'sessions', `${id}.json`);
  const before = fs.readFileSync(file, 'utf8');

  for (const body of [
    { sheet: '明细', index: 0, header: '金额', width: 20 }, // header is elsewhere now
    { sheet: '明细', index: 5, header: '金额', width: 20 },
    { sheet: '没有', index: 1, header: '金额', width: 20 },
    { sheet: '明细', index: 1, header: '金额', width: 'wide' },
  ]) {
    const r = await post(base, `/api/sessions/${id}/column-width`, body);
    assert.strictEqual(r.status, 409, JSON.stringify(body));
    assert.strictEqual(r.json.ok, false);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the session file was not touched');

  const missing = await post(base, '/api/sessions/nope/column-width', {
    sheet: '明细',
    index: 1,
    header: '金额',
    width: 20,
  });
  assert.strictEqual(missing.status, 404);
});

test('a column width saved while a turn is in flight survives the turn landing', async (t) => {
  // The turn's operations are replayed on the stored table, which by then has
  // the new width; writing back its snapshot would have erased it.
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let entered;
  const inFlight = new Promise((r) => {
    entered = r;
  });
  const held = (context) => {
    if (context.messages.some((m) => m.role === 'toolResult')) return '改好了。';
    entered();
    return gate.then(() => ({ tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 1 }] } }));
  };
  const { base, dataDir } = await startServer(t, { replies: [ACTION, [held, held]], chatConfirmEdits: false });
  const id = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const slow = post(base, `/api/sessions/${id}/turn`, { message: '把甲的金额改成 1' });
  await inFlight;
  const w = await post(base, `/api/sessions/${id}/column-width`, {
    sheet: '明细',
    index: 0,
    header: '客户名称',
    width: 40,
  });
  assert.strictEqual(w.status, 200);
  release();
  assert.strictEqual((await slow).json.applied, true);

  const sheet = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8')).spec.sheets[0];
  assert.strictEqual(sheet.columns[0].width, 40, 'the width survived');
  assert.strictEqual(sheet.rows[0][1], 1, 'and the turn landed');
});
