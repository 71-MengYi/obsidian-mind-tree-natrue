/**
 * Reading a mind tree races against everything else that writes the file:
 * Obsidian rewrites wiki links after a rename, sync clients replace the whole
 * file, and the plugin itself writes through `Vault.process`. A plain read can
 * therefore land in the middle of somebody's write and observe truncated or
 * mixed bytes — which is exactly what made the plugin report "damaged" for a
 * file that was healthy again a moment later.
 *
 * These helpers only trust bytes that came from a file that did not change while
 * it was being read. They never write, and they treat "not yet usable" as a
 * reason to wait, not as proof of damage.
 */

export interface StableSourcePorts {
  /** Identity of the current on-disk revision; undefined when the path is gone. */
  readonly stamp: () => Promise<string | undefined>;
  readonly read: () => Promise<string>;
  readonly delay: (milliseconds: number) => Promise<void>;
}

/** Backoff shared by every confirmation: small, bounded, and never blocking a save. */
export const STABLE_READ_DELAYS_MS: readonly number[] = [120, 400, 1000];

export type StableReadOutcome =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly reason: "missing" | "unstable" };

export type ConfirmedSourceOutcome =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly reason: "missing" | "unstable" }
  | { readonly ok: false; readonly reason: "damaged"; readonly source: string };

type SettledRead =
  | { readonly kind: "ok"; readonly source: string }
  | { readonly kind: "missing" }
  | { readonly kind: "changed" };

/**
 * Read once and keep the result only when the file revision is identical before
 * and after the read. A missing path is reported as such instead of as failure.
 */
async function readSettled(ports: StableSourcePorts): Promise<SettledRead> {
  const before = await ports.stamp();
  if (before === undefined) return { kind: "missing" };
  const source = await ports.read();
  return (await ports.stamp()) === before ? { kind: "ok", source } : { kind: "changed" };
}

export async function readStableSource(
  ports: StableSourcePorts,
  delays: readonly number[] = STABLE_READ_DELAYS_MS
): Promise<StableReadOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const settled = await readSettled(ports);
    if (settled.kind === "ok") return { ok: true, source: settled.source };
    if (settled.kind === "missing") return { ok: false, reason: "missing" };
    const wait = delays[attempt];
    if (wait === undefined) return { ok: false, reason: "unstable" };
    await ports.delay(wait);
  }
}

/**
 * Re-read until the settled bytes are usable.
 *
 * This is the only place allowed to conclude that a payload is damaged: the
 * caller supplies the usability test (usually "it parses"), and a path that is
 * merely in flux — including a sync client's remove-and-replace window — is
 * retried within the same bounded budget instead of ending the document.
 */
export async function confirmUsableSource(
  ports: StableSourcePorts,
  isUsable: (source: string) => boolean,
  delays: readonly number[] = STABLE_READ_DELAYS_MS
): Promise<ConfirmedSourceOutcome> {
  let lastUnusable: string | undefined;
  let unstable = false;
  for (let attempt = 0; ; attempt += 1) {
    const settled = await readSettled(ports);
    if (settled.kind === "ok") {
      if (isUsable(settled.source)) return { ok: true, source: settled.source };
      lastUnusable = settled.source;
    } else if (settled.kind === "changed") unstable = true;
    const wait = delays[attempt];
    if (wait === undefined) break;
    await ports.delay(wait);
  }
  if (lastUnusable !== undefined) return { ok: false, reason: "damaged", source: lastUnusable };
  return { ok: false, reason: unstable ? "unstable" : "missing" };
}
