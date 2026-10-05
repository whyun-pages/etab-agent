# AGENTS.md

Conventions for this repository. Read before changing code.

## I/O must be asynchronous

Use the asynchronous form of every `fs` operation. Do not use the `*Sync` variants.

```js
// Yes
const raw = await fs.promises.readFile(file, 'utf8');
await fs.promises.mkdir(dir, { recursive: true });
await fs.promises.writeFile(target, json, { mode: 0o600 });
await fs.promises.rename(tmp, target);

// No
const raw = fs.readFileSync(file, 'utf8');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, json, { mode: 0o600 });
fs.renameSync(tmp, target);
```

### Why

**The server is one process serving one event loop.** Every `*Sync` call blocks that
loop, and while it is blocked *every* in-flight request waits — including ones
that have nothing to do with the file being read. A `readFileSync` on a large
upload, a slow disk, or a misconfigured network share stalls the whole app, not
just the caller.

This matters more here than in a typical CLI, because the app is a long-running
HTTP server with a model call in the middle of it. Model calls already take
seconds; nothing that touches the filesystem should add to that.

**The call sites are on the request path.** The sync calls that exist today are in
`lib/settings.js`, `lib/session-store.js` and `lib/assets.js` — all of which run
inside request handling. `settings.load()` in particular runs on nearly every
settings read.

### Where the rule applies

| Path | Applies? |
|---|---|
| `lib/**` | **Yes** — this is the server, and it is the whole point |
| `server.ts`, `desktop.ts` | **Yes** for anything after `listen()`; startup before the server is up may use sync |
| `tools/**` | No — one-shot build scripts, nothing is waiting on them |
| `tests/**`, `.verify/**` | No — test setup and teardown may use sync; it is clearer that way |
| `public/**` | No — browser code, no `fs` at all |

### Deliberate exceptions, and how to write them

Three things genuinely need synchronous semantics. If you touch these, keep them
sync and add a comment saying why.

**1. Module-load-time work.** A `require` cannot await. Top-level work that must
finish before the module is usable stays sync — this is already the case in
`lib/zip.ts` (building the CRC-32 lookup table) and is inherent, not a shortcut.

**2. Atomic replace on shutdown.** Shutdown paths that must complete before the
process exits cannot yield to the event loop. `desktop.ts` removes its
`instance.json` in a `process.on('exit')` handler; an `await` there would simply
never run.

**3. `lib/assets.ts` — synchronous by API shape.** `loadSea()`, `readAsset()` and
`isPackaged()` are synchronous, and so is everything they call: `sea.getAsset()`
is a synchronous API, and the `try` around `require('node:sea')` is what makes
the lookup allowed to fail (a static `import` would throw at module load and take
down every consumer). `readAsset` is on the static-file hot path and its caller
IS async, so it could be converted — but only by making `loadSea`/`isPackaged`
async too, which buys nothing: there is no I/O to overlap, and `getAsset` returns
a value, not a promise. Converting half of it would be worse than converting
none. This is a decision, not an oversight.

Everything else converts. If you believe a call site needs to stay sync and it is
not one of the three above, say so in review rather than reaching for `*Sync`.

`desktop.ts` keeps its remaining `*Sync` calls deliberately: they all run BEFORE
`listen()` (resolving the Edge path, reading/writing `instance.json`, creating
directories), which the table above already permits. `lib/zip.ts`'s
`inflateRawSync`/`deflateRawSync` are pure CPU on in-memory buffers — `node:zlib`'s
sync API is the only one that fits a synchronous `readZip`/`writeZip` contract,
and no file descriptor is involved.

### The trap this rule creates

**Converting `*Sync` to `await` introduces interleaving that did not exist before.**
`writeFileSync` was atomic with respect to the event loop: two concurrent saves
could not interleave. Two concurrent `await writeFile` calls *can*.

This project writes JSON state files with a deliberate temp-file-plus-rename
sequence, and that pattern is only safe if the read-modify-write around it does
not interleave:

```
read current -> merge -> write temp -> rename
```

If two operations interleave between "read current" and "rename", one update is
lost. When you convert a store like this, you must also serialise access — a
promise queue per instance — **in the same change**. A conversion that only swaps
the call style while quietly dropping the serialisation that `*Sync` was
providing is a data-loss bug that will not show up in a test suite that runs
requests one at a time.

**How it is actually done here — `lib/session-store.ts`:**

- Every public method runs through `#run`, a per-instance promise queue. The
  internals (`#loadFile`, `#writeFile`, ...) are private and NEVER call back into
a public method: `prune` -> `list` -> `load` would each wait for the slot held by
the outermost call, and deadlock.
- The temp file name is unique per write (`<id>.<random>.tmp`), not a shared
  `<id>.json.tmp`. Two writers sharing one temp path is not a lost update, it is a
  hard `ENOENT`/`EPERM` on Windows (the platform also refuses two concurrent
  renames onto the same destination).

**The part that is easy to miss: the queue only covers the store.**

A route that does `await store.load(id)` -> `await runAgentTurn(...)` ->
`await store.save(snapshot)` has a critical section spanning the MODEL CALL,
which is outside the store and therefore unprotected. Two concurrent turns each
write back a snapshot predating the other; one turn's messages vanish silently.
Measured: 12 concurrent turns left 4 of 26 messages on disk.

So a read-modify-write that spans slow work must run inside the store, not around
it — `store.update(id, (current) => ...)` loads and writes in one queue slot, and
the caller folds in only the *result* of the slow work. **Never write a whole
record from a snapshot taken before an `await`.**

→ The general lesson: the cost of async conversion is not in the function you
changed, it is in every CALLER that did `read -> wait -> write`. Those callers
silently went from atomic to racy.

## Other conventions

- **Erasable TypeScript only.** See `tsconfig.json` (`erasableSyntaxOnly`) and the
  notes at the top of `lib/zip.ts`. No `enum`, no `namespace`, no parameter
  properties, no `export =`, no `import x = require(...)`. Node strips types; it
  does not transform them.
- **ESM source, CommonJS emit.** Write `import`/`export` in `.ts`; `tsc`
  (`module: commonjs`) emits the CJS the bundler needs. Relative specifiers keep
  the `.ts` extension — `rewriteRelativeImportExtensions` rewrites them to `.js`
  in the emitted require. A bare `require()` call is NOT rewritten, so do not add
  new ones. The single deliberate exception is the guarded `require('node:sea')`
  in `lib/assets.ts`, which must stay lazy so its `try/catch` still works.
- **Determinism is a feature.** Same input, same output bytes. Do not introduce
  clocks, random ordering, or `Object.keys` iteration over unordered input into
  anything that produces a file.
- **Comments explain why.** This codebase documents the reasoning behind decisions,
  including rejected alternatives. Keep that up; do not strip it as noise.
