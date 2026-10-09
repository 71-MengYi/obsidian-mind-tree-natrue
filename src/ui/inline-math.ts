import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/svg.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";

export interface InlineMath { readonly svg: string; readonly width: number; readonly height: number; readonly ascent: number }
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// All glyph paths are statically bundled. No loader, remote fonts, or shared DOM IDs.
const engine = mathjax.document("", {
  InputJax: new TeX({ packages: ["base", "ams"], maxBuffer: 8192,
    formatError: (_jax: unknown, error: Error) => { throw error; } }),
  OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: "none" })
});
const cache = new Map<string, InlineMath | undefined>();

export function renderInlineMath(source: string): InlineMath | undefined {
  if (cache.has(source)) return cache.get(source);
  let result: InlineMath | undefined;
  try {
    if (source.length > 8192) throw new Error("Formula exceeds the rendering limit.");
    const container = engine.convert(source, { display: false, em: 1, ex: 0.442, containerWidth: 100000 });
    const markup = adaptor.outerHTML(container);
    const svg = markup.match(/<svg\b[\s\S]*<\/svg>/)?.[0];
    const viewBox = svg?.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
    if (svg && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
      result = { svg: svg.replace(/^<svg\b[^>]*>/, (root) => root.replace(/ (?:width|height|style)="[^"]*"/g, "")),
        width: viewBox[2]! / 1000, height: viewBox[3]! / 1000, ascent: -viewBox[1]! / 1000 };
    }
  } catch { /* Invalid or unsupported TeX is displayed verbatim, also in exports. */ }
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(source, result);
  return result;
}
