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
`src/store/settings.ts`, `src/store/session-store.ts` and `src/platform/assets.ts` — all of which run
inside request handling. `settings.load()` in particular runs on nearly every
settings read.

### Where the rule applies

| Path | Applies? |
|---|---|
| `src/**` (except the entries below) | **Yes** — this is the server, and it is the whole point |
| `src/server.ts`, `src/desktop.ts`, `src/desktop/**` | **Yes** for anything after `listen()`; startup before the server is up may use sync (and see the desktop note below) |
| `tools/**` | No — one-shot build scripts, nothing is waiting on them |
| `tests/**`, `.verify/**` | No — test setup and teardown may use sync; it is clearer that way |
| `public/**` | No — browser code, no `fs` at all |

### Deliberate exceptions, and how to write them

Three things genuinely need synchronous semantics. If you touch these, keep them
sync and add a comment saying why.

**1. Module-load-time work.** A `require` cannot await. Top-level work that must
finish before the module is usable stays sync — this is already the case in
`src/formats/zip.ts` (building the CRC-32 lookup table) and is inherent, not a shortcut.

**2. Shutdown.** A shutdown path that must complete before the process exits
cannot wait on the event loop. The desktop's `shutdown()` (src/desktop.ts,
run from its SIGINT/SIGTERM/SIGHUP handlers and when the window closes)
removes `instance.json` with `unlinkSync` and then schedules the exit; an
`await` there could lose the race with that exit.

**3. `src/platform/assets.ts` — synchronous by API shape.** `loadSea()`, `readAsset()` and
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

The desktop entry (src/desktop.ts and src/desktop/) keeps its other `*Sync` calls
deliberately. Most run BEFORE `listen()` — finding Edge, reading or clearing a
stale `instance.json`, creating the data folder — which the table permits. Two
run just after it, once per process: publishing `instance.json` and creating
the window's profile folder. Both happen before the window that would send the
first request exists, so nothing of the app's is waiting on them. `src/formats/zip.ts`'s
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

**How it is actually done here — `src/store/session-store.ts`:**

- Every public method runs through `#run`, a per-instance promise queue
  (`SerialQueue`, src/store/serial-queue.ts, shared with settings). The
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

The turn route applies this to the workbook itself: the agent returns the list of
edit operations it performed (`TurnResult.ops`), and the route replays them on
`current.spec` inside `update` (`applyOps` in `src/workbook/spec-ops.ts`, pure and
deterministic) instead of writing back the spec the turn computed from its
snapshot. When the operations no longer fit the newer table, nothing lands and
the reply says so.

→ The general lesson: the cost of async conversion is not in the function you
changed, it is in every CALLER that did `read -> wait -> write`. Those callers
silently went from atomic to racy.

## Layout

`src/` is layered; a module imports only from its own layer or below:

```
http/       Koa app, per-process AppState, respond.ts (the shared answers),
            projections.ts (what the client is shown), routes/
agent/      the turn (agent.ts and its parts), model access (llm, model, pi);
            tools/ is what the model may call: tools.ts picks the turn's
            tools, defs/ defines them (one file per tool, the edit tools in
            one table), pi-tools/ is pi's file and shell tools, and the rest
            of tools/ is what those tools say to the model
store/      settings, session-store — state on disk, each behind its own SerialQueue
access/     reaching outside the app under rules: fetch (public addresses
            only, the blocklist, limits) and file-access (what may be read or
            written on disk, the reading, the deferred writes). No text for
            the model here — routes and settings use these too
workbook/   spec validation and writing, spec-ops, table-query, preview, export
ingest/     an uploaded or fetched file -> text or rows: one module per kind
            (csv, json, markup, m3u, image, archive), ingest.ts dispatches
formats/    zip, xlsx, xlsx-writer, xls — the file formats themselves
platform/   SEA assets, open-with-system — usable from any layer
```

`agent/` and `store/` are one level: `store/settings` validates against the
protocol definitions in `agent/`. `access/` is below both (settings checks
the file-access mode, the agent's tools run through it) and above `workbook/` and `ingest/` —
`ingest/` reads what it fetches or opens. `workbook/` and `ingest/` are one level,
and do not import each other. Nothing in `access/`, `workbook/`, `ingest/` or
`formats/` may import upward.

Tests mirror `src/`: the test for `src/<layer>/<module>.ts` is
`tests/<layer>/<module>.test.ts`. A test that drives several modules goes where
its entry point lives — everything that goes in over HTTP is under `tests/http/`.
When one module's tests outgrow a file, split them by topic as
`<module>.<topic>.test.ts` (`agent.guard.test.ts`, `session-api.turn.test.ts`),
so the name still leads back to the module. Shared fixtures and harnesses —
the scripted-model turn, the scripted-model server — live in `tests/helpers/`.

Tests are `.ts` and import the source directly (`../../src/formats/xlsx.ts`); they
run through tsx, so they never see `.build/js/`. `pnpm bundle` is what
exercises the compiled tree — keep it after the tests in CI. `.verify/`
scripts stay JavaScript and load the source with `require('tsx/cjs')`.

## Formatting and lint

Biome (`biome.jsonc`) owns formatting; do not hand-format against it. Run
`pnpm format` before committing, or let VS Code do it on save
(`.vscode/settings.json`). CI runs `biome ci .`, which fails on an unformatted
file or a lint error. A rule that is switched off in `biome.jsonc` says why
next to it; switch one back on in its own commit, with the fixes.

A commit that only reformats goes into `.git-blame-ignore-revs`.

## Other conventions

- **Erasable TypeScript only.** See `tsconfig.json` (`erasableSyntaxOnly`) and the
  notes at the top of `src/formats/zip.ts`. No `enum`, no `namespace`, no parameter
  properties, no `export =`, no `import x = require(...)`. Node strips types; it
  does not transform them.
- **ESM source, CommonJS emit.** Write `import`/`export` in `.ts`; `tsc`
  (`module: nodenext`, with `package.json` `type: commonjs`) emits CJS. Relative
  specifiers keep the `.ts` extension — `rewriteRelativeImportExtensions`
  rewrites them to `.js` in the emitted require. A bare `require()` call is NOT
  rewritten, so do not add new ones. The single deliberate exception is the
  guarded `require('node:sea')` in `src/platform/assets.ts`, which must stay lazy so its
  `try/catch` still works.
- **ESM-only dependencies load through `import()`, in one place.** pi-agent
  (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`) ships ESM with only an
  `import` condition, so a CommonJS `require` of it cannot resolve. `src/agent/pi.ts`
  loads it with a dynamic `import()` — kept verbatim in the emit because the
  module setting is `nodenext`; `module: commonjs` would rewrite it into a
  `require` and break it. Everywhere else, use `import type` for pi's types and
  `loadPi()` for its values. Do not add a value import of either package.
- **Determinism is a feature.** Same input, same output bytes. Do not introduce
  clocks, random ordering, or `Object.keys` iteration over unordered input into
  anything that produces a file.
- **Comments explain why.** This codebase documents the reasoning behind decisions,
  including rejected alternatives. Keep that up; do not strip it as noise.
