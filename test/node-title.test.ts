import assert from "node:assert/strict";
import test from "node:test";
import { parseNodeTitle, fileTitleFromNode, validateNodeTitle, nodeTitleMode } from "../src/format/node-title";
import { createEmptyDocument, addNode } from "../src/domain/tree";
import { fallbackNodeTextMeasurer } from "../src/ui/text-measurer";
import { renderInlineMath } from "../src/ui/inline-math";
import { renderRichTitleSvg } from "../src/ui/rich-title";
import { renderBranchSvg } from "../src/services/export";
import { renderBranchMarkdown } from "../src/format/outline";
import { scanTextLinkSpans } from "../src/services/text-url";
import { SharedMindTreeSession } from "../src/services/mind-tree-session-registry";
import { getNodeSize } from "../src/ui/layout";

test("inline titles parse nested formats and preserve literal syntax safely", () => {
  const parsed = parseNodeTitle("中文 **bold *italic*** ~~gone~~ ==mark== `a*b` $x^2$");
  assert.equal(parsed.plainText, "中文 bold italic gone mark a*b x^2");
  assert.ok(parsed.runs.some((run) => run.bold && run.italic));
  assert.ok(parsed.runs.some((run) => run.highlight));
  assert.ok(parsed.runs.some((run) => run.strike));
  assert.deepEqual(parsed.runs.filter((run) => run.kind !== "text").map((run) => [run.kind, run.text]), [["code", "a*b"], ["math", "x^2"]]);
  for (const source of ["$5 and $10", "$$x$$", "$ unclosed", "**unclosed", "<img src=x>", "[link](https://example.com)"]) {
    assert.equal(parseNodeTitle(source).formatted, false, source);
  }
  assert.equal(parseNodeTitle(String.raw`\*plain\* \$x\$`).plainText, "*plain* $x$");
  const code = parseNodeTitle("``a`b **x** $y$``");
  assert.equal(code.runs.length, 1);
  assert.equal(code.runs[0]?.kind, "code");
  assert.equal(parseNodeTitle(code.markdown).plainText, code.plainText);
});

test("URL extraction never enters actual code or formula ranges", () => {
  const source = "`https://code.test [[note]]` $\\text{https://math.test}$ https://real.test";
  const links = scanTextLinkSpans(source).filter((span) => span.syntax !== "opaque");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.target, "https://real.test");
});

test("filename validation distinguishes root, synced filenames, and ordinary titles", () => {
  const doc = createEmptyDocument("Root");
  const node = doc.nodes[doc.rootId]!;
  assert.equal(fileTitleFromNode("**Plan** ==today=="), "Plan today");
  assert.equal(fileTitleFromNode("$x$"), undefined);
  assert.equal(fileTitleFromNode("`x`"), undefined);
  assert.equal(validateNodeTitle("**Plan**", node, true), undefined);
  assert.equal(validateNodeTitle("$x$", node, true), "title.codeOrMath");
  assert.equal(validateNodeTitle("$x$", node, false), undefined);
  node.resource = { type: "file", resourceId: "abc", pathHint: "Note.md", fileKind: "note" };
  node.titleSync = "bidirectional";
  assert.equal(validateNodeTitle("**Plan**", node, false), "title.formattedSync");
  node.title = "_existing_";
  assert.equal(validateNodeTitle(node.title, node, false), undefined);
  assert.equal(nodeTitleMode(node, 1), "literal");
  assert.equal(nodeTitleMode(node, 0), "title");
  assert.equal(fallbackNodeTextMeasurer.measure(node.title, 1, 240, "literal").lines.join(""), node.title);
});

test("math produces independent offline SVG with real height and invalid TeX stays literal", () => {
  for (const source of ["x^2", String.raw`\frac{a}{b}`, String.raw`\sqrt{x}+\sum_{i=0}^{n}i`, String.raw`\begin{matrix}a&b\\c&d\end{matrix}`]) {
    const math = renderInlineMath(source);
    assert.ok(math, source);
    assert.ok(math.width > 0 && math.height > 0);
    assert.match(math.svg, /<path/);
    assert.doesNotMatch(math.svg, /(?:href=|foreignObject|<script)/);
  }
  assert.equal(renderInlineMath(String.raw`\notARealCommand{x}`), undefined);
  const measurement = fallbackNodeTextMeasurer.measure(String.raw`before $\frac{a}{b}$ **after**`, 1, 160);
  assert.ok(measurement.richLines?.some((line) => line.runs.some((run) => run.math)));
  assert.ok(measurement.height! >= measurement.style.lineHeight);
  assert.ok(getNodeSize(1, String.raw`$\frac{a}{b}$`).height >= measurement.style.lineHeight);
  const invalid = fallbackNodeTextMeasurer.measure(String.raw`$\notARealCommand{x}$`, 1, 240);
  assert.equal(invalid.richLines?.flatMap((line) => line.runs).map((run) => run.text).join(""), String.raw`$\notARealCommand{x}$`);
});

test("rich wrapping and exports share glyphs, dimensions, and source formatting", () => {
  const doc = createEmptyDocument("**Root**");
  const source = String.raw`**长标题 bold** ==marked== ~~removed~~ ` + "`code` " + String.raw`$\frac{1}{2}$`;
  const node = addNode(doc, doc.rootId, source);
  const measured = fallbackNodeTextMeasurer.measure(source, 1, 160);
  const svg = renderBranchSvg(doc, doc.rootId, 160);
  assert.ok(svg.includes(renderRichTitleSvg(measured)));
  assert.match(renderBranchMarkdown(doc, node.id), /\*\*长标题 bold\*\*/);
  assert.match(renderBranchMarkdown(doc, node.id), /\$\\frac\{1\}\{2\}\$/);
  assert.ok(measured.richLines!.length > 1);
  assert.ok(measured.richLines!.every((line) => line.width <= 160));
  const wide = fallbackNodeTextMeasurer.measure("$" + "x+".repeat(150) + "x$", 1, 160);
  assert.equal(wide.richLines?.length, 1);
  assert.ok(wide.width <= 160);
  const draft = fallbackNodeTextMeasurer.measure(source, 1, 160, "draft");
  assert.equal(draft.richLines, undefined);
  assert.equal(draft.lines.join(""), source);
});

test("rejected commits preserve shared draft ownership and block another editor", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  session.attach("left", { onSessionChange: () => undefined, commitActiveDraft: () => "rejected" });
  session.attach("right", { onSessionChange: () => undefined, commitActiveDraft: () => "committed" });
  session.claimEditor("left");
  session.updateTitleDraft("left", "n", "before", "**draft**");
  assert.equal(session.claimEditor("right"), "rejected");
  assert.equal(session.commitEditorBeforeMutation("right"), "rejected");
  assert.equal(session.draft?.value, "**draft**");
  session.updateTitleDraft("right", "n", "before", "lost");
  assert.equal(session.draft?.ownerId, "left");
  session.detach("left");
  assert.equal(session.draft, undefined);
  assert.equal(session.claimEditor("right"), "committed");
});
