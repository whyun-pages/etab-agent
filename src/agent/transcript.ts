'use strict';
/**
 * Between pi's loop and this app: which messages go to the model, the text a
 * turn's transcript reduces to, and how a streamed or cut-off reply is read.
 */

import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

// ---------------------------------------------------------------- turn

/**
 * The messages the model understands; anything else the loop holds is dropped.
 *
 * A refusal of a cut-off call is reworded here (see `truncatedReason`).
 */
export function toLlm(messages: PiAgentMessage[]): Message[] {
  const out: Message[] = [];
  let cutOff = false;
  for (const m of messages) {
    const role = (m as { role?: string }).role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'toolResult') continue;
    const msg = m as Message;
    if (msg.role === 'assistant') cutOff = msg.stopReason === 'length';
    if (msg.role === 'toolResult' && cutOff && msg.isError) {
      out.push({ ...msg, content: [{ type: 'text', text: truncatedReason(msg.toolName) }] });
    } else {
      out.push(msg);
    }
  }
  return out;
}

/** A compact, readable transcript of the loop, for `TurnResult.raw`. */
export function transcript(messages: PiAgentMessage[]): string {
  const lines: string[] = [];
  for (const m of toLlm(messages)) {
    if (m.role === 'assistant') {
      for (const c of m.content) {
        if (c.type === 'text' && c.text.trim()) lines.push(`assistant: ${c.text.trim()}`);
        if (c.type === 'toolCall') lines.push(`call ${c.name} ${JSON.stringify(c.arguments)}`);
      }
      if (m.stopReason === 'error' || m.stopReason === 'aborted')
        lines.push(`${m.stopReason}: ${m.errorMessage || ''}`);
    } else if (m.role === 'toolResult') {
      const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      lines.push(`${m.isError ? 'error' : 'result'} ${m.toolName}: ${text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Whether a loop event is part of an assistant reply still being streamed —
 * the stretch where silence earns the longer idle window.
 *
 * `message_end` is deliberately not one: after it come the tools and then a
 * fresh request, which are back under the short window.
 */
export function streamingReply(event: { type: string; message?: unknown }): boolean {
  if (event.type !== 'message_start' && event.type !== 'message_update') return false;
  return (event.message as { role?: string } | undefined)?.role === 'assistant';
}

/**
 * Refuse every tool call in a reply that hit the output-token cap.
 *
 * The provider stops mid-argument and the JSON is closed off by a tolerant
 * parser, so the call still validates — a create_workbook with the last rows
 * missing and the final one short a cell, which normalisation then "repairs"
 * by padding. Seen on a 134-row transcription: 110 rows landed and only a note
 * said anything was wrong. Nothing in a cut-off reply is run; the model is told
 * why and how to fit, and corrects it on the next step like any refused call.
 *
 * Since pi 1.x the loop refuses these calls itself, before `beforeToolCall`
 * would see them, so the hook that did this is gone. Its refusal only says
 * "re-issue with complete arguments" — which a model that just ran out of
 * room repeats, and runs out again. `toLlm` swaps in this text, which says
 * how to fit. It goes by structure (an error result right after a `length`
 * reply), not by matching pi's wording.
 */
function truncatedReason(name: string): string {
  return `这次输出达到长度上限被截断，${name} 的参数不完整，没有执行。请分批完成：先用较少的行建表，再用 add_rows 分批追加（每批不超过 100 行）；数据来自网址时，用 fetch_url 加 importAs 直接导入，不要手抄。`;
}
