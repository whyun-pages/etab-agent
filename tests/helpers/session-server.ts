'use strict';
/**
 * A real server over real HTTP with a scripted model, for the session API tests.
 *
 * The model is pi-ai's faux provider, scripted step by step, so the DECISIONS
 * are the real ones — the agent loop, the tools, `guardChange`, the replay in
 * the store — and only the provider is fake.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listenLocal } from './listen.ts';
import { createServer } from '../../src/http/server.ts';
import { loadPi } from '../../src/agent/pi.ts';

export const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sess-api-'));

// pi-ai is ESM-only, so it is reached with import() even from this CommonJS
// file. One faux provider per test file (each runs in its own process); each
// server start replaces its script. It is registered in the app's own stream
// table (src/agent/pi.ts), the way a protocol is.
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
 * One scripted model response. A string is a final text answer; an object
 * `{ tool, args }` (or an array of them) is a response that calls tools; a
 * function is called with the context and returns either of those, possibly
 * after a delay — that is how a test holds a turn in flight.
 */
export async function step(ai, s, context) {
  if (typeof s === 'function') s = await s(context);
  if (typeof s === 'string') return ai.fauxAssistantMessage(s);
  const calls = Array.isArray(s) ? s : [s];
  return ai.fauxAssistantMessage(
    calls.map((c) => ai.fauxToolCall(c.tool, c.args)),
    { stopReason: 'toolUse' },
  );
}

/** What the model was shown on the FIRST call of a turn: system prompt and user message. */
// pi 1.x carries the system prompt as a system message in the transcript.
export const conversation = (context) => context.messages.filter((m) => m.role !== 'system');
export const promptOf = (ai, context) =>
  [
    ai.getCurrentSystemPrompt(context.messages),
    ...conversation(context).map((m) => (typeof m.content === 'string' ? m.content : '')),
  ].join('\n');

/**
 * Start a server whose model is scripted.
 *
 * `replies` is a list of turns, each a list of steps (see `step`), consumed in
 * order across the whole server. Running out makes the faux provider answer
 * with an error, which is what a dead provider looks like from here.
 * `seen` collects the prompt of each turn's first call.
 */
export async function startServer(
  t,
  {
    configured = true,
    replies = [],
    chatCanEdit = true,
    chatConfirmEdits = true,
    seen = null,
    extra = {},
    fetchOptions,
  } = {},
) {
  const dataDir = tmpdir();
  const { ai, faux } = await loadFaux();
  faux.setResponses(
    replies.flat().map((s) => async (context) => {
      if (seen && conversation(context).length === 1) seen.push(promptOf(ai, context));
      return step(ai, s, context);
    }),
  );

  const server = createServer({
    dataDir,
    staticDir: path.join(__dirname, '..', '..', 'public'),
    // The model override the server accepts for exactly this purpose.
    model: faux.getModel(),
    settingsOverride: settingsStub({ configured, chatCanEdit, chatConfirmEdits, extra }),
    fetchOptions,
  });

  return new Promise((resolve) => {
    listenLocal(server).then(() => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ base, dataDir });
    });
  });
}

export function settingsStub({ configured = true, chatCanEdit = true, chatConfirmEdits = true, extra = {} } = {}) {
  return {
    isConfigured: () => configured,
    load: () => ({ chatCanEdit, chatConfirmEdits, useForAttachments: true, ...extra }),
    publicSettings: () => ({ model: 'stub', hasKey: configured }),
    secrets: () => ({ api: 'openai-completions', baseUrl: 'http://stub/v1', apiKey: 'k', model: 'stub' }),
    save: () => ({}),
  };
}

export const post = (base, p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

export const get = (base, p) =>
  fetch(base + p).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

export const SPEC = {
  title: '销售台账',
  sheets: [
    {
      name: '明细',
      columns: [
        { header: '客户名称', type: 'text' },
        { header: '金额', type: 'currency' },
      ],
      rows: [
        ['甲', 1000000],
        ['乙', 860000],
      ],
    },
  ],
};

export const ACTION = [{ tool: 'create_workbook', args: SPEC }, '建好了。'];
export const ANSWER = ['我能帮你做表格。'];
