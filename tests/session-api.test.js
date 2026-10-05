'use strict';
/**
 * The session API, over real HTTP.
 *
 * Real sockets rather than a function-level test, because the bugs this layer
 * has produced before were all at the boundary: a route that answered 500 on a
 * shape it did not expect, a static guard that 404'd everything, a JSON body
 * that arrived as something slightly different from what the handler assumed.
 *
 * The model is stubbed at the transport, so the DECISIONS are the real ones —
 * `runTurn`, `guardChange`, `normalizeSpec` all run — and only the network call
 * is fake.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../lib/server');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sess-api-'));

/**
 * Start a server whose model transport is scripted.
 *
 * `replies` is a queue: the first turn gets the first reply, and so on. Running
 * out means the test asked for more turns than it scripted, which is a test bug
 * and should be loud.
 */
function startServer(t, { configured = true, replies = [], chatCanEdit = true, chatConfirmEdits = true, seen = null } = {}) {
  const dataDir = tmpdir();
  const queue = [...replies];

  const server = createServer({
    dataDir,
    staticDir: path.join(__dirname, '..', 'public'),
    // The transport override the server accepts for exactly this purpose.
    transport: async (args) => {
      if (seen) seen.push(args.messages.map((m) => m.content).join('\n'));
      if (!queue.length) throw new Error('test ran out of scripted replies');
      return queue.shift();
    },
    settingsOverride: {
      isConfigured: () => configured,
      load: () => ({ chatCanEdit, chatConfirmEdits, useForAttachments: true }),
      publicSettings: () => ({ model: 'stub', hasKey: configured }),
      secrets: () => ({ baseUrl: 'http://stub/v1', apiKey: 'k', model: 'stub' }),
      save: () => ({}),
    },
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ base, dataDir });
    });
  });
}

const post = (base, p, body) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const get = (base, p) => fetch(base + p).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const SPEC = {
  title: '销售台账',
  sheets: [{
    name: '明细',
    columns: [
      { header: '客户名称', type: 'text' },
      { header: '金额', type: 'currency' },
    ],
    rows: [['甲', 1000000], ['乙', 860000]],
  }],
};

const ACTION = JSON.stringify({ intent: 'action', reply: '建好了。', spec: SPEC });
const ANSWER = JSON.stringify({ intent: 'answer', reply: '我能帮你做表格。' });

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

test('an unknown session is 404, not a crash', async (t) => {
  const { base } = await startServer(t);
  assert.strictEqual((await get(base, '/api/sessions/none-0000')).status, 404);
  assert.strictEqual((await post(base, '/api/sessions/none-0000/turn', { message: 'hi' })).status, 404);
});

// ── turns ───────────────────────────────────────────────────────────

test('an answer turn leaves the spec null and does not persist one', async (t) => {
  const { base } = await startServer(t, { replies: [ANSWER] });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '你能做什么' });
  assert.strictEqual(turn.status, 200);
  assert.strictEqual(turn.json.intent, 'answer');
  assert.strictEqual(turn.json.applied, false);
  assert.strictEqual(turn.json.pending, false);
  assert.strictEqual(turn.json.proposed, null);

  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec, null, 'an answer must not create a spec');
  assert.strictEqual(back.json.preview, null);
  assert.strictEqual(back.json.session.messages.length, 2, 'both sides of the turn are recorded');
});

test('an action turn with confirmation ON holds the change', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION], chatConfirmEdits: true });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual(turn.json.intent, 'action');
  assert.strictEqual(turn.json.applied, false);
  assert.strictEqual(turn.json.pending, true);
  assert.ok(turn.json.proposed, 'the proposal is shown before it exists');
  assert.strictEqual(turn.json.proposed.rows, 2);
  // And the grid it would produce is sent, with formats.
  assert.strictEqual(turn.json.proposed.preview.rows[0][0], '客户名称');
  assert.strictEqual(turn.json.proposed.preview.formats[1][1].includes('¥'), true);

  const still = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(still.json.session.spec, null, 'not applied until confirmed');
});

test('applying a held change makes it the document', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION], chatConfirmEdits: true });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const applied = await post(base, `/api/sessions/${id}/apply`, {});
  assert.strictEqual(applied.status, 200);
  assert.strictEqual(applied.json.applied, true);
  assert.strictEqual(applied.json.session.spec.title, '销售台账');
  assert.ok(applied.json.preview);
  assert.strictEqual(applied.json.preview.rows[1][0], '甲');

  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec.title, '销售台账');
  assert.ok(back.json.preview, 'a stored spec yields a preview on load');
});

test('rejecting a held change discards it and keeps the old document', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION], chatConfirmEdits: true });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const rejected = await post(base, `/api/sessions/${id}/apply`, { accept: false });
  assert.strictEqual(rejected.json.applied, false);
  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec, null);

  // And there is nothing left to apply.
  const again = await post(base, `/api/sessions/${id}/apply`, {});
  assert.strictEqual(again.status, 409);
});

test('applying with nothing pending is 409, not a silent success', async (t) => {
  const { base } = await startServer(t);
  const { json: created } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${created.session.id}/apply`, {});
  assert.strictEqual(r.status, 409);
});

test('an action turn with confirmation OFF applies immediately', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION], chatConfirmEdits: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual(turn.json.applied, true);
  assert.strictEqual(turn.json.pending, false);
  assert.ok(turn.json.preview);
  assert.strictEqual(turn.json.preview.rows.length, 3, 'header + two data rows');

  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec.title, '销售台账');
});

test('read-only mode downgrades a change instead of showing one', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION], chatCanEdit: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual(turn.json.ok, true);
  assert.strictEqual(turn.json.applied, false);
  assert.strictEqual(turn.json.pending, false, 'no proposal is offered when editing is off');
  assert.match(turn.json.reply, /允许修改.*已关闭/);
  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec, null);
});

test('the guard refusal is reported, not swallowed', async (t) => {
  // Session already holds two rows; the model proposes one. The reply must say
  // the change did not happen, and the stored spec must be untouched.
  const first = JSON.stringify({ intent: 'action', reply: '建好了。', spec: SPEC });
  const destructive = JSON.stringify({
    intent: 'action',
    reply: '已改好。',
    spec: { title: '销售台账', sheets: [{ name: '明细', columns: SPEC.sheets[0].columns, rows: [['甲', 500]] }] },
  });
  const { base } = await startServer(t, { replies: [first, destructive], chatConfirmEdits: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '把甲的金额改成 500' });
  assert.strictEqual(turn.json.intent, 'question', 'a refused change is not an action');
  assert.strictEqual(turn.json.guarded, true);
  assert.strictEqual(turn.json.lostRows, 1);
  assert.match(turn.json.reply, /为免误删/);
  assert.strictEqual(turn.json.applied, false);

  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec.sheets[0].rows.length, 2, 'the document is intact');
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

test('no workbook before there is a spec', async (t) => {
  const { base } = await startServer(t);
  const { json: created } = await post(base, '/api/sessions', {});
  const r = await fetch(`${base}/api/sessions/${created.session.id}/workbook.xlsx`);
  assert.strictEqual(r.status, 404);
});

// ── the failure paths ───────────────────────────────────────────────

test('an empty message is refused', async (t) => {
  const { base } = await startServer(t);
  const { json: created } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${created.session.id}/turn`, { message: '   ' });
  assert.strictEqual(r.status, 400);
});

test('with no model configured, a turn says so instead of failing oddly', async (t) => {
  const { base } = await startServer(t, { configured: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${created.session.id}/turn`, { message: '做一个表' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /尚未配置模型/);
});

test('a provider failure keeps the transcript usable for a retry', async (t) => {
  // No scripted reply means the transport throws, which is what a dead provider
  // looks like from here.
  const { base } = await startServer(t, { replies: [] });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const r = await post(base, `/api/sessions/${id}/turn`, { message: '做一个表' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, false);
  assert.ok(r.json.error);

  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.messages.length, 0, 'a failed turn is not recorded');
  assert.strictEqual(back.json.session.spec, null);
});

// ── persistence ─────────────────────────────────────────────────────

test('a session survives a server restart', async (t) => {
  // The point of storing sessions at all: "昨天那单改成 40 万" needs yesterday.
  const dataDir = tmpdir();
  const opts = {
    dataDir,
    staticDir: path.join(__dirname, '..', 'public'),
    transport: async () => ACTION,
    settingsOverride: {
      isConfigured: () => true,
      load: () => ({ chatCanEdit: true, chatConfirmEdits: false }),
      publicSettings: () => ({ model: 'stub' }),
      secrets: () => ({ baseUrl: 'http://stub/v1', apiKey: 'k', model: 'stub' }),
      save: () => ({}),
    },
  };

  const first = createServer(opts);
  await new Promise((done) => first.listen(0, '127.0.0.1', done));
  const base1 = `http://127.0.0.1:${first.address().port}`;
  const { json: created } = await post(base1, '/api/sessions', {});
  const id = created.session.id;
  await post(base1, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  await new Promise((done) => first.close(done));

  const second = createServer({ ...opts, transport: async () => ANSWER });
  await new Promise((done) => second.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => second.close(done)));
  const base2 = `http://127.0.0.1:${second.address().port}`;

  const back = await get(base2, `/api/sessions/${id}`);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.session.spec.title, '销售台账');
  assert.strictEqual(back.json.session.messages.length, 2);
  assert.ok(back.json.preview, 'the preview is rebuilt from the stored spec');
});

// ── attachments ─────────────────────────────────────────────────────

/** Upload one file the way the browser's paperclip does. */
async function upload(base, filename, text) {
  const fd = new FormData();
  fd.append('files', new Blob([text], { type: 'text/csv' }), filename);
  const res = await fetch(`${base}/api/attachments`, { method: 'POST', body: fd });
  return res.json();
}

test('attachment content reaches the model but is not stored as what the user said', async (t) => {
  // It used to be folded into the message by the client, so the server saved
  // it: the block showed in the chat bubble, was saved again on every turn the
  // file stayed attached, and was replayed in history after that.
  const seen = [];
  const { base } = await startServer(t, { replies: [ANSWER, ANSWER], seen });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  const up = await upload(base, '客户.csv', '客户名称,金额\n北京甲公司,100\n');
  assert.strictEqual(up.ok, true);

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '照着这个做表' });
  assert.strictEqual(turn.status, 200);
  assert.match(seen[0], /--- 附件资料 ---/);
  assert.match(seen[0], /【附件：客户\.csv】/);
  assert.match(seen[0], /北京甲公司/);

  const user = turn.json.messages[0];
  assert.strictEqual(user.content, '照着这个做表', 'the stored message is what was typed');
  assert.deepStrictEqual(user.attachments, ['客户.csv']);

  // Next turn, file still attached: the model sees it again in full, and the
  // history line carries the name only, not a second copy of the content.
  await post(base, `/api/sessions/${id}/turn`, { message: '再加一列' });
  assert.strictEqual(seen[1].split('北京甲公司').length - 1, 1, 'content appears once, from this turn');
  assert.match(seen[1], /用户：照着这个做表（附件：客户\.csv）/);

  const back = await get(base, `/api/sessions/${id}`);
  assert.ok(back.json.session.messages.every((m) => !/附件资料/.test(m.content)));
});

test('a turn with no attachments sends the message unchanged and records no names', async (t) => {
  const seen = [];
  const { base } = await startServer(t, { replies: [ANSWER], seen });
  const { json: created } = await post(base, '/api/sessions', {});
  const turn = await post(base, `/api/sessions/${created.session.id}/turn`, { message: '你好' });
  assert.doesNotMatch(seen[0], /附件/);
  assert.strictEqual(turn.json.messages[0].attachments, undefined);
});

// ── change log ──────────────────────────────────────────────────────

test('an applied change is logged and shown to the model on later turns', async (t) => {
  const seen = [];
  const { base, dataDir } = await startServer(t, { replies: [ACTION, ANSWER], chatConfirmEdits: false, seen });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  assert.doesNotMatch(seen[0], /已做过的修改/, 'nothing has changed before the first turn');

  await post(base, `/api/sessions/${id}/turn`, { message: '刚才做了什么' });
  assert.match(seen[1], /已做过的修改（共 1 次/);
  assert.match(seen[1], /用户：「做一个销售台账」 → 新建工作簿「销售台账」/);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
  assert.strictEqual(stored.changes.length, 1);
  assert.strictEqual(stored.changes[0].request, '做一个销售台账');
});

test('a held change is logged when applied, and not when rejected', async (t) => {
  const { base, dataDir } = await startServer(t, { replies: [ACTION, ACTION], chatConfirmEdits: true });
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));

  const a = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${a}/turn`, { message: '做一个销售台账' });
  assert.deepStrictEqual(read(a).changes, [], 'a proposal is not a change');
  await post(base, `/api/sessions/${a}/apply`, {});
  assert.strictEqual(read(a).changes.length, 1);
  assert.strictEqual(read(a).changes[0].request, '做一个销售台账');

  const b = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${b}/turn`, { message: '做一个销售台账' });
  await post(base, `/api/sessions/${b}/apply`, { accept: false });
  assert.deepStrictEqual(read(b).changes, []);
});

test('read-only mode logs no change', async (t) => {
  const { base, dataDir } = await startServer(t, { replies: [ACTION], chatCanEdit: false });
  const id = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
  assert.deepStrictEqual(stored.changes, []);
});
