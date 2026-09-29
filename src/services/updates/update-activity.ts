import { UpdateError } from "./release-client";

/** Tracks entire asynchronous operations, including their final node commit. */
export class UpdateActivity {
  private pending = new Set<Promise<unknown>>();
  private failures = 0;

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => {
      this.failures++;
      this.pending.delete(operation);
    });
    return operation;
  }

  async settle(): Promise<void> {
    const failures = this.failures;
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.failures !== failures) throw new UpdateError("save");
  }

  /**
   * Explicit entry-point instrumentation keeps existing command bodies and
   * error handling unchanged. Nested calls are tracked too. The returned
   * disposer restores only our wrappers, leaving third-party wrappers alone.
   */
  observe(target: object, names: readonly string[]): () => void {
    const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const restores = names.map((name) => {
      const original = methods[name];
      if (typeof original !== "function") throw new Error(`Unknown asynchronous update boundary: ${name}`);
      const activity = this;
      const wrapper = function (this: object, ...args: unknown[]): Promise<unknown> {
        return activity.track(original.apply(this, args));
      };
      methods[name] = wrapper;
      return () => { if (methods[name] === wrapper) methods[name] = original; };
    });
    return () => { for (const restore of restores.reverse()) restore(); };
  }
}
