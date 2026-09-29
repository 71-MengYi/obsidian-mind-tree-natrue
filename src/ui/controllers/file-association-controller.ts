import type { FileAssociationProgress } from "../../services/resource-index";

interface CollectionPorts<T extends { cancelled: boolean; assertCurrent(): void }> {
  readonly total: number;
  readonly isCurrent: () => boolean;
  readonly progress: (value: FileAssociationProgress | undefined) => void;
  readonly yield: () => Promise<void>;
  readonly collect: (progress: (value: FileAssociationProgress) => void, isCurrent: () => boolean) => Promise<T>;
  readonly accept: (result: T) => void;
  readonly failed: (error: unknown) => void;
}

/**
 * Owns only the lifetime of UI-initiated file operations. It has no document or
 * Vault access: the caller still validates its session/node at each mutation.
 */
export class FileAssociationController {
  private readonly noteTasks = new Map<string, Promise<void>>();
  private collection?: { cancel(): void };
  private destroyed = false;

  get collecting(): boolean { return this.collection !== undefined; }

  /** Holding Ctrl+E or clicking twice joins the original creation operation. */
  createOnce(key: string, create: () => Promise<void>): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const pending = this.noteTasks.get(key);
    if (pending) return pending;
    const task = Promise.resolve().then(() => this.destroyed ? undefined : create()).finally(() => {
      if (this.noteTasks.get(key) === task) this.noteTasks.delete(key);
    });
    this.noteTasks.set(key, task);
    return task;
  }

  async collect<T extends { cancelled: boolean; assertCurrent(): void }>(ports: CollectionPorts<T>): Promise<void> {
    if (this.destroyed || this.collection || !ports.isCurrent()) return;
    const task = { cancel: () => {
      if (this.collection !== task) return;
      this.collection = undefined;
      ports.progress(undefined);
    } };
    this.collection = task;
    const current = () => !this.destroyed && this.collection === task && ports.isCurrent();
    ports.progress({ phase: "verify", completed: 0, total: ports.total });
    try {
      // Let the neutral progress message paint before any warm-cache batch.
      await ports.yield();
      if (!current()) return;
      const result = await ports.collect((value) => { if (current()) ports.progress(value); }, current);
      if (!current() || result.cancelled) return;
      result.assertCurrent();
      ports.accept(result);
    } catch (error) {
      if (current()) ports.failed(error);
    } finally { task.cancel(); }
  }

  cancelCollection(): void { this.collection?.cancel(); }

  destroy(): void {
    this.destroyed = true;
    this.cancelCollection();
    // In-flight note files are retained. Their original target guards prevent
    // completion against a closed/switched view; no file operation is retried.
  }
}
