import { parseNodeTitle, type TitleRun } from "../format/node-title";
import { renderInlineMath, type InlineMath } from "./inline-math";
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
  readonly height?: number;
  readonly richLines?: readonly MeasuredTitleLine[];
  readonly lines: readonly string[];
  readonly lineWidths: readonly number[];
  readonly width: number;
  readonly style: NodeTextStyle;
}

/** Saved titles and in-progress editor drafts intentionally use different whitespace rules. */
export type NodeTextMeasureMode = "title" | "draft" | "literal";

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

/** Fallback tier styles shared by the browser measurer and headless layout. */
export const FALLBACK_STYLES: readonly [NodeTextStyle, NodeTextStyle, NodeTextStyle] = [
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

const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

/** Grapheme splitting shared by wrapping, fallback widths and rich runs. */
export function splitGraphemes(value: string): string[] {
  if (GRAPHEME_SEGMENTER) return Array.from(GRAPHEME_SEGMENTER.segment(value), (part) => part.segment);
  return Array.from(value);
}

export function normalizeNodeTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

/** Preserve every editable character while making platform line endings deterministic. */
function normalizeNodeDraft(title: string): string {
  return title.replace(/\r\n?/g, "\n");
}

/** Whitespace policy for saved titles versus live drafts, shared with the browser measurer. */
export function prepareNodeText(title: string, mode: NodeTextMeasureMode): string {
  if (mode === "draft") return normalizeNodeDraft(title);
  return mode === "title" ? title.replace(/[\r\n]+/g, " ").trim() || "Untitled" : normalizeNodeTitle(title);
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

/** Greedy grapheme wrapping driven by an injected per-line measurer. */
export function measureWith(
  title: string,
  depth: number,
  maximumWidth: number,
  style: NodeTextStyle,
  measureLine: (value: string) => number,
  mode: NodeTextMeasureMode = "title"
): NodeTitleMeasurement {
  const normalizedTitle = mode === "draft" ? normalizeNodeDraft(title) : normalizeNodeTitle(title);
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
    if (mode === "title") {
      const rich = measureRichTitle(prepareNodeText(title, mode), maximumWidth, style, estimateFallbackTextWidth);
      if (rich) return rich;
    }
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

export interface MeasuredTitleRun extends TitleRun {
  readonly x: number;
  readonly width: number;
  readonly height: number;
  readonly ascent: number;
  readonly style: NodeTextStyle;
  readonly math?: InlineMath;
}
export interface MeasuredTitleLine {
  readonly runs: readonly MeasuredTitleRun[];
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}

export function measureRichTitle(
  source: string, maximumWidth: number, base: NodeTextStyle,
  measure: (text: string, style: NodeTextStyle) => number
): NodeTitleMeasurement | undefined {
  if (!/[\\*_`$~=]/.test(source)) return undefined;
  const content = parseNodeTitle(source);
  if (!content.formatted && content.plainText === source) return undefined;
  const limit = Math.max(1, maximumWidth);
  const lines: MeasuredTitleLine[] = [];
  let runs: MeasuredTitleRun[] = [];
  let x = 0;
  const flush = (): void => {
    const ascent = Math.max(base.fontSize, ...runs.map((run) => run.ascent));
    const descent = Math.max(base.lineHeight - base.fontSize, ...runs.map((run) => run.height - run.ascent));
    lines.push({ runs, width: x, height: ascent + descent, baseline: ascent });
    runs = []; x = 0;
  };
  for (const original of content.runs) {
    const style: NodeTextStyle = { ...base,
      fontWeight: original.bold ? "700" : base.fontWeight,
      fontStyle: original.italic ? "italic" : base.fontStyle,
      fontFamily: original.kind === "code" ? "ui-monospace, SFMono-Regular, Consolas, monospace" : base.fontFamily
    };
    const math = original.kind === "math" ? renderInlineMath(original.text) : undefined;
    if (math && math.width > 0 && math.height > 0) {
      const scale = Math.min(base.fontSize, limit / math.width);
      const width = math.width * scale;
      if (x && x + width > limit) flush();
      runs.push({ ...original, style, math, x, width, height: math.height * scale, ascent: math.ascent * scale });
      x += width;
      continue;
    }
    const run = original.kind === "math" ? { ...original, kind: "text" as const, text: `$${original.text}$` } : original;
    const characters = splitGraphemes(run.text);
    const padding = run.kind === "code" ? 4 : 0;
    let offset = 0;
    while (offset < characters.length) {
      if (x && x + measure(characters[offset]!, style) + padding > limit) flush();
      let low = 1; let high = characters.length - offset; let accepted = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (x + measure(characters.slice(offset, offset + middle).join(""), style) + padding <= limit) {
          accepted = middle; low = middle + 1;
        } else high = middle - 1;
      }
      const text = characters.slice(offset, offset + accepted).join("");
      const width = measure(text, style) + padding;
      runs.push({ ...run, text, style, x, width, height: base.lineHeight, ascent: base.fontSize });
      x += width; offset += accepted;
      if (offset < characters.length) flush();
    }
  }
  if (runs.length || !lines.length) flush();
  return { normalizedTitle: content.plainText, lines: lines.map((line) => line.runs.map((run) => run.text).join("")),
    lineWidths: lines.map((line) => line.width), width: Math.max(1, ...lines.map((line) => line.width)),
    height: lines.reduce((sum, line) => sum + line.height, 0), richLines: lines, style: base };
}

export function escapeTitleXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Shared SVG glyph placement keeps the live node and PNG export identical. */
export function renderRichTitleSvg(measurement: NodeTitleMeasurement): string {
  let y = 0;
  const parts: string[] = [];
  for (const line of measurement.richLines ?? []) {
    for (const run of line.runs) {
      const top = y + line.baseline - run.ascent;
      if (run.highlight || run.kind === "code") {
        parts.push(`<rect x="${run.x}" y="${top}" width="${run.width}" height="${run.height}" rx="2" fill="${run.highlight ? "#e6b800" : "currentColor"}" fill-opacity="${run.highlight ? 0.3 : 0.12}"/>`);
      }
      if (run.math) {
        parts.push(run.math.svg.replace("<svg", `<svg x="${run.x}" y="${top}" width="${run.width}" height="${run.height}"`));
      } else {
        const s = run.style;
        parts.push(`<text x="${run.x + (run.kind === "code" ? 2 : 0)}" y="${y + line.baseline}" fill="currentColor" font-family="${escapeTitleXml(s.fontFamily)}" font-size="${s.fontSize}" font-weight="${escapeTitleXml(s.fontWeight)}" font-style="${escapeTitleXml(s.fontStyle)}" letter-spacing="${s.letterSpacing}" word-spacing="${s.wordSpacing}" font-kerning="${s.fontKerning}" font-stretch="${s.fontStretch}" font-variant-caps="${s.fontVariantCaps}" text-rendering="${s.textRendering}" xml:space="preserve">${escapeTitleXml(run.text)}</text>`);
      }
      if (run.strike) parts.push(`<path d="M${run.x} ${y + line.baseline - run.style.fontSize * 0.3}h${run.width}" stroke="currentColor" stroke-width="1"/>`);
    }
    y += line.height;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(measurement.width)}" height="${measurement.height}" aria-hidden="true">${parts.join("")}</svg>`;
}
