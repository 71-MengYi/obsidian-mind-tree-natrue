export type DuplicateIdentityDecision =
  | { action: "keep" }
  | { action: "reassign" }
  | { action: "reject"; paths: string[] };

export interface DocumentIdentityWriteDecision {
  documentId: string;
  write: boolean;
}

/**
 * Decide duplicate ownership without depending on Obsidian runtime objects.
 * Only a path recorded before the current scan is trusted as the original.
 */
export function decideDuplicateIdentity(
  requestedPath: string,
  ownerPath: string | undefined,
  ownerTrusted: boolean,
  livePaths: readonly string[]
): DuplicateIdentityDecision {
  const paths = [...new Set(livePaths)].sort((left, right) => left.localeCompare(right));
  if (paths.length <= 1) return { action: "keep" };
  if (!ownerTrusted || !ownerPath) return { action: "reject", paths };
  return ownerPath === requestedPath ? { action: "keep" } : { action: "reassign" };
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
