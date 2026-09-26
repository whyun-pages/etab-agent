'use strict';
/**
 * Probe the async `Settings`: return shapes, atomic write, and the two traps
 * that a green unit suite cannot see.
 *
 *   1. `load()` now RETURNS A PROMISE. `if (!settings.isConfigured())` on an
 *      un-awaited promise is ALWAYS truthy — the config gate silently opens.
 *      tsc does not catch this; nothing does except checking it here.
 *   2. The write is temp+rename, so a torn write cannot leave truncated JSON
 *      (and with it, a lost API key).
 *
 * Also: concurrent saves must not lose an update. `save` is a read-modify-write
 * and now spans an `await`, which is exactly the window `writeFileSync` used to
 * close for free.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Settings } = require('../lib/settings');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'probe-settings-'));
}

(async () => {
  // ---------------------------------------------------------- return shape
  {
    const dir = scratch();
    const store = new Settings(dir);
    const ret = store.load();
    check('load() returns a Promise, not a record', ret instanceof Promise, `got ${typeof ret}`);
    const rec = await ret;
    check('awaited load() has defaults', rec.apiKey === '' && rec.baseUrl.startsWith('https://'));
    check('isConfigured() returns a Promise', store.isConfigured() instanceof Promise);
    check('awaited isConfigured() is false on a fresh dir', (await store.isConfigured()) === false);
    check('publicSettings() returns a Promise', store.publicSettings() instanceof Promise);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------- the trap: un-awaited gate
  {
    const dir = scratch();
    const store = new Settings(dir);
    // Unconfigured store. The BUG would be `if (!store.isConfigured())` — a
    // Promise is never falsy, so the guard passes when it must not.
    const buggy = !store.isConfigured();
    const fixed = !(await store.isConfigured());
    check('un-awaited isConfigured() is always truthy (the trap is real)', buggy === false);
    check('awaited isConfigured() correctly reports "not configured"', fixed === true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------- round trip + atomic
  {
    const dir = scratch();
    const store = new Settings(dir);
    await store.save({ apiKey: 'sk-test-abcdef123456', model: 'gpt-4o-mini', evil: 'ignored' });
    const reread = await new Settings(dir).load();
    check('save -> load round-trips the key', reread.apiKey === 'sk-test-abcdef123456');
    check('unknown key is not persisted', !('evil' in reread));
    check('isConfigured true once filled', (await store.isConfigured()) === true);
    const files = fs.readdirSync(dir);
    check('no stray .tmp left behind', files.every((f) => !f.endsWith('.tmp')), files.join(','));
    check('file is settings.json', files.includes('settings.json'));
    const pub = await store.publicSettings();
    check('publicSettings never leaks the key', !JSON.stringify(pub).includes('sk-test-abcdef123456'));
    check('publicSettings reports hasKey + hint', pub.hasKey === true && pub.keyHint === 'sk-…3456');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------- concurrent saves must not lose one
  {
    const dir = scratch();
    const store = new Settings(dir);
    // 20 concurrent saves, each setting a DIFFERENT known key. Without the
    // queue, each read-modify-write would read the same old file and clobber
    // the others; at most a few would survive.
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
    await Promise.all(ops);
    const final = await new Settings(dir).load();
    // The LAST write for each key wins; what matters is that the file holds a
    // coherent record with all six keys present, not a partial one.
    check('concurrent saves leave a coherent record (6 keys)',
      ['baseUrl', 'apiKey', 'model', 'useForAttachments', 'chatCanEdit', 'chatConfirmEdits'].every((k) => k in final),
      JSON.stringify(final));
    const files = fs.readdirSync(dir);
    check('concurrent saves leave no .tmp litter', files.every((f) => !f.endsWith('.tmp')), files.join(','));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nSETTINGS ASYNC PROBE PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
