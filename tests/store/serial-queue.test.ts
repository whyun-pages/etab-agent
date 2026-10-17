'use strict';
/**
 * Tests for the queue both stores run their public methods through.
 */

import test from 'node:test';
import assert from 'node:assert';

import { SerialQueue } from '../../src/store/serial-queue.ts';

const later = (ms: number, v?: unknown) => new Promise((r) => setTimeout(() => r(v), ms));

test('functions run one at a time, in the order they were queued', async () => {
  const q = new SerialQueue();
  const log: string[] = [];
  const job = (name, ms) => async () => {
    log.push(`${name} start`);
    await later(ms);
    log.push(`${name} end`);
    return name;
  };
  // The first is the slowest: without the queue it would finish last.
  const results = await Promise.all([q.run(job('a', 30)), q.run(job('b', 1)), q.run(job('c', 10))]);
  assert.deepStrictEqual(results, ['a', 'b', 'c']);
  assert.deepStrictEqual(log, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

test('a failure reaches its own caller and does not stop the queue', async () => {
  const q = new SerialQueue();
  const failed = q.run(async () => {
    throw new Error('boom');
  });
  const after = q.run(() => 'still runs');
  await assert.rejects(failed, /boom/);
  assert.strictEqual(await after, 'still runs');
});

test('a synchronous function is queued too', async () => {
  const q = new SerialQueue();
  const order: number[] = [];
  const slow = q.run(async () => {
    await later(10);
    order.push(1);
  });
  const sync = q.run(() => order.push(2));
  await Promise.all([slow, sync]);
  assert.deepStrictEqual(order, [1, 2]);
});
