'use strict';
/**
 * SABOTAGE CHECK for .verify/probe-settings-async.cjs.
 *
 * A probe that passes both with and without the thing it claims to test is
 * worthless. This removes the serialisation from `Settings#run` in a COPY of
 * the built module and re-runs the concurrency assertion, expecting it to FAIL.
 *
 * If it still passes, the probe is not measuring the queue.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILT = path.join(__dirname, '..', '.build', 'js', 'lib', 'settings.js');
const src = fs.readFileSync(BUILT, 'utf8');

// The compiled form of `#run` chains onto `this.tail`. Replace the chaining
// with a straight-through call: `fn()` runs immediately, no queue.
const chained = /run\(fn\)\s*\{\s*const run = this\.tail\.then\(fn, fn\);/;
if (!chained.test(src)) {
  console.error('sabotage: could not find the chaining line — the compiled shape changed.');
  console.error('Look for `const run = this.tail.then(fn, fn);` in .build/js/lib/settings.js');
  process.exit(2);
}

const sabotaged = src.replace(
  chained,
  'run(fn) {\n    const run = Promise.resolve().then(fn);',
);

// Write the sabotaged module next to a shim that the probe loads instead.
const shop = path.join(__dirname, 'sabotage-settings.js');
fs.writeFileSync(shop, sabotaged, 'utf8');
console.log('sabotage: wrote', path.relative(process.cwd(), shop));

// Re-run the concurrency section against the sabotaged class.
const { Settings } = require(shop);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabotage-settings-'));
  const store = new Settings(dir);
  const keys = ['baseUrl', 'apiKey', 'model', 'useForAttachments', 'chatCanEdit', 'chatConfirmEdits'];
  const ops = [];
  for (let i = 0; i < 20; i++) {
    const k = keys[i % keys.length];
    const v = k === 'baseUrl' ? `https://host-${i}.test/v1`
      : k === 'apiKey' ? `sk-${i}`
        : k === 'model' ? `model-${i}`
          : Boolean(i % 2);
    ops.push(store.save({ [k]: v }));
  }

  // Without the queue, concurrent writers share the same destination: Windows
  // refuses the second rename with EPERM. A THROWN ERROR here is itself the
  // sabotage observed — that is the crash, not a lost update, and it is a
  // harder failure to read than the one it replaces.
  try {
    await Promise.all(ops);
  } catch (err) {
    fs.rmSync(shop, { force: true });
    console.log(`sabotage: concurrent saves threw ${err.code} — ${err.syscall}`);
    if (err.code === 'EPERM' || err.code === 'ENOENT') {
      console.log('\nSABOTAGE OBSERVED: the concurrency assertion is load-bearing.');
      console.log('(the queue is what turns this crash back into a serialised write)');
      process.exit(0);
    }
    throw err;
  }

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  console.log('on-disk record:', JSON.stringify(onDisk));
  const present = keys.filter((k) => k in onDisk);
  console.log(`keys present: ${present.length}/6`);

  const litter = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  console.log('tmp litter:', litter.length ? litter.join(', ') : 'none');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(shop, { force: true });

  if (present.length < keys.length || litter.length) {
    console.log('\nSABOTAGE OBSERVED: the concurrency assertion is load-bearing.');
    process.exit(0);
  }
  console.log('\nNO SABOTAGE OBSERVED: the probe does NOT measure the queue — it is a blank sheet.');
  process.exit(1);
})();
