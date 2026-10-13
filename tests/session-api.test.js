'use strict';
/**
 * The session API, over real HTTP.
 *
 * Real sockets rather than a function-level test, because the bugs this layer
 * has produced before were all at the boundary: a route that answered 500 on a
 * shape it did not expect, a static guard that 404'd everything, a JSON body
 * that arrived as something slightly different from what the handler assumed.
 *
 * The model is pi-ai's faux provider, scripted step by step, so the DECISIONS
 * are the real ones — the agent loop, the tools, `guardChange`, the replay in
 * the store — and only the provider is fake.
 */

const test = require('node:test');
const assert = require('node:assert');
const { listenLocal } = require('./listen');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../lib/server');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sess-api-'));

// pi-ai is ESM-only, so it is reached with import() even from this CommonJS
// file. One faux provider per file; each server start replaces its script.
let pi = null;
async function loadFaux() {
  if (!pi) {
    const ai = await import('@mariozechner/pi-ai');
    pi = { ai, faux: ai.registerFauxProvider() };
  }
  return pi;
}

/**
 * One scripted model response. A string is a final text answer; an object
 * `{ tool, args }` (or an array of them) is a response that calls tools; a
 * function is called with the context and returns either of those, possibly
 * after a delay — that is how a test holds a turn in flight.
 */
async function step(ai, s, context) {
  if (typeof s === 'function') s = await s(context);
  if (typeof s === 'string') return ai.fauxAssistantMessage(s);
  const calls = Array.isArray(s) ? s : [s];
  return ai.fauxAssistantMessage(calls.map((c) => ai.fauxToolCall(c.tool, c.args)), { stopReason: 'toolUse' });
}

/** What the model was shown on the FIRST call of a turn: system prompt and user message. */
const promptOf = (context) => [context.systemPrompt, ...context.messages.map((m) => (typeof m.content === 'string' ? m.content : ''))].join('\n');

/**
 * Start a server whose model is scripted.
 *
 * `replies` is a list of turns, each a list of steps (see `step`), consumed in
 * order across the whole server. Running out makes the faux provider answer
 * with an error, which is what a dead provider looks like from here.
 * `seen` collects the prompt of each turn's first call.
 */
async function startServer(t, { configured = true, replies = [], chatCanEdit = true, chatConfirmEdits = true, seen = null, extra = {}, fetchOptions } = {}) {
  const dataDir = tmpdir();
  const { ai, faux } = await loadFaux();
  faux.setResponses(replies.flat().map((s) => async (context) => {
    if (seen && context.messages.length === 1) seen.push(promptOf(context));
    return step(ai, s, context);
  }));

  const server = createServer({
    dataDir,
    staticDir: path.join(__dirname, '..', 'public'),
    // The model override the server accepts for exactly this purpose.
    model: faux.getModel(),
    settingsOverride: settingsStub({ configured, chatCanEdit, chatConfirmEdits, extra }),
    fetchOptions,
  });

  return new Promise((resolve) => {
    listenLocal(server).then(() => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ base, dataDir });
    });
  });
}

function settingsStub({ configured = true, chatCanEdit = true, chatConfirmEdits = true, extra = {} } = {}) {
  return {
    isConfigured: () => configured,
    load: () => ({ chatCanEdit, chatConfirmEdits, useForAttachments: true, ...extra }),
    publicSettings: () => ({ model: 'stub', hasKey: configured }),
    secrets: () => ({ api: 'openai-completions', baseUrl: 'http://stub/v1', apiKey: 'k', model: 'stub' }),
    save: () => ({}),
  };
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

const ACTION = [{ tool: 'create_workbook', args: SPEC }, '建好了。'];
const ANSWER = ['我能帮你做表格。'];

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

test('read-only mode offers no edit tools, so nothing can change', async (t) => {
  // The model tries anyway: the tool does not exist in this turn, the call is
  // refused, and its "建好了" is flagged as a claim with nothing behind it.
  const { base } = await startServer(t, { replies: [ACTION], chatCanEdit: false });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const turn = await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual(turn.json.ok, true);
  assert.strictEqual(turn.json.applied, false);
  assert.strictEqual(turn.json.pending, false, 'no proposal is offered when editing is off');
  assert.match(turn.json.reply, /没有形成可执行的修改/);
  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.session.spec, null);
});

test('the guard refusal is reported, not swallowed', async (t) => {
  // Session already holds two rows; the model proposes one. The reply must say
  // the change did not happen, and the stored spec must be untouched.
  const destructive = [
    { tool: 'delete_rows', args: { rows: [2] } },
    { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 500 }] } },
    '已改好。',
  ];
  const { base } = await startServer(t, { replies: [ACTION, destructive], chatConfirmEdits: false });
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
  // No scripted reply means the faux provider answers with an error, which is
  // what a dead provider looks like from here.
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
  const { ai, faux } = await loadFaux();
  faux.setResponses(ACTION.map((s) => (context) => step(ai, s, context)));
  const opts = {
    dataDir,
    staticDir: path.join(__dirname, '..', 'public'),
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

// ── concurrent turns: replayed, not overwritten ──────────────────────

/**
 * Two turns on one session, the first held inside its model call until the
 * second has landed. `route` answers by the turn's own message, so the order
 * the faux provider is called in does not matter.
 */
function concurrentScript({ held, heldCall, other, otherCall }) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inFlight = new Promise((r) => { entered = r; });
  const route = (context) => {
    const user = context.messages[0].content;
    const after = context.messages.some((m) => m.role === 'toolResult');
    if (user.endsWith(held)) {
      if (after) return '改好了。';
      entered();
      return gate.then(() => heldCall);
    }
    if (user.endsWith(other)) return after ? '好了。' : otherCall;
    throw new Error(`unscripted turn: ${user.slice(-40)}`);
  };
  return { steps: [route, route, route, route], release: () => release(), inFlight };
}

test('two concurrent turns both land: the slower one is replayed on the newer table', async (t) => {
  // The failure this prevents: the slow turn writing back the spec it computed
  // from its snapshot, erasing the column the fast turn added meanwhile.
  const script = concurrentScript({
    held: '把甲的金额改成 1',
    heldCall: { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 1 }] } },
    other: '加一列备注',
    otherCall: { tool: 'add_columns', args: { columns: [{ header: '备注', type: 'text' }] } },
  });
  const { base, dataDir } = await startServer(t, { replies: [ACTION, script.steps], chatConfirmEdits: false });
  const id = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const slow = post(base, `/api/sessions/${id}/turn`, { message: '把甲的金额改成 1' });
  await script.inFlight;
  const fast = await post(base, `/api/sessions/${id}/turn`, { message: '加一列备注' });
  assert.strictEqual(fast.json.applied, true);
  script.release();
  const done = await slow;
  assert.strictEqual(done.json.applied, true);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
  const sheet = stored.spec.sheets[0];
  assert.deepStrictEqual(sheet.columns.map((c) => c.header), ['客户名称', '金额', '备注'], 'the fast turn\'s column survived');
  assert.strictEqual(sheet.rows[0][1], 1, 'the slow turn\'s edit landed too');
  assert.strictEqual(stored.changes.length, 3);
  assert.strictEqual(stored.messages.length, 6, 'every message of every turn is on disk');
});

test('a concurrent turn whose rows moved away is not applied to the wrong row', async (t) => {
  const script = concurrentScript({
    held: '把第2行金额改成 1',
    heldCall: { tool: 'update_cells', args: { cells: [{ row: 2, column: '金额', value: 1 }] } },
    other: '删掉第2行',
    otherCall: { tool: 'delete_rows', args: { rows: [2] } },
  });
  const { base, dataDir } = await startServer(t, { replies: [ACTION, script.steps], chatConfirmEdits: false });
  const id = (await post(base, '/api/sessions', {})).json.session.id;
  await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });

  const slow = post(base, `/api/sessions/${id}/turn`, { message: '把第2行金额改成 1' });
  await script.inFlight;
  assert.strictEqual((await post(base, `/api/sessions/${id}/turn`, { message: '删掉第2行' })).json.applied, true);
  script.release();
  const done = await slow;
  assert.strictEqual(done.json.applied, false);
  assert.match(done.json.reply, /表格在这期间被改动过/);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
  assert.deepStrictEqual(stored.spec.sheets[0].rows, [['甲', 1000000]], 'the remaining row was not touched');
  assert.strictEqual(stored.changes.length, 2, 'the refused edit is not logged as a change');
});

// ── saving, downloading in other formats, fetching ──────────────────

const saveSettings = (dir) => ({ chatCanSave: true, exportDir: dir });

test('a turn that edits and saves writes the LANDED table and says where', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: saveSettings(exportDir),
    replies: [[{ tool: 'create_workbook', args: SPEC }, { tool: 'save_file', args: { format: 'csv' } }, '建好并保存了。']],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: '做个销售台账并保存成 csv' });
  assert.strictEqual(r.json.applied, true);
  assert.deepStrictEqual(r.json.saved.map((p) => path.basename(p)), ['销售台账.csv']);
  const csv = fs.readFileSync(path.join(exportDir, '销售台账.csv'), 'utf8');
  assert.match(csv, /^﻿客户名称,金额\r\n甲,1000000\r\n/);
  assert.match(r.json.reply, /已保存：.*销售台账\.csv/);
  // The outcome is part of the stored transcript, not just this response.
  const again = await get(base, `/api/sessions/${session.id}`);
  const last = again.json.session.messages[again.json.session.messages.length - 1];
  assert.match(last.content, /已保存：/);
});

test('saving twice never overwrites', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const save = [{ tool: 'save_file', args: { format: 'json' } }, '好了'];
  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: saveSettings(exportDir),
    replies: [ACTION, save, save],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表' });
  await post(base, `/api/sessions/${session.id}/turn`, { message: '保存成 json' });
  await post(base, `/api/sessions/${session.id}/turn`, { message: '再保存一次' });
  assert.deepStrictEqual(fs.readdirSync(exportDir).sort(), ['销售台账 (1).json', '销售台账.json']);
});

test('a held change is saved only once it is applied', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const { base } = await startServer(t, {
    chatConfirmEdits: true,
    extra: saveSettings(exportDir),
    replies: [[{ tool: 'create_workbook', args: SPEC }, { tool: 'save_file', args: { format: 'xlsx', filename: '台账' } }, '好了']],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: '做表并保存' });
  assert.strictEqual(r.json.pending, true);
  assert.deepStrictEqual(r.json.saved, []);
  assert.match(r.json.reply, /确认修改后会保存文件/);
  assert.deepStrictEqual(fs.readdirSync(exportDir), []);

  const applied = await post(base, `/api/sessions/${session.id}/apply`, { accept: true });
  assert.strictEqual(applied.json.applied, true);
  assert.deepStrictEqual(applied.json.saved.map((p) => path.basename(p)), ['台账.xlsx']);
  assert.strictEqual(fs.readFileSync(path.join(exportDir, '台账.xlsx')).subarray(0, 2).toString(), 'PK');
});

test('a rejected held change saves nothing', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const { base } = await startServer(t, {
    chatConfirmEdits: true,
    extra: saveSettings(exportDir),
    replies: [[{ tool: 'create_workbook', args: SPEC }, { tool: 'save_file', args: { format: 'csv' } }, '好了']],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表并保存' });
  await post(base, `/api/sessions/${session.id}/apply`, { accept: false });
  assert.deepStrictEqual(fs.readdirSync(exportDir), []);
});

test('with saving switched off the tool is not offered and nothing is written', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const seen = [];
  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: { chatCanSave: false, exportDir },
    seen,
    replies: [ACTION],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表并保存' });
  assert.doesNotMatch(seen[0], /save_file/);
  assert.deepStrictEqual(fs.readdirSync(exportDir), []);
});

test('the workbook downloads as CSV and JSON too', async (t) => {
  const { base } = await startServer(t, { chatConfirmEdits: false, replies: [ACTION] });
  const { json: { session } } = await post(base, '/api/sessions', {});
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

test('a turn can fetch a CSV and import it as the table', async (t) => {
  const http = require('node:http');
  const src = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    res.setHeader('content-type', 'text/csv');
    res.end('城市,人口\n杭州,1200\n宁波,950\n');
  });
  await new Promise((r) => listenLocal(src).then(r));
  t.after(() => new Promise((r) => src.close(r)));
  const url = `http://127.0.0.1:${src.address().port}/c.csv`;

  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: { chatCanFetch: true, fetchBlocklist: [] },
    fetchOptions: { allowPrivate: true },
    replies: [[{ tool: 'fetch_url', args: { url, importAs: '城市' } }, '导入了。']],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: `把 ${url} 导入` });
  assert.strictEqual(r.json.applied, true);
  const stored = await get(base, `/api/sessions/${session.id}`);
  assert.deepStrictEqual(stored.json.session.spec.sheets[0].rows, [['杭州', 1200], ['宁波', 950]]);
});

test('the server blocklist reaches the fetch tool', async (t) => {
  const seenResults = [];
  const { base } = await startServer(t, {
    extra: { chatCanFetch: true, fetchBlocklist: ['blocked.example'] },
    replies: [[
      { tool: 'fetch_url', args: { url: 'https://www.blocked.example/a.csv' } },
      (context) => {
        seenResults.push(...context.messages.filter((m) => m.role === 'toolResult'));
        return '被禁止了。';
      },
    ]],
  });
  const { json: { session } } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '抓 https://www.blocked.example/a.csv' });
  assert.strictEqual(seenResults.length, 1);
  assert.strictEqual(seenResults[0].isError, true);
  assert.match(seenResults[0].content[0].text, /禁止抓取/);
});

// ── preview paging ──────────────────────────────────────────────────

/** SPEC with `n` data rows, numbered so a row's position can be checked. */
const bigSpec = (n) => ({
  ...SPEC,
  sheets: [{ ...SPEC.sheets[0], rows: Array.from({ length: n }, (_, i) => [`客户${i + 1}`, (i + 1) * 100]) }],
});

test('the preview comes in a first window, and the rest pages in by key', async (t) => {
  const { base } = await startServer(t, { replies: [[{ tool: 'create_workbook', args: bigSpec(300) }, '好']], chatConfirmEdits: false });
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
  assert.deepStrictEqual(rows.slice(1).map((r) => r[0]), Array.from({ length: 300 }, (_, i) => `客户${i + 1}`));

  // The same key is what reloading the session hands out.
  const back = await get(base, `/api/sessions/${id}`);
  assert.strictEqual(back.json.preview.key, first.key);
});

test('a page request is capped, and a changed table answers stale', async (t) => {
  const { base } = await startServer(t, { replies: [[{ tool: 'create_workbook', args: bigSpec(800) }, '好']], chatConfirmEdits: false });
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
  const { base } = await startServer(t, { replies: [[{ tool: 'create_workbook', args: bigSpec(120) }, '好']], chatConfirmEdits: true });
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

  const r = await post(base, `/api/sessions/${id}/column-width`, { sheet: '明细', index: 1, header: '金额', width: 31.5 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.notStrictEqual(r.json.key, turn.json.preview.key, 'the file changed, so the key did');
  assert.ok(r.json.cols.some((c) => c.min <= 2 && 2 <= c.max && c.width === 31.5), JSON.stringify(r.json.cols));

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
    { sheet: '明细', index: 0, header: '金额', width: 20 },   // header is elsewhere now
    { sheet: '明细', index: 5, header: '金额', width: 20 },
    { sheet: '没有', index: 1, header: '金额', width: 20 },
    { sheet: '明细', index: 1, header: '金额', width: 'wide' },
  ]) {
    const r = await post(base, `/api/sessions/${id}/column-width`, body);
    assert.strictEqual(r.status, 409, JSON.stringify(body));
    assert.strictEqual(r.json.ok, false);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the session file was not touched');

  const missing = await post(base, '/api/sessions/nope/column-width', { sheet: '明细', index: 1, header: '金额', width: 20 });
  assert.strictEqual(missing.status, 404);
});

test('a column width saved while a turn is in flight survives the turn landing', async (t) => {
  // The turn's operations are replayed on the stored table, which by then has
  // the new width; writing back its snapshot would have erased it.
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inFlight = new Promise((r) => { entered = r; });
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
  const w = await post(base, `/api/sessions/${id}/column-width`, { sheet: '明细', index: 0, header: '客户名称', width: 40 });
  assert.strictEqual(w.status, 200);
  release();
  assert.strictEqual((await slow).json.applied, true);

  const sheet = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8')).spec.sheets[0];
  assert.strictEqual(sheet.columns[0].width, 40, 'the width survived');
  assert.strictEqual(sheet.rows[0][1], 1, 'and the turn landed');
});
