import { evictOldest } from "../lru-cache";
import {
  fallbackResourceBadgeMeasurer,
  MANUAL_MARKER_SIZE,
  type ResourceBadge,
  type ResourceBadgeKind,
  type ResourceBadgeMeasurer,
  type ResourceBadgeSize
} from "../render/resource-badges";

const MAX_BADGE_MEASUREMENT_CACHE_ENTRIES = 1_000;

/** Measure badge boxes with the exact CSS resolved by the current Obsidian UI. */
export class BrowserResourceBadgeMeasurer implements ResourceBadgeMeasurer {
  private readonly probes: Record<ResourceBadgeKind, HTMLElement>;
  private readonly cache = new Map<string, ResourceBadgeSize>();
  private styleSignature = "";

  constructor(private readonly host: HTMLElement) {
    this.probes = {
      "mind-tree": this.createProbe("mind-tree"),
      excalidraw: this.createProbe("excalidraw"),
      extension: this.createProbe("extension"),
      // Emoji keep the fixed square marker box; only tags need a text probe.
      emoji: this.createProbe("emoji"),
      tag: this.createProbe("tag")
    };
    this.refreshStyles();
  }

  measure(badge: Readonly<ResourceBadge>): ResourceBadgeSize {
    if (badge.kind === "emoji") return { width: MANUAL_MARKER_SIZE, height: MANUAL_MARKER_SIZE };
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
    evictOldest(this.cache, MAX_BADGE_MEASUREMENT_CACHE_ENTRIES);
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
