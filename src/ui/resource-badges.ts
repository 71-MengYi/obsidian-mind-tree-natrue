import {
  getVisibleNodeMarkers,
  hasExcalidrawResourceMarker,
  hasMindTreeResourceMarker
} from "../domain/markers";
import { isMarkdownPath, stripNonMarkdownResourceId } from "../format/resource-id";
import type { MindTreeNode } from "../types";

export type ResourceBadgeKind = "mind-tree" | "excalidraw" | "extension";

export interface ResourceBadge {
  readonly kind: ResourceBadgeKind;
  readonly label: string;
}

export interface ResourceBadgeSize {
  readonly width: number;
  readonly height: number;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string;
}

export interface ResourceBadgeLabels {
  readonly mindTree: string;
  readonly drawing: string;
}

export interface FileBadgeRules {
  readonly ignoredFileBadgeExtensions: readonly string[];
  readonly fileExtensionBadgeAliases: Readonly<Record<string, string>>;
}

export interface ResourceBadgeMeasurer {
  measure(badge: Readonly<ResourceBadge>): ResourceBadgeSize;
}

/**
 * Runtime-only presentation used by layout, DOM rendering and export. Extension
 * badges are deliberately derived from a linked path and global settings, so
 * they never become node data or affect the generated Markdown outline.
 */
export interface ResourceBadgePresentation {
  resolve(node: Readonly<MindTreeNode>): readonly ResourceBadge[];
  measure(badge: Readonly<ResourceBadge>): ResourceBadgeSize;
}

export interface NodeMarkerGeometry {
  readonly resourceBadges: readonly ResourceBadge[];
  readonly width: number;
  readonly height: number;
}

export const MANUAL_MARKER_SIZE = 18;
export const NODE_MARKER_GAP = 2;
export const MAX_FILE_BADGE_EXTENSION_LENGTH = 64;
export const MAX_FILE_BADGE_ALIAS_LENGTH = 32;
export const MAX_FILE_BADGE_RULE_ENTRIES = 256;

const MAX_BADGE_MEASUREMENT_CACHE_ENTRIES = 1_000;
const VALID_EXTENSION_PATTERN = /^[a-z0-9+_-]+(?:\.[a-z0-9+_-]+)*$/i;
// Automatic filename parsing is stricter than existing user-entered rule keys.
// Keep the latter unchanged so loading settings never rewrites saved rules.
const AUTO_EXTENSION_SEGMENT_PATTERN = /^[a-z0-9]+$/i;
const UNSAFE_EXTENSION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FALLBACK_BADGE_LABELS: ResourceBadgeLabels = { mindTree: "思维树", drawing: "绘图" };
const EMPTY_BADGE_RULES: FileBadgeRules = {
  ignoredFileBadgeExtensions: [],
  fileExtensionBadgeAliases: Object.freeze({})
};

/** Normalize user-facing `.PDF` and `pdf` keys to one case-insensitive form. */
export function normalizeFileBadgeExtension(value: string): string | undefined {
  const normalized = value.trim().replace(/^\.+/, "").toLowerCase();
  if (!normalized || normalized.length > MAX_FILE_BADGE_EXTENSION_LENGTH) return undefined;
  return VALID_EXTENSION_PATTERN.test(normalized) && !UNSAFE_EXTENSION_KEYS.has(normalized)
    ? normalized
    : undefined;
}

/** Alias text is displayed verbatim after outer whitespace is removed. */
export function normalizeFileBadgeAlias(value: string): string | undefined {
  const normalized = value.trim();
  return normalized && Array.from(normalized).length <= MAX_FILE_BADGE_ALIAS_LENGTH
    ? normalized
    : undefined;
}

/**
 * Read whole alphanumeric suffix segments from right to left. An invalid segment
 * belongs to the filename, so stop there instead of rejecting the valid suffix
 * after it or extracting only part of that segment. The first meaningful dot
 * bounds the scan: neither the filename stem nor a hidden-file prefix is a suffix.
 */
export function deriveFileBadgeExtension(path: string): string | undefined {
  const filename = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const cleanName = stripNonMarkdownResourceId(filename);
  const firstDot = cleanName.indexOf(".", cleanName.startsWith(".") ? 1 : 0);
  if (firstDot <= 0 || firstDot === cleanName.length - 1) return undefined;
  const segments = cleanName.slice(firstDot + 1).split(".");
  let suffixStart = segments.length;
  while (suffixStart > 0 && AUTO_EXTENSION_SEGMENT_PATTERN.test(segments[suffixStart - 1]!)) {
    suffixStart -= 1;
  }
  if (suffixStart === segments.length) return undefined;
  // Retain the existing case normalization, length limit and unsafe-key checks.
  return normalizeFileBadgeExtension(segments.slice(suffixStart).join("."));
}

/** Full compound suffix wins, while a final-extension rule remains convenient. */
export function fileBadgeExtensionCandidates(extension: string): readonly string[] {
  const normalized = normalizeFileBadgeExtension(extension);
  if (!normalized) return [];
  const finalExtension = normalized.split(".").at(-1)!;
  return finalExtension === normalized ? [normalized] : [normalized, finalExtension];
}

export function resolveResourceBadges(
  node: Readonly<MindTreeNode>,
  rules: FileBadgeRules,
  labels: ResourceBadgeLabels
): readonly ResourceBadge[] {
  const ignored = new Set(rules.ignoredFileBadgeExtensions
    .map(normalizeFileBadgeExtension)
    .filter((value): value is string => value !== undefined));
  const aliases = new Map<string, string>();
  for (const [key, value] of Object.entries(rules.fileExtensionBadgeAliases)) {
    const normalizedKey = normalizeFileBadgeExtension(key);
    const normalizedAlias = normalizeFileBadgeAlias(value);
    if (normalizedKey && normalizedAlias) aliases.set(normalizedKey, normalizedAlias);
  }
  return resolveResourceBadgesFromLookups(node, ignored, aliases, labels);
}

function resolveResourceBadgesFromLookups(
  node: Readonly<MindTreeNode>,
  ignored: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
  labels: ResourceBadgeLabels
): readonly ResourceBadge[] {
  const specialBadges: ResourceBadge[] = [];
  if (hasMindTreeResourceMarker(node)) specialBadges.push({ kind: "mind-tree", label: labels.mindTree });
  if (hasExcalidrawResourceMarker(node)) specialBadges.push({ kind: "excalidraw", label: labels.drawing });
  if (specialBadges.length > 0) return specialBadges;

  const resource = node.resource;
  if (resource?.type !== "file") return [];
  const extension = deriveFileBadgeExtension(resource.pathHint);
  if (!extension) return [];
  const candidates = fileBadgeExtensionCandidates(extension);
  if (candidates.some((candidate) => ignored.has(candidate))) return [];
  const alias = candidates.map((candidate) => aliases.get(candidate)).find((value) => value !== undefined);
  // Markdown is opt-in, not excluded from rule matching: plugin.md can use a
  // specific alias and ordinary notes can use an md alias. Without a matching
  // alias, preserve their existing badge-free appearance instead of adding MD.
  // Dedicated mind-tree/drawing badges have already returned above.
  if (alias === undefined && isMarkdownPath(resource.pathHint)) return [];
  return [{ kind: "extension", label: alias ?? extension.toUpperCase() }];
}

export function createResourceBadgePresentation(
  rules: FileBadgeRules,
  labels: ResourceBadgeLabels,
  measurer: ResourceBadgeMeasurer = fallbackResourceBadgeMeasurer
): ResourceBadgePresentation {
  // Normalize once for a render pass instead of rebuilding lookup tables for
  // every node in a large tree.
  const ignoredFileBadgeExtensions = new Set(rules.ignoredFileBadgeExtensions
    .map(normalizeFileBadgeExtension)
    .filter((value): value is string => value !== undefined));
  const fileExtensionBadgeAliases = new Map<string, string>();
  for (const [key, value] of Object.entries(rules.fileExtensionBadgeAliases)) {
    const normalizedKey = normalizeFileBadgeExtension(key);
    const normalizedAlias = normalizeFileBadgeAlias(value);
    if (normalizedKey && normalizedAlias) fileExtensionBadgeAliases.set(normalizedKey, normalizedAlias);
  }
  return {
    resolve: (node) => resolveResourceBadgesFromLookups(
      node,
      ignoredFileBadgeExtensions,
      fileExtensionBadgeAliases,
      labels
    ),
    measure: (badge) => measurer.measure(badge)
  };
}

/** Combine fixed icon markers and measured text badges into one trailing box. */
export function getNodeMarkerGeometry(
  node: Readonly<MindTreeNode>,
  presentation: ResourceBadgePresentation = fallbackResourceBadgePresentation
): NodeMarkerGeometry {
  const manualCount = getVisibleNodeMarkers(node).length;
  const resourceBadges = presentation.resolve(node);
  const badgeSizes = resourceBadges.map((badge) => presentation.measure(badge));
  const itemCount = manualCount + resourceBadges.length;
  if (itemCount === 0) return { resourceBadges, width: 0, height: 0 };
  return {
    resourceBadges,
    width: NODE_MARKER_GAP
      + manualCount * MANUAL_MARKER_SIZE
      + badgeSizes.reduce((sum, size) => sum + size.width, 0)
      + (itemCount - 1) * NODE_MARKER_GAP,
    height: Math.max(manualCount > 0 ? MANUAL_MARKER_SIZE : 0, ...badgeSizes.map((size) => size.height))
  };
}

/** Deterministic headless fallback; the live view uses measured DOM badges. */
export const fallbackResourceBadgeMeasurer: ResourceBadgeMeasurer = {
  measure(badge) {
    const glyphWidth = Array.from(badge.label).reduce((sum, character) =>
      sum + (/^[\x00-\x7F]$/u.test(character) ? 6 : 10), 0);
    const border = badge.kind === "mind-tree" ? 2 : 0;
    return { width: Math.ceil(glyphWidth) + 4 + border, height: 12 + 4 + border };
  }
};

export const fallbackResourceBadgePresentation = createResourceBadgePresentation(
  EMPTY_BADGE_RULES,
  FALLBACK_BADGE_LABELS,
  fallbackResourceBadgeMeasurer
);

/** Measure badge boxes with the exact CSS resolved by the current Obsidian UI. */
export class BrowserResourceBadgeMeasurer implements ResourceBadgeMeasurer {
  private readonly probes: Record<ResourceBadgeKind, HTMLElement>;
  private readonly cache = new Map<string, ResourceBadgeSize>();
  private styleSignature = "";

  constructor(private readonly host: HTMLElement) {
    this.probes = {
      "mind-tree": this.createProbe("mind-tree"),
      excalidraw: this.createProbe("excalidraw"),
      extension: this.createProbe("extension")
    };
    this.refreshStyles();
  }

  measure(badge: Readonly<ResourceBadge>): ResourceBadgeSize {
    const key = `${this.styleSignature}\u0000${badge.kind}\u0000${badge.label}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const probe = this.probes[badge.kind];
    probe.textContent = badge.label;
    const rect = probe.getBoundingClientRect();
    const computed = probe.ownerDocument.defaultView?.getComputedStyle(probe);
    const measured = rect.width > 0 && rect.height > 0
      ? {
        width: rect.width,
        height: rect.height,
        fontFamily: computed?.fontFamily || undefined,
        fontSize: finitePositiveNumber(computed?.fontSize),
        fontWeight: computed?.fontWeight || undefined
      }
      : fallbackResourceBadgeMeasurer.measure(badge);
    if (this.cache.size >= MAX_BADGE_MEASUREMENT_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, measured);
    return measured;
  }

  refreshStyles(): boolean {
    const ownerWindow = this.host.ownerDocument.defaultView;
    const signature = (Object.keys(this.probes) as ResourceBadgeKind[]).map((kind) => {
      const computed = ownerWindow?.getComputedStyle(this.probes[kind]);
      return computed ? [
        computed.fontFamily, computed.fontSize, computed.fontWeight, computed.lineHeight,
        computed.letterSpacing, computed.paddingBlock, computed.paddingInline,
        computed.borderBlockWidth, computed.borderInlineWidth
      ].join(";") : kind;
    }).join("|");
    if (signature === this.styleSignature) return false;
    this.styleSignature = signature;
    this.cache.clear();
    return true;
  }

  invalidate(): void {
    this.styleSignature = "";
    this.cache.clear();
  }

  destroy(): void {
    for (const probe of Object.values(this.probes)) probe.remove();
    this.cache.clear();
  }

  private createProbe(kind: ResourceBadgeKind): HTMLElement {
    return this.host.createSpan({
      cls: `mtn-node-marker is-resource-badge is-${kind} mtn-resource-badge-measure-probe`,
      text: kind
    });
  }
}

function finitePositiveNumber(value: string | undefined): number | undefined {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
