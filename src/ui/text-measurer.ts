/**
 * Font information that affects title geometry. Keeping it explicit lets the
 * SVG exporter reproduce the same wrapping as the live Obsidian view.
 */
export interface NodeTextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontStyle: string;
  readonly fontWeight: string;
  readonly fontKerning: CanvasFontKerning;
  readonly fontStretch: CanvasFontStretch;
  readonly fontVariantCaps: CanvasFontVariantCaps;
  readonly letterSpacing: number;
  readonly lineHeight: number;
  readonly textRendering: CanvasTextRendering;
  readonly wordSpacing: number;
}

export interface NodeTitleMeasurement {
  readonly normalizedTitle: string;
  readonly lines: readonly string[];
  readonly lineWidths: readonly number[];
  readonly width: number;
  readonly style: NodeTextStyle;
}

/** Saved titles and in-progress editor drafts intentionally use different whitespace rules. */
export type NodeTextMeasureMode = "title" | "draft";

/** Layout depends on this small interface instead of browser DOM globals. */
export interface NodeTextMeasurer {
  getStyle(depth: number): NodeTextStyle;
  measure(
    title: string,
    depth: number,
    maximumWidth: number,
    mode?: NodeTextMeasureMode
  ): NodeTitleMeasurement;
}

const FALLBACK_STYLES: readonly [NodeTextStyle, NodeTextStyle, NodeTextStyle] = [
  {
    fontFamily: "system-ui, sans-serif", fontSize: 18, fontStyle: "normal",
    fontWeight: "700", fontKerning: "auto", fontStretch: "normal", fontVariantCaps: "normal",
    letterSpacing: 0.3, lineHeight: 23, textRendering: "auto", wordSpacing: 0
  },
  {
    fontFamily: "system-ui, sans-serif", fontSize: 16, fontStyle: "normal",
    fontWeight: "400", fontKerning: "auto", fontStretch: "normal", fontVariantCaps: "normal",
    letterSpacing: 0, lineHeight: 20, textRendering: "auto", wordSpacing: 0
  },
  {
    fontFamily: "system-ui, sans-serif", fontSize: 13, fontStyle: "normal",
    fontWeight: "500", fontKerning: "auto", fontStretch: "normal", fontVariantCaps: "normal",
    letterSpacing: 0, lineHeight: 17, textRendering: "auto", wordSpacing: 0
  }
];

const MAX_MEASUREMENT_CACHE_ENTRIES = 10_000;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function normalizeNodeTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

/** Preserve every editable character while making platform line endings deterministic. */
function normalizeNodeDraft(title: string): string {
  return title.replace(/\r\n?/g, "\n");
}

function prepareNodeText(title: string, mode: NodeTextMeasureMode): string {
  return mode === "draft" ? normalizeNodeDraft(title) : normalizeNodeTitle(title);
}

export function fallbackNodeTextStyle(depth: number): NodeTextStyle {
  return FALLBACK_STYLES[depth <= 0 ? 0 : depth === 1 ? 1 : 2];
}

/**
 * DOM-free fallback for tests and environments without a Canvas 2D context.
 * The live view never relies on these ratios when browser measurement exists.
 */
export function estimateFallbackTextWidth(value: string, style: NodeTextStyle): number {
  let width = 0;
  const graphemes = splitGraphemes(value);
  for (const character of graphemes) {
    if (/\s/u.test(character)) width += style.fontSize * 0.36;
    else if (character === "1") width += style.fontSize * 0.4;
    else if (/^[0-9]$/u.test(character)) width += style.fontSize * 0.62;
    else if (/^[\x00-\x7F]$/u.test(character)) {
      width += style.fontSize * (/[A-ZMWmw@#%]/u.test(character) ? 0.72 : 0.56);
    } else width += style.fontSize;
  }
  // Canvas letterSpacing applies one spacing contribution per rendered text
  // cluster, including the final cluster. Using N - 1 here was enough to make
  // a root title cross the DOM's wrapping boundary while layout still saw one
  // line. wordSpacing is added once for every collapsible word separator.
  return width
    + graphemes.length * style.letterSpacing
    + graphemes.filter((grapheme) => /\s/u.test(grapheme)).length * style.wordSpacing;
}

function measureWith(
  title: string,
  depth: number,
  maximumWidth: number,
  style: NodeTextStyle,
  measureLine: (value: string) => number,
  mode: NodeTextMeasureMode = "title"
): NodeTitleMeasurement {
  const normalizedTitle = prepareNodeText(title, mode);
  const safeWidth = Math.max(1, maximumWidth);
  const lines: string[] = [];
  const lineWidths: number[] = [];

  // Drafts retain hard line breaks and empty lines. Saved-title mode produces
  // one logical line because its existing normalization replaces line breaks.
  for (const logicalLine of normalizedTitle.split("\n")) {
    const graphemes = splitGraphemes(logicalLine);
    if (graphemes.length === 0) {
      lines.push("");
      lineWidths.push(0);
      continue;
    }
    let offset = 0;
    // break-all/anywhere and editor break-spaces make a greedy grapheme split
    // match the live DOM while retaining every leading and trailing space.
    while (offset < graphemes.length) {
      let low = 1;
      let high = graphemes.length - offset;
      let accepted = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = graphemes.slice(offset, offset + middle).join("");
        if (measureLine(candidate) <= safeWidth) {
          accepted = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      const line = graphemes.slice(offset, offset + accepted).join("");
      lines.push(line);
      lineWidths.push(measureLine(line));
      offset += accepted;
    }
  }

  if (lines.length === 0) {
    lines.push(normalizedTitle);
    lineWidths.push(measureLine(normalizedTitle));
  }
  return {
    normalizedTitle,
    lines,
    lineWidths,
    width: Math.max(...lineWidths, 1),
    style
  };
}

/** Deterministic fallback shared by headless layout and unit tests. */
export const fallbackNodeTextMeasurer: NodeTextMeasurer = {
  getStyle: fallbackNodeTextStyle,
  measure(title, depth, maximumWidth, mode = "title") {
    const style = fallbackNodeTextStyle(depth);
    return measureWith(
      title,
      depth,
      maximumWidth,
      style,
      (line) => estimateFallbackTextWidth(line, style),
      mode
    );
  }
};

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
    if (!this.context) {
      return measureWith(
        title,
        depth,
        maximumWidth,
        style,
        (line) => estimateFallbackTextWidth(line, style),
        mode
      );
    }
    const normalized = prepareNodeText(title, mode);
    const width = Math.max(1, maximumWidth);
    const key = `${this.styleSignature}\u0000${mode}\u0000${depth <= 0 ? 0 : depth === 1 ? 1 : 2}\u0000${width}\u0000${normalized}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const context = this.context;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    const nativeLetterSpacing = setCanvasTextProperty(context, "letterSpacing", `${style.letterSpacing}px`);
    const nativeWordSpacing = setCanvasTextProperty(context, "wordSpacing", `${style.wordSpacing}px`);
    setCanvasTextProperty(context, "fontKerning", style.fontKerning);
    setCanvasTextProperty(context, "fontStretch", style.fontStretch);
    setCanvasTextProperty(context, "fontVariantCaps", style.fontVariantCaps);
    setCanvasTextProperty(context, "textRendering", style.textRendering);
    const measurement = measureWith(normalized, depth, width, style, (line) => {
      const graphemes = splitGraphemes(line);
      let measuredWidth = context.measureText(line).width;
      // Recent Obsidian WebViews expose Canvas text spacing directly. Retain a
      // property-level fallback for older WebViews without double-applying the
      // spacing that a newer Canvas already included in TextMetrics.width.
      if (!nativeLetterSpacing) measuredWidth += graphemes.length * style.letterSpacing;
      if (!nativeWordSpacing) {
        measuredWidth += graphemes.filter((grapheme) => /\s/u.test(grapheme)).length * style.wordSpacing;
      }
      return measuredWidth;
    }, mode);
    if (this.cache.size >= MAX_MEASUREMENT_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
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

function splitGraphemes(value: string): string[] {
  if (GRAPHEME_SEGMENTER) return Array.from(GRAPHEME_SEGMENTER.segment(value), (part) => part.segment);
  return Array.from(value);
}
