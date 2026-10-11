import { evictOldest } from "../lru-cache";
import {
  estimateFallbackTextWidth,
  FALLBACK_STYLES,
  measureRichTitle,
  measureWith,
  prepareNodeText,
  splitGraphemes,
  type NodeTextMeasureMode,
  type NodeTextMeasurer,
  type NodeTextStyle,
  type NodeTitleMeasurement
} from "../render/text-measurer";

const MAX_MEASUREMENT_CACHE_ENTRIES = 10_000;

/**
 * Measures titles with the font that Obsidian actually resolved for each node
 * tier. Hidden probes are necessary because themes and user snippets can change
 * inherited font family, weight, line height, and letter spacing at runtime.
 */
export class BrowserNodeTextMeasurer implements NodeTextMeasurer {
  private readonly probeRoots: readonly [HTMLElement, HTMLElement, HTMLElement];
  private readonly probes: readonly [HTMLElement, HTMLElement, HTMLElement];
  private readonly context?: CanvasRenderingContext2D;
  private readonly cache = new Map<string, NodeTitleMeasurement>();
  private styles: readonly [NodeTextStyle, NodeTextStyle, NodeTextStyle] = FALLBACK_STYLES;
  private styleSignature = "";
  private destroyed = false;
  private readonly fontLoadListener: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly onMetricsInvalidated: () => void
  ) {
    const root = host.createDiv("mtn-node mtn-depth-root mtn-text-measure-probe");
    const levelOne = host.createDiv("mtn-node mtn-depth-1 mtn-text-measure-probe");
    const descendant = host.createDiv("mtn-node mtn-depth-2 mtn-text-measure-probe");
    this.probeRoots = [root, levelOne, descendant];
    this.probes = [
      root.createDiv({ cls: "mtn-node-title", text: "M1思" }),
      levelOne.createDiv({ cls: "mtn-node-title", text: "M1思" }),
      descendant.createDiv({ cls: "mtn-node-title", text: "M1思" })
    ];
    const canvas = host.ownerDocument.createElement("canvas");
    this.context = canvas.getContext("2d") ?? undefined;
    this.fontLoadListener = () => {
      if (this.destroyed) return;
      this.invalidate();
      this.onMetricsInvalidated();
    };
    host.ownerDocument.fonts?.addEventListener("loadingdone", this.fontLoadListener);
    this.refreshStyles();
  }

  getStyle(depth: number): NodeTextStyle {
    return this.styles[depth <= 0 ? 0 : depth === 1 ? 1 : 2];
  }

  measure(
    title: string,
    depth: number,
    maximumWidth: number,
    mode: NodeTextMeasureMode = "title"
  ): NodeTitleMeasurement {
    const style = this.getStyle(depth);
    const normalized = prepareNodeText(title, mode);
    const width = Math.max(1, maximumWidth);
    const key = `${this.styleSignature}\u0000${mode}\u0000${depth <= 0 ? 0 : depth === 1 ? 1 : 2}\u0000${width}\u0000${normalized}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const measureText = (line: string, textStyle: NodeTextStyle): number => {
      const context = this.context;
      if (!context) return estimateFallbackTextWidth(line, textStyle);
      context.font = `${textStyle.fontStyle} ${textStyle.fontWeight} ${textStyle.fontSize}px ${textStyle.fontFamily}`;
      const nativeLetterSpacing = setCanvasTextProperty(context, "letterSpacing", `${textStyle.letterSpacing}px`);
      const nativeWordSpacing = setCanvasTextProperty(context, "wordSpacing", `${textStyle.wordSpacing}px`);
      setCanvasTextProperty(context, "fontKerning", textStyle.fontKerning);
      setCanvasTextProperty(context, "fontStretch", textStyle.fontStretch);
      setCanvasTextProperty(context, "fontVariantCaps", textStyle.fontVariantCaps);
      setCanvasTextProperty(context, "textRendering", textStyle.textRendering);
      let value = context.measureText(line).width;
      const graphemes = splitGraphemes(line);
      if (!nativeLetterSpacing) value += graphemes.length * textStyle.letterSpacing;
      if (!nativeWordSpacing) value += graphemes.filter((g) => /\s/u.test(g)).length * textStyle.wordSpacing;
      return value;
    };
    const rich = mode === "title" ? measureRichTitle(normalized, width, style, measureText) : undefined;
    const measurement = rich ?? measureWith(normalized, depth, width, style, (line) => measureText(line, style), mode);
    evictOldest(this.cache, MAX_MEASUREMENT_CACHE_ENTRIES);
    this.cache.set(key, measurement);
    return measurement;
  }

  /** Re-read computed styles after a theme, snippet, or font change. */
  refreshStyles(): boolean {
    if (this.destroyed) return false;
    const next: readonly [NodeTextStyle, NodeTextStyle, NodeTextStyle] = [
      readNodeTextStyle(this.host.ownerDocument.defaultView, this.probes[0], FALLBACK_STYLES[0]),
      readNodeTextStyle(this.host.ownerDocument.defaultView, this.probes[1], FALLBACK_STYLES[1]),
      readNodeTextStyle(this.host.ownerDocument.defaultView, this.probes[2], FALLBACK_STYLES[2])
    ];
    const signature = next.map(styleSignature).join("|");
    if (signature === this.styleSignature) return false;
    this.styles = next;
    this.styleSignature = signature;
    this.cache.clear();
    return true;
  }

  invalidate(): void {
    this.styleSignature = "";
    this.cache.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.host.ownerDocument.fonts?.removeEventListener("loadingdone", this.fontLoadListener);
    for (const probe of this.probeRoots) probe.remove();
    this.cache.clear();
  }
}

function readNodeTextStyle(
  ownerWindow: Window | null,
  probe: HTMLElement,
  fallback: NodeTextStyle
): NodeTextStyle {
  if (!ownerWindow) return fallback;
  const computed = ownerWindow.getComputedStyle(probe);
  return {
    fontFamily: computed.fontFamily || fallback.fontFamily,
    fontSize: positiveNumber(computed.fontSize, fallback.fontSize),
    fontStyle: computed.fontStyle || fallback.fontStyle,
    fontWeight: computed.fontWeight || fallback.fontWeight,
    fontKerning: canvasFontKerning(computed.fontKerning, fallback.fontKerning),
    fontStretch: canvasFontStretch(computed.fontStretch, fallback.fontStretch),
    fontVariantCaps: canvasFontVariantCaps(computed.fontVariantCaps, fallback.fontVariantCaps),
    letterSpacing: finiteNumber(computed.letterSpacing, fallback.letterSpacing),
    lineHeight: positiveNumber(computed.lineHeight, fallback.lineHeight),
    textRendering: canvasTextRendering(computed.textRendering, fallback.textRendering),
    wordSpacing: finiteNumber(computed.wordSpacing, fallback.wordSpacing)
  };
}

/** Assign a modern Canvas typography property only when the WebView implements it. */
function setCanvasTextProperty<K extends keyof CanvasTextDrawingStyles>(
  context: CanvasRenderingContext2D,
  property: K,
  value: CanvasTextDrawingStyles[K]
): boolean {
  if (!(property in context)) return false;
  try {
    return Reflect.set(context, property, value);
  } catch {
    return false;
  }
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function styleSignature(style: NodeTextStyle): string {
  return [
    style.fontFamily,
    style.fontSize,
    style.fontStyle,
    style.fontWeight,
    style.fontKerning,
    style.fontStretch,
    style.fontVariantCaps,
    style.letterSpacing,
    style.lineHeight,
    style.textRendering,
    style.wordSpacing
  ].join(";");
}

function canvasFontKerning(value: string, fallback: CanvasFontKerning): CanvasFontKerning {
  return isOneOf(value, ["auto", "normal", "none"] as const) ? value : fallback;
}

function canvasFontStretch(value: string, fallback: CanvasFontStretch): CanvasFontStretch {
  const keywords = [
    "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal",
    "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"
  ] as const;
  if (isOneOf(value, keywords)) return value;
  const percentage = Number.parseFloat(value);
  if (!Number.isFinite(percentage)) return fallback;
  const percentages = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200] as const;
  let nearestIndex = 0;
  for (let index = 1; index < percentages.length; index += 1) {
    if (Math.abs(percentages[index]! - percentage) < Math.abs(percentages[nearestIndex]! - percentage)) {
      nearestIndex = index;
    }
  }
  return keywords[nearestIndex]!;
}

function canvasFontVariantCaps(value: string, fallback: CanvasFontVariantCaps): CanvasFontVariantCaps {
  const allowed = [
    "normal", "small-caps", "all-small-caps", "petite-caps", "all-petite-caps",
    "unicase", "titling-caps"
  ] as const;
  return isOneOf(value, allowed) ? value : fallback;
}

function canvasTextRendering(value: string, fallback: CanvasTextRendering): CanvasTextRendering {
  const allowed = ["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"] as const;
  return isOneOf(value, allowed) ? value : fallback;
}

function isOneOf<const T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}
