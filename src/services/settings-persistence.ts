/**
 * Local I/O ordering only: Obsidian remains responsible for cross-device merges.
 * An external-settings notification invalidates queued snapshots immediately,
 * even when an earlier save is still waiting for I/O.
 */
export class SettingsPersistence<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private readFailed = false;
  private lastFailure?: unknown;

  constructor(private readonly ports: {
    read(): Promise<T>;
    write(value: T): Promise<void>;
    apply(value: T): void;
    failed(error: unknown, operation: "read" | "write"): void;
  }) {}

  private serial(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }

  reload(): Promise<void> {
    const generation = ++this.generation;
    this.cancelRetry();
    return this.serial(async () => {
      if (this.disposed || generation !== this.generation) return;
      try {
        const value = await this.ports.read();
        if (this.disposed || generation !== this.generation) return;
        this.readFailed = false;
        this.lastFailure = undefined;
        this.ports.apply(value);
      } catch (error) {
        if (generation !== this.generation || this.disposed) return;
        this.readFailed = true;
        this.lastFailure = error;
        this.ports.failed(error, "read");
      }
    });
  }

  save(value: T): Promise<void> {
    const generation = ++this.generation;
    this.cancelRetry();
    const snapshot = structuredClone(value);
    return this.write(snapshot, generation);
  }

  private write(value: T, generation: number): Promise<void> {
    return this.serial(async () => {
      if (this.disposed || generation !== this.generation) return;
      try {
        // A failed read may mean malformed JSON. Never replace it with defaults.
        if (this.readFailed) {
          await this.ports.read();
          if (this.disposed || generation !== this.generation) return;
          this.readFailed = false;
        }
        await this.ports.write(value);
        this.retryAttempt = 0;
        this.lastFailure = undefined;
      } catch (error) {
        if (this.disposed || generation !== this.generation) return;
        this.ports.failed(error, "write");
        this.lastFailure = error;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retryAttempt++, 5));
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.write(value, generation);
        }, delay);
      }
    });
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    this.retryAttempt = 0;
  }

  /** Unlike ordinary UI saves, update preparation must observe failed writes. */
  async flush(): Promise<void> {
    let tail: Promise<unknown>;
    do { tail = this.tail; await tail; } while (tail !== this.tail);
    if (this.disposed || this.readFailed || this.lastFailure || this.retry !== undefined) {
      throw this.lastFailure ?? new Error("Settings have not been saved.");
    }
  }

  destroy(): void {
    this.disposed = true;
    this.generation++;
    this.cancelRetry();
  }
}

/** One-time cleanup operates on the atomic callback's latest text, not old memory. */
export function removeLegacyResourceIndex(source: string): string {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin settings JSON");
  if (!Object.hasOwn(value, "resourceIndex")) return source;
  const result = { ...value } as Record<string, unknown>;
  delete result["resourceIndex"];
  return JSON.stringify(result, null, 2);
}
