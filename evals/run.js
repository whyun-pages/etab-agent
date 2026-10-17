'use strict';
/**
 * Runs the eval cases under evals/cases/ against the user's REAL model.
 *
 * Each case is a classic spreadsheet task (payroll, attendance, pivot, VLOOKUP,
 * dedupe, split, ID-card parsing, aging, reconciling two files, ...) phrased
 * the way a user would say it in the chat box. The case gives the starting
 * workbook, optional "uploaded" files, one or more turns, and deterministic
 * expectations on what comes back: intent, row count, columns, cell values,
 * sort order, totals. See evals/README.md for the format.
 *
 * ===
 * This sends real content to a third party and spends real quota. Not part of
 * the normal test run.
 * ===
 *
 * Usage:
 *   node evals/run.js                     # every case
 *   node evals/run.js --only=payroll      # one case, by id (or a prefix of the file name)
 *   node evals/run.js --dry               # no model: just load, normalise and validate the givens
 *   node evals/run.js --data-dir=D:\xl    # where settings.json (the model config) lives
 *
 * Without --data-dir the config is looked up in TAB_AGENT_HOME, then the repo's
 * data/ folder, then %APPDATA%\ETabAgent — the same places the app itself uses.
 */

// Let a plain `node` run of this script require the TypeScript source.
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CASES = path.join(__dirname, 'cases');
const OUT = path.join(__dirname, 'out');

const { Settings } = require(path.join(ROOT, 'src', 'store', 'settings.ts'));
const { runTurn, INTENT } = require(path.join(ROOT, 'src', 'agent', 'agent.ts'));
const { normalizeSpec } = require(path.join(ROOT, 'src', 'workbook', 'normalize.ts'));
const { validateSpec } = require(path.join(ROOT, 'src', 'workbook', 'validate.ts'));
const { writeSpec } = require(path.join(ROOT, 'src', 'workbook', 'layout.ts'));
const { readAttachment } = require(path.join(ROOT, 'src', 'ingest', 'ingest.ts'));
const { attachmentContext } = require(path.join(ROOT, 'src', 'http', 'projections.ts'));

const argOf = (name) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const ONLY = argOf('only');
const DRY = process.argv.includes('--dry');
const TURN_TIMEOUT_MS = Number(argOf('timeout') || 180000);

function resolveDataDir() {
  const explicit = argOf('data-dir');
  if (explicit) return explicit;
  if (process.env.TAB_AGENT_HOME) return process.env.TAB_AGENT_HOME;
  const dev = path.join(ROOT, 'data');
  if (fs.existsSync(path.join(dev, 'settings.json'))) return dev;
  return path.join(process.env.APPDATA || '', 'ETabAgent');
}

/** Never let key material into the output, whatever the provider echoes back. */
function scrub(s) {
  const str = String(s == null ? '' : s);
  return str.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').replace(/\b[\w-]{40,}\b/g, '<long-token>');
}

// ------------------------------------------------------------ expectations

/** A column selector is a regex over the header; a plain string is used as one. */
function re(sel) {
  return sel instanceof RegExp ? sel : new RegExp(String(sel), 'i');
}

function pickSheet(spec, sel) {
  if (!spec || !spec.sheets || !spec.sheets.length) return null;
  if (!sel) return spec.sheets[0];
  return spec.sheets.find((s) => re(sel).test(s.name)) || null;
}

function colIndex(sheet, sel) {
  const r = re(sel);
  return sheet.columns.findIndex((c) => r.test(c.header));
}

/** What a cell is compared as: dates become YYYY-MM-DD, empty strings become null. */
function plain(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (v === '' || v === undefined) return null;
  return v;
}

function same(a, b) {
  const x = plain(a);
  const y = plain(b);
  if (x === null || y === null) return x === y;
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 1e-9;
  return String(x) === String(y);
}

function show(v) {
  const p = plain(v);
  return p === null ? '(空)' : JSON.stringify(p);
}

/**
 * Evaluate one turn's expectations. Returns [{label, ok, detail}]. Every check
 * is independent, so one failure does not hide the others.
 */
function evaluate(expect, res, spec) {
  const out = [];
  const check = (label, ok, detail) => out.push({ label, ok: Boolean(ok), detail: detail || '' });

  if (expect.intent) check(`intent=${expect.intent}`, res.intent === expect.intent, `got ${res.intent}`);
  if (expect.guarded === false) check('not guarded', !res.guarded, res.guarded ? `lost ${res.lostRows} rows` : '');
  if (expect.ops === 'none')
    check('no edit operations', !res.ops || res.ops.length === 0, `${(res.ops || []).length} ops`);
  for (const pat of expect.reply || []) {
    check(`reply matches /${pat}/`, re(pat).test(res.reply || ''), scrub(res.reply).slice(0, 160));
  }

  const needsSheet =
    expect.sheetCount != null ||
    expect.rowCount != null ||
    expect.rowCountMin != null ||
    expect.columns ||
    expect.noColumns ||
    expect.columnTypes ||
    expect.firstColumn ||
    expect.cells ||
    expect.sortedBy ||
    expect.unique ||
    expect.totals != null;
  if (!needsSheet) return out;

  if (expect.sheetCount != null) {
    const n = spec ? spec.sheets.length : 0;
    check(`${expect.sheetCount} sheets`, n === expect.sheetCount, `got ${n}`);
  }
  const sheet = pickSheet(spec, expect.sheet);
  if (!sheet) {
    check(`sheet ${expect.sheet || '#1'} exists`, false, spec ? spec.sheets.map((s) => s.name).join('、') : 'no spec');
    return out;
  }
  const headers = sheet.columns.map((c) => c.header);
  const headerList = JSON.stringify(headers);

  if (expect.rowCount != null)
    check(`${expect.rowCount} rows`, sheet.rows.length === expect.rowCount, `got ${sheet.rows.length}`);
  if (expect.rowCountMin != null) {
    check(`at least ${expect.rowCountMin} rows`, sheet.rows.length >= expect.rowCountMin, `got ${sheet.rows.length}`);
  }
  for (const sel of expect.columns || []) check(`column /${sel}/ present`, colIndex(sheet, sel) >= 0, headerList);
  for (const sel of expect.noColumns || []) check(`column /${sel}/ absent`, colIndex(sheet, sel) < 0, headerList);
  if (expect.firstColumn) {
    check(`first column is /${expect.firstColumn}/`, re(expect.firstColumn).test(headers[0] || ''), headerList);
  }
  for (const [sel, type] of Object.entries(expect.columnTypes || {})) {
    const i = colIndex(sheet, sel);
    check(
      `column /${sel}/ is ${type}`,
      i >= 0 && sheet.columns[i].type === type,
      i >= 0 ? sheet.columns[i].type : 'missing',
    );
  }
  if (expect.totals != null) {
    check(`totals ${expect.totals ? 'on' : 'off'}`, Boolean(sheet.totals && sheet.totals.enabled) === expect.totals);
  }

  for (const c of expect.cells || []) {
    const target = c.sheet ? pickSheet(spec, c.sheet) : sheet;
    const label = `[${c.row}, ${c.column}]`;
    if (!target) {
      check(label, false, `sheet ${c.sheet} missing`);
      continue;
    }
    const i = colIndex(target, c.column);
    if (i < 0) {
      check(label, false, `no column /${c.column}/ in ${JSON.stringify(target.columns.map((x) => x.header))}`);
      continue;
    }
    const row = target.rows[c.row - 1];
    if (!row) {
      check(label, false, `only ${target.rows.length} rows`);
      continue;
    }
    const v = row[i];
    if ('equals' in c) check(`${label} = ${show(c.equals)}`, same(v, c.equals), `got ${show(v)}`);
    if ('approx' in c) {
      const tol = c.tolerance == null ? 0.01 : c.tolerance;
      const n = typeof v === 'number' ? v : Number(v);
      check(`${label} ≈ ${c.approx}`, Number.isFinite(n) && Math.abs(n - c.approx) <= tol, `got ${show(v)}`);
    }
    if ('matches' in c)
      check(`${label} ~ /${c.matches}/`, re(c.matches).test(String(plain(v) ?? '')), `got ${show(v)}`);
  }

  if (expect.sortedBy) {
    const i = colIndex(sheet, expect.sortedBy.column);
    if (i < 0) check(`sorted by /${expect.sortedBy.column}/`, false, headerList);
    else {
      const vals = sheet.rows.map((r) => plain(r[i])).filter((v) => v !== null);
      const desc = expect.sortedBy.order === 'desc';
      let ok = true;
      for (let k = 1; k < vals.length; k++) {
        const a = vals[k - 1];
        const b = vals[k];
        const cmp = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh');
        if (desc ? cmp < 0 : cmp > 0) ok = false;
      }
      check(`sorted by /${expect.sortedBy.column}/ ${desc ? 'desc' : 'asc'}`, ok, JSON.stringify(vals));
    }
  }

  if (expect.unique) {
    const i = colIndex(sheet, expect.unique);
    if (i < 0) check(`unique /${expect.unique}/`, false, headerList);
    else {
      const vals = sheet.rows.map((r) => plain(r[i])).filter((v) => v !== null);
      check(`unique /${expect.unique}/`, new Set(vals.map(String)).size === vals.length, JSON.stringify(vals));
    }
  }
  return out;
}

// ------------------------------------------------------------ running

async function loadCases() {
  const names = (await fs.promises.readdir(CASES)).filter((f) => f.endsWith('.json')).sort();
  const cases = [];
  for (const name of names) {
    const raw = await fs.promises.readFile(path.join(CASES, name), 'utf8');
    const c = JSON.parse(raw);
    c.file = name;
    if (!ONLY || c.id === ONLY || name.startsWith(ONLY)) cases.push(c);
  }
  return cases;
}

/** The starting workbook of a case, through the same normalisation the app applies. */
function givenSpec(c) {
  if (!c.given) return { spec: null, problems: [] };
  const { spec, notes } = normalizeSpec(c.given, { today: c.today });
  const verdict = validateSpec(spec);
  const problems = [...notes.filter((n) => n.level === 'error').map((n) => n.message), ...(verdict.blocking || [])];
  return { spec, problems };
}

/**
 * A case's "uploaded files". Each is written as a real xlsx (from a raw spec)
 * or as raw text, then read back through the same ingest path an upload takes,
 * so the model sees exactly what it would see after a drag-and-drop.
 */
async function buildAttachments(c) {
  const out = [];
  for (const a of c.attachments || []) {
    let buffer;
    if (a.spec) {
      const { spec, notes } = normalizeSpec(a.spec, { today: c.today });
      const bad = notes.filter((n) => n.level === 'error').map((n) => n.message);
      if (bad.length) throw new Error(`attachment ${a.filename} does not normalise: ${bad.join('；')}`);
      buffer = writeSpec(spec);
    } else if (typeof a.text === 'string') {
      buffer = Buffer.from(a.text, 'utf8');
    } else {
      throw new Error(`attachment ${a.filename} needs "spec" (a workbook) or "text"`);
    }
    out.push(await readAttachment(buffer, a.filename));
  }
  return out;
}

async function turn(settings, args) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TURN_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await runTurn({ settings, signal: ctl.signal, ...args });
    return { ...res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function describe(res) {
  const bits = [`intent=${res.intent}`, `${res.ms}ms`];
  if (res.spec) bits.push(`${res.spec.sheets.length}表/${res.spec.sheets.map((s) => s.rows.length).join('+')}行`);
  else bits.push('spec=null');
  if (res.guarded) bits.push(`GUARDED(-${res.lostRows}行)`);
  if (res.ops && res.ops.length) bits.push(`ops=${res.ops.map((o) => o.op).join(',')}`);
  return bits.join(' ');
}

async function runCase(c, settings, report) {
  console.log(`\n=== ${c.file}  ${c.title}`);
  const entry = { id: c.id, file: c.file, title: c.title, turns: [], pass: 0, fail: 0 };
  report.cases.push(entry);

  const { spec: start, problems } = givenSpec(c);
  if (problems.length) {
    console.log(`  FAIL given workbook does not normalise cleanly: ${problems.join('；')}`);
    entry.fail++;
    return;
  }
  let attachments;
  try {
    attachments = await buildAttachments(c);
  } catch (err) {
    console.log(`  FAIL ${err.message}`);
    entry.fail++;
    return;
  }
  const context = attachmentContext(attachments);
  const files = attachments.map((a) => a.name);

  if (DRY) {
    console.log(
      `  ok   given: ${start ? `${start.sheets.length}表/${start.sheets.map((s) => s.rows.length).join('+')}行` : '(empty)'}`,
    );
    for (const a of attachments) {
      const t = a.table || (a.sheets && a.sheets[0]);
      console.log(`  ok   attachment ${a.name}: ${a.kind}${t ? ` ${t.header.length}列/${t.rows.length}行` : ''}`);
    }
    console.log(
      `  ok   ${c.turns.length} turn(s), ${c.turns.reduce((n, t) => n + Object.keys(t.expect || {}).length, 0)} expectation group(s)`,
    );
    entry.pass++;
    return;
  }

  let spec = start;
  const history = [];
  for (let k = 0; k < c.turns.length; k++) {
    const t = c.turns[k];
    console.log(`  turn ${k + 1}: ${t.message}`);
    let res;
    try {
      // The route appends the attachment previews (the same `attachmentContext`)
      // to the typed message and hands the parsed uploads to the turn; same here.
      res = await turn(settings, {
        message: context ? `${t.message}\n\n${context}` : t.message,
        spec,
        history,
        today: c.today,
        attachments,
      });
    } catch (err) {
      console.log(`  FAIL turn threw: ${scrub(err && err.message)}`);
      entry.fail++;
      entry.turns.push({ message: t.message, error: scrub(err && err.message) });
      return;
    }
    console.log(`     -> ${describe(res)}`);
    console.log(`     reply: ${scrub(res.reply).replace(/\s+/g, ' ').slice(0, 200)}`);

    // An action that went through becomes the next turn's starting point; an
    // answer leaves the workbook as it was — exactly what the server does.
    const after = res.spec && res.intent === INTENT.ACTION && !res.guarded ? res.spec : spec;
    const checks = evaluate(t.expect || {}, res, after);
    for (const ch of checks) {
      console.log(`  ${ch.ok ? 'ok  ' : 'FAIL'} ${ch.label}${ch.detail ? '  — ' + ch.detail : ''}`);
      if (ch.ok) entry.pass++;
      else entry.fail++;
    }
    entry.turns.push({
      message: t.message,
      intent: res.intent,
      ms: res.ms,
      guarded: Boolean(res.guarded),
      reply: scrub(res.reply),
      ops: res.ops,
      checks,
    });
    await fs.promises.writeFile(
      path.join(OUT, `${c.id}.turn${k + 1}.json`),
      JSON.stringify({ reply: scrub(res.reply), reason: res.reason, ops: res.ops, spec: after }, null, 2),
    );

    spec = after;
    history.push({ role: 'user', content: t.message, attachments: files });
    history.push({ role: 'assistant', content: res.reply, intent: res.intent });
  }
}

async function main() {
  await fs.promises.mkdir(OUT, { recursive: true });
  const cases = await loadCases();
  if (!cases.length) {
    console.error(`no case matches ${ONLY}`);
    process.exit(2);
  }

  const settings = new Settings(resolveDataDir());
  if (!DRY && !(await settings.isConfigured())) {
    console.error(`no model configured in ${resolveDataDir()} — configure one in the app, or pass --data-dir=`);
    process.exit(2);
  }

  const report = { startedAt: new Date().toISOString(), dry: DRY, cases: [] };
  for (const c of cases) await runCase(c, settings, report);

  const pass = report.cases.reduce((n, c) => n + c.pass, 0);
  const fail = report.cases.reduce((n, c) => n + c.fail, 0);
  console.log(`\n${pass} passed, ${fail} failed across ${report.cases.length} case(s)`);
  for (const c of report.cases) {
    console.log(`  ${c.fail ? 'FAIL' : 'ok  '} ${c.file}  ${c.pass}/${c.pass + c.fail}`);
  }
  await fs.promises.writeFile(path.join(OUT, 'last-run.json'), JSON.stringify(report, null, 2));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(scrub(err && err.stack ? err.stack : err));
  process.exit(1);
});
