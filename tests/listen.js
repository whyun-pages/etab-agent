'use strict';
/**
 * Listen on a free 127.0.0.1 port that `fetch` will actually talk to.
 *
 * Node's `fetch` (undici) refuses the WHATWG "bad ports" — 5060, 6000,
 * 6665–6669, 10080 and friends — with `TypeError: fetch failed` /
 * `cause: bad port`, before any connection is made. `listen(0)` takes
 * whatever the OS hands out, and on a machine whose dynamic port range starts
 * low (this one's is 1024–15000; Windows' default is 49152+) a few of those
 * are in range. The result was a test failing at random, a fraction of a
 * percent per server, a few percent per full run — once blamed on keep-alive
 * sockets. So: take the port, and if it is one fetch refuses, take another.
 */

// https://fetch.spec.whatwg.org/#port-blocking
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Resolves with the port once `server` listens on one fetch accepts. */
async function listenLocal(server, host = '127.0.0.1') {
  for (;;) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => { server.off('error', reject); resolve(); });
    });
    const { port } = server.address();
    if (!BAD_PORTS.has(port)) return port;
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { listenLocal, BAD_PORTS };
