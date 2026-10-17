'use strict';
/**
 * The model client: one call, one string back — on top of pi-ai.
 *
 * Why pi-ai instead of the old hand-rolled `fetch`
 * -----------------------------------------------
 * The session turn moved to pi-agent (see src/agent/agent.ts), which drives the model
 * through pi-ai. Keeping a second, hand-written HTTP client beside it for the
 * one remaining plain call (the settings panel's connection test) would mean
 * two implementations of every provider quirk, and a test that passes against
 * one client while turns fail against the other. So this module is now a thin
 * layer over pi-ai's `stream()`, and what it adds is what this app needs on
 * top: the user's clocks, and errors in words the user can act on.
 *
 * What it still owns
 * ------------------
 * - **Clocks.** `createClocks` combines the caller's signal, a total cap and an
 *   idle cap into one `AbortSignal`. The idle clock restarts on every streamed
 *   event, reasoning included, so a model that is thinking is never mistaken
 *   for a dead one. src/agent/agent.ts uses the same clocks for a whole turn.
 * - **Loud errors.** A wrong key, an exhausted balance, a mistyped model name
 *   are three different problems the user must see verbatim. pi-ai reports a
 *   failure as a final message with `stopReason: 'error'` and the provider's
 *   own text; `toLlmError` keeps that text and the status code, and says which
 *   of our own clocks fired when it was one of those.
 */

import type { AssistantMessage, AssistantMessageEvent, Context, Message } from '@earendil-works/pi-ai';
import { loadPi } from './pi.ts';
import { modelFromSecrets } from './model.ts';
import type { ModelApi } from './model.ts';

export const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 600;

/** The credentials a request needs. Shape matches `Settings.secrets()`. */
export interface Credentials {
  /** wire protocol; absent means OpenAI-compatible */
  api?: ModelApi;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One chat message, as callers of `chat` write it. */
export interface ChatMessage {
  role: string;
  content: string;
}

/** Optional extras a caller may attach to an error, for the UI to show. */
export interface LlmErrorOptions {
  status?: number;
  body?: string;
  code?: string;
}

/** Arguments accepted by `chat`. */
export interface ChatArgs {
  credentials: Credentials;
  messages: ChatMessage[];
  /** total time allowed, from request to the last byte */
  timeoutMs?: number;
  /** abort after this long with no streamed event at all */
  idleTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** caller cancellation (user pressed stop) */
  signal?: AbortSignal;
}

/** Thrown for anything that should reach the user with its cause intact. */
export class LlmError extends Error {
  status?: number;
  body?: string;
  code?: string;

  constructor(message: string, { status, body, code }: LlmErrorOptions = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

function truncate(s: unknown): string {
  const str = String(s == null ? '' : s);
  return str.length > MAX_ERROR_CHARS ? `${str.slice(0, MAX_ERROR_CHARS)}…` : str;
}

/**
 * Refuse incomplete credentials before any request is made. A missing key
 * would otherwise reach the provider and come back as a 401 that reads like a
 * wrong key, which is a different fix.
 */
export function requireCredentials(credentials: Credentials | null | undefined): Credentials {
  const { baseUrl, apiKey, model } = credentials || ({} as Credentials);
  if (!apiKey) throw new LlmError('尚未配置 API key', { code: 'no-key' });
  if (!baseUrl) throw new LlmError('尚未配置接口地址 (baseUrl)', { code: 'no-base-url' });
  if (!model) throw new LlmError('尚未配置模型名 (model)', { code: 'no-model' });
  return credentials as Credentials;
}

// ------------------------------------------------------------------ clocks

/** Why a set of clocks fired. */
export type AbortWhy = 'timeout' | 'idle' | 'caller';

/** Arguments to `createClocks`. */
export interface ClockArgs {
  timeoutMs: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/** One combined cancellation source, and how to read why it fired. */
export interface Clocks {
  signal: AbortSignal;
  /**
   * Restart the idle clock; call on every sign of life. `idleMs` sets how long
   * the NEXT silence may last, for a caller that knows some silences are
   * longer than others; omitted, it is `idleTimeoutMs`.
   */
  touch(idleMs?: number): void;
  /** which source fired, once aborted; null before */
  reason(): AbortWhy | null;
  timeoutMs: number;
  idleTimeoutMs?: number;
  /** the silence limit currently armed — the one that fired, after an idle abort */
  idleWindowMs(): number | undefined;
  /** clear the timers and detach from the caller's signal */
  dispose(): void;
}

/**
 * Three cancellation sources folded into one signal: the caller's, the total
 * clock, and the idle clock. `AbortSignal.any` would do the folding but not
 * remember which source fired, and the user's message depends on that. The
 * idle clock is armed immediately — a provider that never sends its first byte
 * is as dead as one that stops halfway.
 */
export function createClocks({ timeoutMs, idleTimeoutMs, signal }: ClockArgs): Clocks {
  const ctrl = new AbortController();
  let why: AbortWhy | null = null;
  const abort = (r: AbortWhy): void => {
    if (ctrl.signal.aborted) return;
    why = r;
    ctrl.abort(new Error(r));
  };
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  let windowMs = idleTimeoutMs;
  const touch = (idleMs?: number): void => {
    if (!idleTimeoutMs || ctrl.signal.aborted) return;
    windowMs = idleMs || idleTimeoutMs;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => abort('idle'), windowMs);
  };
  const onCallerAbort = (): void => abort('caller');
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  touch();
  return {
    signal: ctrl.signal,
    touch,
    reason: () => why,
    timeoutMs,
    idleTimeoutMs,
    idleWindowMs: () => windowMs,
    dispose() {
      clearTimeout(timer);
      if (idle) clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    },
  };
}

// ------------------------------------------------------------------ errors

/** Messages that mean the request never reached a model. */
const NETWORK_RE =
  /connection error|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|socket hang up|network|certificate|self.signed/i;

/**
 * A failed or aborted assistant message, as an `LlmError` the user can act on.
 *
 * Our own clocks are named first: when one of them fired, the provider's text
 * is only "request aborted", which hides the real story. Otherwise the
 * provider's words go through, with the status code pulled out when the SDK
 * put one at the front ("401 Incorrect API key…").
 *
 * A stream that ended with nothing in it is `EMPTY_REPLY` (see there), not the
 * SDK's words — pi 1.x reports it as an error where 0.x reported an empty
 * success, and "Stream ended without finish_reason" tells the user nothing.
 */
export function toLlmError(
  message: Pick<AssistantMessage, 'stopReason' | 'errorMessage'> & { content?: AssistantMessage['content'] },
  clocks?: Clocks,
): LlmError {
  const why = clocks ? clocks.reason() : null;
  if (why === 'timeout') {
    return new LlmError(`请求超时（${Math.round(clocks!.timeoutMs / 1000)} 秒）`, { code: 'aborted' });
  }
  if (why === 'idle') {
    // The window that fired, not the default: a turn arms a longer one while a
    // reply is streaming, and quoting the shorter would misstate the wait.
    return new LlmError(`模型 ${Math.round((clocks!.idleWindowMs() || 0) / 1000)} 秒没有任何输出，已中断`, {
      code: 'aborted',
    });
  }
  if (why === 'caller' || message.stopReason === 'aborted') {
    return new LlmError('请求已取消', { code: 'aborted' });
  }

  const text = String(message.errorMessage || '').trim();
  if (message.content && isEmptyReply(message as Pick<AssistantMessage, 'content'>) && NO_FINISH_RE.test(text)) {
    return new LlmError(EMPTY_REPLY, { code: 'empty' });
  }
  const m = /^(\d{3})\b\s*([\s\S]*)$/.exec(text);
  if (m) {
    const status = Number(m[1]);
    const detail = truncate(m[2].trim());
    // A 401 says "your key", a 404 usually "your model or base URL", a 429
    // "slow down or pay up" — all actionable, all the user's to fix.
    return new LlmError(`模型服务返回 ${status}${detail ? `：${detail}` : ''}`, { status, body: truncate(text) });
  }
  if (NETWORK_RE.test(text)) {
    // The proxy case lands here too — undici honours HTTPS_PROXY/NO_PROXY from
    // the environment, which is how a user behind a MITM proxy gets through.
    return new LlmError(`无法连接模型服务（${truncate(text)}）`, { code: 'network', body: truncate(text) });
  }
  return new LlmError(`模型服务返回错误：${truncate(text) || '未知错误'}`, { body: truncate(text) });
}

// ------------------------------------------------------------- empty reply

/**
 * Said when a reply has no content blocks at all — no text, no reasoning, no
 * tool call.
 *
 * The one way this happens in practice: a provider that ignores `stream: true`
 * and answers with a single JSON body. pi-ai reads only the event stream and
 * finds no events in it. Up to 0.x it reported an EMPTY SUCCESS; 1.x's
 * OpenAI-compatible client reports an error instead ("Stream ended without
 * finish_reason", matched by `NO_FINISH_RE`), so both shapes are read as this.
 * The hand-rolled client this replaced read such a body whole; pi-ai does not,
 * and passing the empty reply on would surface as "the model did not
 * understand" — a wrong story about a different problem. So it is an error,
 * and it names the likely cause.
 */
export const EMPTY_REPLY = '模型没有返回任何内容。如果该接口不支持流式输出（stream），请换用支持的接口或协议。';

/** pi-ai's error for a stream that closed without saying why it stopped. */
const NO_FINISH_RE = /stream ended without finish_reason/i;

/** True for a reply with no content blocks at all. See `EMPTY_REPLY`. */
export function isEmptyReply(message: Pick<AssistantMessage, 'content'>): boolean {
  return !message.content || message.content.length === 0;
}

// -------------------------------------------------------------------- chat

/** The visible answer in an assistant message: its text blocks, joined. */
export function textOf(message: Pick<AssistantMessage, 'content'>): string {
  return (message.content || [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** `ChatMessage[]` to a pi-ai context: system messages become the system prompt. */
function toContext(messages: ChatMessage[], model: string): Context {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest: Message[] = messages
    .filter((m) => m.role !== 'system')
    .map(
      (m): Message =>
        m.role === 'assistant'
          ? {
              role: 'assistant',
              content: [{ type: 'text', text: m.content }],
              api: 'openai-completions',
              provider: 'custom',
              model,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: 0,
            }
          : { role: 'user', content: m.content, timestamp: 0 },
    );
  return { systemPrompt: system || undefined, messages: rest };
}

/**
 * Send one request and return the assistant's text.
 *
 * Always streamed, because pi-ai always streams; the clocks decide when to give
 * up. Reasoning arrives as separate thinking blocks and is NOT part of the
 * returned text — a provider that puts `<think>` inline in its answer still
 * does, which is what `stripReasoning` is for.
 *
 * @returns the message text
 */
export async function chat({
  credentials,
  messages,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleTimeoutMs,
  maxTokens = 4096,
  temperature = 0,
  signal,
}: ChatArgs): Promise<string> {
  const creds = requireCredentials(credentials);
  const pi = await loadPi();
  const model = modelFromSecrets({
    api: creds.api || 'openai-completions',
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: creds.model,
  });
  const clocks = createClocks({ timeoutMs, idleTimeoutMs, signal });
  try {
    // A direct API call skips the normalisation a `Models` collection would
    // do, so it is done here: the system prompt moves into the transcript.
    const events = pi.stream(model, pi.ai.normalizeContext(toContext(messages, creds.model)), {
      apiKey: creds.apiKey,
      // Parsing wants the same answer twice, not a creative one.
      temperature,
      maxTokens,
      signal: clocks.signal,
      // No silent retries: a retry hides a 429 behind a long wait, and the
      // user is better served by the provider's own words, now.
      maxRetries: 0,
    });
    for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
      void event;
      clocks.touch();
    }
    const result = await events.result();
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw toLlmError(result, clocks);
    if (isEmptyReply(result)) throw new LlmError(EMPTY_REPLY, { code: 'empty' });
    return textOf(result);
  } finally {
    clocks.dispose();
  }
}

/**
 * Strip a reasoning block from a reply, if the provider emits one inline.
 *
 * Most reasoning models stream their thinking separately, and pi-ai keeps it
 * out of the text. Some (MiniMax among them) print `<think>…</think>` inside
 * the answer itself; left in place it reads to the user as part of the reply.
 */
export function stripReasoning(content: unknown): string {
  return (
    String(content)
      // <think>…</think> style, possibly multiline.
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
      // Some providers emit an empty tag when reasoning is suppressed.
      .replace(/<think\b[^>]*\/>/gi, '')
      .trim()
  );
}

/** The request part for one image, the format the vision APIs expect. */
interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

/** A `data:` URL for one image, the format the vision APIs expect. */
export function imagePart(buffer: Buffer, mime?: string): ImagePart {
  return {
    type: 'image_url',
    image_url: { url: `data:${mime || 'image/png'};base64,${buffer.toString('base64')}` },
  };
}
