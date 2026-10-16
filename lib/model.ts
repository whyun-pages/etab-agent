'use strict';
/**
 * From the user's settings to a pi-ai `Model`.
 *
 * pi-ai ships a catalogue of known models, but this app never consults it: the
 * user types a base URL and a model name, and those are the truth. A catalogue
 * lookup would refuse a model it has not heard of — every domestic provider
 * and every self-hosted gateway — which is exactly the population that uses a
 * custom base URL. So the `Model` is built by hand from three settings, and
 * the fields only a catalogue would know (pricing, context window) get neutral
 * values that nothing here reads.
 *
 * Three protocols, chosen by the user
 * -----------------------------------
 * OpenAI-compatible `/chat/completions` stays the default: it is what the
 * settings could express before, and what most providers mimic. Anthropic
 * Messages and Gemini are the two native protocols worth offering, because a
 * user pointing at those providers would otherwise need a translating proxy.
 * The list is closed on purpose — every entry is a protocol someone has to be
 * able to test, and an unknown value from an old or hand-edited settings file
 * reads as the default rather than as a request pi cannot route.
 */

import type { Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai';
import type { Secrets } from './settings.ts';

/** The wire protocols the settings panel offers, in display order. */
export const MODEL_APIS = ['openai-completions', 'anthropic-messages', 'google-generative-ai'] as const;

/** One of the offered protocols. */
export type ModelApi = (typeof MODEL_APIS)[number];

export const DEFAULT_API: ModelApi = 'openai-completions';

/**
 * Each protocol's official endpoint, for the settings panel to prefill.
 *
 * The Anthropic one has no `/v1`: the Anthropic SDK appends `/v1/messages`
 * itself. The Gemini one does carry its version, because pi-ai tells the
 * Google SDK the base URL already includes it.
 */
const BASE_URLS: Record<ModelApi, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

/** The official endpoint for a protocol. */
export function defaultBaseUrl(api: ModelApi): string {
  return BASE_URLS[api];
}

/** Read a stored or posted value as a protocol; anything unknown is the default. */
export function normalizeApi(raw: unknown): ModelApi {
  return (MODEL_APIS as readonly unknown[]).includes(raw) ? (raw as ModelApi) : DEFAULT_API;
}

/** True when `raw` names an offered protocol exactly. For validating input. */
export function isModelApi(raw: unknown): raw is ModelApi {
  return (MODEL_APIS as readonly unknown[]).includes(raw);
}

/**
 * Output ceiling per call. Unchanged from the single-call design, where a whole
 * spec had to fit; with edit tools a call is usually far smaller, but a fresh
 * workbook still arrives in one `create_workbook` call.
 */
export const MAX_OUTPUT_TOKENS = 8192;

/**
 * OpenAI-compatible endpoints differ in small ways that break a request
 * outright. pi-ai auto-detects these for providers it recognises by URL; for
 * anything else these are the settings that a strict server will not reject:
 *
 *   - `store` is an OpenAI-only field, and some gateways 400 on unknown fields.
 *   - The `developer` role is newer than most compatible servers; `system` is
 *     understood everywhere.
 *   - `strict` on tool schemas is likewise OpenAI-only.
 *
 * These three override pi-ai's URL detection for every endpoint, OpenAI's own
 * included (its `getCompat` prefers an explicit value). That costs nothing
 * there: OpenAI still accepts `system`, and neither `store` nor `strict` is
 * something this app relies on. Every other compat field is left unset, so
 * detection still decides it.
 */
const CONSERVATIVE_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsStrictMode: false,
};

/** The pi-ai model for the user's settings. */
export function modelFromSecrets(secrets: Secrets): Model<ModelApi> {
  const api = normalizeApi(secrets.api);
  const model: Model<ModelApi> = {
    id: secrets.model,
    name: secrets.model,
    api,
    provider: 'custom',
    baseUrl: String(secrets.baseUrl || defaultBaseUrl(api)).replace(/\/+$/, ''),
    // Off: a reasoning request is a provider-specific parameter, and an endpoint
    // that does not know it rejects the call. A model that reasons anyway still
    // works — pi reads its reasoning stream as thinking, apart from the answer.
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
  if (api === 'openai-completions') {
    (model as Model<'openai-completions'>).compat = { ...CONSERVATIVE_COMPAT };
  }
  return model;
}
