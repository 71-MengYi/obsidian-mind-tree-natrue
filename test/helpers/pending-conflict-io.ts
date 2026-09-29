import type { PendingConflictIO } from "../../src/services/pending-conflict-store";

/** Deterministic adapter: failures do not depend on the host filesystem. */
export class MemoryConflictIO implements PendingConflictIO {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  failWrite = false;
  failRemove = false;
  corruptReadback = false;
  writes = 0;
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
  async mkdir(path: string): Promise<void> { this.folders.add(path); }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const parent = (candidate: string) => candidate.slice(0, candidate.lastIndexOf("/"));
    return { files: [...this.files.keys()].filter((file) => parent(file) === path),
      folders: [...this.folders].filter((folder) => parent(folder) === path) };
  }
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return this.corruptReadback ? `${value} ` : value;
  }
  async write(path: string, value: string): Promise<void> {
    if (this.failWrite) throw new Error("disk full");
    this.writes++;
    this.files.set(path, value);
  }
  async process(path: string, fn: (text: string) => string): Promise<void> {
    await this.write(path, fn(await this.read(path)));
  }
  async remove(path: string): Promise<void> {
    if (this.failRemove) throw new Error("cleanup denied");
    this.files.delete(path);
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
