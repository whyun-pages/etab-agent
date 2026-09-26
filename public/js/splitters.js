/* ════════════════════════════════════════════════════════════════════
   Column splitters — drag the rail and the preview pane.

   The three columns are tracks of the shell grid, so resizing means writing a
   pixel width back onto :root. Two things make that safe:

     - the widths are clamped against the container, not just to constants, so
       a drag can never squeeze the centre pane out of existence on a small
       window;
     - the narrow-viewport rules in the stylesheet use !important, because the
       saved width lives in an inline style and would otherwise outrank them —
       a wide rail would follow the user onto a screen that cannot fit it.

   Persisted in localStorage, not on the server: it is a property of this
   window, not of the workbook.
   ════════════════════════════════════════════════════════════════════ */

const KEY = 'tab-agent:columns';

const RAIL_MIN = 160;
const RAIL_MAX = 460;
const PREVIEW_MIN = 280;
/** Below this the centre pane stops being usable, whatever the drag wants. */
const PANE_MIN = 320;

/**
 * Where each splitter's width lives, and which neighbour it sizes.
 *
 * `sign` is the direction that makes the target column bigger: the rail grows
 * to the right, the preview grows to the left.
 */
const COLUMNS = [
  { id: 'split-rail', css: '--rail-w', min: RAIL_MIN, max: RAIL_MAX, sign: 1 },
  { id: 'split-preview', css: '--preview-w', min: PREVIEW_MIN, max: Infinity, sign: -1 },
];

function readStored() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Corrupt or unavailable (private mode). Defaults are the right answer.
    return {};
  }
}

function writeStored(widths) {
  try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch { /* not fatal */ }
}

/** Clamp a proposed width against both its own bounds and the centre pane. */
function clampWidth(column, next, shellWidth, otherWidth) {
  const max = Math.min(column.max, shellWidth - otherWidth - PANE_MIN);
  return Math.max(column.min, Math.min(next, Math.max(column.min, max)));
}

export function initSplitters() {
  const shell = document.getElementById('shell');
  if (!shell) return;

  const root = document.documentElement;
  const stored = readStored();
  let dragging = null;

  for (const column of COLUMNS) {
    const handle = document.getElementById(column.id);
    if (!handle) continue;

    // Restore a saved width before anyone drags, so the layout the user left
    // is the layout they come back to.
    if (Number.isFinite(stored[column.css])) {
      root.style.setProperty(column.css, `${stored[column.css]}px`);
    }

    handle.addEventListener('pointerdown', (e) => {
      // Left button only; a right-click drag is not a resize.
      if (e.button !== 0) return;
      const rect = handle.getBoundingClientRect();
      dragging = { column, startX: e.clientX, startW: rect.width ? trackWidth(column.css) : 0 };
      // Pointer capture keeps the events coming to this element even when the
      // cursor leaves the 5px strip, which it always does during a real drag.
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.column !== column) return;
      const delta = (e.clientX - dragging.startX) * column.sign;
      apply(column, dragging.startW + delta);
    });

    const end = (e) => {
      if (!dragging || dragging.column !== column) return;
      const moved = e.clientX !== dragging.startX;
      dragging = null;
      handle.classList.remove('is-dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      if (moved) save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    // Double-click restores the default. Without it, a column dragged to its
    // minimum has no obvious way back.
    handle.addEventListener('dblclick', () => {
      root.style.removeProperty(column.css);
      // A removed inline width is the default, so the stored copy has to go too
      // or the next load would put the old width straight back.
      save();
    });

    // Arrow keys, so the splitter is operable without a mouse.
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key === 'ArrowLeft') { apply(column, trackWidth(column.css) - step * column.sign); e.preventDefault(); save(); }
      else if (e.key === 'ArrowRight') { apply(column, trackWidth(column.css) + step * column.sign); e.preventDefault(); save(); }
    });
  }

  /** The current width of a column, in pixels, straight from layout. */
  function trackWidth(cssVar) {
    const el = cssVar === '--rail-w'
      ? document.getElementById('rail')
      : document.getElementById('preview-pane');
    return el ? el.getBoundingClientRect().width : 0;
  }

  /** Width of the column the OTHER splitter controls, for the clamp budget. */
  function otherWidth(column) {
    const other = COLUMNS.find((c) => c !== column);
    return other ? trackWidth(other.css) : 0;
  }

  function apply(column, proposed) {
    const shellWidth = shell.getBoundingClientRect().width;
    const next = clampWidth(column, proposed, shellWidth, otherWidth(column));
    root.style.setProperty(column.css, `${Math.round(next)}px`);
  }

  function save() {
    const out = {};
    for (const column of COLUMNS) {
      const v = root.style.getPropertyValue(column.css);
      if (v) out[column.css] = parseFloat(v);
    }
    writeStored(out);
  }
}
