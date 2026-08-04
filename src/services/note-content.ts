/**
 * Default content belongs to plugin data, which can contain stale or manually
 * edited values. Accept only strings so note creation never serializes an
 * unexpected object as Markdown.
 */
export function normalizeNewNoteDefaultContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Ordinary topic notes use the configured Markdown verbatim. In particular,
 * the node title is deliberately absent from this function: it names the file
 * but must never be injected as an implicit level-one heading.
 */
export function buildNewNoteBody(defaultContent: string): string {
  return defaultContent;
}
