export type DuplicateIdentityDecision =
  | { action: "keep" }
  | { action: "reject"; paths: string[] };

export interface DocumentIdentityWriteDecision {
  documentId: string;
  write: boolean;
}

/**
 * Decide duplicate ownership without depending on Obsidian runtime objects.
 * Historical paths cannot prove original ownership across devices.
 */
export function decideDuplicateIdentity(
  livePaths: readonly string[]
): DuplicateIdentityDecision {
  const paths = [...new Set(livePaths)].sort((left, right) => left.localeCompare(right));
  if (paths.length <= 1) return { action: "keep" };
  return { action: "reject", paths };
}

/**
 * Compare-and-set policy for lazy identity writes. If another operation has
 * already changed the value we adopt that winner rather than overwrite it.
 */
export function decideDocumentIdentityWrite(
  currentDocumentId: string | undefined,
  proposedDocumentId: string,
  expectedDocumentId?: string
): DocumentIdentityWriteDecision {
  if (currentDocumentId && currentDocumentId !== expectedDocumentId) {
    return { documentId: currentDocumentId, write: false };
  }
  return {
    documentId: proposedDocumentId,
    write: currentDocumentId !== proposedDocumentId
  };
}
