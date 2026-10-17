'use strict';
/**
 * One instance per data folder: the running one publishes its port, and a
 * second launch finds it, opens a window at it, and exits.
 */

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

// ------------------------------------------------------------ single instance

/**
 * Why this exists
 * ---------------
 * Edge is single-instance per profile. When a window for the profile is already
 * open, the msedge.exe we spawn hands the request to the running instance and
 * exits within a few hundred milliseconds — which looks exactly like "the user
 * closed the window". Treating it as such shut the server down underneath a
 * window still on screen, and the user got ERR_CONNECTION_REFUSED.
 *
 * The fix is not to guess at the exit code but to not create the situation: a
 * second launch finds the first one's published port, opens a window at it, and
 * exits without ever starting a server of its own.
 *
 * The record lives in the data directory. It is only advisory: on a stale entry
 * (crash, power loss) the probe below fails and we start normally, overwriting
 * it.
 */
function instanceRecordPath(dataDir: string): string {
  return path.join(dataDir, 'instance.json');
}

/** The published record as it is read back. Advisory only, so its fields are. */
interface InstanceRecord {
  port: number;
  pid?: number;
}

/**
 * Is something answering as this app on that port?
 *
 * http.get, not fetch: fetch refuses the "bad ports" (6000, 5060, 6665-6669,
 * 10080 ...), and the instance's port is whatever the OS handed out for port
 * 0. A refused probe reads as "no instance", so the second launch would start
 * a server of its own instead of handing off.
 */
function probeHealth(port: number, timeoutMs = 1200): Promise<{ port: number } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      let s = '';
      res.on('data', (d) => {
        s += d;
      });
      res.on('end', () => {
        // Require our own identity, not just any 200: some unrelated dev server
        // on that port must not be mistaken for a running instance.
        //
        // `app` is a fixed string rather than a field that can be removed. An
        // earlier version keyed on `templates`, which vanished when the template
        // concept was dropped — and single-instance detection then failed
        // silently, restarting a server on every launch. Identity that cannot be
        // deleted is the point.
        try {
          const j = JSON.parse(s);
          resolve(j && j.ok === true && j.app === 'tab-agent' ? { port } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Read the published port, if a live instance still answers on it. */
export async function findRunningInstance(dataDir: string): Promise<{ port: number; pid: number | undefined } | null> {
  const file = instanceRecordPath(dataDir);
  let rec: InstanceRecord;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!rec || !Number.isInteger(rec.port)) return null;
  const alive = await probeHealth(rec.port);
  if (!alive) {
    // Stale record from a crash. Clear it so it cannot mislead a later launch.
    try {
      fs.unlinkSync(file);
    } catch {}
    return null;
  }
  return { port: rec.port, pid: rec.pid };
}

export function publishInstance(dataDir: string, port: number): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      instanceRecordPath(dataDir),
      JSON.stringify(
        {
          port,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* advisory only; never fatal */
  }
}

export function unpublishInstance(dataDir: string): void {
  try {
    fs.unlinkSync(instanceRecordPath(dataDir));
  } catch {}
}
