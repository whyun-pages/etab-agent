'use strict';
/**
 * Settings — the user's own model credentials, stored locally.
 *
 * Scope
 * -----
 * This holds ONLY what the user typed into the settings panel: an API key, a
 * base URL, a model name. Everything else stays in code. Nothing here is
 * synced, uploaded, or baked into the build.
 *
 * On storing the key in plain text
 * -------------------------------
 * The key is written as plain JSON on the user's own machine. That is a real
 * choice with a real downside — any process running as this user can read it —
 * and it is made deliberately:
 *
 *   - The alternative is the OS credential store (DPAPI / Credential Manager).
 *     Reaching it from pure Node means either a native addon (new build
 *     toolchain, and this project ships a single executable) or shelling out to
 *     powershell (slow, and it can prompt).
 *   - Every comparable CLI (gh, aws, openai) keeps a plain-text or plain-JSON
 *     credential file for the same reason.
 *
 * What we DO control is that the key never leaves this file for anywhere it is
 * not needed: the API never returns it, and it is never logged or echoed into
 * a plan. `publicSettings()` exists so callers cannot leak it by accident.
 *
 * The file is written 0600 where the platform honours it. On Windows that mode
 * is mostly advisory, so treat the key as readable by the user's own processes
 * and no more.
 *
 * Module style
 * ------------
 * This file uses ESM `import`/`export` syntax and is compiled to CommonJS by
 * `tsc` (see tsconfig.json, `module: commonjs`). The extension on a relative
 * specifier is `.ts` and is rewritten to `.js` at emit time by
 * `rewriteRelativeImportExtensions` — so a specifier here names the file you
 * would edit, and the build handles the rest.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE_NAME = 'settings.json';

/** The stored settings, with defaults applied. */
export interface SettingsRecord {
  baseUrl: string;
  apiKey: string;
  model: string;
  // Whether to send attachment content (documents, images) to the model.
  useForAttachments: boolean;
  // Whether the chat panel may change fields at all. Off means chat is
  // read-only: it can answer questions but never proposes an edit.
  chatCanEdit: boolean;
  // Whether a proposed edit is applied immediately or held for confirmation.
  // Default is to confirm, because a chat message is the easiest way to
  // change the wrong cell by accident, and a click is cheap.
  chatConfirmEdits: boolean;
}

/** A patch as written by the settings panel: any subset of the known keys. */
export interface SettingsPatch {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  useForAttachments?: boolean;
  chatCanEdit?: boolean;
  chatConfirmEdits?: boolean;
}

/** Outbound credentials. Never handed to a response handler. */
export interface Secrets {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The safe projection the UI sees. Deliberately has no `apiKey`. */
export interface PublicSettings {
  baseUrl: string;
  model: string;
  useForAttachments: boolean;
  chatCanEdit: boolean;
  chatConfirmEdits: boolean;
  hasKey: boolean;
  keyHint: string | null;
}

/** Shape of the on-disk file, with defaults applied. */
export function defaults(): SettingsRecord {
  return {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    // Whether to send attachment content (documents, images) to the model.
    useForAttachments: true,
    // Whether the chat panel may change fields at all. Off means chat is
    // read-only: it can answer questions but never proposes an edit.
    chatCanEdit: true,
    // Whether a proposed edit is applied immediately or held for confirmation.
    // Default is to confirm, because a chat message is the easiest way to
    // change the wrong cell by accident, and a click is cheap.
    chatConfirmEdits: true,
  };
}

/**
 * Settings store bound to one directory.
 *
 * Reads are forgiving: a missing or corrupt file yields defaults rather than an
 * error, because a broken settings file must never keep the app from starting.
 */
export class Settings {
  dir: string;
  file: string;
  /** Tail of the serialisation chain. A resolved promise means idle. */
  tail: Promise<unknown>;
  cache: SettingsRecord | null;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.tail = Promise.resolve();
    this.cache = null;
  }

  /**
   * Run `fn` after every previously queued operation has finished.
   *
   * Same shape as `SessionStore#run`, and for the same reason: `save` is a
   * read-modify-write, so two concurrent saves that each read the old file and
   * then write back would lose one update. `writeFileSync` used to make that
   * impossible by never yielding; `await` reintroduces the window. The queue is
   * what closes it again.
   *
   * One failure must not wedge the chain, but the caller still sees its own
   * rejection.
   */
  #run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---------------------------------------------------------- internals
  //
  // These run INSIDE a queue slot and must never call a public method — that is
  // the deadlock described in `SessionStore`'s header, and it applies verbatim.

  /** Read the file and merge it over defaults. Never throws. */
  async #loadFile(): Promise<SettingsRecord> {
    let stored: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed;
    } catch {
      // Missing file on first run, or invalid JSON. Either way: defaults.
    }
    return { ...defaults(), ...stored };
  }

  /**
   * Write the record wholesale, atomically.
   *
   * Temp file then rename, so an interrupted write leaves the previous settings
   * readable. Overwriting in place has the opposite failure mode: a crash
   * mid-write leaves truncated JSON, and since the API key lives here, the
   * recovery is "retype your credentials".
   */
  async #writeFile(record: SettingsRecord): Promise<SettingsRecord> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = this.file;
    // Unique temp name per write, not `${target}.tmp`: the queue serialises
    // writes today, but the temp path should not depend on an invariant held
    // somewhere else. Two writers sharing one temp path is a hard ENOENT/EPERM
    // on Windows, not a lost update.
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const body = JSON.stringify(record, null, 2);
    try {
      await fs.promises.writeFile(tmp, body, { mode: 0o600 });
      await fs.promises.rename(tmp, target);
    } catch (err) {
      // Do not leave a stray temp file for a write that never landed.
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return record;
  }

  /** Load from disk, tolerating absence and corruption. Cached after the first read. */
  load(): Promise<SettingsRecord> {
    return this.#run(async () => {
      if (this.cache) return this.cache;
      this.cache = await this.#loadFile();
      return this.cache;
    });
  }

  /** Persist. Only known keys are written, so a stray property cannot sneak in. */
  save(next: SettingsPatch): Promise<SettingsRecord> {
    return this.#run(async () => {
      // Read the CURRENT file inside the slot, not the cache: another process
      // (or an earlier queued save) may have changed it since we last loaded.
      const current = this.cache || (await this.#loadFile());
      const merged = { ...current, ...next };
      // Collected as an open record first, then narrowed: writing through a
      // union of keys would need a cast per assignment, and the key loop is what
      // actually guarantees the shape.
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(defaults())) {
        if (k in merged) out[k] = (merged as Record<string, unknown>)[k];
      }
      // Every key came from `defaults()`, so the shape is the record; the cast
      // is the annotation the loop cannot carry, not a relaxation of it.
      const record = out as unknown as SettingsRecord;
      this.cache = await this.#writeFile(record);
      return this.cache;
    });
  }

  /**
   * The real credentials, for outbound requests only.
   *
   * Never hand this to a response handler. It exists so the client module has
   * one clearly-named place to read the secret from.
   */
  async secrets(): Promise<Secrets> {
    const s = await this.load();
    return {
      baseUrl: String(s.baseUrl || '').replace(/\/+$/, ''),
      apiKey: String(s.apiKey || ''),
      model: String(s.model || ''),
    };
  }

  /** Usable for outbound calls? An empty key means "not configured". */
  async isConfigured(): Promise<boolean> {
    const s = await this.secrets();
    return Boolean(s.apiKey && s.baseUrl && s.model);
  }

  /**
   * A safe projection for the UI.
   *
   * Deliberately reports only WHETHER a key is set, plus a masked tail so the
   * user can confirm which key is loaded without the value crossing the wire.
   * There is no `apiKey` field here — that is the whole point of the function.
   */
  async publicSettings(): Promise<PublicSettings> {
    const s = await this.load();
    const key = String(s.apiKey || '');
    return {
      baseUrl: s.baseUrl,
      model: s.model,
      useForAttachments: Boolean(s.useForAttachments),
      chatCanEdit: Boolean(s.chatCanEdit),
      chatConfirmEdits: Boolean(s.chatConfirmEdits),
      hasKey: Boolean(key),
      keyHint: key ? mask(key) : null,
    };
  }
}

/**
 * Show enough of a key to recognise it, not enough to use it.
 *
 * Keeping the last 4 is the convention (`sk-...a1b2`), and it is what makes
 * "did my paste take?" answerable without revealing the value.
 */
export function mask(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
