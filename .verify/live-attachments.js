'use strict';
/**
 * Live check of the attachment routes, independent of the test harness.
 * Boots the real server over real HTTP and posts a real multipart body.
 */
const http = require('node:http');
const { createServer } = require('../lib/server');

function request(base, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart(files) {
  const b = '----livecheck';
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.contentType}\r\n\r\n`
    ));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { buffer: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

(async () => {
  const { AppState } = require('../lib/server');
  const server = createServer({ state: new AppState({ dataDir: require('node:os').tmpdir() }), staticDir: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failures = 0;

  function check(name, cond, extra = '') {
    if (cond) { console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${extra}`); }
  }

  // health: stable identity, no template count
  const h = JSON.parse((await request(base, 'GET', '/api/health')).body);
  check('health reports app identity', h.app === 'tab-agent');
  check('health dropped templates field', !('templates' in h), JSON.stringify(h));

  // POST multipart
  const mp = multipart([
    { filename: '数据.csv', data: Buffer.from('客户名称,数量,单价\n北京甲公司,10,250\n上海乙,5,300\n', 'utf8'), contentType: 'text/csv' },
    { filename: 'doc.pdf', data: Buffer.from('%PDF-1.4\n%x'), contentType: 'application/pdf' },
  ]);
  const up = JSON.parse((await request(base, 'POST', '/api/attachments', mp.buffer, mp.headers)).body);
  check('POST returns both files', up.attachments && up.attachments.length === 2);
  check('csv parsed as table', up.attachments[0].kind === 'table');
  check('pdf described, not fatal', up.attachments[1].kind === 'unknown' && /PDF/.test(up.attachments[1].note));
  check('raw bytes never returned', up.attachments[0].data === undefined);

  // GET list
  const list = JSON.parse((await request(base, 'GET', '/api/attachments')).body);
  check('GET lists one item', list.attachments.length === 2);
  check('health reflects upload count', JSON.parse((await request(base, 'GET', '/api/health')).body).uploads === 2);

  // DELETE
  await request(base, 'DELETE', '/api/attachments');
  const after = JSON.parse((await request(base, 'GET', '/api/attachments')).body);
  check('DELETE clears the list', after.attachments.length === 0);

  // the removed routes must genuinely be gone, not silently 200
  for (const p of ['/api/template', '/api/plan', '/api/skills', '/api/chat']) {
    const r = await request(base, 'GET', p);
    check(`removed route 404s: ${p}`, r.status === 404, `got ${r.status}`);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL LIVE ATTACHMENT CHECKS PASSED');
  server.close();
  process.exit(failures ? 1 : 0);
})();
