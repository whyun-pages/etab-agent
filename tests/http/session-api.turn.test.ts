'use strict';
/**
 * The session API over real HTTP: a turn, from the message to what is stored.
 *
 * Held and applied changes, the guard, failures that must leave the transcript
 * usable, attachments reaching the model, the change log, and concurrent
 * turns on one session — which must replay, not overwrite.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../src/store/settings.ts';

import { conversation, startServer, settingsStub, post, get, ACTION, ANSWER } from '../helpers/session-server.ts';

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

test('a turn returns its tool trace only when asked', async (t) => {
  const { base } = await startServer(t, { replies: [ACTION, ACTION] });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const plain = await post(base, `/api/sessions/${id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual(plain.json.trace, undefined);

  const traced = await post(base, `/api/sessions/${id}/turn`, { message: '再做一遍', trace: true });
  assert.ok(Array.isArray(traced.json.trace));
  assert.ok(
    traced.json.trace.some((l) => l.startsWith('call create_workbook ')),
    traced.json.trace.join('\n'),
  );
  assert.ok(traced.json.trace.some((l) => l.startsWith('result create_workbook: ')));
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

test('a turn decides with the settings it read at the start, even if they change', async (t) => {
  // The route read settings once for the tools offered, then again for
  // "confirm edits": switching confirmation off while the model ran made one
  // turn obey two different settings. The first read is the turn's.
  const stub = settingsStub({ chatConfirmEdits: true });
  let reads = 0;
  // Spread, the stub is a plain object again; the seam takes the class.
  const settings = {
    ...stub,
    load: () => ({ ...stub.load(), chatConfirmEdits: reads++ === 0 }),
  } as unknown as Settings;
  const { base } = await startServer(t, { replies: [ACTION], settings });
  const { json: created } = await post(base, '/api/sessions', {});
  const turn = await post(base, `/api/sessions/${created.session.id}/turn`, { message: '做一个销售台账' });
  assert.strictEqual(turn.json.pending, true, 'confirmation was on when the turn began');
  assert.strictEqual(turn.json.applied, false);
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

// ── attachments ─────────────────────────────────────────────────────

/** Upload one file to a session the way the browser's paperclip does. */
async function upload(base: string, id: string, filename: string, text: string): Promise<any> {
  const fd = new FormData();
  fd.append('files', new Blob([text], { type: 'text/csv' }), filename);
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/attachments`, { method: 'POST', body: fd });
  return res.json();
}

test('attachment content reaches the model but is not stored as what the user said', async (t) => {
  // It used to be folded into the message by the client, so the server saved
  // it: the block showed in the chat bubble, was saved again on every turn the
  // file stayed attached, and was replayed in history after that.
  const seen: string[] = [];
  const { base } = await startServer(t, { replies: [ANSWER, ANSWER], seen });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;
  const up = await upload(base, id, '客户.csv', '客户名称,金额\n北京甲公司,100\n');
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

test("a turn reads only its own session's attachments", async (t) => {
  const seen = [];
  const { base } = await startServer(t, { replies: [ANSWER], seen });
  const a = (await post(base, '/api/sessions', {})).json.session.id;
  const b = (await post(base, '/api/sessions', {})).json.session.id;
  await upload(base, a, '客户.csv', '客户名称,金额\n北京甲公司,100\n');

  const turn = await post(base, `/api/sessions/${b}/turn`, { message: '你好' });
  assert.strictEqual(turn.status, 200);
  assert.doesNotMatch(seen[0], /附件资料|北京甲公司/);
  assert.strictEqual(turn.json.messages[0].attachments, undefined);
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
  const gate = new Promise((r) => {
    release = r;
  });
  let entered;
  const inFlight = new Promise((r) => {
    entered = r;
  });
  const route = (context) => {
    const user = conversation(context)[0].content;
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

test('a burst of concurrent turns on one session loses no message', async (t) => {
  // The test below pins one interleaving exactly. This one goes by volume, the
  // way it was first measured: before `store.update`, 12 concurrent turns
  // left 4 of 26 messages on disk (AGENTS.md). Each turn read the session,
  // waited on the model, and wrote back a snapshot that predated the others.
  const TURNS = 12;
  const { base } = await startServer(t, { replies: Array.from({ length: TURNS }, () => ANSWER) });
  const { json: created } = await post(base, '/api/sessions', {});
  const id = created.session.id;

  const burst = await Promise.all(
    Array.from({ length: TURNS }, (_, i) => post(base, `/api/sessions/${id}/turn`, { message: `并发第 ${i} 次` })),
  );
  assert.ok(
    burst.every((b) => b.status === 200),
    burst.map((b) => b.status).join(','),
  );

  const messages = (await get(base, `/api/sessions/${id}`)).json.session.messages;
  const asked = new Set(messages.filter((m) => m.role === 'user').map((m) => m.content));
  const lost = Array.from({ length: TURNS }, (_, i) => `并发第 ${i} 次`).filter((m) => !asked.has(m));
  assert.deepStrictEqual(lost, [], 'these turns vanished');
  assert.strictEqual(messages.length, TURNS * 2, 'one user and one assistant message per turn');
});

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
  assert.deepStrictEqual(
    sheet.columns.map((c) => c.header),
    ['客户名称', '金额', '备注'],
    "the fast turn's column survived",
  );
  assert.strictEqual(sheet.rows[0][1], 1, "the slow turn's edit landed too");
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
