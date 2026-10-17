'use strict';
/**
 * End-to-end tests for the HTTP layer.
 *
 * These drive a real server over a real socket, because the parts most likely
 * to break are the ones no unit test covers: multipart framing, byte counts,
 * static-path traversal, and the shape of the attachment responses.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { listenLocal } from '../helpers/listen.ts';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer, AppState, safeFilename } from '../../src/http/server.ts';

// --------------------------------------------------------------- harness
/** Start a server on an ephemeral port with a scratch data directory. */
function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-test-'));
  const server = createServer({
    state: new AppState({ dataDir: dir }),
    staticDir: null,
  });
  return new Promise((resolve) => {
    listenLocal(server).then(() => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(() => new Promise((done) => server.close(done)));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      resolve({ server, base, dir });
    });
  });
}

/** Minimal request helper. */
function request(base, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + urlPath, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const getJson = async (base, p) => JSON.parse((await request(base, 'GET', p)).buffer.toString('utf8'));

/** Build a multipart body the way a browser would. */
function multipart(fields) {
  const boundary = '----TabAgentTest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.filename) head += `Content-Type: ${f.contentType || 'application/octet-stream'}\r\n`;
    head += '\r\n';
    parts.push(Buffer.from(head, 'utf8'), Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '', 'utf8'), Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(parts),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ---------------------------------------------------------------- UI
//
// The UI is plain ES modules served as files. These checks do what a browser
// does on load: fetch the page, then walk the import graph from the entry
// point. A typo in an import path is invisible to `node --check` but breaks
// the app at runtime, so every hop is fetched for real.

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** Start a server that also serves public/. */
async function startUiServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-ui-'));
  const server = createServer({
    state: new AppState({ dataDir: dir }),
    staticDir: PUBLIC_DIR,
  });
  await new Promise((r) => listenLocal(server).then(r));
  t.after(() => new Promise((done) => server.close(done)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the UI page and its stylesheet are served', async (t) => {
  const base = await startUiServer(t);

  const page = await request(base, 'GET', '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  const html = page.buffer.toString('utf8');
  assert.match(html, /<script type="module" src="\/js\/app\.js">/);
  assert.match(html, /\/css\/app\.css/);

  const css = await request(base, 'GET', '/css/app.css');
  assert.strictEqual(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.ok(css.buffer.length > 1000, 'the stylesheet should not be a stub');
});

test('every module the UI imports resolves over HTTP', async (t) => {
  const base = await startUiServer(t);

  const seen = new Set();
  const queue = ['/js/app.js'];
  while (queue.length) {
    const mod = queue.shift();
    if (seen.has(mod)) continue;
    seen.add(mod);

    const res = await request(base, 'GET', mod);
    assert.strictEqual(res.status, 200, `${mod} should be served, got ${res.status}`);
    assert.match(res.headers['content-type'], /javascript/, `${mod} needs a JS content type`);

    const src = res.buffer.toString('utf8');
    assert.ok(src.length > 0, `${mod} is empty`);

    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // no bare specifiers in the browser build
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(mod), spec)));
    }
  }
  assert.ok(seen.size >= 10, `expected the whole module set, saw ${seen.size}`);
});

test('static serving refuses anything outside its root', async (t) => {
  const base = await startUiServer(t);

  for (const evil of [
    '/../lib/server.js',
    '/js/../../lib/xlsx.js',
    '/..%2f..%2flib/zip.js',
    '/package.json',
    '/tools/make-sample.js',   // a real file, just not under public/
  ]) {
    const res = await request(base, 'GET', evil);
    assert.strictEqual(res.status, 404, `${evil} must not be served`);
    assert.doesNotMatch(res.buffer.toString('utf8'), /createServer/, `${evil} leaked source`);
  }

  // A normal asset still works after the rejections.
  assert.strictEqual((await request(base, 'GET', '/js/app.js')).status, 200);
});

// ------------------------------------------------------- unit-level bits

test('safeFilename strips directories and reserved names', () => {
  assert.strictEqual(safeFilename('C:\\Users\\me\\..\\..\\etc\\passwd'), 'passwd');
  assert.strictEqual(safeFilename('/tmp/x/../../boot.ini'), 'boot.ini');
  assert.strictEqual(safeFilename('CON.xlsx'), '_CON.xlsx');
  assert.strictEqual(safeFilename('a<b>|c?.xlsx'), 'a_b__c_.xlsx');
  assert.strictEqual(safeFilename(''), 'file');
});

// ------------------------------------------------------------- health/meta

test('health identifies this app by a stable field', async (t) => {
  const { base } = await startServer(t);
  const h = await getJson(base, '/api/health');
  assert.strictEqual(h.ok, true);
  // `app` is what desktop.js probes for to tell its own instance from an
  // unrelated server on the same port. It must NOT be a count that a future
  // feature removal could delete — that is how single-instance detection broke
  // once already.
  assert.strictEqual(h.app, 'tab-agent');
  assert.strictEqual(typeof h.uploads, 'number');
});

test('unknown route yields a structured 404', async (t) => {
  const { base } = await startServer(t);
  const r = await request(base, 'GET', '/api/nope');
  assert.strictEqual(r.status, 404);
  const body = JSON.parse(r.buffer.toString('utf8'));
  assert.strictEqual(body.ok, false);
  assert.match(body.error, /未知接口/);
});

test('the removed template routes are gone, not merely unreachable', async (t) => {
  const { base } = await startServer(t);
  // These endpoints were deleted with the template concept. A 404 with the
  // generic message means the route table no longer knows them; anything else
  // would mean a handler survived the removal.
  for (const [method, p] of [
    ['POST', '/api/template'],
    ['POST', '/api/plan'],
    ['POST', '/api/generate'],
    ['GET', '/api/skills'],
    ['POST', '/api/chat'],
  ]) {
    // No body: a 404 is answered before the request body is read, so sending
    // one would leave it unread and the socket would reset instead of replying.
    const r = await request(base, method, p);
    assert.strictEqual(r.status, 404, `${method} ${p} should be gone`);
    assert.match(JSON.parse(r.buffer.toString('utf8')).error, /未知接口/);
  }
});

// ------------------------------------------------------------- attachments

/** Create a session and return its attachments path. */
async function sessionAttachments(base) {
  const r = await request(base, 'POST', '/api/sessions', {
    body: Buffer.from('{}'),
    headers: { 'Content-Type': 'application/json' },
  });
  const { session } = JSON.parse(r.buffer.toString('utf8'));
  return `/api/sessions/${encodeURIComponent(session.id)}/attachments`;
}

test('attachments are accepted, described and clearable', async (t) => {
  const { base } = await startServer(t);
  const att = await sessionAttachments(base);
  const csv = '客户名称,数量,单价\n北京甲公司的,10,250\n上海乙,5,300\n';
  const mp = multipart([{ name: 'files', filename: '数据.csv', data: Buffer.from(csv, 'utf8'), contentType: 'text/csv' }]);
  const up = JSON.parse((await request(base, 'POST', att, mp)).buffer.toString('utf8'));
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.attachments.length, 1);
  // CSV becomes a parsed table; the kind reports the shape, not the extension.
  assert.strictEqual(up.attachments[0].kind, 'table');
  assert.strictEqual(up.attachments[0].meta.ext, '.csv');
  assert.strictEqual(up.attachments[0].rowCount, 2);
  // Raw bytes must never leak into the JSON response.
  assert.strictEqual(up.attachments[0].data, undefined);

  const list = await getJson(base, att);
  assert.strictEqual(list.attachments.length, 1);

  await request(base, 'DELETE', att);
  assert.strictEqual((await getJson(base, att)).attachments.length, 0);
});

test('attachments belong to one session', async (t) => {
  // They used to be one process-wide list: a file attached in one session
  // showed up in every other, and went to the model with their turns too.
  const { base } = await startServer(t);
  const a = await sessionAttachments(base);
  const b = await sessionAttachments(base);
  const mp = multipart([{ name: 'files', filename: 'a.csv', data: 'x,y\n1,2\n', contentType: 'text/csv' }]);
  await request(base, 'POST', a, mp);

  assert.deepStrictEqual((await getJson(base, a)).attachments.map((x) => x.name), ['a.csv']);
  assert.deepStrictEqual((await getJson(base, b)).attachments, []);
  // Clearing one session leaves the other alone.
  await request(base, 'POST', b, mp);
  await request(base, 'DELETE', b);
  assert.strictEqual((await getJson(base, a)).attachments.length, 1);
  assert.strictEqual((await getJson(base, '/api/health')).uploads, 1);
});

test('deleting a session drops its attachments; an unknown session is a 404', async (t) => {
  const { base } = await startServer(t);
  const att = await sessionAttachments(base);
  const mp = multipart([{ name: 'files', filename: 'a.csv', data: 'x,y\n1,2\n', contentType: 'text/csv' }]);
  await request(base, 'POST', att, mp);
  assert.strictEqual((await getJson(base, '/api/health')).uploads, 1);

  await request(base, 'DELETE', att.replace(/\/attachments$/, ''));
  assert.strictEqual((await getJson(base, '/api/health')).uploads, 0);
  assert.strictEqual((await request(base, 'GET', att)).status, 404);
  assert.strictEqual((await request(base, 'POST', '/api/sessions/nope/attachments', mp)).status, 404);
  // The old process-wide route is gone, not silently kept as a second store.
  assert.strictEqual((await request(base, 'GET', '/api/attachments')).status, 404);
});

/** A server whose "open with the default program" records the path instead. */
async function startOpenServer(t) {
  const started = await startServer(t);
  const opened = [];
  started.server.state.openFile = async (file) => { opened.push(file); };
  started.server.state.openDir = path.join(started.dir, 'opened');
  return { ...started, opened };
}

async function uploadOne(base, att, filename, data) {
  const mp = multipart([{ name: 'files', filename, data }]);
  return JSON.parse((await request(base, 'POST', att, mp)).buffer.toString('utf8')).attachments[0];
}

test('an upload keeps a file byte for byte, beside a text field, under its UTF-8 name', async (t) => {
  // Multipart framing is the parser's job now (multer), so this checks it from
  // the outside: a payload with an embedded CRLFCRLF and NULs, which a naive
  // parser takes for a header end, must come back exactly as sent.
  const { base, opened } = await startOpenServer(t);
  const att = await sessionAttachments(base);
  const payload = Buffer.concat([Buffer.from('a,b\r\n\r\n1,2\r\n'), Buffer.alloc(64, 0x00)]);
  const mp = multipart([
    { name: 'note', data: '你好' },
    { name: 'files', filename: '原始 数据.txt', data: payload, contentType: 'text/plain' },
  ]);
  const up = JSON.parse((await request(base, 'POST', att, mp)).buffer.toString('utf8'));
  assert.strictEqual(up.attachments.length, 1, 'the text field is not an attachment');
  assert.strictEqual(up.attachments[0].name, '原始 数据.txt');
  assert.strictEqual((await request(base, 'POST', `${att}/${up.attachments[0].id}/open`)).status, 200);
  assert.deepStrictEqual(fs.readFileSync(opened[0]), payload);
});

test('an attachment opens as a copy under its own name, reused on a second click', async (t) => {
  const { base, opened } = await startOpenServer(t);
  const att = await sessionAttachments(base);
  const up = await uploadOne(base, att, '会员 名单.csv', 'a,b\n1,2\n');
  assert.ok(up.id, 'an upload carries an id to address it by');
  assert.strictEqual(up.openable, true);

  const r = await request(base, 'POST', `${att}/${up.id}/open`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(path.basename(opened[0]), '会员 名单.csv');
  assert.strictEqual(fs.readFileSync(opened[0], 'utf8'), 'a,b\n1,2\n');

  await request(base, 'POST', `${att}/${up.id}/open`);
  assert.strictEqual(opened[1], opened[0], 'the copy is reused, not written again');

  // Clearing drops the copies with the uploads (removal is best-effort, async).
  await request(base, 'DELETE', att);
  assert.strictEqual((await request(base, 'POST', `${att}/${up.id}/open`)).status, 404);
  for (let i = 0; i < 20 && fs.existsSync(opened[0]); i++) await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(fs.existsSync(opened[0]), false);
});

test('an executable attachment is never handed to the OS', async (t) => {
  const { base, opened } = await startOpenServer(t);
  const att = await sessionAttachments(base);
  for (const name of ['run.bat', 'setup.exe', 'x.ps1', 'page.html']) {
    const up = await uploadOne(base, att, name, 'echo hi');
    assert.strictEqual(up.openable, false, name);
    assert.strictEqual((await request(base, 'POST', `${att}/${up.id}/open`)).status, 400, name);
  }
  assert.deepStrictEqual(opened, []);
});

test('opening refuses another site and a rebinding host', async (t) => {
  const { base, opened } = await startOpenServer(t);
  const att = await sessionAttachments(base);
  const up = await uploadOne(base, att, 'a.csv', 'a\n1\n');
  const open = (headers) => request(base, 'POST', `${att}/${up.id}/open`, { headers });
  const port = new URL(base).port;

  // Any web page can fire a form POST at 127.0.0.1; its Origin gives it away.
  assert.strictEqual((await open({ Origin: 'https://evil.example' })).status, 403);
  // DNS rebinding: a hostile name resolving to 127.0.0.1 matches its own Origin.
  assert.strictEqual((await open({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).status, 403);
  assert.deepStrictEqual(opened, []);

  // The app's own page is fine.
  assert.strictEqual((await open({ Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.strictEqual(opened.length, 1);
});

test('a failed open is reported, not a crash', async (t) => {
  const { server, base } = await startOpenServer(t);
  server.state.openFile = async () => { throw new Error('系统没有能打开这类文件的程序'); };
  const att = await sessionAttachments(base);
  const up = await uploadOne(base, att, 'a.csv', 'a\n1\n');
  const r = await request(base, 'POST', `${att}/${up.id}/open`);
  assert.strictEqual(r.status, 502);
  assert.match(JSON.parse(r.buffer.toString('utf8')).error, /没有能打开/);
});

test('an unsupported attachment is reported per-file without failing the batch', async (t) => {
  const { base } = await startServer(t);
  const mp = multipart([
    { name: 'files', filename: 'ok.csv', data: 'a,b\n1,2\n', contentType: 'text/csv' },
    { name: 'files', filename: 'doc.pdf', data: Buffer.from('%PDF-1.4\n%bytes'), contentType: 'application/pdf' },
  ]);
  const up = JSON.parse((await request(base, 'POST', await sessionAttachments(base), mp)).buffer.toString('utf8'));
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.attachments.length, 2);
  const pdf = up.attachments.find((a) => a.name === 'doc.pdf');
  // Unsupported types are described, never fatal.
  assert.strictEqual(pdf.kind, 'unknown');
  assert.strictEqual(pdf.meta.kind, 'pdf');
  assert.match(pdf.note, /PDF/);
  const csv = up.attachments.find((a) => a.name === 'ok.csv');
  assert.strictEqual(csv.kind, 'table');
});

test('an oversized attachment body is refused rather than buffered', async (t) => {
  const { base } = await startServer(t);
  const att = await sessionAttachments(base);
  const oversized = Buffer.alloc(33 * 1024 * 1024, 0x41);
  const mp = multipart([{ name: 'files', filename: 'big.csv', data: oversized }]);
  // The server drops the connection mid-upload, so a socket error here is the
  // expected outcome; buffering 33MB first would be the bug.
  let status = null;
  try {
    status = (await request(base, 'POST', att, mp)).status;
  } catch (err) {
    assert.match(err.code, /ECONNRESET|EPIPE/);
  }
  if (status !== null) assert.strictEqual(status, 413);
});

test('a non-multipart attachment upload is rejected', async (t) => {
  const { base } = await startServer(t);
  const r = await request(base, 'POST', await sessionAttachments(base), {
    body: Buffer.from('{"a":1}'),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.strictEqual(r.status, 400);
  assert.match(JSON.parse(r.buffer.toString('utf8')).error, /multipart/);
});
