import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument, insertBranches } from "../src/domain/tree";
import { renderBranchMarkdown, renderOutline } from "../src/format/outline";
import {
  copyBranch,
  parseMarkdownBranch,
  readClipboardEventContent,
  readClipboardFallbackContent,
  readStructuredBranchFromClipboardEvent,
  readStructuredBranchFromPlainText,
  resolveMarkdownBranchLinks
} from "../src/services/clipboard";
import { renderBranchSvg } from "../src/services/export";
import { DocumentSession } from "../src/services/document-session";
import type { NodeTextMeasurer } from "../src/ui/text-measurer";
import { layoutTree } from "../src/ui/layout";
import type { FileResourceRef } from "../src/types";

test("renders readable Markdown links and parses list structure", () => {
  const document = createEmptyDocument("Project");
  const note = addNode(document, document.rootId, "Requirement [A]");
  note.resource = { type: "file", resourceId: "resource", pathHint: "notes/Requirement.md", fileKind: "note" };
  const link = addNode(document, note.id, "Obsidian");
  link.resource = { type: "url", url: "https://obsidian.md" };
  const outline = renderOutline(document);
  assert.ok(outline.includes("[[notes/Requirement|Requirement \\[A\\]]]") );
  assert.match(outline, /\[Obsidian\]\(https:\/\/obsidian\.md\)/);

  const parsed = parseMarkdownBranch(renderBranchMarkdown(document, document.rootId));
  assert.ok(parsed);
  assert.equal(Object.keys(parsed.nodes).length, 3);
  assert.equal(parsed.nodes[parsed.rootId]?.childIds.length, 1);
  const parsedNoteId = parsed.nodes[parsed.rootId]!.childIds[0]!;
  const parsedUrlId = parsed.nodes[parsedNoteId]!.childIds[0]!;
  assert.equal(parsed.nodes[parsedNoteId]?.title, "Requirement [A]");
  assert.equal(parsed.nodes[parsedNoteId]?.resource, undefined);
  assert.equal(parsed.linkTargets?.[parsedNoteId]?.type, "file");
  assert.deepEqual(parsed.nodes[parsedUrlId]?.resource, { type: "url", url: "https://obsidian.md/" });
});

test("parses mixed ordered and unordered Markdown lists as a multi-root forest", () => {
  const payload = parseMarkdownBranch([
    "1. Roadmap",
    "   - Phase one",
    "     1) Task A",
    "2) Notes",
    "\t* Follow-up"
  ].join("\n"));
  assert.ok(payload);
  assert.equal(payload.rootIds?.length, 2);

  const [roadmapId, notesId] = payload.rootIds ?? [];
  assert.equal(payload.nodes[roadmapId!]?.title, "Roadmap");
  assert.equal(payload.nodes[notesId!]?.title, "Notes");
  const phaseId = payload.nodes[roadmapId!]?.childIds[0];
  assert.equal(payload.nodes[phaseId!]?.title, "Phase one");
  assert.equal(payload.nodes[payload.nodes[phaseId!]?.childIds[0] ?? ""]?.title, "Task A");
  assert.equal(payload.nodes[payload.nodes[notesId!]?.childIds[0] ?? ""]?.title, "Follow-up");

  const target = createEmptyDocument("Target");
  const insertedIds = insertBranches(target, target.rootId, payload);
  assert.equal(insertedIds.length, 2);
  assert.deepEqual(target.nodes[target.rootId]?.childIds, insertedIds);
});

test("text imports resolve notes, headings, attachments, images and URLs before one undoable commit", async () => {
  const payload = parseMarkdownBranch([
    "- [[notes/Plan#Scope|Plan alias]]",
    "  - [Manual](assets/manual.pdf)",
    "  - ![[images/diagram.png]]",
    "  - [Website](https://example.com/docs)"
  ].join("\n"));
  assert.ok(payload);
  const planId = payload.rootId;
  const [manualId, imageId, websiteId] = payload.nodes[planId]!.childIds;
  assert.equal(payload.nodes[planId]?.title, "Plan alias");
  assert.equal(payload.nodes[manualId!]?.title, "Manual");
  assert.equal(payload.nodes[imageId!]?.title, "diagram");
  const files: Record<string, FileResourceRef> = {
    "notes/Plan#Scope": { type: "file", resourceId: "plan", pathHint: "notes/Plan.md", fileKind: "note" },
    "assets/manual.pdf": { type: "file", resourceId: "Ab123", pathHint: "assets/manual@Ab123.pdf", fileKind: "attachment" },
    "images/diagram.png": { type: "file", resourceId: "Cd456", pathHint: "images/diagram@Cd456.png", fileKind: "image" }
  };
  assert.deepEqual(payload.nodes[websiteId!]?.resource, { type: "url", url: "https://example.com/docs" });

  const lookups: string[] = [];
  const resolved = await resolveMarkdownBranchLinks(payload, async (path) => {
    lookups.push(path);
    return files[path];
  }, false);
  assert.deepEqual(new Set(lookups), new Set(Object.keys(files)));
  assert.deepEqual(resolved.unresolvedFileLinks, []);
  assert.deepEqual(resolved.payload.nodes[planId]?.resource, files["notes/Plan#Scope"]);
  assert.deepEqual(resolved.payload.nodes[manualId!]?.resource, files["assets/manual.pdf"]);
  assert.deepEqual(resolved.payload.nodes[imageId!]?.resource, files["images/diagram.png"]);
  assert.equal(resolved.payload.nodes[planId]?.title, "Plan alias");
  assert.equal(resolved.payload.nodes[planId]?.titleSync, "off");
  assert.equal(resolved.payload.linkTargets, undefined);
  assert.equal(payload.nodes[planId]?.resource, undefined, "Resolution must not mutate the parser's payload");

  const original = createEmptyDocument("Imported links");
  const session = new DocumentSession();
  session.load("disk");
  const target = session.execute(original, (draft) => { insertBranches(draft, draft.rootId, resolved.payload); });
  const [insertedPlanId] = target.nodes[target.rootId]!.childIds;
  assert.ok(insertedPlanId);
  const [insertedManualId, insertedImageId, insertedWebsiteId] = target.nodes[insertedPlanId]!.childIds;
  assert.deepEqual(target.nodes[insertedPlanId]?.resource, files["notes/Plan#Scope"]);
  assert.deepEqual(target.nodes[insertedManualId!]?.resource, files["assets/manual.pdf"]);
  assert.deepEqual(target.nodes[insertedImageId!]?.resource, files["images/diagram.png"]);
  assert.deepEqual(target.nodes[insertedWebsiteId!]?.resource, { type: "url", url: "https://example.com/docs" });
  assert.equal(session.undo(target), original);
  assert.equal(session.canUndo, false);
  assert.equal(session.redo(original), target);
});

test("imported aliases follow the global title-sync rule without changing source files", async () => {
  const payload = parseMarkdownBranch("[[原名|自定义别名]] [图片](图片.png) [Tree](tree.mtn.md) [Draw](drawing.md)")!;
  const refs: Record<string, FileResourceRef> = {
    "原名": { type: "file", resourceId: "note", pathHint: "notes/原名.md", fileKind: "note" },
    "图片.png": { type: "file", resourceId: "Ab123", pathHint: "images/图片@Ab123.png", fileKind: "image" },
    "tree.mtn.md": { type: "file", resourceId: "tree", pathHint: "trees/tree.mtn.md", fileKind: "note" },
    "drawing.md": { type: "file", resourceId: "drawing", pathHint: "drawing.md", fileKind: "note", fileSubtype: "excalidraw" }
  };
  const before = JSON.stringify(refs);
  for (const sync of [false, true]) {
    const result = await resolveMarkdownBranchLinks(payload, async (path) => refs[path], sync);
    const nodes = result.payload.rootIds!.map((id) => result.payload.nodes[id]!);
    assert.deepEqual(nodes.map((node) => node.title), sync
      ? ["原名", "图片", "tree", "drawing"] : ["自定义别名", "图片", "Tree", "Draw"]);
    assert.ok(nodes.every((node) => node.titleSync === (sync ? "bidirectional" : "off")));
    assert.equal(nodes[3]!.resource?.type === "file" && nodes[3]!.resource.fileSubtype, "excalidraw");
  }
  assert.equal(JSON.stringify(refs), before);
});

test("unresolved links restore literal source while resolved siblings and aliases survive", async () => {
  const payload = parseMarkdownBranch([
    "- 前文 [[missing#Scope|别名]] 后文",
    "- 说明 [[also-missing|别名2]] [Good](good.md) https://example.com",
    "- [Failed](failed.pdf)"
  ].join("\n"))!;
  const result = await resolveMarkdownBranchLinks(payload, async (path) => {
    if (path === "failed.pdf") throw new Error("Unavailable");
    return path === "good.md" ? { type: "file", resourceId: "good", pathHint: "good.md", fileKind: "note" } : undefined;
  }, false);
  assert.deepEqual(result.unresolvedFileLinks, ["missing#Scope", "also-missing", "failed.pdf"]);
  assert.deepEqual(result.payload.rootIds!.map((id) => result.payload.nodes[id]!.title), [
    "前文 [[missing#Scope|别名]] 后文", "说明", "[[also-missing|别名2]]", "Good", "https://example.com", "[Failed](failed.pdf)"
  ]);
  assert.equal(result.payload.linkTargets, undefined);
  assert.equal(result.payload.nodes[result.payload.rootId]!.resource, undefined);
});

test("repeated attachment occurrences share one identity lookup but remain separate nodes", async () => {
  const payload = parseMarkdownBranch("[[asset.png|One]] [[asset.png|Two]] [[asset.png|Three]]")!;
  let lookups = 0;
  const reference: FileResourceRef = {
    type: "file", resourceId: "Ab123", pathHint: "asset@Ab123.png", fileKind: "image"
  };
  const result = await resolveMarkdownBranchLinks(payload, async () => {
    lookups += 1;
    return lookups === 1 ? reference : undefined;
  }, false);
  assert.equal(lookups, 1);
  const nodes = result.payload.rootIds!.map((id) => result.payload.nodes[id]!);
  assert.deepEqual(nodes.map((node) => node.title), ["One", "Two", "Three"]);
  assert.ok(nodes.every((node) => node.resource?.type === "file" && node.resource.resourceId === "Ab123"));
  assert.deepEqual(result.unresolvedFileLinks, []);
  const doc = createEmptyDocument("Paste");
  const ids = insertBranches(doc, doc.rootId, result.payload);
  assert.equal(new Set(ids).size, 3);
});

test("identity conflicts abort resolution rather than silently guessing another file", async () => {
  const payload = parseMarkdownBranch("[[Conflict]] [[Other]]")!;
  const error = new Error("Conflicting paths: one.md, two.md");
  error.name = "DuplicateResourceIdError";
  await assert.rejects(() => resolveMarkdownBranchLinks(payload, async () => { throw error; }, true), error);
  assert.equal(payload.nodes[payload.rootId]!.resource, undefined);
});

test("abandoning the source session cancels in-flight resolution and skips remaining files", async () => {
  const payload = parseMarkdownBranch("[[One]] [[Two]] https://example.com")!;
  let release!: (file: FileResourceRef) => void;
  const wait = new Promise<FileResourceRef>((resolve) => { release = resolve; });
  let active = true;
  let lookups = 0;
  const pending = resolveMarkdownBranchLinks(payload, async () => { lookups += 1; return wait; }, false, () => active);
  active = false;
  release({ type: "file", resourceId: "one", pathHint: "One.md", fileKind: "note" });
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(lookups, 1);
  assert.equal(result.payload.nodes[result.payload.rootId]!.resource, undefined);
  const original = createEmptyDocument("Other view");
  const session = new DocumentSession();
  session.load("disk");
  if (!result.cancelled) session.execute(original, (draft) => { insertBranches(draft, draft.rootId, result.payload); });
  assert.equal(session.canUndo, false);
  assert.deepEqual(original.nodes[original.rootId]!.childIds, []);
});

test("same-session clipboard fallback preserves linked note resources", async () => {
  const document = createEmptyDocument("Project");
  const note = addNode(document, document.rootId, "Linked note");
  note.resource = {
    type: "file",
    resourceId: "linked-note-id",
    pathHint: "notes/Linked note.md",
    fileKind: "note"
  };
  note.titleSync = "bidirectional";
  note.markers = [{ type: "priority", value: "red" }];
  const web = addNode(document, note.id, "Keep title https://example.com");
  web.resource = { type: "url", url: "https://example.com/" };
  web.titleSync = "off";

  let copiedText = "";
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => { copiedText = text; } } }
    });
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: undefined });
    await copyBranch(document, note.id, "branch");

    const payload = readStructuredBranchFromClipboardEvent({
      clipboardData: { getData: (type: string) => type === "text/plain" ? copiedText : "" }
    } as ClipboardEvent);
    assert.ok(payload);
    assert.deepEqual(payload.nodes[payload.rootId]?.resource, note.resource);
    assert.equal(payload.nodes[payload.rootId]?.titleSync, "bidirectional");
    assert.deepEqual(payload.nodes[payload.rootId]?.markers, note.markers);
    assert.equal(payload.nodes[web.id]?.title, web.title);
    assert.deepEqual(payload.nodes[web.id]?.resource, web.resource);

    const fallbackPayload = readStructuredBranchFromPlainText(copiedText);
    assert.ok(fallbackPayload);
    assert.deepEqual(fallbackPayload.nodes[fallbackPayload.rootId]?.resource, note.resource);
    const delayed = await readClipboardFallbackContent(async () => copiedText);
    assert.equal(delayed.kind, "structured");
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (clipboardItemDescriptor) Object.defineProperty(globalThis, "ClipboardItem", clipboardItemDescriptor);
    else Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
});

test("a failed clipboard write preserves the previous successful structured cache", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
  let rejectWrites = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => {
      if (rejectWrites) throw new Error("denied");
    } } }
  });
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: undefined });
  try {
    const first = createEmptyDocument("First cached branch");
    await copyBranch(first, first.rootId, "branch");
    const firstMarkdown = renderBranchMarkdown(first, first.rootId);
    assert.ok(readStructuredBranchFromPlainText(firstMarkdown));

    rejectWrites = true;
    const second = createEmptyDocument("Failed branch");
    await assert.rejects(copyBranch(second, second.rootId, "branch"), /denied/);
    assert.ok(readStructuredBranchFromPlainText(firstMarkdown));
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalClipboardItem) Object.defineProperty(globalThis, "ClipboardItem", originalClipboardItem);
    else delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  }
});

test("clipboard event content prefers structured data and exposes empty first reads", () => {
  const document = createEmptyDocument("Clipboard order");
  const payload = parseMarkdownBranch("- Structured");
  assert.ok(payload);
  const structured = readClipboardEventContent({
    clipboardData: {
      getData: (type: string) => type === "application/x-mind-tree-nature+json"
        ? JSON.stringify(payload)
        : "Different plain text"
    }
  } as ClipboardEvent);
  assert.equal(structured.kind, "structured");

  const plain = readClipboardEventContent({
    clipboardData: { getData: (type: string) => type === "text/plain" ? document.title : "" }
  } as ClipboardEvent);
  assert.deepEqual(plain, { kind: "text", text: "Clipboard order" });
  assert.deepEqual(readClipboardEventContent({
    clipboardData: { getData: () => "" }
  } as unknown as ClipboardEvent), { kind: "empty" });
});

test("delayed clipboard reads preserve text, empty state, and failures", async () => {
  assert.deepEqual(await readClipboardFallbackContent(async () => "First paste"), {
    kind: "text",
    text: "First paste"
  });
  assert.deepEqual(await readClipboardFallbackContent(async () => ""), { kind: "empty" });
  await assert.rejects(
    readClipboardFallbackContent(async () => { throw new Error("permission denied"); }),
    /permission denied/
  );
});

test("SVG export escapes titles and includes every collapsed descendant", () => {
  const document = createEmptyDocument("<Project>");
  const branch = addNode(document, document.rootId, "A & B");
  addNode(document, branch.id, "Hidden");
  branch.collapsed = true;
  const svg = renderBranchSvg(document, document.rootId);
  assert.match(svg, /&lt;Project&gt;/);
  assert.match(svg, /A &amp; B/);
  assert.match(svg, /Hidden/);
  assert.match(svg, /text-anchor="start"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 4); // background plus three nodes
});

test("SVG export keeps root bold, first-level nodes regular, and deeper nodes medium", () => {
  const document = createEmptyDocument("Root");
  const levelOne = addNode(document, document.rootId, "Level one");
  addNode(document, levelOne.id, "Level two");
  const svg = renderBranchSvg(document, document.rootId);

  assert.equal((svg.match(/font-weight="700"/g) ?? []).length, 1);
  assert.equal((svg.match(/font-weight="400"/g) ?? []).length, 1);
  assert.equal((svg.match(/font-weight="500"/g) ?? []).length, 1);
});

test("URL and file open controls share canvas/export geometry in all layouts and alignments", () => {
  const document = createEmptyDocument("Root");
  const linked = addNode(document, document.rootId, "Same title");
  linked.markers = [{ type: "priority", value: "red" }];
  addNode(document, linked.id, "A descendant");
  addNode(document, document.rootId, "Other branch");
  for (const mode of ["balanced", "right", "left", "tree", "radial"] as const) {
    for (const alignment of ["level", "compact"] as const) {
      linked.resource = { type: "file", resourceId: "id", fileKind: "note", pathHint: "Same title.md" };
      linked.titleSync = "bidirectional";
      const fileLayout = layoutTree(document, document.rootId, true, 160, mode, alignment);
      const fileSvg = renderBranchSvg(document, document.rootId, 160, mode, "theme", "vibrant", "rounded", alignment);
      linked.resource = { type: "url", url: "https://example.com/" };
      linked.titleSync = "off";
      assert.deepEqual(layoutTree(document, document.rootId, true, 160, mode, alignment), fileLayout);
      const urlSvg = renderBranchSvg(document, document.rootId, 160, mode, "theme", "vibrant", "rounded", alignment);
      assert.equal(urlSvg, fileSvg);
      assert.doesNotMatch(urlSvg, /mtn-resource-open/); // Export does not add action buttons.
    }
  }
});

test("SVG export reuses resolved view font metrics and typography", () => {
  const document = createEmptyDocument("1111");
  const style = {
    fontFamily: '"Study Sans", sans-serif', fontSize: 17, fontStyle: "italic",
    fontWeight: "650", fontKerning: "normal", fontStretch: "semi-expanded",
    fontVariantCaps: "small-caps", letterSpacing: 0.5, lineHeight: 22,
    textRendering: "optimizeLegibility", wordSpacing: 1.25
  } as const;
  const textMeasurer: NodeTextMeasurer = {
    getStyle: () => style,
    measure(title) {
      return { normalizedTitle: title, lines: [title], lineWidths: [12], width: 12, style };
    }
  };
  const svg = renderBranchSvg(
    document, document.rootId, 240, "right", "theme", "vibrant", "rounded", "level", undefined, textMeasurer
  );

  assert.match(svg, /font-family="&quot;Study Sans&quot;, sans-serif"/);
  assert.match(svg, /font-size="17" font-style="italic" font-weight="650" letter-spacing="0.5"/);
  assert.match(svg, /word-spacing="1.25" font-kerning="normal" font-stretch="semi-expanded"/);
  assert.match(svg, /font-variant-caps="small-caps" text-rendering="optimizeLegibility"/);
  assert.match(svg, /<rect x="36" y="36" width="22" height="32"/);
});

test("SVG export wraps long titles instead of truncating them", () => {
  const title = "A long node title that remains complete across several lines";
  const document = createEmptyDocument(title);
  const svg = renderBranchSvg(document, document.rootId, 160);
  const renderedText = Array.from(svg.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g), (match) => match[1]).join("");
  const nodeX = Number(/<g class="[^"]+"[^>]*><rect x="([^"]+)"/.exec(svg)?.[1]);
  const textX = Number(/<tspan x="([^"]+)"/.exec(svg)?.[1]);

  assert.equal(renderedText, title);
  assert.ok((svg.match(/<tspan /g) ?? []).length > 1);
  assert.equal(textX - nodeX, 5);
});

test("SVG export applies the selected layout, line, theme, and node shape", () => {
  const document = createEmptyDocument("Root");
  addNode(document, document.rootId, "Child");
  const svg = renderBranchSvg(document, document.rootId, 180, "tree", "orthogonal-dashed", "midnight", "rounded");

  assert.match(svg, /stroke-dasharray="8 6"/);
  assert.match(svg, /stroke-width="1"/);
  assert.match(svg, / V .* H .* V /);
  assert.match(svg, /fill="#202531"/);
  assert.match(svg, /rx="2"/);
  assert.doesNotMatch(svg, /(?:linear|radial)Gradient|url\(#mtn-root-gradient\)/);
});

test("SVG export follows the active theme's connection preset", () => {
  const document = createEmptyDocument("Root");
  addNode(document, document.rootId, "Child");

  const classic = renderBranchSvg(document, document.rootId, 180, "right", "theme", "classic");
  const midnight = renderBranchSvg(document, document.rootId, 180, "right", "theme", "midnight");
  const slate = renderBranchSvg(document, document.rootId, 180, "right", "theme", "slate");

  assert.match(classic, / H .* V .* H /);
  assert.doesNotMatch(classic, /stroke-dasharray=/);
  assert.match(midnight, / H .* V .* H /);
  assert.match(midnight, /stroke-dasharray="6 4"/);
  assert.match(slate, /d="M [^"]+ L /);
});

test("neutral rainbow themes keep node fills gray while connections use branch colors", () => {
  const document = createEmptyDocument("Root");
  const first = addNode(document, document.rootId, "First");
  addNode(document, first.id, "Deep");
  addNode(document, document.rootId, "Second");
  const runtimeColors = {
    canvas: "#1E1E1E",
    root: "#123456",
    rootText: "#FAFAFA",
    levelOne: "#484848",
    levelOneText: "#FFFFFF",
    descendant: "#2E2E2E",
    descendantText: "#F1F1F1"
  };

  const flat = renderBranchSvg(document, document.rootId, 180, "right", "theme", "flat", "rounded", "level", runtimeColors);
  const fallback = renderBranchSvg(document, document.rootId, 180, "right", "theme", "flat");
  const minimal = renderBranchSvg(document, document.rootId, 180, "right", "theme", "minimal", "rounded", "level", runtimeColors);
  const floating = renderBranchSvg(document, document.rootId, 180, "right", "theme", "floating", "rounded", "level", runtimeColors);

  assert.match(flat, /<rect width="100%" height="100%" fill="#1E1E1E"/);
  assert.match(flat, /fill="#123456" stroke="none"/);
  assert.match(flat, /fill="#484848" stroke="none"/);
  assert.match(flat, /fill="#2E2E2E" stroke="none"/);
  // The first root branch and its descendant share slot one; the second root
  // branch advances to slot two. This catches exports that collapse every
  // connection to a single theme/accent color.
  assert.equal((flat.match(/<path[^>]+stroke="#F87171"/g) ?? []).length, 2);
  assert.equal((flat.match(/<path[^>]+stroke="#FB923C"/g) ?? []).length, 1);
  assert.equal((flat.match(/<path[^>]+stroke-width="1"/g) ?? []).length, 3);
  assert.match(fallback, /fill="#7C3AED" stroke="none"/);
  assert.match(fallback, /font-weight="700"[^>]*fill="#FFFFFF"/);
  assert.doesNotMatch(flat, /filter:drop-shadow\(0 [246]/);
  assert.match(minimal, /filter:drop-shadow\(0 4px 12px rgb\(0 0 0 \/ 14%\)\)/);
  assert.match(minimal, /filter:drop-shadow\(0 2px 6px rgb\(0 0 0 \/ 10%\)\)/);
  assert.match(floating, /filter:drop-shadow\(0 10px 28px rgb\(0 0 0 \/ 24%\)\)/);
  assert.match(floating, /filter:drop-shadow\(0 6px 18px rgb\(0 0 0 \/ 20%\)\)/);
});

test("every theme and node shape export border-free while preserving shape semantics", () => {
  const themes = [
    "vibrant", "classic", "fresh", "ocean", "sunset",
    "midnight", "slate", "flat", "minimal", "floating"
  ] as const;
  for (const theme of themes) {
    for (const shape of ["rounded", "square", "borderless"] as const) {
      const document = createEmptyDocument("Root");
      addNode(document, document.rootId, "Leaf");
      const svg = renderBranchSvg(document, document.rootId, 180, "right", "theme", theme, shape);
      assert.equal((svg.match(/stroke="none"/g) ?? []).length, 2, `${theme}/${shape}`);
      assert.match(svg, /<path[^>]+stroke-width="1"/, `${theme}/${shape}`);
      if (shape === "square") assert.match(svg, /rx="0"/);
      if (shape === "rounded") assert.match(svg, /rx="2"/);
      if (shape === "borderless") {
        assert.match(svg, /rx="2"/);
        assert.match(svg, /fill="none" stroke="none"/);
      }
    }
  }
});
