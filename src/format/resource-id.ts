import { createId } from "../domain/tree";

/** Separators available for newly identified non-Markdown resources. */
export type NonMarkdownResourceIdSeparator = "%" | "@";

export const DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR: NonMarkdownResourceIdSeparator = "@";
export const NON_MARKDOWN_RESOURCE_ID_LENGTH = 5;

const NEW_NON_MARKDOWN_ID_PATTERN = /([%@])([A-Za-z0-9]{5})(?=\.[^.]+$|$)/;
const LEGACY_NON_MARKDOWN_ID_PATTERN = /~mtn-([0-9a-hjkmnp-tv-z]{10})(?=\.[^.]+$|$)/i;
const SHORT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

interface NonMarkdownResourceIdentity {
  resourceId: string;
  separator?: NonMarkdownResourceIdSeparator;
  legacy: boolean;
}

export function extractNonMarkdownResourceId(path: string): string | undefined {
  return extractNonMarkdownResourceIdentity(path)?.resourceId;
}

/**
 * Add the current compact suffix to a new resource. The legacy ten-character
 * form is deliberately not generated here; it remains readable only.
 */
export function appendNonMarkdownResourceId(
  path: string,
  shortId: string,
  separator: NonMarkdownResourceIdSeparator = DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR
): string {
  if (isMarkdownPath(path)) return path;
  if (!/^[A-Za-z0-9]{5}$/.test(shortId)) throw new Error("Invalid Mind Tree short resource ID.");
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return `${directory}${name}${separator}${shortId}`;
  return `${directory}${name.slice(0, dotIndex)}${separator}${shortId}${name.slice(dotIndex)}`;
}

export function stripNonMarkdownResourceId(name: string): string {
  return name.replace(NEW_NON_MARKDOWN_ID_PATTERN, "").replace(LEGACY_NON_MARKDOWN_ID_PATTERN, "");
}

export function buildLinkedResourcePath(
  path: string,
  title: string,
  resourceId: string,
  separator: NonMarkdownResourceIdSeparator = DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR
): string {
  const cleanedTitle = title.replace(/[\\/:*?"<>|]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleanedTitle) throw new Error("The file name cannot be empty.");
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = name.lastIndexOf(".");
  // A mind-tree document has a compound extension. Preserving only the final
  // `.md` would silently turn it into a normal note during title synchronization.
  const mindTreeExtension = name.match(/\.mtn\.md$/i)?.[0];
  const extension = mindTreeExtension ?? (dotIndex > 0 ? name.slice(dotIndex) : "");
  const basePath = `${directory}${cleanedTitle}${extension}`;
  if (isMarkdownPath(path)) return basePath;

  // Renaming an existing resource must not silently rewrite its historical
  // identity syntax. The configured separator applies only when an unmanaged
  // file receives a brand-new compact ID.
  const existingIdentity = extractNonMarkdownResourceIdentity(path);
  if (existingIdentity?.legacy) return appendLegacyNonMarkdownResourceId(basePath, existingIdentity.resourceId);
  return appendNonMarkdownResourceId(
    basePath,
    existingIdentity?.resourceId ?? resourceId,
    existingIdentity?.separator ?? separator
  );
}

/** Produce the node title represented by a linked file path. */
export function linkedFileTitle(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").at(-1) ?? path;
  const withoutExtension = name.replace(/\.mtn\.md$/i, "").replace(/\.[^.]+$/, "");
  return stripNonMarkdownResourceId(withoutExtension);
}

export function createShortResourceId(): string {
  const bytes = new Uint8Array(NON_MARKDOWN_RESOURCE_ID_LENGTH);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((value) => value === 0)) {
    const fallback = createId().replace(/-/g, "");
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(fallback.slice(index * 2, index * 2 + 2) || "01", 16);
    }
  }
  return Array.from(bytes, (byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]).join("");
}

/** Recognize both the current compact suffix and the historical ~mtn- suffix. */
function extractNonMarkdownResourceIdentity(path: string): NonMarkdownResourceIdentity | undefined {
  const current = NEW_NON_MARKDOWN_ID_PATTERN.exec(path);
  if (current?.[1] && current[2]) {
    return {
      resourceId: current[2],
      separator: current[1] as NonMarkdownResourceIdSeparator,
      legacy: false
    };
  }
  const legacy = LEGACY_NON_MARKDOWN_ID_PATTERN.exec(path)?.[1];
  return legacy ? { resourceId: legacy.toLowerCase(), legacy: true } : undefined;
}

function appendLegacyNonMarkdownResourceId(path: string, resourceId: string): string {
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = name.lastIndexOf(".");
  const suffix = `~mtn-${resourceId.toLowerCase()}`;
  if (dotIndex <= 0) return `${directory}${name}${suffix}`;
  return `${directory}${name.slice(0, dotIndex)}${suffix}${name.slice(dotIndex)}`;
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

export function classifyFile(path: string): "note" | "image" | "attachment" {
  if (isMarkdownPath(path)) return "note";
  if (/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path)) return "image";
  return "attachment";
}
