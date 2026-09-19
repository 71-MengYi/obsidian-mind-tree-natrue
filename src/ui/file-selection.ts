/** Minimal shape keeps vault-file filtering independent from Obsidian runtime. */
export interface VaultFileCandidate {
  readonly path: string;
}

/**
 * Return every vault file except the mind tree currently being edited.
 * A copy is sorted for deterministic fuzzy-search results without mutating the
 * array owned by Obsidian's Vault service.
 */
export function linkableVaultFiles<T extends VaultFileCandidate>(
  files: readonly T[],
  currentMindTreePath?: string
): T[] {
  return files
    .filter((file) => file.path !== currentMindTreePath)
    .sort((left, right) => left.path.localeCompare(right.path));
}
