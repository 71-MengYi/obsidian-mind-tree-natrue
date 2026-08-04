/**
 * Fixed safety boundaries for every untrusted data entry point.
 *
 * These are deliberately product constants rather than settings. Raising them
 * changes the amount of memory and synchronous work a file can force Obsidian
 * to perform, so callers must not silently override them.
 */
export const MAX_COMPRESSED_MIND_TREE_BYTES = 20 * 1024 * 1024;
export const MAX_DECOMPRESSED_MIND_TREE_BYTES = 50 * 1024 * 1024;
export const MAX_MIND_TREE_NODES = 10_000;
export const MAX_MIND_TREE_DEPTH = 256;
export const MAX_JSON_CONTAINER_DEPTH = 256;
export const MAX_STRUCTURED_CLIPBOARD_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_IMPORT_BYTES = 10 * 1024 * 1024;
export const EXTERNAL_FILE_CONFIRM_BYTES = 100 * 1024 * 1024;
export const EXTERNAL_FILE_REJECT_BYTES = 1024 * 1024 * 1024;

/** Small compressed chunks bound the largest single streaming inflate output. */
export const GUNZIP_INPUT_CHUNK_BYTES = 4 * 1024;

const DANGEROUS_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class InputLimitError extends Error {
  constructor(
    readonly code:
      | "compressed-bytes"
      | "decompressed-bytes"
      | "clipboard-bytes"
      | "text-import-bytes"
      | "node-count"
      | "tree-depth"
      | "json-depth"
      | "unsafe-key",
    message: string
  ) {
    super(message);
    this.name = "InputLimitError";
  }
}

/** UTF-8 byte length without retaining a second encoded copy of a large string. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xDC00 && value.charCodeAt(index + 1) <= 0xDFFF) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function assertSafeRecordKey(key: string): void {
  if (DANGEROUS_RECORD_KEYS.has(key)) {
    throw new InputLimitError("unsafe-key", `Unsafe object key is not allowed: ${key}`);
  }
}

/**
 * Inspect parsed JSON iteratively. JSON.parse itself does not execute values,
 * but deeply nested unknown fields can later overflow JSON.stringify or clone
 * operations unless they are bounded here.
 */
export function assertJsonContainerDepth(value: unknown, maximumDepth = MAX_JSON_CONTAINER_DEPTH): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (current.depth > maximumDepth) {
      throw new InputLimitError("json-depth", `JSON nesting exceeds the ${maximumDepth}-level safety limit.`);
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      assertSafeRecordKey(key);
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

/** A null-prototype map prevents special node IDs from mutating prototypes. */
export function createSafeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
