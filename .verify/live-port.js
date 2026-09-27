'use strict';
/**
 * Real-process check of TAB_AGENT_PORT.
 *
 * Spawns `node server.js` for real rather than requiring the module, because
 * the resolution lives at module scope and reads process.env at load time.
 *
 * The server is probed WHILE IT IS ALIVE. An earlier version asked "is the port
 * live?" after tearing the child down, which can only ever answer no.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}  ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the dev entry and hand back a handle that can be probed then stopped. */
function launch({ env = {}, args = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xlport-'));
  const baseEnv = { ...process.env, TAB_AGENT_HOME: home };
  // Absent by default, so "no variable set" is a real case and not an accident
  // of the parent shell having one.
  delete baseEnv.TAB_AGENT_PORT;

  const proc = spawn(NODE, [path.join(ROOT, '.build', 'js', 'server.js'), ...args], {
    cwd: ROOT,
    env: { ...baseEnv, ...env },
    windowsHide: true,
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));

  return {
    home,
    get out() { return out; },
    get err() { return err; },
    exited,
    /** The port the process reported, or null. */
    boundPort() {
      const m = out.match(/http:\/\/[^:]+:(\d+)/);
      return m ? Number(m[1]) : null;
    },
    async waitForUrl(ms = 6000) {
      for (let i = 0; i < ms / 100; i++) {
        if (this.boundPort() !== null) return true;
        if (proc.exitCode !== null) return false;
        await sleep(100);
      }
      return false;
    },
    async stop() {
      if (proc.exitCode === null) proc.kill();
      await exited;
      await sleep(200);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* scratch */ }
    },
  };
}

/** Is the app answering on this port right now? */
function portLive(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve(s.includes('tab-agent')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

(async () => {
  // 1. the environment variable is honoured, and really binds
  const p1 = await freePort();
  const a = launch({ env: { TAB_AGENT_PORT: String(p1) } });
  check('TAB_AGENT_PORT is used when no flag is given', await a.waitForUrl() && a.boundPort() === p1,
    `wanted ${p1} got ${a.boundPort()}\n${a.out}${a.err}`);
  check('  ...and it really answers on that port', await portLive(p1));
  await a.stop();
  check('  ...and the port is free again after shutdown', !(await portLive(p1)));

  // 2. the explicit flag beats the environment
  const p2env = await freePort();
  const p2flag = await freePort();
  const b = launch({ env: { TAB_AGENT_PORT: String(p2env) }, args: ['--port', String(p2flag)] });
  check('--port overrides TAB_AGENT_PORT', await b.waitForUrl() && b.boundPort() === p2flag,
    `flag=${p2flag} env=${p2env} got=${b.boundPort()}`);
  await b.stop();

  // 3. a bad value is fatal, not silently ignored
  const c = launch({ env: { TAB_AGENT_PORT: 'not-a-port' } });
  check('a malformed TAB_AGENT_PORT exits non-zero', (await c.exited) !== 0);
  check('  ...and says which setting was wrong', c.err.includes('TAB_AGENT_PORT'), JSON.stringify(c.err));
  check('  ...and names the offending value', c.err.includes('not-a-port'), JSON.stringify(c.err));
  await c.stop();

  // 4. out of range is rejected too
  const d = launch({ env: { TAB_AGENT_PORT: '70000' } });
  check('an out-of-range port is rejected', (await d.exited) !== 0);
  await d.stop();

  // 5. 0 means "any free port", not "unset"
  const e = launch({ env: { TAB_AGENT_PORT: '0' } });
  const ok = await e.waitForUrl();
  check('TAB_AGENT_PORT=0 binds an OS-chosen port', ok && e.boundPort() !== 0 && e.boundPort() > 1024,
    `got ${e.boundPort()}`);
  await e.stop();

  // 6. nothing set, nothing passed -> the documented default
  const f = launch({});
  check('falls back to 3179 by default', await f.waitForUrl() && f.boundPort() === 3179,
    `got ${f.boundPort()}\n${f.out}${f.err}`);
  await f.stop();

  console.log(failures ? `\n${failures} FAILED` : '\nALL PORT CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
