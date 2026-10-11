/**
 * Promise-tail helper for the file-level serial lanes: it owns only the
 * "next task runs after the previous one settled" bookkeeping so callers keep
 * their own validation, generation checks and error reporting.
 *
 * Two tail semantics exist in this codebase and both are preserved explicitly:
 * `serial()` keeps the tail rejecting (a later task still runs because it
 * chains through `catch` first) while `serialNormalized()` keeps the tail
 * permanently resolved so reference comparison and `await tail` never throw.
 */
export class SerialTaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Next task starts after the previous attempt settled, success or failure. */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(task);
    this.tail = next;
    return next;
  }

  /**
   * Same ordering, but the stored tail never rejects. Callers that need the
   * failure still receive it from the returned promise; `tail` itself stays a
   * resolved-reference marker that may be awaited or compared repeatedly.
   */
  serialNormalized(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Target of `await`/reference comparison; never rejects for `serialNormalized`. */
  get settledTail(): Promise<unknown> {
    return this.tail;
  }
}
