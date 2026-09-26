'use strict';
/**
 * The session routes over REAL HTTP, with the model faked.
 *
 * Why this exists next to the unit tests
 * --------------------------------------
 * `session-store.test.js` calls the store directly. It cannot see the layer
 * where the async conversion actually broke things: the ROUTES. When
 * `store.load()` went from returning a session to returning a Promise, every
 * `state.sessions.load(...)` in `lib/server.js` had to gain an `await`. A
 * missing `await` there does not throw — it hands `undefined` (or a Promise) to
 * code that then reads `.spec` off it, and the failure shows up as a 500 on one
 * route, or as a session that silently never persists. Unit tests on the store
 * pass the whole time.
 *
 * So this drives the real `createServer`, over a real socket, and asserts on
 * HTTP status and response bodies. Only `llm.chat` is replaced (the `transport`
 * seam on `createServer`), so the decision logic — intent, the guard, the
 * confirmation flow — runs for real.
 *
 * No third party is contacted and no key is needed: the settings are overridden.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../lib/server');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-http-'));

/** A settings stub that reports "configured" and returns a fixed record. */
function fakeSettings() {
  const record = {
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-not-a-real-key',
    model: 'stub-model',
    useForAttachments: false,
    chatCanEdit: true,
    chatConfirmEdits: false, // apply immediately, so one round trip lands a spec
  };
  return {
    load: () => record,
    save: (patch) => ({ ...record, ...patch }),
    secrets: () => ({ baseUrl: record.baseUrl, apiKey: record.apiKey, model: record.model }),
    isConfigured: () => true,
    publicSettings: () => ({
      baseUrl: record.baseUrl, model: record.model, hasKey: true, keyHint: 'sk-…key',
      useForAttachments: false, chatCanEdit: true, chatConfirmEdits: false,
    }),
  };
}

/**
 * A transport that returns a full workbook spec for any turn.
 *
 * The agent calls this instead of the network. Returning a spec (not prose) is
 * what makes the turn an APPLIED change, which is the path that writes to the
 * store — the path a missing `await` breaks.
 */
function specTransport() {
  let n = 0;
  return async () => {
    n += 1;
    return JSON.stringify({
      intent: 'action',
      reply: `已生成第 ${n} 版`,
      spec: {
        title: `表-${n}`,
        sheets: [{
          name: 'Sheet1',
          columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'number' }],
          rows: [['甲', 100], ['乙', 200]],
        }],
      },
    });
  };
}

async function main() {
  console.log('session routes over real HTTP (faked model)');

  const dataDir = tmpdir();
  const server = createServer({
    dataDir,
    settingsOverride: fakeSettings(),
    transport: specTransport(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const req = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON (xlsx) */ }
    return { status: res.status, json, text, res };
  };

  try {
    // ---- create ----
    const created = await req('POST', '/api/sessions', { title: '并发测试' });
    check('POST /api/sessions -> 200 with an id', created.status === 200 && created.json.session.id,
      `status=${created.status} body=${created.text.slice(0, 120)}`);
    const id = created.json.session.id;

    // A create that was not awaited would leave no file behind.
    const list1 = await req('GET', '/api/sessions');
    check('GET /api/sessions sees the new session (create awaited)', list1.json.sessions.length === 1,
      `sessions=${JSON.stringify(list1.json.sessions)}`);

    // ---- turn: applies a spec ----
    const turn = await req('POST', `/api/sessions/${id}/turn`, { message: '来一张销售表' });
    check('POST turn -> 200', turn.status === 200, `status=${turn.status} body=${turn.text.slice(0, 200)}`);
    check('turn applied a spec (not pending)', turn.json && turn.json.applied === true,
      `json=${JSON.stringify(turn.json && { applied: turn.json.applied, pending: turn.json.pending, error: turn.json.error })}`);
    check('turn returned a preview of the sheet', Boolean(turn.json && turn.json.preview),
      'preview missing — the spec did not reach the writer');
    check('turn recorded the user message', turn.json.messages.some((m) => m.role === 'user' && m.content === '来一张销售表'));

    // ---- the load-after-save path: this is what an un-awaited save breaks ----
    const got = await req('GET', `/api/sessions/${id}`);
    check('GET session -> spec persisted (save awaited)', got.status === 200 && got.json.session.spec,
      `status=${got.status} spec=${JSON.stringify(got.json.session.spec)}`);
    check('the persisted spec has the rows from the turn',
      got.json.session.spec && got.json.session.spec.sheets[0].rows.length === 2,
      `rows=${JSON.stringify(got.json.session.spec && got.json.session.spec.sheets[0].rows)}`);
    check('a user-given title is not overwritten by the spec title', got.json.session.title === '并发测试',
      `title=${got.json.session.title}`);

    // ---- download: derived from the spec, so it depends on the load ----
    const dl = await req('GET', `/api/sessions/${id}/workbook.xlsx`);
    check('GET workbook.xlsx -> 200 xlsx bytes', dl.status === 200 && dl.res.headers.get('content-type').includes('spreadsheetml'),
      `status=${dl.status} type=${dl.res.headers.get('content-type')}`);
    check('the download has a non-trivial body', dl.text.length > 500, `bytes=${dl.text.length}`);

    // ---- concurrent turns on one session: the lost-update path over HTTP ----
    const bursts = await Promise.all(
      Array.from({ length: 12 }, (_, i) => req('POST', `/api/sessions/${id}/turn`, { message: `并发第 ${i} 次` })),
    );
    check('12 concurrent turns all returned 200', bursts.every((b) => b.status === 200),
      `statuses=${bursts.map((b) => b.status).join(',')}`);

    const after = await req('GET', `/api/sessions/${id}`);
    // 1 original user + 1 assistant, then 12 turns x (user + assistant) = 26.
    check('no turn was lost to interleaving (26 messages)', after.json.session.messages.length === 26,
      `messages=${after.json.session.messages.length} (expected 26)`);

    // ---- concurrent creates ----
    const many = await Promise.all(
      Array.from({ length: 10 }, (_, i) => req('POST', '/api/sessions', { title: `批量-${i}` })),
    );
    const ids = many.map((m) => m.json.session.id);
    check('10 concurrent creates gave 10 distinct ids', new Set(ids).size === 10,
      `ids=${ids.join(',')}`);
    check('10 concurrent creates all returned 200', many.every((m) => m.status === 200));

    const list2 = await req('GET', '/api/sessions');
    check('GET sessions sees all 11 sessions (1 + 10 creates)', list2.json.sessions.length === 11,
      `count=${list2.json.sessions.length}`);

    // ---- delete ----
    const del = await req('DELETE', `/api/sessions/${id}`);
    check('DELETE session -> ok', del.status === 200 && del.json.ok === true, `status=${del.status}`);
    const gone = await req('GET', `/api/sessions/${id}`);
    check('a deleted session 404s', gone.status === 404, `status=${gone.status}`);
    const delAgain = await req('DELETE', `/api/sessions/${id}`);
    check('deleting twice reports 404, not a crash', delAgain.status === 404, `status=${delAgain.status}`);

    // ---- a non-existent session ----
    const missing = await req('GET', '/api/sessions/nope-0001');
    check('an unknown session 404s rather than 500s', missing.status === 404, `status=${missing.status}`);

    // ---- a session created with NO title takes its name from the first change ----
    const untitled = await req('POST', '/api/sessions', { title: '' });
    const uid = untitled.json.session.id;
    await req('POST', `/api/sessions/${uid}/turn`, { message: '帮我建一张表' });
    const titled = await req('GET', `/api/sessions/${uid}`);
    check('an untitled session is named by its first change',
      Boolean(titled.json.session.title) && titled.json.session.title.startsWith('表-'),
      `title=${JSON.stringify(titled.json.session.title)}`);
  } finally {
    server.close();
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
