'use strict';
/**
 * Tests for the agent turn.
 *
 * All DETERMINISTIC — no model, no network. That is the point of the module's
 * structure: the parts that decide whether a change is allowed are ordinary
 * code, and ordinary code can be pinned down exactly. The model is only asked
 * what the text means.
 *
 * What this file guards:
 *   - a question can never produce a spec
 *   - an action that lost rows without being asked to is refused
 *   - an unparseable reply cannot change anything
 *   - history is not presented as a conversation to continue
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  runTurn,
  agentMessages,
  specSummary,
  looksLikeWork,
  guardChange,
  proseReply,
  INTENT,
} = require('../lib/agent');

const { normalizeSpec } = require('../lib/workbook');

// ── helpers ─────────────────────────────────────────────────────────

/** A settings object that claims to be configured. */
function fakeSettings() {
  return {
    isConfigured: () => true,
    secrets: () => ({ baseUrl: 'http://127.0.0.1/v1', apiKey: 'k', model: 'm' }),
  };
}

/**
 * A transport that answers with a canned reply.
 *
 * Stubbing `llm.chat` through the module cache does NOT work: `lib/agent.js`
 * destructures `chat` at require time, so the local binding keeps pointing at
 * the real function regardless of what the cache holds. The first version of
 * this file did that, and every async test failed with ECONNREFUSED while
 * looking exactly like a logic bug. `runTurn` takes its transport as a
 * parameter for this reason.
 */
function stubTransport(reply) {
  const fn = async () => reply;
  fn.calls = [];
  return fn;
}

/** Run one turn against a canned reply, with the transport injected. */
function turnWith(reply, args) {
  const transport = stubTransport(reply);
  return runTurn({ settings: fakeSettings(), transport, ...args })
    .then((res) => { res.transport = transport; return res; });
}

const SPEC_3_ROWS = {
  title: '销售',
  sheets: [{
    name: '明细',
    columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }],
    rows: [['甲', 100], ['乙', 200], ['丙', 300]],
  }],
};

const specWith = (rows) => normalizeSpec({
  ...SPEC_3_ROWS,
  sheets: [{ ...SPEC_3_ROWS.sheets[0], rows }],
}).spec;

// ── the cheap filter ────────────────────────────────────────────────

test('looksLikeWork: a plain question is not work', () => {
  assert.strictEqual(looksLikeWork('你能做什么'), false);
  assert.strictEqual(looksLikeWork('你是谁'), false);
});

test('looksLikeWork: a request to build is work', () => {
  assert.strictEqual(looksLikeWork('做一个销售表'), true);
  assert.strictEqual(looksLikeWork('帮我生成一个台账'), true);
  assert.strictEqual(looksLikeWork('再加一列税率'), true);
});

test('looksLikeWork: a question ABOUT the table is still a question', () => {
  // The trap this exists for: both markers are present, and it must not be read
  // as an instruction.
  assert.strictEqual(looksLikeWork('这个表怎么加一行？'), false);
  assert.strictEqual(looksLikeWork('表格里的金额为什么算错了？'), false);
  assert.strictEqual(looksLikeWork('你能做表格吗'), false);
});

test('looksLikeWork: empty and whitespace are not work', () => {
  assert.strictEqual(looksLikeWork(''), false);
  assert.strictEqual(looksLikeWork('   '), false);
  assert.strictEqual(looksLikeWork(null), false);
});

// ── the guard ───────────────────────────────────────────────────────

test('guardChange: a fresh start with no current spec is allowed', () => {
  const v = guardChange({ current: null, next: specWith(SPEC_3_ROWS.sheets[0].rows), message: '做一个销售表' });
  assert.strictEqual(v.ok, true);
});

test('guardChange: adding a row is allowed', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = specWith([...SPEC_3_ROWS.sheets[0].rows, ['丁', 400]]);
  assert.strictEqual(guardChange({ current, next, message: '再加一行' }).ok, true);
});

test('guardChange: silently dropping rows is refused', () => {
  // The failure this exists for: "把第一行金额改成500" answered by a tidy
  // one-row sheet. The reply would describe the edit and say nothing about the
  // two rows that vanished.
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = specWith([['甲', 500]]);
  const v = guardChange({ current, next, message: '把第一行金额改成500' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.lostRows, 2);
  assert.match(v.reason, /少 2 行/);
});

test('guardChange: losing rows IS allowed when the user asked', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = specWith([['甲', 100]]);
  const v = guardChange({ current, next, message: '把后面两行删掉' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.lostRows, 2);
});

test('guardChange: a small edit in a big table is judged by proportion', () => {
  // Small edits must not trip the guard, or every legitimate change gets a
  // confirmation prompt and the check becomes noise the user clicks through.
  const big = (n) => ({
    title: 'T',
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'currency' }],
      rows: Array.from({ length: n }, (_, i) => [`客户${i}`, i * 100]),
    }],
  });
  const current = normalizeSpec(big(100)).spec;

  // Lost 2 of 100 — under the threshold, ordinary editing.
  assert.strictEqual(
    guardChange({ current, next: normalizeSpec(big(98)).spec, message: '把第一行改一下' }).ok,
    true,
  );

  // Lost 50 of 100 — not editing, and not asked for.
  const carved = guardChange({ current, next: normalizeSpec(big(50)).spec, message: '把第一行改一下' });
  assert.strictEqual(carved.ok, false);
  assert.strictEqual(carved.lostRows, 50);

  // The same loss, but asked for this time.
  assert.strictEqual(
    guardChange({ current, next: normalizeSpec(big(50)).spec, message: '删掉一半的行' }).ok,
    true,
  );
});

test('guardChange: an empty workbook is refused', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = normalizeSpec({ title: 'T', sheets: [] }).spec;
  assert.strictEqual(guardChange({ current, next, message: '改成空表' }).ok, false);
});

// ── the turn: answers never carry a spec ─────────────────────────────

test('runTurn: an answer carries no spec, even if the model attached one', async () => {
  // The whole safety property in one test. A model that answers a question and
  // attaches a workbook anyway must not have it applied — the intent field is
  // what was checked, and it said answer.
  const res = await turnWith(JSON.stringify({
    intent: 'answer',
    reply: '我可以帮你做表格，也能改。',
    spec: SPEC_3_ROWS,
  }), { message: '你能做什么' });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null, 'an answer must never carry a spec');
});

test('runTurn: a question carries no spec', async () => {
  const res = await turnWith(JSON.stringify({ intent: 'question', reply: '要改成多少？' }), {
    message: '金额改高点',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.spec, null);
});

test('runTurn: an unlabelled reply is treated as an answer', async () => {
  const res = await turnWith(JSON.stringify({ reply: '好的' }), {
    message: '再加一列',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null);
});

test('runTurn: prose cannot change anything', async () => {
  // Providers do not always honour json_object. A prose reply has no parsed
  // object behind it, so it has no spec — whatever it claims to have done.
  const res = await turnWith('好的，已把金额改成40万了。', {
    message: '把金额改成40万',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null);
  assert.ok(res.reply.includes('40万'), 'the prose is passed through');
  // `proseReply` computed this flag and nothing read it — the warning NOTES.md
  // promised had never been wired up. A reply that reads as done while nothing
  // changed is exactly the case the flag exists for.
  assert.match(res.reply, /没有形成可执行的修改/, 'a false completion claim is flagged in the reply');
});

test('runTurn: an honest prose reply gets no false-alarm warning', async () => {
  const res = await turnWith('我是一个 Excel 助手，可以帮你做表。', { message: '你能做什么' });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.ok(!/没有形成可执行的修改/.test(res.reply), res.reply);
});

test('proseReply: detects a claim of a change that did not happen', () => {
  assert.strictEqual(proseReply('已把金额改成40万').claimed, true);
  assert.strictEqual(proseReply('表格已经创建好了').claimed, true);
  assert.strictEqual(proseReply('我可以帮你改表格').claimed, false);
});

// ── the turn: actions produce a normalised spec ──────────────────────

test('runTurn: a valid action returns a normalised spec', async () => {
  const res = await turnWith(JSON.stringify({
    intent: 'action',
    reply: '已经建好了。',
    spec: {
      title: '销售明细',
      sheets: [{
        name: '一月',
        columns: [{ header: '客户' }, { header: '金额', type: 'money' }],
        rows: [['甲', '125万']],
      }],
    },
  }), { message: '做一个销售表，客户甲，金额一百二十五万' });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.ok(res.spec);
  // Normalisation ran: the alias `money` became `currency`, and 一百二十五万
  // became a number rather than text.
  assert.strictEqual(res.spec.sheets[0].columns[1].type, 'currency');
  assert.deepStrictEqual(res.spec.sheets[0].rows[0], ['甲', 1250000]);
});

test('runTurn: an action with no spec becomes a question', async () => {
  const res = await turnWith(JSON.stringify({ intent: 'action', reply: '好的' }), {
    message: '做一个表',
  });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.spec, null);
  assert.match(res.reply, /没有给出新的表格内容/);
});

test('runTurn: an action that loses rows unasked becomes a question', async () => {
  const res = await turnWith(JSON.stringify({
    intent: 'action',
    reply: '已把第一行的金额改成 500。',
    spec: {
      title: '销售',
      sheets: [{
        name: '明细',
        columns: [{ header: '客户' }, { header: '金额', type: 'currency' }],
        rows: [['甲', 500]],
      }],
    },
  }), {
    message: '把第一行的金额改成 500',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.spec, null, 'the destructive spec must not be applied');
  assert.strictEqual(res.guarded, true);
  assert.strictEqual(res.lostRows, 2);
  assert.match(res.reply, /为免误删/);
});

test('runTurn: a row-dropping action passes when the user asked for it', async () => {
  const res = await turnWith(JSON.stringify({
    intent: 'action',
    reply: '删掉了。',
    spec: {
      title: '销售',
      sheets: [{
        name: '明细',
        columns: [{ header: '客户' }, { header: '金额', type: 'currency' }],
        rows: [['甲', 100]],
      }],
    },
  }), {
    message: '删掉后面两行',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.ok(res.spec);
  assert.strictEqual(res.spec.sheets[0].rows.length, 1);
});

test('runTurn: notes from normalisation are passed through', async () => {
  const res = await turnWith(JSON.stringify({
    intent: 'action',
    reply: '好了。',
    spec: {
      title: 'T',
      sheets: [{ name: 'S', columns: [{ header: '客户' }], rows: [['甲', 1, 2]] }],
    },
  }), { message: '做一个表' });
  assert.ok(Array.isArray(res.notes));
  assert.ok(res.notes.some((n) => /不一致/.test(n.message)), JSON.stringify(res.notes));
});

test('runTurn: throws when there is no model configured', async () => {
  await assert.rejects(
    () => runTurn({
      settings: { isConfigured: () => false, secrets: () => ({}) },
      message: '做一个表',
    }),
    /尚未配置模型/,
  );
});

test('runTurn: the model is never asked to describe a template', async () => {
  // A regression guard on the refactor itself: the old chat layer's prompt named
  // 模板/字段/operations. If any of that survives in the new prompt the model
  // will answer in the old grammar and emit operations nothing consumes.
  const res = await turnWith(JSON.stringify({ intent: 'answer', reply: 'ok' }), { message: '你好' });
  const sent = res.transport.calls;
  // The transport was called with the message list; re-derive it to inspect.
  const messages = agentMessages({ message: '你好' });
  const sys = messages[0].content;
  assert.strictEqual(/operations/.test(sys), false, 'no operations grammar in the prompt');
  assert.match(sys, /spec/);
  void sent;
});

// ── messages and history ─────────────────────────────────────────────

test('agentMessages: history is reference material, not a conversation', () => {
  // The measured failure this prevents: replayed as alternating turns, one prior
  // question was enough to make 0/5 following commands classify as answers.
  const messages = agentMessages({
    message: '再加一列税率',
    history: [
      { role: 'user', content: '你能做什么' },
      { role: 'assistant', content: '我可以帮你做表格。' },
      { role: 'user', content: '能改吗' },
      { role: 'assistant', content: '可以。' },
    ],
  });
  assert.strictEqual(messages.length, 2, 'one system + one user message, never a replay');
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[1].role, 'user');
  assert.match(messages[1].content, /【之前的对话（仅供参考，不是本轮指令）】/);
  assert.match(messages[1].content, /【本轮用户输入】/);
  assert.ok(messages[1].content.trimEnd().endsWith('再加一列税率'));
});

test('agentMessages: no history means no preamble', () => {
  const messages = agentMessages({ message: '做一个表', history: [] });
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[1].content, '做一个表');
});

test('agentMessages: the current spec is summarised into the system message', () => {
  const messages = agentMessages({ message: '加一列', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  const sys = messages[0].content;
  assert.match(sys, /当前工作簿：销售/);
  assert.match(sys, /客户:text/);
  assert.match(sys, /\["甲",100\]/);
});

test('agentMessages: rows beyond the budget are announced, not hidden', () => {
  // A model that does not know it is seeing a subset will "restore" the rows it
  // believes are missing. Saying so is the whole fix.
  const many = {
    title: 'T',
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }],
      rows: Array.from({ length: 30 }, (_, i) => [`客户${i}`]),
    }],
  };
  const messages = agentMessages({ message: 'x', spec: normalizeSpec(many).spec, rowBudget: 10 });
  assert.match(messages[0].content, /还有 20 行没有列出来/);
});

test('specSummary: an empty spec has nothing to say', () => {
  assert.strictEqual(specSummary(null), '');
  assert.strictEqual(specSummary({ sheets: [] }), '');
});

test('specSummary: dates are rendered, not serialised as numbers', () => {
  const { spec } = normalizeSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: '日期', type: 'date' }], rows: [['2026-03-01']] }],
  });
  const text = specSummary(spec);
  assert.match(text, /2026-03-01/);
  assert.strictEqual(/\d{5}/.test(text), false, 'no raw serial numbers in the summary');
});
