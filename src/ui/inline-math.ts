import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/svg.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";

export interface InlineMath { readonly svg: string; readonly width: number; readonly height: number; readonly ascent: number }
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// All glyph paths are statically bundled. No loader, remote fonts, or shared DOM IDs.
// Inline line breaking is off on purpose: a node title renders one formula as one
// atomic run, and MathJax otherwise emits one sibling <svg> per break opportunity
// (any binary operator is one). Those pieces share no common viewBox, so placing them
// as a single SVG made later pieces land on top of earlier ones.
const engine = mathjax.document("", {
  InputJax: new TeX({ packages: ["base", "ams"], maxBuffer: 8192,
    formatError: (_jax: unknown, error: Error) => { throw error; } }),
  OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: "none", linebreaks: { inline: false } })
});
// A forced break inside inline math (a bare "\\" or "\newline") sizes the line to the
// container, i.e. far past anything a node can show. Falling back to the source is more
// useful than scaling the formula down to an invisible speck.
const MAX_INLINE_FORMULA_EM_WIDTH = 1024;
const cache = new Map<string, InlineMath | undefined>();

export function renderInlineMath(source: string): InlineMath | undefined {
  if (cache.has(source)) return cache.get(source);
  let result: InlineMath | undefined;
  try {
    if (source.length > 8192) throw new Error("Formula exceeds the rendering limit.");
    const container = engine.convert(source, { display: false, em: 1, ex: 0.442, containerWidth: 100000 });
    const roots = adaptor.childNodes(container).filter((node): node is LiteElement => adaptor.kind(node) === "svg");
    const root = roots.length === 1 ? roots[0] : undefined;
    const viewBox = root ? readViewBox(adaptor.getAttribute(root, "viewBox")) : undefined;
    if (root && viewBox) {
      const [, top, w, h] = viewBox;
      const width = w / 1000;
      if (width > 0 && width <= MAX_INLINE_FORMULA_EM_WIDTH && h > 0) {
        // The caller owns x/y and the exact box, so only the intrinsic geometry stays.
        for (const attribute of ["width", "height", "style"]) adaptor.removeAttribute(root, attribute);
        result = { svg: adaptor.outerHTML(root), width, height: h / 1000, ascent: -top / 1000 };
      }
    }
  } catch { /* Invalid or unsupported TeX is displayed verbatim, also in exports. */ }
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(source, result);
  return result;
}

function readViewBox(value: unknown): readonly [number, number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.trim().split(/\s+/).map((part) => Number(part));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}
