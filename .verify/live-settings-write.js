'use strict';
/**
 * The settings WRITE path over real HTTP, against a running packaged exe.
 *
 * `live-exe.js` only READS settings. This exercises the part that changed:
 * POST /api/settings (a now-async read-modify-write with an atomic replace),
 * and the un-awaitable-guard trap — if `isConfigured()` were left un-awaited in
 * a route, these guards would silently open and the 400s below would 200.
 *
 * Usage: node .verify/live-settings-write.js [port]
 */
const http = require('node:http');

const PORT = Number(process.argv[2] || 59441);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {};
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const getJson = async (p) => JSON.parse((await request('GET', p)).body);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

(async () => {
  // 1. Fresh data dir: the un-awaited-guard trap would make this report TRUE.
  const fresh = await getJson('/api/health');
  check('fresh dir: modelConfigured is FALSE (guard awaited, not a truthy Promise)',
    fresh.modelConfigured === false, JSON.stringify(fresh));

  // 2. The config gate must still fire. If `!isConfigured()` were left
  //    un-awaited, this 400 would have been a 200 (or a 500 from an empty key).
  const t1 = await request('POST', '/api/settings/test', {});
  check('unconfigured: /api/settings/test refuses with 400', t1.status === 400, `status ${t1.status}`);

  const sess = await request('POST', '/api/sessions', {});
  const sid = JSON.parse(sess.body).session.id;
  const t2 = await request('POST', `/api/sessions/${sid}/turn`, { message: '你好' });
  check('unconfigured: a turn refuses with 400, not a crash',
    t2.status === 400, `status ${t2.status} ${t2.body.slice(0, 120)}`);

  // 3. Reject a non-http base URL (the validation that runs before `save`).
  const bad = await request('POST', '/api/settings', { baseUrl: 'ftp://nope' });
  check('non-http baseUrl is refused with 400', bad.status === 400, `status ${bad.status}`);

  // 4. Round-trip a write, through the atomic replace.
  const wrote = await request('POST', '/api/settings', {
    apiKey: 'sk-probe-abcdef123456', baseUrl: 'https://probe.test/v1', model: 'probe-model',
  });
  const wroteBody = JSON.parse(wrote.body);
  check('POST /api/settings succeeds', wrote.status === 200, `status ${wrote.status}`);
  check('the write is echoed WITHOUT the key',
    !wrote.body.includes('sk-probe-abcdef123456'), wrote.body.slice(0, 160));
  check('echo reports hasKey:true and a masked hint',
    wroteBody.settings.hasKey === true && /3456$/.test(wroteBody.settings.keyHint || ''),
    JSON.stringify(wroteBody.settings));

  // 5. It must have actually landed on disk, and be readable on a fresh GET.
  const reread = await getJson('/api/settings');
  check('GET reflects the write', reread.settings.model === 'probe-model');
  check('GET still hides the key', reread.settings.hasKey === true);

  // 6. Now configured: the gate must OPEN (health + the test route proceed).
  const now = await getJson('/api/health');
  check('after configuring: modelConfigured is TRUE', now.modelConfigured === true, JSON.stringify(now));

  // 7. An empty apiKey is meaningful ("clear it"), not ignored.
  const cleared = await request('POST', '/api/settings', { apiKey: '' });
  check('empty apiKey clears the key', JSON.parse(cleared.body).settings.hasKey === false);
  const afterClear = await getJson('/api/health');
  check('clearing the key closes the gate again', afterClear.modelConfigured === false);

  console.log(failures === 0 ? '\nPACKAGED-EXE SETTINGS-WRITE CHECKS PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
