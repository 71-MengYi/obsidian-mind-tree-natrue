import { parseNodeTitle, type TitleRun } from "../format/node-title";
import { renderInlineMath, type InlineMath } from "./inline-math";
import type { NodeTextStyle, NodeTitleMeasurement } from "./text-measurer";

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
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

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
    const characters = segmenter ? Array.from(segmenter.segment(run.text), (part) => part.segment) : Array.from(run.text);
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
