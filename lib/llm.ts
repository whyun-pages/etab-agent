'use strict';
/**
 * A minimal OpenAI-compatible chat client.
 *
 * Why hand-rolled instead of an SDK
 * ---------------------------------
 * Same reason the rest of this project has no runtime dependencies: the surface
 * we need is one POST with a JSON body, and `fetch` is built in. An SDK would
 * add a dependency tree to a single-file executable in exchange for very little.
 *
 * What "OpenAI-compatible" buys us
 * --------------------------------
 * Every provider worth naming exposes `/chat/completions` with the same request
 * shape, so one implementation reaches OpenAI, Azure-style gateways, and the
 * many domestic providers that mimic the format. The user supplies the base URL,
 * which is what makes that true — we never hard-code a host.
 *
 * Error handling is deliberately loud
 * -----------------------------------
 * A wrong key, an exhausted balance, or a mistyped model name are all things the
 * user must see verbatim. Wrapping them in a generic "extraction failed" would
 * make three different problems look like one. So provider error bodies are
 * surfaced, truncated only to keep a dump from becoming a wall.
 */

export const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 600;

/** The credentials a request needs. Shape matches `Settings.secrets()`. */
export interface Credentials {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One chat message, in the OpenAI wire format. */
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
  /** request a JSON object response */
  json?: boolean;
  /** total time allowed, from request to the last byte */
  timeoutMs?: number;
  /** stream the reply (server-sent events) instead of waiting for it whole */
  stream?: boolean;
  /** when streaming: abort after this long with no chunk at all */
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

/**
 * Pull the provider's own message out of an error response.
 *
 * OpenAI returns `{error:{message}}`; gateways vary. Try the common shapes, then
 * fall back to the raw text so nothing is lost.
 */
function describeErrorBody(text: string): string {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const m = (j && j.error && (j.error.message || j.error.code))
      || (j && (j.message || j.detail))
      || null;
    if (m) return String(m);
  } catch { /* not JSON — fall through to raw */ }
  return text;
}

function truncate(s: unknown): string {
  const str = String(s == null ? '' : s);
  return str.length > MAX_ERROR_CHARS ? `${str.slice(0, MAX_ERROR_CHARS)}…` : str;
}

/**
 * POST a chat completion and return the assistant's text.
 *
 * Two ways to wait
 * ----------------
 * Without `stream`, the provider answers once, when generation is finished, so
 * the only clock available is a total one: `timeoutMs` from request to reply.
 * That is fine for short calls (the connection test, attachment extraction) and
 * wrong for a session turn. A turn returns a WHOLE workbook spec, and a reasoning
 * model thinks before it writes it; with a fixed 60s cap a healthy model that was
 * still writing got cut off, and the user saw "请求超时" for a request that would
 * have succeeded.
 *
 * With `stream`, the reply arrives as server-sent events and the useful question
 * becomes "is it still producing anything?" — `idleTimeoutMs` restarts on every
 * chunk, reasoning chunks included, so a model that is thinking out loud is
 * never mistaken for a dead one. `timeoutMs` stays as an outer cap so a model
 * that trickles forever still ends.
 *
 * A provider that ignores `stream: true` and answers with plain JSON is handled:
 * the response's content type decides how it is read, not what we asked for.
 *
 * @returns the message content
 */
export async function chat({
  credentials,
  messages,
  json = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleTimeoutMs,
  stream = false,
  maxTokens = 4096,
  temperature = 0,
  signal,
}: ChatArgs): Promise<string> {
  const { baseUrl, apiKey, model } = credentials || {};
  if (!apiKey) throw new LlmError('尚未配置 API key', { code: 'no-key' });
  if (!baseUrl) throw new LlmError('尚未配置接口地址 (baseUrl)', { code: 'no-base-url' });
  if (!model) throw new LlmError('尚未配置模型名 (model)', { code: 'no-model' });

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    // Parsing wants the same answer twice, not a creative one.
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };
  if (stream) body.stream = true;

  // Three cancellation sources: the caller's signal, the total clock, and (when
  // streaming) the idle clock. AbortSignal.any is not available everywhere, so
  // chain them by hand. The clocks cover reading the body too, not just waiting
  // for headers — a streamed reply sends its headers first and its content later.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (!stream || !idleTimeoutMs) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error('idle')), idleTimeoutMs);
  };
  const onCallerAbort = (): void => ctrl.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    touch();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      // Surface status AND the provider's own words. A 401 says "your key",
      // a 404 usually says "your model or base URL", a 429 says "slow down or
      // pay up" — all three are actionable and all three are the user's to fix.
      const text = await res.text();
      const detail = truncate(describeErrorBody(text));
      throw new LlmError(`模型服务返回 ${res.status}${detail ? `：${detail}` : ''}`, {
        status: res.status,
        body: truncate(text),
      });
    }

    const type = (res.headers && res.headers.get('content-type')) || '';
    if (stream && res.body && /text\/event-stream/i.test(type)) {
      return await readStream(res.body, touch);
    }
    return contentOf(await res.text());
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // Network-level failure: DNS, TLS, refused, or one of our clocks. The proxy
    // case lands here too — undici honours HTTPS_PROXY/HTTP_PROXY/NO_PROXY from
    // the environment, which is how a user behind a MITM proxy gets through.
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : '';
    const aborted = ctrl.signal.aborted;
    const why = aborted && ctrl.signal.reason ? (ctrl.signal.reason as Error).message : '';
    const reason = why === 'timeout' ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
      : why === 'idle' ? `模型 ${Math.round((idleTimeoutMs || 0) / 1000)} 秒没有任何输出，已中断`
        : aborted ? '请求已取消' : '无法连接模型服务';
    throw new LlmError(`${reason}${cause}`, { code: aborted ? 'aborted' : 'network' });
  } finally {
    clearTimeout(timer);
    if (idle) clearTimeout(idle);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

/** The assistant's text out of a complete (non-streamed) response body. */
function contentOf(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmError('模型服务返回的不是 JSON，请检查 baseUrl 是否指向兼容接口', { body: truncate(text) });
  }

  const choices = parsed && (parsed as { choices?: unknown[] }).choices;
  const choice = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } : undefined;
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string') {
    throw new LlmError('模型没有返回内容', { body: truncate(text) });
  }
  return content;
}

/** One server-sent chunk of a streamed completion, as far as we read it. */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
  error?: unknown;
}

/**
 * Collect a streamed reply into the same string `contentOf` would return.
 *
 * Only `delta.content` is kept. A provider that streams its reasoning in a
 * separate field (`reasoning_content`, DeepSeek-style) is NOT folded in: the
 * non-streamed response never included it either, and `parseJsonReply` should
 * see the same text whichever way it arrived. A provider that puts its
 * `<think>` block inside `content` (MiniMax) keeps it there, exactly as before.
 * Every chunk still counts as activity for the idle clock, reasoning included.
 */
async function readStream(bodyStream: ReadableStream<Uint8Array>, touch: () => void): Promise<string> {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let sawChoice = false;

  /** Fold one SSE line in; true when the stream says it is finished. */
  const handle = (line: string): boolean => {
    const m = /^data:\s?(.*)$/.exec(line.trimEnd());
    if (!m) return false;
    const data = m[1];
    if (data === '[DONE]') return true;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return false; // a keep-alive or a provider comment; not ours to judge
    }
    // Some gateways report a failure mid-stream rather than with a status code.
    if (chunk && chunk.error) {
      throw new LlmError(`模型服务返回错误：${truncate(describeErrorBody(data))}`, { body: truncate(data) });
    }
    if (chunk && Array.isArray(chunk.choices) && chunk.choices.length) {
      sawChoice = true;
      const delta = chunk.choices[0] && chunk.choices[0].delta;
      if (delta && typeof delta.content === 'string') content += delta.content;
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (handle(line)) return content;
      }
    }
    buffered += decoder.decode();
    if (buffered) handle(buffered);
  } finally {
    // Cancel rather than just release: after an early [DONE] or a mid-stream
    // error the connection would otherwise stay open until the provider closes it.
    reader.cancel().catch(() => {});
  }

  if (!sawChoice) throw new LlmError('模型没有返回内容');
  return content;
}

/**
 * Strip a reasoning block from a reply, if the provider emits one.
 *
 * Reasoning models (MiniMax's ``, DeepSeek's ``, and others) print their
 * thinking before the answer. That thinking routinely CONTAINS a copy of the
 * requested format — with `response_format: json_object` the model tends to
 * sketch the schema example inside its reasoning before producing the real
 * object. So a reasoning block is not just noise to skip: left in place it
 * supplies a decoy `{...}` that a first-brace-to-last-brace scan will happily
 * swallow, producing one unparseable blob.
 *
 * Only blocks that appear BEFORE the final answer are removed. A stray word in
 * the answer itself is left alone.
 */
export function stripReasoning(content: unknown): string {
  return String(content)
    //  style, possibly multiline.
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    // Some providers emit an empty tag when reasoning is suppressed.
    .replace(/<think\b[^>]*\/>/gi, '')
    .trim();
}

/**
 * Extract a JSON object from a model reply.
 *
 * Even with `response_format: json_object`, providers wrap output in prose or
 * fences often enough that a strict parse is not enough. Strategy: strip any
 * reasoning block, then try as-is, the outermost braces, and each balanced
 * object in turn — preferring the LAST valid one, because a reasoning model's
 * final answer follows its own sketch. Fail with the raw text attached so the
 * user can see what came back rather than a bare "parse error".
 */
export function parseJsonReply(content: string): Record<string, unknown> {
  const cleaned = stripReasoning(content);
  const attempts: unknown[] = [content, cleaned];

  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1]);

  // Every balanced top-level object, so a decoy sketch does not hide the answer.
  for (const obj of balancedObjects(cleaned)) attempts.push(obj);

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(cleaned.slice(first, last + 1));

  // Later candidates win: the answer comes after the thinking.
  let best: Record<string, unknown> | null = null;
  for (const a of attempts) {
    try {
      const v = JSON.parse(String(a).trim());
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // Prefer a candidate that looks like our payload when several parse.
        if (best === null || scoreShape(v) >= scoreShape(best)) best = v;
      }
    } catch { /* try the next shape */ }
  }
  if (best) return best;

  throw new LlmError('模型返回的内容无法解析为 JSON', { body: truncate(content) });
}

/** How much a parsed object looks like the extraction payload we asked for. */
function scoreShape(v: Record<string, unknown>): number {
  if (v && Array.isArray(v.fields)) return 2;
  if (v && Array.isArray(v.records)) return 1;
  return 0;
}

/**
 * Split a string into balanced `{...}` spans, ignoring braces inside strings.
 *
 * A plain indexOf/lastIndexOf pair cannot do this: when a model sketches the
 * schema and then answers, those two braces straddle both objects.
 */
function balancedObjects(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { out.push(s.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out;
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
