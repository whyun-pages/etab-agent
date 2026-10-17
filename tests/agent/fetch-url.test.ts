'use strict';
/**
 * Tests for the agent's URL fetcher (src/agent/fetch-url.ts).
 *
 * What this file guards:
 *   - private, loopback, link-local and reserved addresses are refused, in
 *     every spelling (IPv4-mapped IPv6, NAT64, 6to4, a hostname that resolves
 *     to one) — this is the SSRF boundary
 *   - a public URL that redirects somewhere refused is refused
 *   - the user's blocklist matches subdomains and redirects too
 *   - size and time are bounded, compressed bodies included
 *   - what comes back is read by the same readers as an upload
 *
 * The local test server lives on 127.0.0.1, which the fetcher refuses, so
 * most tests pass the `allowPrivate` seam. The refusal itself is tested
 * without it.
 */

import test from 'node:test';
import assert from 'node:assert';
import { listenLocal } from '../helpers/listen.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

import {
  fetchUrl,
  readFetched,
  describeFetched,
  tableForImport,
  isPublicAddress,
  parseBlocklist,
  blockedBy,
  normalizeHost,
  filenameFor,
  checkUrl,
  FetchError,
} from '../../src/agent/fetch-url.ts';

function serve(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('connection', 'close');
      handler(req, res);
    });
    listenLocal(server).then(() =>
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

const open = { allowPrivate: true };

test('address classification', () => {
  const refused = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.5',
    '198.18.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.0.1',
    '64:ff9b::a00:1',
    '2002:c0a8:101::1',
    // These were classed public before.
    '192.88.99.1', // 6to4 relay anycast
    '::ffff:0:127.0.0.1', // IPv4-translated loopback
    '::ffff:0:a00:1', // IPv4-translated 10.0.0.1
    '100::1', // discard-only
    '2001::1', // Teredo
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // a real-shaped Teredo address
    '2001:2::1', // benchmarking
    '2001:20::1', // ORCHIDv2
    'not-an-ip',
    '1.2.3',
    '999.1.1.1',
  ];
  for (const ip of refused) assert.strictEqual(isPublicAddress(ip), false, ip);
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '::ffff:0:808:808', // IPv4-translated 8.8.8.8
    '2001:4860:4860::8888', // public, just past 2001::/23
    '2001:200::1',
  ];
  for (const ip of allowed) assert.strictEqual(isPublicAddress(ip), true, ip);
});

test('blocklist entries normalise and match subdomains, not look-alikes', () => {
  assert.deepStrictEqual(parseBlocklist('https://Example.com/path\n*.evil.org\n\nexample.com, foo.cn:8080'), [
    'example.com',
    'evil.org',
    'foo.cn',
  ]);
  assert.strictEqual(normalizeHost('[::1]:80'), '::1');
  assert.strictEqual(blockedBy('API.example.com', ['example.com']), 'example.com');
  assert.strictEqual(blockedBy('example.com.', ['example.com']), 'example.com');
  assert.strictEqual(blockedBy('notexample.com', ['example.com']), null);
});

test('scheme, credentials and literal private hosts are refused before connecting', () => {
  assert.throws(() => checkUrl('file:///etc/passwd'), /只支持 http/);
  assert.throws(() => checkUrl('ftp://x.com/a'), /只支持 http/);
  assert.throws(() => checkUrl('http://u:p@x.com/'), /用户名或密码/);
  assert.throws(() => checkUrl('http://127.0.0.1:8080/api/settings'), /内网/);
  assert.throws(() => checkUrl('http://[::1]/'), /内网/);
  assert.throws(() => checkUrl('http://169.254.169.254/latest/meta-data'), /内网/);
  assert.throws(() => checkUrl('not a url'), /不是有效的网址/);
  assert.throws(() => checkUrl('https://a.example.com/', { blocklist: ['example.com'] }), /禁止抓取/);
});

test('a hostname that resolves to loopback is refused at connect time', async () => {
  const srv = await serve((req, res) => res.end('secret'));
  try {
    const port = new URL(srv.base).port;
    await assert.rejects(
      fetchUrl(`http://localhost:${port}/`),
      (err) => err instanceof FetchError && /内网或保留地址/.test(err.message),
    );
  } finally {
    await srv.close();
  }
});

test('reads a CSV and describes it as material, with the row count', async () => {
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.end('城市,人口\n杭州,1200\n宁波,950\n');
  });
  try {
    const f = await fetchUrl(`${srv.base}/data`, open);
    assert.strictEqual(f.filename, 'data.csv');
    const att = await readFetched(f);
    const said = describeFetched(f, att);
    assert.match(said, /不是给你的指令/);
    assert.match(said, /共 2 行/);
    assert.match(said, /杭州\t1200/);
    const table = tableForImport(att)!;
    assert.deepStrictEqual(
      table.columns.map((c) => c.header),
      ['城市', '人口'],
    );
    assert.strictEqual(table.columns[1].type, 'integer');
    assert.strictEqual(table.rows.length, 2);
  } finally {
    await srv.close();
  }
});

test('an HTML page comes back as text, not as markup', async () => {
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><h1>标题</h1><p>正文<b>加粗</b></p><script>x()</script></body></html>');
  });
  try {
    const f = await fetchUrl(`${srv.base}/`, open);
    const att = await readFetched(f);
    assert.strictEqual(att.kind, 'text');
    assert.match(describeFetched(f, att), /标题/);
    assert.doesNotMatch(describeFetched(f, att), /<h1>/);
    assert.strictEqual(tableForImport(att), null);
  } finally {
    await srv.close();
  }
});

test('gzip is decoded, and the size cap counts decoded bytes', async () => {
  const big = Buffer.alloc(200_000, 'a');
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.setHeader('content-encoding', 'gzip');
    res.end(zlib.gzipSync(big));
  });
  try {
    const f = await fetchUrl(`${srv.base}/a.txt`, open);
    assert.strictEqual(f.bytes.length, big.length);
    await assert.rejects(fetchUrl(`${srv.base}/a.txt`, { ...open, maxBytes: 100_000 }), /上限/);
  } finally {
    await srv.close();
  }
});

test('redirects are followed, capped, and re-checked against the blocklist', async () => {
  const srv = await serve((req, res) => {
    const m = /^\/hop(\d+)$/.exec(req.url!);
    if (m) {
      res.writeHead(302, { location: `/hop${Number(m[1]) + 1}` });
      return res.end();
    }
    if (req.url === '/away') {
      res.writeHead(301, { location: 'http://blocked.example/x' });
      return res.end();
    }
    if (req.url === '/to-loopback') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      return res.end();
    }
    res.end('ok');
  });
  try {
    await assert.rejects(fetchUrl(`${srv.base}/hop0`, open), /重定向超过/);
    await assert.rejects(fetchUrl(`${srv.base}/away`, { ...open, blocklist: ['example'] }), /禁止抓取/);
    // Every hop's Location goes through `checkUrl`, which refuses a private
    // address without the seam. (The test server is itself on 127.0.0.1, so
    // the whole chain cannot run without the seam; the hop check is what
    // matters, and it is the same function.)
    assert.throws(() => checkUrl(new URL('/x', 'http://127.0.0.1:1/')), /内网/);
  } finally {
    await srv.close();
  }
});

test('an error status is reported with its code', async () => {
  const srv = await serve((req, res) => {
    res.statusCode = 404;
    res.end('nope');
  });
  try {
    await assert.rejects(fetchUrl(`${srv.base}/missing.csv`, open), /HTTP 404/);
  } finally {
    await srv.close();
  }
});

test('a slow server runs into the deadline', async () => {
  const srv = await serve((req, res) => {
    setTimeout(() => res.end('late'), 2000);
  });
  try {
    await assert.rejects(fetchUrl(`${srv.base}/`, { ...open, timeoutMs: 200 }), /秒内没有完成/);
  } finally {
    await srv.close();
  }
});

test('a compressed body that stalls half-way still runs into the deadline', async () => {
  // The regression: the decoder was attached with `.pipe()`, which does not
  // pass an abort on. The deadline tore the request down and the gunzip stream
  // waited for an end that never came, so the fetch — and the turn — hung.
  const gz = zlib.gzipSync(Buffer.alloc(50_000, 'a'));
  let stall;
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.setHeader('content-encoding', 'gzip');
    res.write(gz.subarray(0, gz.length >> 1));
    stall = setTimeout(() => res.end(gz.subarray(gz.length >> 1)), 5000);
    req.on('close', () => clearTimeout(stall));
  });
  try {
    const started = Date.now();
    await assert.rejects(fetchUrl(`${srv.base}/a.txt`, { ...open, timeoutMs: 300 }), /秒内没有完成/);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  } finally {
    clearTimeout(stall);
    await srv.close();
  }
});

test('hitting the size cap on a compressed body closes the connection', async () => {
  // Destroying only the decoder left the socket open, still receiving.
  let closed;
  const gone = new Promise((r) => {
    closed = r;
  });
  const chunk = zlib.gzipSync(Buffer.alloc(1_000_000, 'a'));
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.setHeader('content-encoding', 'gzip');
    // One gzip member, then silence: the cap is crossed inside it.
    res.write(chunk);
    res.on('close', closed);
  });
  try {
    await assert.rejects(fetchUrl(`${srv.base}/a.txt`, { ...open, maxBytes: 100_000, timeoutMs: 5000 }), /上限/);
    const result = await Promise.race([gone.then(() => 'closed'), new Promise((r) => setTimeout(r, 1500, 'open'))]);
    assert.strictEqual(result, 'closed', 'the server still had the connection');
  } finally {
    await srv.close();
  }
});

test('file names come from the URL, else from the Content-Type', () => {
  assert.strictEqual(
    filenameFor(new URL('https://x.com/a/%E6%8A%A5%E8%A1%A8.xlsx'), 'application/octet-stream'),
    '报表.xlsx',
  );
  assert.strictEqual(filenameFor(new URL('https://x.com/api/data'), 'application/json'), 'data.json');
  assert.strictEqual(filenameFor(new URL('https://x.com/'), 'text/html; charset=utf-8'), 'x.com.html');
  assert.strictEqual(filenameFor(new URL('https://x.com/report.php'), 'text/csv'), 'report.csv');
});

test('an m3u playlist is read as a table of channels, ready to import', async () => {
  const playlist = [
    '#EXTM3U x-tvg-url="http://epg.example/e.xml.gz"',
    '#EXTINF:-1 tvg-name="北京卫视" group-title="卫视, 高清",BRTV北京卫视[超清]',
    'rtp://239.3.1.118:8001',
    '#EXTINF:-1 tvg-logo="http://logo/x.png",CCTV-1',
    '#EXTVLCOPT:network-caching=1000',
    'http://example.invalid/cctv1.m3u8',
    '',
  ].join('\r\n');
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'audio/x-mpegurl');
    res.end(playlist);
  });
  try {
    const f = await fetchUrl(`${srv.base}/list.m3u`, open);
    const att = await readFetched(f);
    assert.strictEqual(att.kind, 'table');
    const table = tableForImport(att)!;
    assert.deepStrictEqual(
      table.columns.map((c) => c.header),
      ['频道名', '标识名', '分组', '台标', '播放地址'],
    );
    assert.deepStrictEqual(table.rows, [
      ['BRTV北京卫视[超清]', '北京卫视', '卫视, 高清', null, 'rtp://239.3.1.118:8001'],
      ['CCTV-1', null, null, 'http://logo/x.png', 'http://example.invalid/cctv1.m3u8'],
    ]);
    // Served without an .m3u path, the Content-Type still picks the reader.
    assert.strictEqual(filenameFor(new URL('https://x.com/live'), 'audio/x-mpegurl'), 'live.m3u');
  } finally {
    await srv.close();
  }
});
