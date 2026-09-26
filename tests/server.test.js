'use strict';
/**
 * End-to-end tests for the HTTP layer.
 *
 * These drive a real server over a real socket, because the parts most likely
 * to break are the ones no unit test covers: multipart framing, byte counts,
 * static-path traversal, and the shape of the attachment responses.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, AppState, parseMultipart, safeFilename } = require('../lib/server');

// --------------------------------------------------------------- harness
/** Start a server on an ephemeral port with a scratch data directory. */
function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-test-'));
  const server = createServer({
    state: new AppState({ dataDir: dir }),
    staticDir: null,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Start a server that also serves public/. */
async function startUiServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-ui-'));
  const server = createServer({
    state: new AppState({ dataDir: dir }),
    staticDir: PUBLIC_DIR,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
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
    assert.doesNotMatch(res.buffer.toString('utf8'), /createHandler/, `${evil} leaked source`);
  }

  // A normal asset still works after the rejections.
  assert.strictEqual((await request(base, 'GET', '/js/app.js')).status, 200);
});

// ------------------------------------------------------- unit-level bits

test('parseMultipart splits a file part from a text field', () => {
  const { body, headers } = multipart([
    { name: 'note', data: '你好' },
    { name: 'file', filename: 'a.xlsx', data: Buffer.from([0x50, 0x4b, 3, 4]), contentType: 'application/zip' },
  ]);
  const parts = parseMultipart(body, headers['Content-Type']);
  assert.strictEqual(parts.length, 2);
  const field = parts.find((p) => p.name === 'note');
  assert.strictEqual(field.filename, null);
  assert.strictEqual(field.data.toString('utf8'), '你好');
  const file = parts.find((p) => p.name === 'file');
  assert.strictEqual(file.filename, 'a.xlsx');
  assert.deepStrictEqual([...file.data], [0x50, 0x4b, 3, 4]);
});

test('parseMultipart preserves binary bytes containing the boundary-length CRLF', () => {
  // A payload with embedded CRLFCRLF must not be mistaken for a header end.
  const payload = Buffer.concat([Buffer.from('X\r\n\r\nY'), Buffer.alloc(64, 0x00)]);
  const { body, headers } = multipart([{ name: 'file', filename: 'b.bin', data: payload }]);
  const parts = parseMultipart(body, headers['Content-Type']);
  assert.deepStrictEqual(parts[0].data, payload);
});

test('parseMultipart rejects a request with no boundary', () => {
  assert.throws(() => parseMultipart(Buffer.from('x'), 'multipart/form-data'), /boundary/);
});

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

test('attachments are accepted, described and clearable', async (t) => {
  const { base } = await startServer(t);
  const csv = '客户名称,数量,单价\n北京甲公司的,10,250\n上海乙,5,300\n';
  const mp = multipart([{ name: 'files', filename: '数据.csv', data: Buffer.from(csv, 'utf8'), contentType: 'text/csv' }]);
  const up = JSON.parse((await request(base, 'POST', '/api/attachments', mp)).buffer.toString('utf8'));
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.attachments.length, 1);
  // CSV becomes a parsed table; the kind reports the shape, not the extension.
  assert.strictEqual(up.attachments[0].kind, 'table');
  assert.strictEqual(up.attachments[0].meta.ext, '.csv');
  assert.strictEqual(up.attachments[0].rowCount, 2);
  // Raw bytes must never leak into the JSON response.
  assert.strictEqual(up.attachments[0].data, undefined);

  const list = await getJson(base, '/api/attachments');
  assert.strictEqual(list.attachments.length, 1);

  await request(base, 'DELETE', '/api/attachments');
  assert.strictEqual((await getJson(base, '/api/attachments')).attachments.length, 0);
});

test('an unsupported attachment is reported per-file without failing the batch', async (t) => {
  const { base } = await startServer(t);
  const mp = multipart([
    { name: 'files', filename: 'ok.csv', data: 'a,b\n1,2\n', contentType: 'text/csv' },
    { name: 'files', filename: 'doc.pdf', data: Buffer.from('%PDF-1.4\n%bytes'), contentType: 'application/pdf' },
  ]);
  const up = JSON.parse((await request(base, 'POST', '/api/attachments', mp)).buffer.toString('utf8'));
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
  const oversized = Buffer.alloc(33 * 1024 * 1024, 0x41);
  const mp = multipart([{ name: 'files', filename: 'big.csv', data: oversized }]);
  // The server drops the connection mid-upload, so a socket error here is the
  // expected outcome; buffering 33MB first would be the bug.
  let status = null;
  try {
    status = (await request(base, 'POST', '/api/attachments', mp)).status;
  } catch (err) {
    assert.match(err.code, /ECONNRESET|EPIPE/);
  }
  if (status !== null) assert.strictEqual(status, 413);
});

test('a non-multipart attachment upload is rejected', async (t) => {
  const { base } = await startServer(t);
  const r = await request(base, 'POST', '/api/attachments', {
    body: Buffer.from('{"a":1}'),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.strictEqual(r.status, 400);
  assert.match(JSON.parse(r.buffer.toString('utf8')).error, /multipart/);
});
