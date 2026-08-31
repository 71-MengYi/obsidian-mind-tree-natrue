import {
  MAX_STRUCTURED_CLIPBOARD_BYTES,
  assertJsonContainerDepth,
  utf8ByteLength
} from "../input-limits";

export { DragDropController, type ExternalFileBatch } from "./controllers/drag-drop-controller";

/**
 * Extract vault-like paths from the text formats commonly carried by internal
 * Obsidian drags. Resolution against the actual vault happens in the view so a
 * plain basename can still use MetadataCache link resolution.
 */
export function extractVaultPathCandidates(payloads: string[], vaultName: string): string[] {
  const candidates = new Set<string>();

  const add = (rawValue: string): void => {
    // Strip quotes only when they form a matching wrapper; an unmatched quote
    // can be a legal character in a payload and must not silently change paths.
    let value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!value || value.startsWith("#")) return;
    try { value = decodeURIComponent(value); } catch { /* Keep malformed text unchanged. */ }

    if (/^file:/i.test(value) || /^https?:/i.test(value)) return;
    if (/^obsidian:/i.test(value)) {
      try {
        const url = new URL(value);
        const file = url.searchParams.get("file");
        if (file) add(file);
      } catch { /* Ignore invalid application URLs. */ }
      return;
    }
    if (/^app:\/\/obsidian\.md\//i.test(value)) {
      try {
        const url = new URL(value);
        value = url.pathname.replace(/^\/+/, "");
      } catch { return; }
    }

    value = value.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\\/g, "/");
    if (vaultName && value.startsWith(`${vaultName}/`)) value = value.slice(vaultName.length + 1);
    const hashIndex = value.indexOf("#");
    if (hashIndex >= 0) value = value.slice(0, hashIndex);
    if (value) candidates.add(value);
  };

  const visitJson = (value: unknown): void => {
    assertJsonContainerDepth(value);
    const pending: Array<{ value: unknown; key: string }> = [{ value, key: "" }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (typeof current.value === "string") {
        if (["path", "file", "filePath", "sourcePath"].includes(current.key) || current.key === "") {
          add(current.value);
        }
        continue;
      }
      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          pending.push({ value: current.value[index], key: current.key });
        }
        continue;
      }
      if (!current.value || typeof current.value !== "object") continue;
      const entries = Object.entries(current.value as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        pending.push({ value: child, key });
      }
    }
  };

  for (const payload of payloads) {
    const trimmed = payload.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let decoded: unknown;
      try {
        if (utf8ByteLength(trimmed) > MAX_STRUCTURED_CLIPBOARD_BYTES) continue;
        decoded = JSON.parse(trimmed) as unknown;
      } catch { /* A textual path may legally begin with a bracket. */ }
      if (decoded !== undefined) {
        try { visitJson(decoded); } catch { /* Ignore unsafe structured drag data. */ }
        continue;
      }
    }

    let foundLink = false;
    for (const match of trimmed.matchAll(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      if (match[1]) add(match[1]);
      foundLink = true;
    }
    for (const match of trimmed.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (match[1]) add(match[1]);
      foundLink = true;
    }
    if (foundLink) continue;
    for (const line of trimmed.split(/\r?\n/)) add(line);
  }

  return [...candidates];
}
