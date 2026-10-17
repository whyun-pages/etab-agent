/* ════════════════════════════════════════════════════════════════════
   Chat scroll — follow the conversation unless the user has scrolled away.

   The chat pane is rebuilt on every state change, so the transcript's scroll
   offset would reset to the top on each repaint. This module carries it over:

     - Stuck to the bottom (the default, and after sending): every repaint ends
       at the bottom, so new output is always in view.
     - Scrolled up to read something: the offset is kept exactly, and when the
       transcript grows below it a ↓ button appears. Clicking it, or scrolling
       back down by hand, sticks to the bottom again.

   "At the bottom" has a small tolerance: sub-pixel offsets and a trailing gap
   would otherwise make a user sitting at the end count as scrolled away.
   ════════════════════════════════════════════════════════════════════ */

const SLACK = 24;

/** Per conversation; a different session always starts stuck to the bottom. */
let session = null;
let stuck = true;
let unseen = false;
/** Set by stickChat: the next repaint goes to the bottom wherever it was. */
let force = false;
let observer = null;

function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= SLACK;
}

function toBottom(box) {
  box.scrollTop = box.scrollHeight;
}

/** Make the next repaint follow the bottom — used when the user sends. */
export function stickChat() {
  force = true;
}

/**
 * Measure the transcript about to be replaced. Call before mounting the new one,
 * and hand the result to restoreChatScroll afterwards.
 */
export function captureChatScroll(root, activeId) {
  const box = root.querySelector('.chat__stream');
  if (activeId !== session) {
    session = activeId;
    stuck = true;
    unseen = false;
    force = false;
    return null;
  }
  if (!box) return null;
  // Read the position now rather than trusting the scroll listener: a repaint
  // can land between a scroll and its event.
  stuck = force || atBottom(box);
  force = false;
  if (stuck) unseen = false;
  return { top: box.scrollTop, height: box.scrollHeight };
}

/** Put the new transcript where the old one was, or at the bottom. */
export function restoreChatScroll(root, before) {
  const box = root.querySelector('.chat__stream');
  const jump = root.querySelector('.chat__jump');
  if (!box) return;

  if (stuck) {
    toBottom(box);
  } else if (before) {
    box.scrollTop = before.top;
    // Grew while the user was reading further up: that is new output they
    // have not seen, which is what the button is for.
    if (box.scrollHeight > before.height) unseen = true;
  }

  const sync = () => {
    if (jump) jump.hidden = stuck || !unseen;
  };
  sync();

  box.addEventListener(
    'scroll',
    () => {
      // A replaced stream still gets one late scroll event once detached, where
      // its height is 0 and so it reads as "at the bottom". Only the live one
      // speaks for where the user is.
      if (!box.isConnected) return;
      stuck = atBottom(box);
      if (stuck) unseen = false;
      sync();
    },
    { passive: true },
  );

  if (jump) {
    jump.addEventListener('click', () => {
      // Instant, not smooth: the scroll events of an animation report
      // positions short of the bottom, and would unstick it half way down.
      stuck = true;
      unseen = false;
      toBottom(box);
      sync();
    });
  }

  // The composer grows as a long message is typed, which shrinks the
  // transcript from below without any repaint. While stuck, stay at the end.
  observer?.disconnect();
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (stuck) toBottom(box);
    });
    observer.observe(box);
  }
}
