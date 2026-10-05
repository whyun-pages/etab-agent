'use strict';
/**
 * Live end-to-end test for the AGENT layer, against the user's REAL provider.
 *
 * Every other agent test stubs the transport. That verifies our own decisions —
 * a question cannot carry a spec, an unasked row loss is refused — but it says
 * nothing about whether a real model obeys the spec grammar, and nothing about
 * whether the guard fires on a real reply. The previous round of this project
 * produced three real bugs that only appeared against the live provider, so this
 * runs the real thing.
 *
 * ===
 * This sends real content to a third party and spends real quota. Not part of
 * the normal test run.
 * ===
 *
 * The key is never printed and never written to a file. Only a masked hint.
 *
 * Usage:
 *   node .verify/live-agent.js              # full run
 *   node .verify/live-agent.js --only=build # one case
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.verify', 'out');

const LIVE_DATA = path.join(process.env.APPDATA || '', 'ETabAgent');
const DATA = fs.existsSync(path.join(LIVE_DATA, 'settings.json')) ? LIVE_DATA : path.join(OUT, 'live-agent-data');

const { Settings } = require(path.join(ROOT, 'lib', 'settings'));
const { runTurn, INTENT } = require(path.join(ROOT, 'lib', 'agent'));
const { writeSpec, specStats } = require(path.join(ROOT, 'lib', 'workbook'));

const ONLY = (() => {
  const a = process.argv.find((s) => s.startsWith('--only='));
  return a ? a.split('=')[1] : null;
})();

let pass = 0, fail = 0;
const notes = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

/** Never let key material into the output, whatever the provider echoes back. */
function scrub(s) {
  const str = String(s == null ? '' : s);
  return str.replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***').replace(/\b[\w-]{40,}\b/g, '<long-token>');
}

const settings = new Settings(DATA);

/** One turn, with a hard timeout so a stuck request cannot hang the run. */
async function turn(message, spec, history = [], timeoutMs = 180000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await runTurn({ settings, message, spec, history, signal: ctl.signal });
    return { ...res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function describe(res) {
  const bits = [`intent=${res.intent}`, `${res.ms}ms`];
  if (res.spec) {
    const st = specStats(res.spec);
    bits.push(`spec=${st.sheets}表/${st.rows}行/${st.columns}列`);
  } else {
    bits.push('spec=null');
  }
  if (res.guarded) bits.push(`GUARDED(-${res.lostRows}行)`);
  if (res.notes && res.notes.length) bits.push(`notes=${res.notes.length}`);
  return bits.join(' ');
}

async function caseAnswer() {
  console.log('\n--- A) a question must not produce a spec ---');
  for (const q of ['你能做什么？', '你好', '这个表格是怎么算出来的？']) {
    const res = await turn(q);
    console.log(`  "${q}" -> ${describe(res)}`);
    console.log(`     reply: ${scrub(res.reply).slice(0, 120)}`);
    check(`"${q}" is not an action`, res.intent !== INTENT.ACTION, describe(res));
    check(`"${q}" carries no spec`, res.spec === null, describe(res));
  }
}

async function caseBuild() {
  console.log('\n--- B) build a table from prose ---');
  const message = '做一个销售台账，三个客户：杭州云图科技有限公司、上海临港数据服务、深圳前海智算中心，'
    + '金额分别是125万、86万、88万，签约日期分别是2026年1月8日、1月22日、2月3日，'
    + '再加一列税率，百分之六、百分之六、百分之十三。';
  const res = await turn(message);
  console.log(`  -> ${describe(res)}`);
  console.log(`     reply: ${scrub(res.reply).slice(0, 160)}`);
  if (res.spec) {
    for (const s of res.spec.sheets) {
      console.log(`     sheet "${s.name}": ${(s.columns || []).map((c) => `${c.header}:${c.type}`).join('、')}`);
      for (const r of (s.rows || []).slice(0, 5)) console.log('       ' + JSON.stringify(r));
    }
  }
  check('an action was declared', res.intent === INTENT.ACTION, describe(res));
  check('a spec came back', Boolean(res.spec), describe(res));
  if (!res.spec) return null;

  const sheet = res.spec.sheets[0];
  const headers = (sheet.columns || []).map((c) => c.header);
  console.log('     headers: ' + JSON.stringify(headers));
  const flat = JSON.stringify(sheet.rows);
  check('the customers are present', /云图/.test(flat), scrub(flat).slice(0, 160));
  check('three rows', (sheet.rows || []).length === 3, `${(sheet.rows || []).length} rows`);
  check('the amounts are numbers, not "125万"', /1250000/.test(flat), scrub(flat).slice(0, 200));
  check('a date column exists', headers.some((h) => /日期|签约/.test(h)), JSON.stringify(headers));
  check('no column header is a latin placeholder',
    !headers.every((h) => /^[a-z]+$/i.test(String(h))), JSON.stringify(headers));

  // And it must actually become a file.
  try {
    const buffer = writeSpec(res.spec);
    const isZip = buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    check('the spec writes to real xlsx bytes', isZip, `${buffer.length} bytes`);
    fs.writeFileSync(path.join(OUT, 'live-agent-build.xlsx'), buffer);
    console.log(`     wrote .verify/out/live-agent-build.xlsx (${buffer.length} bytes)`);
  } catch (err) {
    check('the spec writes to real xlsx bytes', false, scrub(err && err.message));
  }
  return res.spec;
}

async function caseEdit(spec) {
  console.log('\n--- C) an edit must keep the rows it was not asked about ---');
  if (!spec) { console.log('  (skipped: no spec from case B)'); return spec; }
  const before = specStats(spec).rows;

  const res = await turn('把杭州云图那行的金额改成 150 万', spec);
  console.log(`  -> ${describe(res)}`);
  console.log(`     reply: ${scrub(res.reply).slice(0, 160)}`);
  check('an action was declared', res.intent === INTENT.ACTION, describe(res));
  check('a spec came back', Boolean(res.spec), describe(res));
  if (!res.spec) return spec;

  const after = specStats(res.spec).rows;
  const flat = JSON.stringify(res.spec.sheets[0].rows);
  console.log(`     rows ${before} -> ${after}`);
  for (const r of res.spec.sheets[0].rows) console.log('       ' + JSON.stringify(r));

  check('no rows were lost (the guard did not have to fire)', after >= before, `${before} -> ${after}`);
  check('the edited amount arrived', /1500000/.test(flat), scrub(flat).slice(0, 200));
  check('the other customers survived', /临港/.test(flat) && /前海/.test(flat), scrub(flat).slice(0, 240));
  return res.spec;
}

async function caseDestructive(spec) {
  console.log('\n--- D) a reply that silently drops rows must be refused ---');
  // Not asking the model to misbehave. This asks for something vague — the kind
  // of request that tempts a model to "tidy up" — and checks that whatever it
  // produces, the guard either lets a safe result through or names the loss.
  if (!spec) { console.log('  (skipped: no spec)'); return; }
  const before = specStats(spec).rows;

  const res = await turn('把这个表整理一下吧', spec);
  console.log(`  -> ${describe(res)}`);
  console.log(`     reply: ${scrub(res.reply).slice(0, 200)}`);
  if (res.spec) {
    const after = specStats(res.spec).rows;
    console.log(`     rows ${before} -> ${after}`);
    check('either the rows survived, or the loss was announced',
      after >= before || /为免误删|少 \d+ 行/.test(res.reply),
      `${before} -> ${after}`);
  } else {
    check('no spec, and the reply explains why', Boolean(res.reply), scrub(res.reply).slice(0, 160));
  }
}

async function caseHistory() {
  console.log('\n--- E) history must not turn a command into a question ---');
  // The measured failure on the old chat layer: with prior questions replayed as
  // conversation, 0/5 commands were recognised. This is the same check on the
  // agent layer.
  const spec = { title: '销售', sheets: [{ name: '明细', columns: [{ header: '客户' }, { header: '金额', type: 'currency' }], rows: [['甲', 100], ['乙', 200], ['丙', 300]] }] };
  const history = [];
  for (let i = 0; i < 4; i++) {
    const res = await turn(`第 ${i + 1} 个问题：你能做什么？`, null, history.slice());
    history.push({ role: 'user', content: `第 ${i + 1} 个问题：你能做什么？` });
    history.push({ role: 'assistant', content: res.reply, intent: res.intent });
  }
  console.log(`  asked ${history.length / 2} questions first`);

  const res = await turn('把甲的金额改成 500', spec, history);
  console.log(`  then a command -> ${describe(res)}`);
  console.log(`     reply: ${scrub(res.reply).slice(0, 160)}`);
  check('the command is still recognised as an action', res.intent === INTENT.ACTION, describe(res));
  check('and it produced a spec', Boolean(res.spec), describe(res));
  if (res.spec) {
    const flat = JSON.stringify(res.spec.sheets[0].rows);
    check('the change landed', /500/.test(flat), scrub(flat));
    check('the rows survived', /200/.test(flat) && /300/.test(flat), scrub(flat));
  }
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  if (!settings.isConfigured()) {
    console.error(`no usable model configured in ${DATA}`);
    process.exit(2);
  }
  const pub = settings.publicSettings();
  console.log('=== live agent test ===');
  console.log(`data dir : ${DATA}`);
  console.log(`model    : ${pub.model}  key: ${pub.apiKeyMask || '(masked)'}  baseUrl: ${pub.baseUrl}`);
  console.log('(real requests; the key is never printed and never written)');

  const t0 = Date.now();
  try {
    if (!ONLY || ONLY === 'answer') await caseAnswer();
    if (!ONLY || ONLY === 'build') {
      const spec = await caseBuild();
      if (!ONLY) {
        const edited = await caseEdit(spec);
        await caseDestructive(edited || spec);
      }
    }
    if (!ONLY || ONLY === 'history') await caseHistory();
  } catch (err) {
    check('the run completed without throwing', false, scrub(err && err.message));
    if (err && err.stack) notes.push(scrub(err.stack).split('\n').slice(0, 3).join(' | '));
  }

  console.log('');
  console.log(`LIVE AGENT: ${pass} passed, ${fail} failed   (${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const n of notes) console.log('  note: ' + n);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('FAILED:', scrub(err && err.stack || err)); process.exit(2); });
