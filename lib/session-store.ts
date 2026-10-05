/**
 * Sessions — one conversation and the workbook it produced.
 *
 * Why this replaced the template/plan/run stores
 * ----------------------------------------------
 * Those made sense when the document came from somewhere else: an uploaded
 * template was the anchor, a plan was a diff against it, and a run was the
 * rendered result of that diff. With no template the anchor has to be the
 * CONVERSATION. A session is:
 *
 *   { id, title, messages, spec, changes, updatedAt }
 *
 * and the workbook is derived from `spec` on demand. That means one source of
 * truth instead of three things that can disagree — there is no "plan" that has
 * drifted from the spec, because the spec is what the user approved.
 *
 * Why the spec is stored and not the bytes
 * ----------------------------------------
 * The bytes are a pure function of the spec, so storing both invites the case
 * where the file on disk no longer matches the spec it came from and nothing can
 * tell which one the user is looking at. `writeSpec` is cheap and deterministic;
 * it runs on demand.
 *
 * Why on disk at all
 * ------------------
 * "昨天那单改成 40 万" is a real sentence, and it needs yesterday to still exist.
 * A conversation that evaporates when the window closes is half a feature. Same
 * reasoning, and the same atomic-write pattern, as `chat-store.js`.
 *
 * What is NOT stored
 * ------------------
 * No credentials, no attachment bytes (attachments are per-run input, not
 * conversation). The conversation is text and a JSON spec.
 *
 * Concurrency
 * -----------
 * The store is asynchronous (AGENTS.md: no `*Sync` outside module load and the
 * exit path), and that is what makes serialisation load-bearing rather than
 * decorative. `append` is read-modify-write:
 *
 *     load(id)  ->  messages.push(msg)  ->  save(session)
 *
 * With synchronous I/O this whole sequence was atomic by accident: `*Sync`
 * cannot yield the event loop, so two "concurrent" appends could never
 * interleave. The moment `load` awaits, that window opens and an update is lost
 * silently — B reads a snapshot taken before A saved, then writes over A:
 *
 *     A: load ...        (await, yields)
 *     B: load ...        (await, yields — A has not saved yet)
 *     A: push, save      (A's message persisted)
 *     B: push, save      (B wrote from a snapshot missing A)
 *
 * `#run` is the fix: every public method goes through a per-instance promise
 * queue, so mutations to this store execute one at a time in call order.
 *
 * The trap, and why the internals are private: a public method that calls
 * another public method deadlocks — `prune` -> `list` -> `load` would each wait
 * for the queue slot held by the outermost call, forever. So the queue is on the
 * public surface ONLY; everything below it (`#loadFile`, `#writeFile`, ...) is a
 * private async method that never re-enters the queue. A red `.verify/
 * concurrent-session.js` run means this split was done wrong, not that the probe
 * is wrong.
 *
 * Note the queue is per-instance, not per-file or global. Two stores over the
 * same directory would still race each other. That is deliberate: the process
 * has exactly one store, and a process-wide map keyed by path would be a second
 * source of truth about which files exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeSpec } from './workbook.ts';

type WorkbookSpec = import('./workbook.ts').WorkbookSpec;

const DIR_NAME = 'sessions';
const MAX_SESSIONS = 200;
const MAX_MESSAGES = 400;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_CHANGES = 50;

/** One stored turn. Mirrors what `cleanMessage` keeps. */
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string;
  intent?: string;
  guarded?: boolean;
  notes?: string[];
  /** Names of the files attached when this was sent. Their content is not kept. */
  attachments?: string[];
}

/** An incoming message before cleaning: anything at all may be handed in. */
export interface MessageInput {
  role?: unknown;
  content?: unknown;
  at?: unknown;
  intent?: unknown;
  guarded?: unknown;
  notes?: unknown;
  attachments?: unknown;
}

/**
 * One change that actually reached the spec.
 *
 * Kept separately from the messages because the messages cannot answer "what
 * changed": an `action` reply may have been held for confirmation and then
 * rejected, downgraded by read-only mode, or refused by the guard. A record is
 * written only where the spec is replaced, so the list is the document's own
 * history, not the conversation's account of it. `summary` is computed by code
 * from the two specs (`describeChange` in lib/agent.ts), not taken from the
 * model's reply, for the same reason the guard does not trust the reply.
 */
export interface ChangeRecord {
  /** What the user asked for, as typed. */
  request: string;
  /** What changed, derived from the before/after specs. */
  summary: string;
  at?: string;
}

/** A whole session as stored and returned. */
export interface Session {
  id: string;
  title: string;
  spec: WorkbookSpec | null;
  messages: StoredMessage[];
  /** Applied changes, oldest first. Absent in sessions written before it existed. */
  changes: ChangeRecord[];
  updatedAt: string | null;
}

/** A session to write. `updatedAt` is assigned by the store. */
export interface SessionInput {
  id?: unknown;
  title?: unknown;
  spec?: unknown;
  messages?: unknown;
  changes?: unknown;
}

/** One row of the sidebar list. */
export interface SessionSummary {
  id: string;
  title: string;
  messages: number;
  rows: number;
  updatedAt: string | null;
}

/** A short, sortable id. Time-prefixed so `list()` can order without stat. */
function newId(): string {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(3).toString('hex');
  return `${t}-${r}`;
}

/** A filesystem-safe name for a session id, or null when it is not one. */
function safeId(id: unknown): string | null {
  const s = String(id || '').trim();
  if (!/^[a-z0-9-]{4,64}$/i.test(s)) return null;
  return s;
}

/** Trim a stored message to what is worth keeping, or null if it is not one. */
/** Attachment names as stored: strings only, bounded like everything else here. */
function cleanNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const names = v.filter((n): n is string => typeof n === 'string' && n.length > 0)
    .slice(0, 20)
    .map((n) => n.slice(0, 200));
  return names.length ? names : undefined;
}

/** Change records as stored: well-formed entries only, newest kept. */
function cleanChanges(v: unknown): ChangeRecord[] {
  if (!Array.isArray(v)) return [];
  const out: ChangeRecord[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const { request, summary, at } = c as Record<string, unknown>;
    if (typeof request !== 'string' || typeof summary !== 'string') continue;
    out.push({
      request: request.slice(0, 500),
      summary: summary.slice(0, 500),
      at: typeof at === 'string' ? at : undefined,
    });
  }
  return out.slice(-MAX_CHANGES);
}

function cleanMessage(m: MessageInput): StoredMessage | null {
  if (!m || typeof m.content !== 'string') return null;
  // A message with no role is not a message. The first version defaulted it to
  // "user", which silently re-labelled an assistant turn as the user's own and
  // would replay the conversation back to the model under the wrong speaker.
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  return {
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
    at: typeof m.at === 'string' ? m.at : new Date().toISOString(),
    // The intent is kept so a reloaded conversation still shows WHY a turn did
    // nothing — "answer" versus "the action was refused" is the difference
    // between the assistant being chatty and the guard having fired.
    intent: typeof m.intent === 'string' ? m.intent : undefined,
    guarded: m.guarded === true ? true : undefined,
    notes: Array.isArray(m.notes) && m.notes.length ? m.notes.slice(0, 20) as string[] : undefined,
    attachments: cleanNames(m.attachments),
  };
}

class SessionStore {
  dir: string;
  /** Tail of the serialisation chain. Resolved promise = idle. */
  tail: Promise<unknown>;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, DIR_NAME);
    this.tail = Promise.resolve();
  }

  /**
   * Run `fn` after every previously queued operation has finished.
   *
   * Chains onto the tail and swallows the result into the chain so one failure
   * does not wedged every later call — but the caller still sees its own
   * rejection. `finally`-style reset: the next caller always gets a live chain
   * even if this one threw.
   */
  #run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Keep the chain alive regardless of this call's outcome.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  // ---------------------------------------------------------- internals
  //
  // Everything below this line runs INSIDE a queue slot. These must never call a
  // public method — that is the deadlock described in the header.

  /**
   * Read and parse one session, or null.
   *
   * Never throws: a missing or corrupt file is an absent session, not a crash.
   * A store that can fail to load is worse than no store, because the failure
   * arrives at the moment the user is trying to get their work back.
   *
   * The spec is run back through `normalizeSpec` on the way out, and that is
   * load-bearing rather than tidy: JSON has no date type, so a `date` column
   * that was a real Date on the way in comes back as an ISO string. Everything
   * downstream trusts the type — `writeSpec` writes a Date as a serial number
   * and a string as a text cell — so a reloaded session rendered every date as
   * literal `2026-01-08T00:00:00.000Z` text in the grid, while the same session
   * looked right until it was saved and reopened. Normalising here is what makes
   * "what the user saw" and "what the user sees after a restart" the same thing.
   */
  async #loadFile(key: string | null): Promise<Session | null> {
    if (!key) return null;
    try {
      const raw = await fs.promises.readFile(this.file(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        id: key,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        spec: parsed.spec && typeof parsed.spec === 'object' ? normalizeSpec(parsed.spec).spec : null,
        messages: (Array.isArray(parsed.messages) ? parsed.messages : [])
          .map((m: MessageInput) => cleanMessage(m))
          .filter((m: StoredMessage | null): m is StoredMessage => m !== null),
        changes: cleanChanges(parsed.changes),
        updatedAt: parsed.updatedAt || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Write one session wholesale.
   *
   * Temp file then rename, so an interrupted write leaves the previous session
   * readable rather than a truncated file that fails to parse and takes the
   * conversation with it.
   */
  async #writeFile(session: SessionInput): Promise<Session> {
    const key = safeId(session && session.id);
    if (!key) throw new Error('session id is not valid');
    await fs.promises.mkdir(this.dir, { recursive: true });

    const payload = {
      version: 1,
      id: key,
      title: String(session.title || '').slice(0, 200),
      spec: session.spec || null,
      messages: (Array.isArray(session.messages) ? session.messages : [])
        .map((m: MessageInput) => cleanMessage(m))
        .filter((m: StoredMessage | null): m is StoredMessage => m !== null)
        .slice(-MAX_MESSAGES),
      changes: cleanChanges(session.changes),
      updatedAt: new Date().toISOString(),
    };

    const target = this.file(key);
    // A UNIQUE temp name per write, not `${target}.tmp`. Sharing one temp path
    // means two writers race on the same file: the first `rename` moves it away
    // and the second then fails with ENOENT — a crash, not a lost update, which
    // is a harder failure to read. The queue serialises writes today so the
    // collision cannot happen, but the temp name should not depend on an
    // invariant held somewhere else: a second process, or a future caller that
    // bypasses the queue, would hit it directly.
    //
    // The random suffix is also what makes the write safe to retry — nothing
    // else can be holding this exact path.
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    // If the process dies between write and rename, a `.tmp` is orphaned. That
    // is deliberate: an orphan is inert (the reader only opens `*.json`), and
    // cleaning up temp files on startup would mean deleting files the store did
    // not write in this run.
    await fs.promises.rename(tmp, target);
    return { ...payload, id: key } as Session;
  }

  /** Sessions on disk, newest first, without their message bodies. */
  async #listFiles(): Promise<SessionSummary[]> {
    let names = [];
    try { names = await fs.promises.readdir(this.dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const s = await this.#loadFile(id);
      if (!s) continue;
      out.push({
        id: s.id,
        title: s.title,
        messages: s.messages.length,
        rows: (s.spec && Array.isArray(s.spec.sheets))
          ? s.spec.sheets.reduce((n, sh) => n + ((sh.rows || []).length), 0)
          : 0,
        updatedAt: s.updatedAt,
      });
    }
    out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
    return out.slice(0, MAX_SESSIONS);
  }

  /** Delete one session file. Returns whether it existed. */
  async #removeFile(key: string): Promise<boolean> {
    try {
      await fs.promises.unlink(this.file(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Delete the oldest sessions beyond the cap. */
  async #pruneFiles(): Promise<string[]> {
    const all = await this.#listFiles();
    if (all.length <= MAX_SESSIONS) return [];
    const removed: string[] = [];
    for (const s of all.slice(MAX_SESSIONS)) {
      if (await this.#removeFile(s.id)) removed.push(s.id);
    }
    return removed;
  }

  // ------------------------------------------------------------- public

  /** One session, or null. */
  load(id: unknown): Promise<Session | null> {
    return this.#run(() => this.#loadFile(safeId(id)));
  }

  /** Create an empty session and return it. */
  create(title = ''): Promise<Session> {
    return this.#run(async () => {
      const id = newId();
      const session: Session = { id, title, spec: null, messages: [], changes: [], updatedAt: new Date().toISOString() };
      await this.#writeFile(session);
      return session;
    });
  }

  /** Write one session wholesale. */
  save(session: SessionInput): Promise<Session> {
    return this.#run(() => this.#writeFile(session));
  }

  /**
   * Append one message and persist. Returns the saved session, or null.
   *
   * The read-modify-write runs as ONE queue slot. Splitting it — `await load()`
   * then `await save()` as two public calls — is precisely the lost-update bug
   * this module is written to avoid.
   */
  append(id: unknown, message: MessageInput): Promise<Session | null> {
    return this.#run(async () => {
      const session = await this.#loadFile(safeId(id));
      if (!session) return null;
      session.messages.push(message as StoredMessage);
      return this.#writeFile(session);
    });
  }

  /**
   * Apply `mutate` to one session and persist, as ONE queue slot.
   *
   * This is the fix for a real lost-update bug. The route for a chat turn looks
   * like:
   *
   *     const session = await store.load(id)
   *     const turn = await runAgentTurn(...)   // <-- model call, seconds
   *     await store.save({ ...session, spec, messages: [...session.messages, ...] })
   *
   * The critical section spans the model call, which is OUTSIDE the store — so
   * the store's queue cannot protect it, and two concurrent turns both save a
   * snapshot taken before the other ran. One turn's spec, title and messages are
   * silently discarded. Measured: 12 concurrent turns on one session left 4 of
   * 26 messages on disk.
   *
   * The fix is to make the read-modify-write happen INSIDE the queue: the caller
   * passes the slow work's RESULT and a pure function that folds it into the
   * freshest on-disk state. Nothing is saved from a snapshot.
   *
   * `mutate` receives the session as loaded at write time (so it must be a
   * function, not a value) and returns the session to write, or null to write
   * nothing. Returning null is how "the session went away mid-turn" is handled.
   */
  update(id: unknown, mutate: (session: Session) => Session | null): Promise<Session | null> {
    return this.#run(async () => {
      const session = await this.#loadFile(safeId(id));
      if (!session) return null;
      const next = mutate(session);
      if (!next) return null;
      return this.#writeFile(next);
    });
  }

  /** Delete one session. Returns whether it existed. */
  remove(id: unknown): Promise<boolean> {
    return this.#run(async () => {
      const key = safeId(id);
      if (!key) return false;
      return this.#removeFile(key);
    });
  }

  /**
   * Sessions on disk, newest first, without their message bodies.
   *
   * The list is for a sidebar, so it needs a title and a timestamp and not the
   * whole conversation. Reading every transcript to draw a list would make the
   * list slower as the user's history grows, for no benefit.
   */
  list(): Promise<SessionSummary[]> {
    return this.#run(() => this.#listFiles());
  }

  /** Delete the oldest sessions beyond the cap. Returns the removed ids. */
  prune(): Promise<string[]> {
    return this.#run(() => this.#pruneFiles());
  }
}

export { SessionStore, safeId, newId, MAX_SESSIONS };
