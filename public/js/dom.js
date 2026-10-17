/* ════════════════════════════════════════════════════════════════════
   Small DOM helpers shared by the views: building elements, and keeping
   focus across a render pass.
   ════════════════════════════════════════════════════════════════════ */

/** Escape for interpolation into an HTML string. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Create an element with attributes and children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Replace a container's contents, preserving focus across a whole render pass.
 *
 * Repainting tears down the nodes it replaces, and tearing down the focused
 * element blurs it. That is fine for everything derived from state, but it is
 * fatal for a textarea someone is typing into: the browser moves focus to
 * <body> and the next keystrokes land nowhere.
 *
 * The save/restore cannot live here, per call, because the first container
 * mounted in a pass usually does not contain the focused element — repainting
 * the session list blurs the composer on its way past. By the time the editor body is
 * reached, focus is already gone. So the pass brackets itself with
 * `beginRender` / `endRender` and this function just does the swap.
 */
export function mount(container, node) {
  container.replaceChildren(...[].concat(node).filter(Boolean));
}

/**
 * Focus carried across one render pass.
 *
 * Held as a stack because a render can be triggered from inside a render
 * (setting state in a subscriber); the inner pass restores first, and the outer
 * one sees a still-connected node and restores again.
 */
const focusPasses = [];

/**
 * Start a render pass: remember what is focused and where the caret is.
 *
 * Returns a token to hand to `endRender`.
 */
export function beginRender() {
  const active = document.activeElement;
  const token = {
    active: active && active !== document.body ? active : null,
    selection: null,
  };
  if (token.active && typeof token.active.selectionStart === 'number') {
    token.selection = { start: token.active.selectionStart, end: token.active.selectionEnd };
  }
  focusPasses.push(token);
  return token;
}

/**
 * Finish a render pass: put focus and the caret back if the element survived.
 *
 * A re-created element is a different object — its `isConnected` is true but it
 * is not the one we saved — so the check is identity, not connectivity. That
 * distinction is the whole point: reusing the node is what makes restoring
 * focus meaningful, and if a future change goes back to rebuilding the textarea
 * this quietly stops hiding it.
 */
export function endRender(token) {
  const idx = focusPasses.lastIndexOf(token);
  if (idx !== -1) focusPasses.splice(idx, 1);

  const { active, selection } = token;
  if (!active || !active.isConnected) return;
  // Something else claimed focus during the pass; leave it alone.
  if (document.activeElement !== document.body && document.activeElement !== active) return;

  try {
    active.focus({ preventScroll: true });
  } catch {
    try {
      active.focus();
    } catch {
      return;
    }
  }
  if (selection && typeof active.setSelectionRange === 'function') {
    try {
      active.setSelectionRange(selection.start, selection.end);
    } catch {
      /* not a text control */
    }
  }
}
