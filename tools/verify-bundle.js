'use strict';
/**
 * Verify the bundle before it is trusted in the release path.
 *
 * Checks:
 *   1. the shipped entry bundles, and every import left for runtime is a Node
 *      builtin or a known optional package (see OPTIONAL)
 *   2. every protocol the settings panel offers has a stream implementation
 *      in src/agent/pi.ts
 *   3. the bundled server code RUNS somewhere with no node_modules at all: a
 *      probe bundle is copied to a temp directory outside the repository and
 *      driven in a child process — one plain call and one full agent turn
 *      against a local fake provider, and every offered provider module loaded
 *
 * Step 3 is the one that matters. An esbuild bundle can build cleanly and
 * still fail at load — an ESM dependency reading `import.meta.url`, a dynamic
 * import esbuild could not see, a provider module that pulls in something
 * missing. Running it far from node_modules is the only way to know that the
 * executable will not reach for a file that is not there.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundle } = require('./bundle');

const ROOT = path.join(__dirname, '..');
const BUILT = path.join(ROOT, '.build', 'js');
// Which entry to bundle. The desktop entry is what ships.
const ENTRY_NAME = process.argv[2] || 'desktop.js';

/**
 * Packages left external that a packaged executable cannot load, and why that
 * is fine. Each is required inside a try/catch by the package that wants it,
 * and esbuild leaves exactly those requires external.
 */
const OPTIONAL = {
  bufferutil: 'ws: optional native speed-up for masking frames',
  'utf-8-validate': 'ws: optional native UTF-8 validator',
  'supports-color': 'debug: optional terminal colour detection',
};

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !detail ? '' : '  -> ' + detail));
  if (!ok) failures++;
}

async function main() {
  if (!fs.existsSync(path.join(BUILT, ENTRY_NAME))) {
    console.error(`.build/js/${ENTRY_NAME} is missing. Run \`pnpm build:js\` first.`);
    process.exit(1);
  }

  console.log(`===== 1) bundle ${ENTRY_NAME} =====`);
  const out = path.join(ROOT, '.build', 'bundle.js');
  const r = await bundle({ entry: path.join(BUILT, ENTRY_NAME), outfile: out });
  console.log(`     ${r.inputs} inputs, ${r.bytes} bytes`);
  console.log(`     externals: ${r.externals.join(', ')}`);
  check('bundle is non-trivial', r.bytes > 20000, `${r.bytes} bytes`);
  const unexplained = r.thirdParty.filter((s) => !Object.prototype.hasOwnProperty.call(OPTIONAL, s));
  check('every non-builtin external is a known optional package', unexplained.length === 0, unexplained.join(', '));
  for (const s of r.thirdParty.filter((x) => OPTIONAL[x])) console.log(`     optional: ${s} — ${OPTIONAL[s]}`);
  for (const w of r.warnings) console.log(`     warning: ${w}`);

  console.log('\n===== 2) offered protocols have a stream implementation =====');
  const { MODEL_APIS } = require(path.join(BUILT, 'agent', 'model.js'));
  const { apis } = await require(path.join(BUILT, 'agent', 'pi.js')).loadPi();
  for (const api of MODEL_APIS) {
    check(`${api} is in src/agent/pi.ts's stream table`, apis.has(api), 'import its .lazy module in loadPi');
  }

  console.log('\n===== 3) bundled server code runs with no node_modules =====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-bundle-'));
  try {
    const entry = path.join(ROOT, '.build', 'bundle-probe-entry.js');
    fs.writeFileSync(
      entry,
      [
        "exports.server = require('./js/http/server.js');",
        "exports.llm = require('./js/agent/llm.js');",
        "exports.agent = require('./js/agent/agent.js');",
        "exports.pi = require('./js/agent/pi.js');",
        "exports.model = require('./js/agent/model.js');",
        '',
      ].join('\n'),
    );
    await bundle({ entry, outfile: path.join(dir, 'probe-bundle.js') });
    fs.rmSync(entry, { force: true });
    fs.writeFileSync(path.join(dir, 'run.js'), RUNNER);
    let output = '';
    try {
      output = execFileSync(process.execPath, ['run.js'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_PATH: '' },
      });
    } catch (e) {
      output = String(e.stdout || '') + String(e.stderr || '') + `\n[runner exited: ${e.status ?? e.message}]`;
    }
    for (const line of output.trim().split('\n')) {
      const m = /^(ok|FAIL) (.*?)(?: -> (.*))?$/.exec(line);
      if (m) check(m[2], m[1] === 'ok', m[3]);
      else console.log('     ' + line);
    }
    check('runner reported results', /^(ok|FAIL) /m.test(output), 'no output');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? 'BUNDLER CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Runs in the temp directory against the probe bundle. Prints one `ok`/`FAIL`
 * line per check; the parent turns those into its own checks.
 */
const RUNNER = String.raw`'use strict';
const http = require('node:http');
const report = (label, ok, detail) => console.log((ok ? 'ok ' : 'FAIL ') + label + (ok || !detail ? '' : ' -> ' + detail));

(async () => {
  let b;
  try {
    b = require('./probe-bundle.js');
    report('probe bundle loads', true);
  } catch (e) {
    report('probe bundle loads', false, e.message);
    return;
  }
  report('src/http/server exports createServer', typeof b.server.createServer === 'function');
  report('src/http/server exports AppState', typeof b.server.AppState === 'function');

  // A fake OpenAI-compatible provider: the first call of a turn asks for a
  // tool, the second answers in text.
  const chunk = (d, f = null) => 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: d, finish_reason: f }] }) + '\n\n';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const hasTools = Array.isArray(body.tools) && body.tools.length;
      const answered = body.messages.some((m) => m.role === 'tool');
      if (hasTools && !answered) {
        const args = JSON.stringify({ title: 'T', sheets: [{ name: 'S', columns: [{ header: '客户', type: 'text' }], rows: [['甲']] }] });
        res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_workbook', arguments: args } }] }));
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
      } else {
        res.write(chunk({ role: 'assistant', content: hasTools ? '建好了。' : 'ok' }));
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  const secrets = { api: 'openai-completions', baseUrl, apiKey: 'k', model: 'm' };

  try {
    const text = await b.llm.chat({ credentials: secrets, messages: [{ role: 'user', content: 'hi' }], timeoutMs: 10000 });
    report('chat over the bundled OpenAI provider', text === 'ok', JSON.stringify(text));
  } catch (e) { report('chat over the bundled OpenAI provider', false, e.message); }

  try {
    const settings = { isConfigured: async () => true, secrets: async () => secrets };
    const turn = await b.agent.runTurn({ settings, message: '做一个表' });
    report('agent turn with a tool call', turn.intent === 'action' && turn.spec && turn.spec.sheets[0].rows[0][0] === '甲', turn.intent + ' ' + turn.raw);
  } catch (e) { report('agent turn with a tool call', false, e.message); }
  server.close();

  // The other offered providers: each must LOAD. Pointed at a closed port, a
  // loaded provider fails with a connection error; a missing or broken one
  // fails with something else.
  const pi = await b.pi.loadPi();
  for (const api of b.model.MODEL_APIS.filter((a) => a !== 'openai-completions')) {
    const model = b.model.modelFromSecrets({ api, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' });
    try {
      const context = pi.ai.normalizeContext({ messages: [{ role: 'user', content: 'x', timestamp: 0 }] });
      const res = await pi.stream(model, context, { apiKey: 'k', maxRetries: 0 }).result();
      const msg = String(res.errorMessage || '');
      const loaded = res.stopReason === 'error' && !/no stream implementation|Cannot find module|is not a function/i.test(msg);
      report(api + ' provider loads', loaded, msg.slice(0, 200));
    } catch (e) { report(api + ' provider loads', false, e.message); }
  }
})().catch((e) => { report('runner', false, e.stack || e.message); });
`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
