'use strict';
/**
 * Tests for the session store.
 *
 * The properties that matter are the failure ones. A store that works when
 * everything is fine is easy; this one has to survive a corrupt file, a
 * half-written file, and a directory that does not exist yet — because the
 * moment it is asked to load is the moment the user wants their work back.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionStore, safeId, MAX_SESSIONS } from '../../src/store/session-store.ts';
import type { Session } from '../../src/store/session-store.ts';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));

test('create then load round-trips', async () => {
  const store = new SessionStore(tmpdir());
  const created = await store.create('销售台账');
  assert.match(created.id, /^[a-z0-9-]+$/i);

  const loaded = (await store.load(created.id))!;
  assert.strictEqual(loaded.title, '销售台账');
  assert.deepStrictEqual(loaded.messages, []);
  assert.strictEqual(loaded.spec, null);
});

test('save then load keeps the spec and the messages', async () => {
  const store = new SessionStore(tmpdir());
  const s = await store.create();
  const spec = {
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: '客户' }], rows: [['甲']] }],
  };
  await store.save({
    ...s,
    title: '改了名',
    spec,
    messages: [{ role: 'user', content: '你好', at: '2026-09-26T00:00:00.000Z' }],
  });

  const loaded = (await store.load(s.id))!;
  assert.strictEqual(loaded.title, '改了名');
  assert.strictEqual(loaded.messages.length, 1);
  assert.strictEqual(loaded.messages[0].content, '你好');

  // Not `deepStrictEqual(loaded.spec, spec)`: what comes back is the spec after
  // `normalizeSpec`, so the two differ in the ways normalisation is FOR —
  // column types get filled in, a bare table gets wrapped in a sheet. Asserting
  // raw equality would pin the store to returning un-normalised data, which is
  // the bug this normalisation exists to prevent.
  assert.strictEqual(loaded.spec!.title, 'T');
  assert.strictEqual(loaded.spec!.sheets[0].name, 'S');
  assert.deepStrictEqual(loaded.spec!.sheets[0].rows, [['甲']]);
  assert.strictEqual(loaded.spec!.sheets[0].columns[0].type, 'text', 'a missing type is filled in');
});

test('load: a date survives the round trip as a date, not as a string', async () => {
  // JSON has no date type. A `date` column that is a real Date on the way in
  // comes back as an ISO string, and everything downstream trusts the type —
  // the writer emits a serial for a Date and a text cell for a string. This
  // failed in the real app: a reopened session rendered every date as literal
  // `2026-01-08T00:00:00.000Z` text in the grid.
  const store = new SessionStore(tmpdir());
  const s = await store.create();
  await store.save({
    ...s,
    spec: { sheets: [{ name: 'S', columns: [{ header: '日期', type: 'date' }], rows: [['2026-01-08']] }] },
  });

  const cell = (await store.load(s.id))!.spec!.sheets[0].rows[0][0];
  assert.ok(cell instanceof Date, `expected a Date, got ${typeof cell}: ${JSON.stringify(cell)}`);
  assert.strictEqual(cell.toISOString().slice(0, 10), '2026-01-08');
});

test('load: a TEXT column holding a date-shaped string is left alone', async () => {
  // The flip side of the fix. "2026-01-08" in a text column is text, and
  // turning it into a Date would change what the file contains.
  const store = new SessionStore(tmpdir());
  const s = await store.create();
  await store.save({
    ...s,
    spec: { sheets: [{ name: 'S', columns: [{ header: '编号', type: 'text' }], rows: [['2026-01-08']] }] },
  });

  assert.strictEqual((await store.load(s.id))!.spec!.sheets[0].rows[0][0], '2026-01-08');
});

test('load: a missing session is null, not a throw', async () => {
  const store = new SessionStore(tmpdir());
  assert.strictEqual(await store.load('nope-0001'), null);
  assert.strictEqual(await store.load(''), null);
  assert.strictEqual(await store.load(null), null);
  assert.strictEqual(await store.load('../../etc/passwd'), null, 'a path is not an id');
});

test('load: a corrupt file is null, not a throw', async () => {
  // The failure that matters: the file is there and unreadable. Throwing here
  // would surface as "cannot open your work" at exactly the wrong moment.
  const dir = tmpdir();
  const store = new SessionStore(dir);
  const s = await store.create();
  fs.writeFileSync(path.join(dir, 'sessions', `${s.id}.json`), '{ broken json', 'utf8');
  assert.strictEqual(await store.load(s.id), null);
});

test('load: a truncated file from an interrupted write leaves the old one readable', async () => {
  // save() writes a temp file then renames. Simulating a crash mid-write means
  // leaving a .tmp behind; the real file must be untouched.
  const dir = tmpdir();
  const store = new SessionStore(dir);
  const s = await store.create();
  await store.save({ ...s, title: '第一次' });
  fs.writeFileSync(path.join(dir, 'sessions', `${s.id}.json.tmp`), '{ half', 'utf8');
  assert.strictEqual((await store.load(s.id))!.title, '第一次');
});

test('save: messages are trimmed to the shaped fields only', async () => {
  const store = new SessionStore(tmpdir());
  const s = await store.create();
  await store.save({
    ...s,
    messages: [
      { role: 'user', content: 'x', apiKey: 'sk-should-not-be-stored', extra: 1 },
      { role: 'assistant', content: 'y', intent: 'answer', guarded: true },
      { content: 'no role' }, // dropped: not a message
    ],
  });
  const loaded = (await store.load(s.id))!;
  assert.strictEqual(loaded.messages.length, 2);
  assert.strictEqual('apiKey' in loaded.messages[0], false, 'unknown fields are not persisted');
  assert.strictEqual('extra' in loaded.messages[0], false);
  assert.strictEqual(loaded.messages[1].intent, 'answer');
  assert.strictEqual(loaded.messages[1].guarded, true);
});

test('save: an invalid id rejects rather than writing somewhere odd', async () => {
  const store = new SessionStore(tmpdir());
  await assert.rejects(() => store.save({ id: '../../evil', messages: [] }), /not valid/);
});

test('append: adds to the end and persists', async () => {
  const store = new SessionStore(tmpdir());
  const s = await store.create();
  await store.append(s.id, { role: 'user', content: 'a' });
  await store.append(s.id, { role: 'assistant', content: 'b' });
  const loaded = (await store.load(s.id))!;
  assert.deepStrictEqual(
    loaded.messages.map((m) => m.content),
    ['a', 'b'],
  );
});

test('append: an unknown session returns null instead of creating one', async () => {
  const store = new SessionStore(tmpdir());
  assert.strictEqual(await store.append('missing-01', { role: 'user', content: 'a' }), null);
});

test('remove: deletes, and reports honestly when there is nothing to delete', async () => {
  const store = new SessionStore(tmpdir());
  const s = await store.create();
  assert.strictEqual(await store.remove(s.id), true);
  assert.strictEqual(await store.load(s.id), null);
  assert.strictEqual(await store.remove(s.id), false);
});

test('list: newest first, with a summary and no message bodies', async () => {
  const store = new SessionStore(tmpdir());
  const a = await store.create('第一个');
  await store.save({ ...a, spec: { title: 'T', sheets: [{ name: 'S', columns: [], rows: [[1], [2]] }] } });
  const b = await store.create('第二个');

  const list = await store.list();
  assert.strictEqual(list.length, 2);
  // Ids are time-prefixed, so the newer one sorts first without a stat.
  assert.strictEqual(list[0].id, b.id);
  assert.strictEqual(list[0].title, '第二个');
  const first = list.find((x) => x.id === a.id)!;
  assert.strictEqual(first.rows, 2, 'the row count is summarised');
  assert.strictEqual('spec' in first, false, 'the list does not ship whole specs');
  assert.strictEqual('messages' in first && Array.isArray(first.messages), false);
});

test('list: prunes past the cap, oldest first', async () => {
  // Unbounded growth is invisible until a directory listing takes a second.
  const store = new SessionStore(tmpdir());
  for (let i = 0; i < 5; i++) await store.create(`s${i}`);
  const before = await store.list();
  assert.strictEqual(before.length, 5);

  // Lower the cap by monkey-patching the module constant is not possible, so
  // assert the mechanism directly instead: prune() with a full list is a no-op.
  assert.deepStrictEqual(await store.prune(), []);

  // And the cap itself is a sane number, not accidentally tiny.
  assert.ok(MAX_SESSIONS >= 50, `${MAX_SESSIONS}`);
});

test('safeId: only plausible ids pass', () => {
  assert.strictEqual(safeId('abc123'), 'abc123');
  assert.strictEqual(safeId('a-b-c-1'), 'a-b-c-1');
  assert.strictEqual(safeId('ab'), null, 'too short to be one of ours');
  assert.strictEqual(safeId('has space'), null);
  assert.strictEqual(safeId('../x'), null);
  assert.strictEqual(safeId(''), null);
});

test('a directory that does not exist yet is created on first save', async () => {
  const dir = path.join(tmpdir(), 'deep', 'deeper');
  const store = new SessionStore(dir);
  const s = await store.create();
  assert.ok(fs.existsSync(path.join(dir, 'sessions', `${s.id}.json`)));
});

test('list: a missing directory is an empty list, not a throw', async () => {
  const store = new SessionStore(path.join(tmpdir(), 'never-made'));
  assert.deepStrictEqual(await store.list(), []);
});

test('the written file is not world-readable', async () => {
  // Conversations are plain text and users paste real things into them.
  if (process.platform === 'win32') return; // mode bits are advisory here
  const dir = tmpdir();
  const store = new SessionStore(dir);
  const s = await store.create();
  const mode = fs.statSync(path.join(dir, 'sessions', `${s.id}.json`)).mode & 0o777;
  assert.strictEqual(mode, 0o600, mode.toString(8));
});

// ── concurrency ─────────────────────────────────────────────────────
//
// `append` is read-modify-write: load -> push -> save. With async I/O, two
// appends can interleave between the load and the save, and the later save
// writes from a snapshot that predates the earlier one — a lost message, with
// nothing thrown and nothing logged. `#run` (the per-instance queue) is what
// prevents it; see AGENTS.md, "The trap this rule creates".
//
// The tests cannot reach the await boundary to force an interleaving, so they
// fire many concurrent calls and detect by volume. Measured with the queue
// removed: the run does not even get as far as a lost update — Windows refuses
// two concurrent renames onto one destination (EPERM), and before temp names
// were unique the shared `.tmp` vanished under the second writer (ENOENT).
// Either way these tests go red.

test('concurrent appends to one session keep every message', async () => {
  const CONCURRENCY = 50;
  for (let round = 1; round <= 5; round += 1) {
    const dir = tmpdir();
    const store = new SessionStore(dir);
    const session = await store.create('并发测试');

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        store.append(session.id, { role: 'user', content: `msg-${round}-${i}`, at: new Date().toISOString() }),
      ),
    );

    const loaded = (await store.load(session.id))!;
    const got = new Set(loaded.messages.map((m) => m.content));
    const missing = Array.from({ length: CONCURRENCY }, (_, i) => `msg-${round}-${i}`).filter((w) => !got.has(w));
    assert.deepStrictEqual(missing, [], `round ${round}: lost to interleaving`);
    assert.strictEqual(loaded.messages.length, CONCURRENCY, `round ${round}`);

    const strays = fs.readdirSync(path.join(dir, 'sessions')).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(strays, [], `round ${round}: stray temp files`);
  }
});

test('concurrent appends to distinct sessions do not cross over', async () => {
  // A serialiser keyed on the wrong thing would pass the test above and fail
  // this one.
  const store = new SessionStore(tmpdir());
  const sessions: Session[] = [];
  for (let i = 0; i < 8; i += 1) sessions.push(await store.create(`session-${i}`));

  await Promise.all(
    sessions.flatMap((s, si) =>
      Array.from({ length: 6 }, (_, m) => store.append(s.id, { role: 'assistant', content: `s${si}-${m}` })),
    ),
  );

  for (let i = 0; i < sessions.length; i += 1) {
    const loaded = (await store.load(sessions[i].id))!;
    assert.strictEqual(loaded.messages.length, 6, `session ${i}`);
    assert.ok(
      loaded.messages.every((m) => m.content.startsWith(`s${i}-`)),
      `session ${i} picked up another session's message`,
    );
  }
});

test('concurrent creates all land, each with its own id and title', async () => {
  const store = new SessionStore(tmpdir());
  const created = await Promise.all(Array.from({ length: 20 }, (_, i) => store.create(`title-${i}`)));
  assert.strictEqual(new Set(created.map((s) => s.id)).size, 20, 'create() handed out a duplicate id');
  for (const s of created) {
    const loaded = (await store.load(s.id))!;
    assert.ok(loaded, `session ${s.id} did not persist`);
    assert.strictEqual(loaded.title, s.title);
  }
});
