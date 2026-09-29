import { canonicalTreePath } from "./pending-conflict-store";

export interface MindTreeOpenPorts<Leaf> {
  findExisting(path: string, requested: Leaf): Leaf | undefined;
  reveal(leaf: Leaf): Promise<void>;
  discardRedirected(requested: Leaf, winner: Leaf, path: string): void;
}

/** Path-based single-flight routing; identities are deliberately irrelevant. */
export class MindTreeOpenCoordinator<Leaf> {
  private readonly opening = new Map<string, { leaf: Leaf; task: Promise<Leaf>; nestedRoute: boolean }>();

  constructor(private readonly ports: MindTreeOpenPorts<Leaf>) {}

  /** openFile internally calls setViewState on the same leaf; do not await itself. */
  isOpening(path: string, leaf: Leaf): boolean {
    return this.opening.get(canonicalTreePath(path))?.leaf === leaf;
  }

  /** One openFile → setViewState delegation is allowed; independent repeats wait. */
  consumeNestedRoute(path: string, leaf: Leaf): boolean {
    const entry = this.opening.get(canonicalTreePath(path));
    if (!entry || entry.leaf !== leaf || !entry.nestedRoute) return false;
    entry.nestedRoute = false;
    return true;
  }

  async open(path: string, requested: Leaf, open: () => Promise<unknown>, activate = true, nestedRoute = false): Promise<Leaf> {
    const key = canonicalTreePath(path);
    const inFlight = this.opening.get(key);
    let winner: Leaf;
    if (inFlight) winner = await inFlight.task;
    else {
      const existing = this.ports.findExisting(key, requested);
      if (existing) winner = existing;
      else {
        // Defer the actual open by a microtask so nested setViewState sees the
        // reservation before Obsidian starts constructing a view.
        const task = Promise.resolve().then(open).then(() => requested);
        this.opening.set(key, { leaf: requested, task, nestedRoute });
        try { winner = await task; }
        finally { if (this.opening.get(key)?.task === task) this.opening.delete(key); }
      }
    }
    if (winner !== requested) this.ports.discardRedirected(requested, winner, key);
    if (activate) await this.ports.reveal(winner);
    return winner;
  }
}
