'use strict';
/**
 * Run functions one at a time, in the order they were queued.
 *
 * What the stores use to keep a read-modify-write atomic once their I/O is
 * async (AGENTS.md, "The trap this rule creates"): every public method of a
 * store runs through its own queue, so a second save cannot read the file
 * between the first one's read and its rename.
 *
 * One failure must not wedge the queue: the next function runs whether the
 * previous one resolved or threw, and each caller still sees its own result
 * or rejection.
 *
 * Per instance on purpose, not per file or process-wide; see the note in
 * session-store.ts. And never re-entered: a queued function that queues
 * another on the same instance waits for itself.
 */
export class SerialQueue {
  /** The last queued function's settlement. Resolved means idle. */
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.#tail.then(
      () => fn(),
      () => fn(),
    );
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
