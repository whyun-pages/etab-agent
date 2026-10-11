'use strict';
/**
 * Drive the agent from an old-style scripted transport.
 *
 * Before the move to pi-agent, the server took a `transport` seam: a function
 * given the message list that returned the model's whole reply as a JSON
 * envelope, `{ intent, reply, spec }`. The probes in this directory script
 * their model that way, and the envelope is still a compact way to say "this
 * turn produces this workbook". The server now takes a pi-ai `model` instead.
 *
 * `modelFromTransport(transport)` adapts one to the other with pi-ai's faux
 * provider. On the first model call of a turn it calls the transport with
 * `{ messages: [system, user] }` — the same two messages the old seam saw —
 * and turns the envelope into what a real model would do:
 *
 *   - `intent: 'action'` with a spec  ->  one `create_workbook` call with that
 *     spec, then the reply as text
 *   - anything else                   ->  the reply as text
 *
 * So the REAL loop, tools, guard and store run, exactly as with a provider.
 * A spec is applied by `create_workbook`, which replaces the whole workbook —
 * the same thing the envelope meant.
 */

let pi = null;

/** @param {(args: {messages: Array<{role: string, content: string}>}) => Promise<string>} transport */
async function modelFromTransport(transport) {
  if (!pi) pi = await import('@mariozechner/pi-ai');
  const faux = pi.registerFauxProvider();
  const pending = new Map();
  const respond = async (context) => {
    const user = context.messages[0];
    const key = typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
    const afterTool = context.messages.some((m) => m.role === 'toolResult');
    if (afterTool && pending.has(key)) {
      const reply = pending.get(key);
      pending.delete(key);
      return pi.fauxAssistantMessage(reply);
    }
    const raw = await transport({
      messages: [
        { role: 'system', content: context.systemPrompt || '' },
        { role: 'user', content: key },
      ],
    });
    let env;
    try { env = JSON.parse(raw); } catch { env = { intent: 'answer', reply: String(raw) }; }
    if (env.intent === 'action' && env.spec) {
      pending.set(key, String(env.reply || ''));
      return pi.fauxAssistantMessage([pi.fauxToolCall('create_workbook', env.spec)], { stopReason: 'toolUse' });
    }
    return pi.fauxAssistantMessage(String(env.reply || ''));
  };
  // A faux provider answers from a queue; keep it topped up so a probe can run
  // as many turns as it likes.
  const refill = () => faux.setResponses(Array.from({ length: 1000 }, () => respond));
  refill();
  return faux.getModel();
}

module.exports = { modelFromTransport };
