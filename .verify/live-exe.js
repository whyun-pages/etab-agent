'use strict';
/**
 * Live check against a RUNNING packaged TabAgent.exe.
 * Usage: node .verify/live-exe.js [port]
 */
const http = require('node:http');

const PORT = Number(process.argv[2] || 59431);
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const getJson = async (p) => JSON.parse((await request('GET', p)).buffer.toString('utf8'));

function multipart(files) {
  const b = '----exelive';
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.contentType}\r\n\r\n`));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { buffer: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

(async () => {
  // 1. health
  const h = await getJson('/api/health');
  check('packaged exe: health app identity', h.app === 'tab-agent', JSON.stringify(h));
  check('packaged exe: templates field gone', !('templates' in h));

  // 2. UI assets really embedded
  const index = await request('GET', '/');
  check('packaged exe: serves index.html from embedded assets', index.status === 200 && /<html/i.test(index.buffer.toString('utf8')), `status ${index.status}`);
  for (const p of ['/css/app.css', '/js/app.js', '/js/views/settings.js']) {
    const r = await request('GET', p);
    check(`packaged exe: serves ${p}`, r.status === 200, `status ${r.status}`);
  }

  // 3. attachments
  const mp = multipart([
    { filename: '数据.csv', data: Buffer.from('客户名称,数量,单价\n北京甲公司,10,250\n上海乙,5,300\n', 'utf8'), contentType: 'text/csv' },
    { filename: 'doc.pdf', data: Buffer.from('%PDF-1.4\n%x'), contentType: 'application/pdf' },
  ]);
  const up = JSON.parse((await request('POST', '/api/attachments', mp.buffer, mp.headers)).buffer.toString('utf8'));
  check('packaged exe: attachment upload works', up.attachments.length === 2);
  check('packaged exe: csv -> table', up.attachments[0].kind === 'table');

  // 4. useForPrompt must be gone from the settings surface
  const s = await getJson('/api/settings');
  check('packaged exe: settings has no useForPrompt', !('useForPrompt' in s.settings), JSON.stringify(s.settings));
  check('packaged exe: settings keeps useForAttachments', 'useForAttachments' in s.settings);

  // 5. sessions work end to end
  const created = JSON.parse((await request('POST', '/api/sessions', JSON.stringify({ title: '打包验证' }), { 'Content-Type': 'application/json' })).buffer.toString('utf8'));
  check('packaged exe: session created', created.ok === true && created.session && created.session.id, JSON.stringify(created).slice(0, 200));

  console.log(failures ? `\n${failures} FAILED` : '\nALL PACKAGED-EXE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
