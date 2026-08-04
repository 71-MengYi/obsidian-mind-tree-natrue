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
  assert.deepEqual(parsed.linkTargets?.[parsedNoteId], { type: "file", linkPath: "notes/Requirement" });
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

test("parses list links and resolves notes, headings, attachments, images, and URLs", async () => {
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
  assert.deepEqual(payload.linkTargets?.[planId], { type: "file", linkPath: "notes/Plan#Scope" });
  assert.deepEqual(payload.linkTargets?.[manualId!], { type: "file", linkPath: "assets/manual.pdf" });
  assert.deepEqual(payload.linkTargets?.[imageId!], { type: "file", linkPath: "images/diagram.png" });
  assert.deepEqual(payload.nodes[websiteId!]?.resource, { type: "url", url: "https://example.com/docs" });

  const references = new Map([
    ["notes/Plan#Scope", { type: "file" as const, resourceId: "plan", pathHint: "notes/Plan.md", fileKind: "note" as const }],
    ["assets/manual.pdf", { type: "file" as const, resourceId: "manual", pathHint: "assets/manual@Ab123.pdf", fileKind: "attachment" as const }],
    ["images/diagram.png", { type: "file" as const, resourceId: "image", pathHint: "images/diagram@Cd456.png", fileKind: "image" as const }]
  ]);
  const resolved = await resolveMarkdownBranchLinks(payload, async (linkPath) => references.get(linkPath), true);
  assert.deepEqual(resolved.unresolvedFileLinks, []);
  assert.deepEqual(resolved.payload.nodes[planId]?.resource, references.get("notes/Plan#Scope"));
  assert.deepEqual(resolved.payload.nodes[manualId!]?.resource, references.get("assets/manual.pdf"));
  assert.deepEqual(resolved.payload.nodes[imageId!]?.resource, references.get("images/diagram.png"));
  assert.equal(resolved.payload.nodes[manualId!]?.titleSync, "bidirectional");
  assert.equal(resolved.payload.linkTargets, undefined);

  // Exercise the final persistence boundary as well as the parser/resolver:
  // imported nodes must retain their file/URL resources after IDs are replaced.
  const target = createEmptyDocument("Imported links");
  const [insertedPlanId] = insertBranches(target, target.rootId, resolved.payload);
  assert.ok(insertedPlanId);
  const [insertedManualId, insertedImageId, insertedWebsiteId] = target.nodes[insertedPlanId]!.childIds;
  assert.deepEqual(target.nodes[insertedPlanId]?.resource, references.get("notes/Plan#Scope"));
  assert.deepEqual(target.nodes[insertedManualId!]?.resource, references.get("assets/manual.pdf"));
  assert.deepEqual(target.nodes[insertedImageId!]?.resource, references.get("images/diagram.png"));
  assert.deepEqual(target.nodes[insertedWebsiteId!]?.resource, { type: "url", url: "https://example.com/docs" });
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

test("SVG export wraps long titles instead of truncating them", () => {
  const title = "A long node title that remains complete across several lines";
  const document = createEmptyDocument(title);
  const svg = renderBranchSvg(document, document.rootId, 160);
  const renderedText = Array.from(svg.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g), (match) => match[1]).join("");
  const nodeX = Number(/<g class="[^"]+"[^>]*><rect x="([^"]+)"/.exec(svg)?.[1]);
  const textX = Number(/<tspan x="([^"]+)"/.exec(svg)?.[1]);

  assert.equal(renderedText, title);
  assert.ok((svg.match(/<tspan /g) ?? []).length > 1);
  assert.equal(textX - nodeX, 2);
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
  assert.match(fallback, /font-weight="700" fill="#FFFFFF"/);
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
