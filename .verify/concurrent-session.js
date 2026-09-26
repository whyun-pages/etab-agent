'use strict';
/**
 * Concurrency probe: concurrent appends must not lose an update.
 *
 * Why this file exists
 * --------------------
 * `SessionStore.append` is read-modify-write:
 *
 *     load(id)  ->  messages.push(msg)  ->  save(session)
 *
 * Today every step is synchronous, so the whole sequence is atomic with respect
 * to the event loop: two "concurrent" appends cannot interleave, and no update
 * is lost — not because the code arranges it, but because `*Sync` cannot yield.
 *
 * The planned change (AGENTS.md: I/O must be asynchronous) replaces the `*Sync`
 * calls with `await`. That is where the bug arrives. Once `load` awaits, this
 * window opens:
 *
 *     A: load ...        (await, yields)
 *     B: load ...        (await, yields — A has not saved yet)
 *     A: push, save      (A's message persisted)
 *     B: push, save      (B wrote from a snapshot taken before A's save)
 *
 * A's message is gone. Nothing throws, nothing logs, and a test suite that fires
 * requests one at a time sees a perfect green run. That is the failure this
 * probe is built to catch: it must PASS on the current synchronous
 * implementation and it must PASS again after the async conversion — and it is
 * expected to FAIL in between, against a conversion that swapped the call style
 * without adding serialisation. A red run here means the serialisation is
 * missing, not that the probe is wrong.
 *
 * Why it is probabilistic
 * -----------------------
 * The probe cannot force an interleaving from outside the module: it has no hook
 * into the await boundary. So it fires many concurrent appends across several
 * rounds, which makes a naive conversion lose a message with near-certainty,
 * but does not *prove* serialisation. The property being asserted is real; the
 * detection is by volume. That is the honest limit of an external probe, and it
 * is why the permanent version of this test belongs next to the store.
 *
 * What a missing serialiser actually looks like (measured)
 * -------------------------------------------------------
 * Removing the queue and re-running this probe does NOT produce a clean "lost N
 * messages" — it throws first, and the thrown error is worth knowing:
 *
 *   - Before unique temp names: ENOENT on `rename`. Every concurrent write
 *     reused `${target}.tmp`, so the first rename moved the shared temp file
 *     away and the rest found nothing to move.
 *   - After unique temp names: EPERM on `rename`. The temp paths no longer
 *     collide, but Windows refuses two concurrent renames onto the SAME
 *     destination while it is being replaced.
 *
 * Both are reported as a FAIL (the probe exits non-zero either way), and both
 * are the serialisation being absent. The lesson is that the queue protects
 * against more than the lost-update story in the module header: on Windows the
 * atomic-write pattern itself is not concurrency-safe without it.
 *
 * The probe therefore fails LOUDLY and EARLY when the queue is gone. If you want
 * to watch the lost-update variant specifically, you have to remove the queue
 * AND stub the rename to be a no-op — deliberately not done here, because a
 * probe that needs a stub to show its own bug is testing the stub.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionStore } = require('../lib/session-store');

const CONCURRENCY = 50;
const ROUNDS = 5;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message}`);
  }
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-session-'));

/**
 * Call a store method and normalise the result to a promise.
 *
 * This is what lets one probe cover both shapes: while the store is synchronous
 * the calls run back to back, and once it is asynchronous they genuinely
 * interleave. The probe does not need to know which one it is looking at.
 */
function call(fn) {
  return Promise.resolve().then(fn);
}

async function main() {
  console.log('concurrent session-store appends');

  // The core property: N concurrent appends, N messages on disk.
  for (let round = 1; round <= ROUNDS; round += 1) {
    const dir = tmpdir();
    const store = new SessionStore(dir);
    const session = await call(() => store.create('并发测试'));

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        call(() => store.append(session.id, {
          role: 'user',
          content: `msg-${round}-${i}`,
          at: new Date().toISOString(),
        }))),
    );

    await checkAsync(`round ${round}: ${CONCURRENCY} concurrent appends keep all ${CONCURRENCY} messages`, async () => {
      const loaded = await store.load(session.id);
      assert.ok(loaded, 'the session must still load');
      assert.strictEqual(
        loaded.messages.length,
        CONCURRENCY,
        `lost ${CONCURRENCY - loaded.messages.length} message(s) to interleaving`,
      );
    });

    await checkAsync(`round ${round}: the surviving messages are the ones that were written`, async () => {
      const loaded = await store.load(session.id);
      const got = new Set(loaded.messages.map((m) => m.content));
      const want = Array.from({ length: CONCURRENCY }, (_, i) => `msg-${round}-${i}`);
      const missing = want.filter((w) => !got.has(w));
      assert.deepStrictEqual(missing, [], `these messages were lost: ${missing.join(', ')}`);
    });

    await checkAsync(`round ${round}: no temp files are left behind`, () => {
      const strays = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
      assert.deepStrictEqual(strays, [], `stray temp files: ${strays.join(', ')}`);
    });
  }

  // A different shape of the same hazard: appends to distinct sessions run at
  // once. These must not corrupt each other's files — a per-file serialiser
  // that keys on the wrong thing would pass the test above and fail this one.
  {
    const dir = tmpdir();
    const store = new SessionStore(dir);
    const sessions = [];
    for (let i = 0; i < 8; i += 1) sessions.push(await call(() => store.create(`session-${i}`)));

    await Promise.all(sessions.flatMap((s, si) =>
      Array.from({ length: 6 }, (_, m) =>
        call(() => store.append(s.id, { role: 'assistant', content: `s${si}-${m}` })))));

    await checkAsync('appends across distinct sessions do not interfere', async () => {
      for (let i = 0; i < sessions.length; i += 1) {
        const loaded = await store.load(sessions[i].id);
        assert.strictEqual(loaded.messages.length, 6, `session ${i} has ${loaded.messages.length} messages, expected 6`);
        assert.ok(
          loaded.messages.every((m) => m.content.startsWith(`s${i}-`)),
          `session ${i} picked up a message from another session`,
        );
      }
    });
  }

  // Interleaved creates must each land, and each must keep its own title.
  {
    const dir = tmpdir();
    const store = new SessionStore(dir);
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call(() => store.create(`title-${i}`))),
    );
    await checkAsync('concurrent creates all land, with their own titles', async () => {
      const ids = new Set(created.map((s) => s.id));
      assert.strictEqual(ids.size, 20, 'create() handed out a duplicate id');
      for (const s of created) {
        const loaded = await store.load(s.id);
        assert.ok(loaded, `session ${s.id} did not persist`);
        assert.strictEqual(loaded.title, s.title);
      }
    });
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
