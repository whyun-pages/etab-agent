'use strict';
/**
 * TAB_AGENT_PORT and --port, checked against a real process.
 *
 * The entry is spawned rather than imported: the port is resolved at module
 * scope from process.env and argv, and `src/server.ts` starts listening on
 * load. It runs through tsx, like the rest of the suite, so no build is needed.
 *
 * The server is probed WHILE IT IS ALIVE. An earlier version asked "is the port
 * live?" after tearing the child down, which can only ever answer no.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the entry and hand back a handle that can be probed, then stopped. */
function launch(t, { env = {}, args = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-port-'));
  const baseEnv = { ...process.env, TAB_AGENT_HOME: home };
  // Absent by default, so "no variable set" is a real case and not an accident
  // of the parent shell having one.
  delete baseEnv.TAB_AGENT_PORT;

  const proc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'server.ts'), ...args], {
    cwd: ROOT,
    env: { ...baseEnv, ...env },
    windowsHide: true,
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));

  const handle = {
    get out() { return out; },
    get err() { return err; },
    exited,
    /** The port the process reported, or null. */
    boundPort() {
      const m = out.match(/http:\/\/[^:]+:(\d+)/);
      return m ? Number(m[1]) : null;
    },
    async waitForUrl(ms = 15000) {
      for (let i = 0; i < ms / 100; i++) {
        if (handle.boundPort() !== null) return true;
        if (proc.exitCode !== null) return false;
        await sleep(100);
      }
      return false;
    },
    async stop() {
      if (proc.exitCode === null) proc.kill();
      await exited;
    },
  };
  t.after(async () => {
    await handle.stop();
    // Windows holds the directory for a moment after the child is gone.
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return handle;
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

/** A port that is free right now, or null when `port` is given and taken. */
function freePort(port = 0) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('TAB_AGENT_PORT is used when no flag is given, and really binds', async (t) => {
  const port = await freePort();
  const a = launch(t, { env: { TAB_AGENT_PORT: String(port) } });
  assert.ok(await a.waitForUrl(), a.out + a.err);
  assert.strictEqual(a.boundPort(), port);
  assert.ok(await portLive(port), 'nothing answered on the reported port');
  await a.stop();
  assert.ok(!(await portLive(port)), 'the port is still answering after shutdown');
});

test('--port overrides TAB_AGENT_PORT', async (t) => {
  const fromEnv = await freePort();
  const fromFlag = await freePort();
  const b = launch(t, { env: { TAB_AGENT_PORT: String(fromEnv) }, args: ['--port', String(fromFlag)] });
  assert.ok(await b.waitForUrl(), b.out + b.err);
  assert.strictEqual(b.boundPort(), fromFlag, `flag=${fromFlag} env=${fromEnv}`);
});

test('a malformed TAB_AGENT_PORT is fatal and names the setting and the value', async (t) => {
  const c = launch(t, { env: { TAB_AGENT_PORT: 'not-a-port' } });
  assert.notStrictEqual(await c.exited, 0);
  assert.ok(c.err.includes('TAB_AGENT_PORT'), c.err);
  assert.ok(c.err.includes('not-a-port'), c.err);
});

test('an out-of-range TAB_AGENT_PORT is rejected', async (t) => {
  const d = launch(t, { env: { TAB_AGENT_PORT: '70000' } });
  assert.notStrictEqual(await d.exited, 0);
});

test('TAB_AGENT_PORT=0 means "any free port", not "unset"', async (t) => {
  const e = launch(t, { env: { TAB_AGENT_PORT: '0' } });
  assert.ok(await e.waitForUrl(), e.out + e.err);
  assert.ok(e.boundPort() > 1024, `got ${e.boundPort()}`);
  assert.notStrictEqual(e.boundPort(), 3179);
});

test('nothing set, nothing passed: the documented default, 3179', async (t) => {
  // The one case that has to bind a fixed port. A running copy of the app
  // holds it on a developer's machine, and that is not a failure of this code.
  if ((await freePort(3179)) === null) return t.skip('3179 is in use on this machine');
  const f = launch(t);
  assert.ok(await f.waitForUrl(), f.out + f.err);
  assert.strictEqual(f.boundPort(), 3179);
});
