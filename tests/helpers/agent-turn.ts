'use strict';
/**
 * Running one agent turn against a scripted model, for the agent tests.
 *
 * No network. The model is pi-ai's faux provider, scripted step by step: each
 * step is either plain text or a set of tool calls, and the REAL loop runs
 * around it — the tools, the spec operations, the derived intent, the guard.
 */

import { runTurn } from '../../src/agent/agent.ts';
import { loadPi } from '../../src/agent/pi.ts';
import { normalizeSpec } from '../../src/workbook/workbook.ts';

/** A settings object that claims to be configured. */
export function fakeSettings() {
  return {
    isConfigured: () => true,
    secrets: () => ({ api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1', apiKey: 'k', model: 'm' }),
  };
}

// pi-ai is ESM-only, so it is reached with import() even from this CommonJS
// file. One faux provider per test file (each runs in its own process); each
// test replaces its script. It is registered in the app's own stream table
// (src/agent/pi.ts), the way a protocol is.
let pi = null;
export async function loadFaux() {
  if (!pi) {
    const ai = await import('@earendil-works/pi-ai');
    const faux = ai.fauxProvider();
    (await loadPi()).apis.set(faux.api, faux.provider);
    pi = { ai, faux };
  }
  return pi;
}

/**
 * A request context as the tests read it. pi 1.x carries the system prompt
 * and the tool declarations as system messages in the transcript; this lifts
 * them back out, and leaves `messages` as the conversation alone.
 */
export function view(ai, context) {
  return {
    systemPrompt: ai.getCurrentSystemPrompt(context.messages),
    tools: ai.getCurrentTools(context.messages),
    messages: context.messages.filter((m) => m.role !== 'system'),
  };
}

/**
 * One scripted model response. A string is a final text answer; an object
 * `{ tool, args }` (or an array of them, optionally with `text`) is a turn
 * that calls tools.
 */
export function step(ai, s) {
  if (typeof s === 'string') return ai.fauxAssistantMessage(s);
  if (s && s.error) return ai.fauxAssistantMessage([], { stopReason: 'error', errorMessage: s.error });
  const calls = Array.isArray(s) ? s : s.calls || [s];
  const content = calls.map((c) => ai.fauxToolCall(c.tool, c.args));
  if (s.text) content.unshift(ai.fauxText(s.text));
  return ai.fauxAssistantMessage(content, { stopReason: 'toolUse' });
}

/**
 * Run one turn against a script. The contexts the model was sent are kept on
 * the result, so a test can inspect the prompt and the tools offered.
 */
export async function turnWith(steps, args) {
  const { ai, faux } = await loadFaux();
  const contexts = [];
  faux.setResponses(
    steps.map((s) => (context) => {
      contexts.push(view(ai, context));
      return step(ai, s);
    }),
  );
  const res = await runTurn({ settings: fakeSettings(), model: faux.getModel(), ...args });
  res.contexts = contexts;
  return res;
}

export const SPEC_3_ROWS = {
  title: '销售',
  sheets: [
    {
      name: '明细',
      columns: [
        { header: '客户', type: 'text' },
        { header: '金额', type: 'currency' },
      ],
      rows: [
        ['甲', 100],
        ['乙', 200],
        ['丙', 300],
      ],
    },
  ],
};

export const specWith = (rows) =>
  normalizeSpec({
    ...SPEC_3_ROWS,
    sheets: [{ ...SPEC_3_ROWS.sheets[0], rows }],
  }).spec;

export const rows10 = () => specWith(Array.from({ length: 10 }, (_, i) => [`客户${i + 1}`, (i + 1) * 100]));
