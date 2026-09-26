/* ════════════════════════════════════════════════════════════════════
   The composer — a DOM node that outlives re-renders.

   Every state change re-paints the conversation, and painting it means
   replaceChildren. That is fine for everything derived from state, but it is
   fatal for a textarea someone is typing into: the node is destroyed, focus
   falls to <body>, and the next keystrokes go nowhere. Measured on this app's
   earlier prompt box: focus once and type 12 characters — 11 were lost.

   So the textarea is built once and then handed back into every repaint
   instead of being recreated. Re-inserting a node keeps it, its focus and its
   caret; recreating it does not.

   Composition (IME) is tracked here too. While a composition is open the
   textarea owns its value — the browser is mid-word and will rewrite it — so
   nothing should push state into it. The node being stable is what fixes the
   Chinese-input lag; this flag fixes the rest, by keeping a send from firing
   on pinyin that has not been committed.

   It is per-session: switching conversations should hand the user a fresh,
   empty box, not the half-typed message meant for the other one.
   ════════════════════════════════════════════════════════════════════ */

let node = null;
/** Which session the cached composer belongs to; null when there is none. */
let ownerId = null;
/** True between compositionstart and compositionend on the cached node. */
let composing = false;

/** The live textarea, or null before a composer has been built. */
export const composer = () => node;

/** True while the composer has an open IME composition. */
export const isComposing = () => composing;

/**
 * The composer for this session, built on first use.
 *
 * Passing the same id returns the same node; passing a different one destroys
 * the old composer and builds a new one, which is what makes switching
 * sessions clear the box.
 *
 * @param {string|null} sessionId
 * @param {{ placeholder: string, onInput: (v: string) => void, onSend: () => void }} hooks
 * @returns {HTMLTextAreaElement}
 */
export function prepareComposer(sessionId, hooks) {
  const id = sessionId || null;
  if (node && id === ownerId) {
    node.placeholder = hooks.placeholder || node.placeholder;
    // Rebind: the hooks close over handlers that are rebuilt each render, and
    // a stale closure would call the previous render's send.
    node.__hooks = hooks;
    return node;
  }

  const ta = document.createElement('textarea');
  ta.className = 'composer__input';
  ta.spellcheck = false;
  ta.rows = 1;
  ta.placeholder = hooks.placeholder || '';
  ta.__hooks = hooks;

  // The IME owns the value between these two events. Reverting mid-word would
  // corrupt the composition, so only the flag is touched.
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; });

  ta.addEventListener('input', () => {
    autoGrow(ta);
    ta.__hooks.onInput(ta.value);
  });

  ta.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a newline. Ctrl+Enter is kept as well
    // because that was the old binding and fingers remember it.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing) {
      e.preventDefault();
      ta.__hooks.onSend();
    }
  });

  node = ta;
  ownerId = id;
  composing = false;
  return node;
}

/** Drop the cached composer, so the next build starts clean. */
export function resetComposer() {
  node = null;
  ownerId = null;
  composing = false;
}

/**
 * Put text into the live composer, focus it and put the caret at the end.
 *
 * Programmatic value assignment fires no `input` event, so the box would not
 * grow on its own — `autoGrow` is called here for that reason. The caret goes
 * to the end rather than selecting the text: a suggestion is a starting point
 * to edit, not text to be overwritten.
 *
 * @param {string} text
 * @returns {boolean} whether a composer was there to fill
 */
export function fillComposer(text) {
  const ta = node;
  if (!ta) return false;
  ta.value = text;
  ta.focus();
  try { ta.setSelectionRange(text.length, text.length); } catch { /* not focusable */ }
  autoGrow(ta);
  return true;
}

export function setComposing(v) {
  composing = Boolean(v);
}

/**
 * Grow the box to fit its content, up to a ceiling.
 *
 * `height:auto` first because scrollHeight is measured against the current
 * height, and a box that already grew once would never shrink back.
 */
function autoGrow(ta) {
  const MAX = 200;
  ta.style.height = 'auto';
  const next = Math.min(ta.scrollHeight, MAX);
  ta.style.height = `${next}px`;
  ta.style.overflowY = ta.scrollHeight > MAX ? 'auto' : 'hidden';
}
