import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument, moveNode } from "../src/domain/tree";
import {
  connectionPath,
  getNodeBoxSize,
  getNodeFontSize,
  getNodeHorizontalInsets,
  getNodeLineHeight,
  getNodeSize,
  getNodeSizeClass,
  getNodeTitleEditorSize,
  layoutTree,
  NODE_HORIZONTAL_INSETS,
  NODE_VERTICAL_INSETS,
  wrapNodeTitle
} from "../src/ui/layout";
import { BRANCH_COLOR_COUNT, branchColorCss, getBranchColorSlots } from "../src/ui/presentation";
import {
  estimateFallbackTextWidth,
  fallbackNodeTextStyle,
  type NodeTextMeasurer,
  type NodeTextStyle
} from "../src/ui/text-measurer";
import { getThemePreset, resolveThemeConnection } from "../src/ui/theme-presets";

test("node width follows content while only the root retains a minimum height", () => {
  const root = getNodeSize(0, "A");
  const first = getNodeSize(1, "A");
  const second = getNodeSize(2, "A");
  const third = getNodeSize(3, "A");
  const tenth = getNodeSize(10, "A");
  assert.deepEqual(root, { width: 24, height: 32 });
  assert.deepEqual(first, { width: 22, height: 26 });
  assert.deepEqual(second, { width: 20, height: 23 });
  assert.deepEqual(third, second);
  assert.deepEqual(tenth, third);
  assert.ok(root.width < 112);
  assert.ok(first.width < 96);
  assert.ok(second.width < 80);
  assert.deepEqual([getNodeFontSize(0), getNodeFontSize(1), getNodeFontSize(2), getNodeFontSize(20)], [18, 16, 13, 13]);
  assert.deepEqual([getNodeLineHeight(0), getNodeLineHeight(1), getNodeLineHeight(2), getNodeLineHeight(20)], [23, 20, 17, 17]);
  assert.equal(getNodeSizeClass(3), getNodeSizeClass(99));
});

test("trailing UI has an independent width and never changes title measurement", () => {
  const document = createEmptyDocument("Root");
  const node = addNode(document, document.rootId, "Same title");
  const plain = getNodeBoxSize(1, node.title, 200, node);
  assert.equal(plain.trailingWidth, 0);
  assert.equal(plain.width, plain.contentWidth);

  node.markers = [{ type: "progress", value: "todo" }];
  node.resource = { type: "file", resourceId: "note", pathHint: "Same title.md", fileKind: "note" };
  node.titleSync = "bidirectional";
  const decorated = getNodeBoxSize(1, node.title, 200, node);

  assert.equal(decorated.contentWidth, plain.contentWidth);
  assert.equal(decorated.height, 26);
  assert.equal(decorated.trailingWidth, 42);
  assert.equal(decorated.width, plain.width + decorated.trailingWidth);
});

test("non-root height follows the tallest actual title or tail element", () => {
  const document = createEmptyDocument("Root");
  const node = addNode(document, document.rootId, "A");
  const plain = getNodeBoxSize(2, node.title, 200, node);
  assert.equal(plain.height, 23); // 17 px line box + 3 px on each side.

  node.markers = [{ type: "priority", value: "red" }];
  assert.equal(getNodeBoxSize(2, node.title, 200, node).height, 24);
  node.resource = { type: "file", resourceId: "note", pathHint: "A.md", fileKind: "note" };
  node.titleSync = "bidirectional";
  assert.equal(getNodeBoxSize(2, node.title, 200, node).height, 26);
});

test("URL controls add exactly one 20px button and 2px gap without shrinking the title", () => {
  const document = createEmptyDocument("Root");
  const node = addNode(document, document.rootId, "1".repeat(50));
  for (const depth of [0, 1, 2, 8]) {
    delete node.resource;
    const plain = getNodeBoxSize(depth, node.title, 160, node);
    node.resource = { type: "url", url: "https://example.com/" };
    node.titleSync = "off";
    const web = getNodeBoxSize(depth, node.title, 160, node);
    assert.equal(web.trailingWidth, 22);
    assert.equal(web.width, plain.width + 22);
    assert.equal(web.contentWidth, plain.contentWidth);
    assert.equal(web.height, plain.height);
    assert.equal(getNodeHorizontalInsets(node), NODE_HORIZONTAL_INSETS + 22);

    node.resource = { type: "file", resourceId: "note", pathHint: "Title.md", fileKind: "note" };
    node.titleSync = "bidirectional";
    assert.deepEqual(getNodeBoxSize(depth, node.title, 160, node), web);
    node.titleSync = "off";
    assert.equal(getNodeBoxSize(depth, node.title, 160, node).trailingWidth, 44);
  }
  node.title = "1";
  node.resource = { type: "url", url: "https://example.com/" };
  assert.equal(getNodeBoxSize(2, node.title, 160, node).height, 26);
});

test("injected real glyph metrics size narrow digits without a safety allowance", () => {
  const measurer = createTestMeasurer((character) => character === "1" ? 3 : character === "8" ? 9 : 7);
  const narrow = getNodeSize(1, "1111", 240, NODE_HORIZONTAL_INSETS, measurer);
  const wide = getNodeSize(1, "8888", 240, NODE_HORIZONTAL_INSETS, measurer);

  assert.deepEqual(narrow, { width: 22, height: 26 });
  assert.deepEqual(wide, { width: 46, height: 26 });
  assert.equal(narrow.width, 12 + NODE_HORIZONTAL_INSETS);
});

test("root letter spacing participates in wrapping and increases the measured height", () => {
  const rootStyle = { ...testTextStyle(18, "700", 23), letterSpacing: 0.3 };
  const styles = [
    rootStyle,
    testTextStyle(16, "400", 20),
    testTextStyle(13, "500", 17)
  ] as const;
  // 36 × (4.4 + 0.3) = 169.2px. Omitting the final spacing contribution
  // incorrectly reports 168.9px, keeps this at one line, and allocates 32px.
  const measurer = createTestMeasurer(() => 4.4, styles);
  const size = getNodeSize(0, "1".repeat(36), 169, NODE_HORIZONTAL_INSETS, measurer);

  assert.deepEqual(size, { width: 175, height: 52 });
  assert.equal(measurer.measure("1".repeat(36), 0, 169).lines.length, 2);
});

test("fallback measurement applies spacing to every rendered grapheme and word separator", () => {
  const base = { ...fallbackNodeTextStyle(0), letterSpacing: 0, wordSpacing: 0 };
  const spaced = { ...base, letterSpacing: 0.3, wordSpacing: 1.5 };
  const value = "A B";

  const spacingDelta = estimateFallbackTextWidth(value, spaced) - estimateFallbackTextWidth(value, base);
  assert.ok(Math.abs(spacingDelta - (value.length * 0.3 + 1.5)) < 1e-9);
});

test("the floating editor grows alone and wraps at the configured title width", () => {
  const measurer = createTestMeasurer(() => 9);
  const short = getNodeTitleEditorSize(1, "888", 160, measurer);
  const wrapped = getNodeTitleEditorSize(1, "8".repeat(20), 160, measurer);

  assert.deepEqual(short, { width: 37, height: 26, lineCount: 1 });
  assert.ok(wrapped.width <= 170);
  assert.equal(wrapped.height, 46);
  assert.equal(wrapped.lineCount, 2);
});

test("the floating editor measures leading, trailing, repeated, and multiline draft whitespace", () => {
  const measurer = createTestMeasurer((character) => character === " " ? 4 : 9);
  const plain = getNodeTitleEditorSize(1, "A", 160, measurer);
  const leading = getNodeTitleEditorSize(1, " A", 160, measurer);
  const trailing = getNodeTitleEditorSize(1, "A ", 160, measurer);
  const repeated = getNodeTitleEditorSize(1, "A  ", 160, measurer);
  const multiline = getNodeTitleEditorSize(1, "A\n\nB", 160, measurer);
  const wrappedSpaces = getNodeTitleEditorSize(1, " ".repeat(41), 160, measurer);

  assert.deepEqual(plain, { width: 19, height: 26, lineCount: 1 });
  assert.equal(leading.width, 23);
  assert.equal(trailing.width, 23);
  assert.equal(repeated.width, 27);
  assert.deepEqual(multiline, { width: 19, height: 66, lineCount: 3 });
  assert.deepEqual(wrappedSpaces, { width: 170, height: 46, lineCount: 2 });

  const saved = measurer.measure("  A   B  ", 1, 160);
  const draft = measurer.measure("  A   B  ", 1, 160, "draft");
  assert.equal(saved.normalizedTitle, "A B");
  assert.equal(draft.normalizedTitle, "  A   B  ");
});

test("first-level branches use ordered unique slots and descendants inherit them", () => {
  const document = createEmptyDocument("Root");
  const branches = Array.from({ length: 13 }, (_, index) =>
    addNode(document, document.rootId, `Branch ${index + 1}`));
  const first = branches[0]!;
  const second = branches[1]!;
  const descendant = addNode(document, first.id, "Descendant");
  const slots = getBranchColorSlots(document);

  assert.equal(slots.get(document.rootId), 0);
  branches.slice(0, 12).forEach((branch, index) => assert.equal(slots.get(branch.id), index + 1));
  assert.equal(slots.get(branches[12]!.id), 1);
  assert.equal(slots.get(descendant.id), 1);
  assert.equal(branchColorCss(slots.get(second.id)), "var(--mtn-branch-2)");
  assert.equal(branchColorCss(slots.get(document.rootId)), "var(--mtn-theme-root-accent)");
  assert.equal(BRANCH_COLOR_COUNT, 12);

  moveNode(document, second.id, first.id, "before");
  const reordered = getBranchColorSlots(document);
  assert.equal(reordered.get(second.id), 1);
  assert.equal(reordered.get(first.id), 2);
  assert.equal(reordered.get(descendant.id), 2);
});

test("node width follows title length and long titles wrap at the configured text width", () => {
  const short = getNodeSize(1, "A", 200);
  const medium = getNodeSize(1, "A medium title", 200);
  const long = getNodeSize(1, "A very long title that must wrap onto several compact lines", 200);

  assert.ok(short.width < medium.width);
  assert.ok(medium.width < long.width);
  assert.equal(long.width, 209);
  assert.ok(long.height > short.height);
  assert.ok(wrapNodeTitle("这是一个需要自动换行的较长节点标题", 1, 80).length > 1);
});

test("continuous digits are fully wrapped inside the calculated node height", () => {
  const title = "123456789012345678901234567890123456789012345678901234567890";
  const size = getNodeSize(2, title, 160);
  const lines = wrapNodeTitle(title, 2, size.width - getNodeHorizontalInsets());

  assert.equal(lines.join(""), title);
  assert.ok(lines.length > 1);
  assert.ok(size.height >= lines.length * 17 + NODE_VERTICAL_INSETS);
});

test("the default CJK node title stays on one line at every size level", () => {
  for (const depth of [0, 1, 2, 3, 8]) {
    const size = getNodeSize(depth, "未命名节点", 160);
    assert.equal(wrapNodeTitle("未命名节点", depth, size.width - getNodeHorizontalInsets()).length, 1);
  }
});

test("editing-sized width and height changes reflow descendants and later siblings", () => {
  const document = createEmptyDocument("Root");
  const edited = addNode(document, document.rootId, "A");
  const descendant = addNode(document, edited.id, "Child");
  const laterSibling = addNode(document, document.rootId, "Later");
  const before = layoutTree(document, document.rootId, true, 160, "right", "compact");
  const beforeEdited = before.nodes.find((node) => node.id === edited.id)!;
  const beforeDescendant = before.nodes.find((node) => node.id === descendant.id)!;
  const beforeSibling = before.nodes.find((node) => node.id === laterSibling.id)!;

  edited.title = "这是一个编辑过程中会同时增加节点宽度和高度的很长标题";
  const after = layoutTree(document, document.rootId, true, 160, "right", "compact");
  const afterEdited = after.nodes.find((node) => node.id === edited.id)!;
  const afterDescendant = after.nodes.find((node) => node.id === descendant.id)!;
  const afterSibling = after.nodes.find((node) => node.id === laterSibling.id)!;

  assert.ok(afterEdited.width > beforeEdited.width);
  assert.ok(afterEdited.height > beforeEdited.height);
  assert.ok(afterDescendant.x > beforeDescendant.x);
  assert.ok(afterSibling.y > beforeSibling.y);
  assert.ok(afterSibling.y >= afterEdited.y + afterEdited.height + 9);
});

test("layout hides collapsed descendants but export layout expands them", () => {
  const document = createEmptyDocument();
  const branch = addNode(document, document.rootId, "Branch");
  addNode(document, branch.id, "Leaf");
  branch.collapsed = true;
  assert.equal(layoutTree(document, document.rootId, true).nodes.length, 2);
  assert.equal(layoutTree(document, document.rootId, false).nodes.length, 3);
});

test("root direct children are level one", () => {
  const document = createEmptyDocument();
  const child = addNode(document, document.rootId, "Level one");
  const grandchild = addNode(document, child.id, "Level two");
  const layout = layoutTree(document);
  assert.equal(layout.nodes.find((node) => node.id === document.rootId)?.depth, 0);
  assert.equal(layout.nodes.find((node) => node.id === child.id)?.depth, 1);
  assert.equal(layout.nodes.find((node) => node.id === grandchild.id)?.depth, 2);
});

test("dynamic columns leave room for the widest node at the preceding depth", () => {
  const document = createEmptyDocument("Root");
  const child = addNode(document, document.rootId, "A wide first-level node title");
  const grandchild = addNode(document, child.id, "Leaf");
  const layout = layoutTree(document, document.rootId, true, 320);
  const rootPosition = layout.nodes.find((node) => node.id === document.rootId)!;
  const childPosition = layout.nodes.find((node) => node.id === child.id)!;
  const grandchildPosition = layout.nodes.find((node) => node.id === grandchild.id)!;

  assert.ok(childPosition.x > rootPosition.x + rootPosition.width);
  assert.ok(grandchildPosition.x > childPosition.x + childPosition.width);
});

test("node alignment switches between shared level columns and compact parent-relative placement", () => {
  const document = createEmptyDocument("Root");
  const shortParent = addNode(document, document.rootId, "Short");
  const wideParent = addNode(document, document.rootId, "A substantially wider parent node");
  const shortChild = addNode(document, shortParent.id, "Child A");
  const wideChild = addNode(document, wideParent.id, "Child B");

  const aligned = layoutTree(document, document.rootId, true, 320, "right", "level");
  const alignedShortChild = aligned.nodes.find((node) => node.id === shortChild.id)!;
  const alignedWideChild = aligned.nodes.find((node) => node.id === wideChild.id)!;
  assert.equal(alignedShortChild.x, alignedWideChild.x);

  const compact = layoutTree(document, document.rootId, true, 320, "right", "compact");
  const compactShortParent = compact.nodes.find((node) => node.id === shortParent.id)!;
  const compactWideParent = compact.nodes.find((node) => node.id === wideParent.id)!;
  const compactShortChild = compact.nodes.find((node) => node.id === shortChild.id)!;
  const compactWideChild = compact.nodes.find((node) => node.id === wideChild.id)!;
  assert.notEqual(compactShortChild.x, compactWideChild.x);
  assert.equal(compactShortChild.x - compactShortParent.x - compactShortParent.width,
    compactWideChild.x - compactWideParent.x - compactWideParent.width);
});

test("level columns align title anchors even when sibling trailing widths differ", () => {
  const document = createEmptyDocument("Root");
  const plain = addNode(document, document.rootId, "Same");
  const decorated = addNode(document, document.rootId, "Same");
  decorated.markers = [{ type: "priority", value: "red" }];
  decorated.resource = { type: "file", resourceId: "same", pathHint: "Same.md", fileKind: "note" };
  decorated.titleSync = "off";

  for (const mode of ["right", "left"] as const) {
    const layout = layoutTree(document, document.rootId, true, 200, mode, "level");
    const plainPosition = layout.nodes.find((node) => node.id === plain.id)!;
    const decoratedPosition = layout.nodes.find((node) => node.id === decorated.id)!;
    assert.equal(plainPosition.x, decoratedPosition.x, mode);
    assert.equal(plainPosition.contentWidth, decoratedPosition.contentWidth, mode);
    assert.equal(decoratedPosition.width - decoratedPosition.contentWidth, 64, mode);
  }

  const balancedDocument = createEmptyDocument("Root");
  const branches = Array.from({ length: 4 }, (_, index) =>
    addNode(balancedDocument, balancedDocument.rootId, `B${index}`));
  branches[3]!.markers = [{ type: "progress", value: "done" }];
  const balanced = layoutTree(balancedDocument, balancedDocument.rootId, true, 200, "balanced", "level");
  const root = balanced.nodes.find((node) => node.id === balancedDocument.rootId)!;
  const levelOne = balanced.nodes.filter((node) => node.depth === 1);
  const leftAnchors = new Set(levelOne.filter((node) => node.x < root.x).map((node) => node.x));
  const rightAnchors = new Set(levelOne.filter((node) => node.x > root.x).map((node) => node.x));
  assert.equal(leftAnchors.size, 1);
  assert.equal(rightAnchors.size, 1);
});

test("a node's trailing UI extends right from a stable title anchor in every layout", () => {
  for (const mode of ["balanced", "right", "left", "tree", "radial"] as const) {
    const document = createEmptyDocument("Root");
    const first = addNode(document, document.rootId, "First");
    addNode(document, document.rootId, "Second");
    addNode(document, first.id, "Leaf");
    const before = layoutTree(document, document.rootId, true, 200, mode, "level");
    const beforeRoot = before.nodes.find((node) => node.id === document.rootId)!;

    document.nodes[document.rootId]!.markers = [{ type: "priority", value: "blue" }];
    document.nodes[document.rootId]!.resource = {
      type: "file", resourceId: "root-note", pathHint: "Root.md", fileKind: "note"
    };
    document.nodes[document.rootId]!.titleSync = "bidirectional";
    const after = layoutTree(document, document.rootId, true, 200, mode, "level");
    const afterRoot = after.nodes.find((node) => node.id === document.rootId)!;

    assert.equal(afterRoot.x, beforeRoot.x, mode);
    assert.equal(afterRoot.contentWidth, beforeRoot.contentWidth, mode);
    assert.equal(afterRoot.width - beforeRoot.width, 42, mode);
  }
});

test("reparenting keeps every depth free of vertical overlap", () => {
  const document = createEmptyDocument("Root");
  const first = addNode(document, document.rootId, "First");
  addNode(document, first.id, "A wrapped descendant with enough text to increase its height");
  const second = addNode(document, document.rootId, "Second");
  addNode(document, second.id, "Second child");
  addNode(document, document.rootId, "Third");

  moveNode(document, first.id, second.id, "inside");
  const layout = layoutTree(document, document.rootId, true, 160);
  const depths = new Set(layout.nodes.map((node) => node.depth));
  for (const depth of depths) {
    const row = layout.nodes.filter((node) => node.depth === depth).sort((left, right) => left.y - right.y);
    for (let index = 1; index < row.length; index += 1) {
      const previous = row[index - 1]!;
      const current = row[index]!;
      assert.ok(current.y >= previous.y + previous.height + 9);
    }
  }
});

test("five layout modes place branches in their advertised directions", () => {
  const document = createEmptyDocument("Root");
  const children = ["One", "Two", "Three", "Four"].map((title) => addNode(document, document.rootId, title));
  for (const child of children) addNode(document, child.id, `${child.title} leaf`);

  const right = layoutTree(document, document.rootId, true, 200, "right");
  const rightRoot = right.nodes.find((node) => node.id === document.rootId)!;
  assert.ok(right.nodes.filter((node) => node.depth === 1).every((node) => node.x > rightRoot.x + rightRoot.width));

  const left = layoutTree(document, document.rootId, true, 200, "left");
  const leftRoot = left.nodes.find((node) => node.id === document.rootId)!;
  assert.ok(left.nodes.filter((node) => node.depth === 1).every((node) => node.x + node.width < leftRoot.x));

  const balanced = layoutTree(document, document.rootId, true, 200, "balanced");
  const balancedRoot = balanced.nodes.find((node) => node.id === document.rootId)!;
  const balancedChildren = balanced.nodes.filter((node) => node.depth === 1);
  assert.ok(balancedChildren.some((node) => node.x < balancedRoot.x));
  assert.ok(balancedChildren.some((node) => node.x > balancedRoot.x + balancedRoot.width));

  const tree = layoutTree(document, document.rootId, true, 200, "tree");
  const treeRoot = tree.nodes.find((node) => node.id === document.rootId)!;
  assert.ok(tree.nodes.filter((node) => node.depth === 1).every((node) => node.y > treeRoot.y + treeRoot.height));

  const radial = layoutTree(document, document.rootId, true, 200, "radial");
  const radialRoot = radial.nodes.find((node) => node.id === document.rootId)!;
  const rootCenterX = radialRoot.x + radialRoot.width / 2;
  const rootCenterY = radialRoot.y + radialRoot.height / 2;
  const radialChildren = radial.nodes.filter((node) => node.depth === 1);
  assert.ok(radialChildren.some((node) => node.x + node.width / 2 < rootCenterX));
  assert.ok(radialChildren.some((node) => node.x + node.width / 2 > rootCenterX));
  assert.ok(radialChildren.some((node) => node.y + node.height / 2 < rootCenterY));
  assert.ok(radialChildren.some((node) => node.y + node.height / 2 > rootCenterY));
});

test("source-derived layout rules use compact gaps and right-first weighted balancing", () => {
  const document = createEmptyDocument("Root");
  const children = ["One", "Two", "Three", "Four"].map((title) => addNode(document, document.rootId, title));
  const grandchild = addNode(document, children[0]!.id, "Nested");

  const right = layoutTree(document, document.rootId, true, 200, "right", "compact");
  const rightRoot = right.nodes.find((node) => node.id === document.rootId)!;
  const rightFirst = right.nodes.find((node) => node.id === children[0]!.id)!;
  assert.equal(rightFirst.x - rightRoot.x - rightRoot.width, 45);
  const rightGrandchild = right.nodes.find((node) => node.id === grandchild.id)!;
  assert.equal(rightGrandchild.x - rightFirst.x - rightFirst.width, 32);

  const balanced = layoutTree(document, document.rootId, true, 200, "balanced", "compact");
  const balancedRoot = balanced.nodes.find((node) => node.id === document.rootId)!;
  const first = balanced.nodes.find((node) => node.id === children[0]!.id)!;
  const second = balanced.nodes.find((node) => node.id === children[1]!.id)!;
  assert.ok(first.x > balancedRoot.x + balancedRoot.width);
  assert.ok(second.x + second.width < balancedRoot.x);

  const radial = layoutTree(document, document.rootId, true, 200, "radial", "level");
  const radialRoot = radial.nodes.find((node) => node.id === document.rootId)!;
  const radialFirst = radial.nodes.find((node) => node.id === children[0]!.id)!;
  assert.ok(radialFirst.x + radialFirst.width / 2 > radialRoot.x + radialRoot.width / 2);
  assert.ok(radialFirst.y + radialFirst.height / 2 > radialRoot.y + radialRoot.height / 2);
});

test("all layouts return whole-pixel node anchors", () => {
  const document = createEmptyDocument("Root");
  const first = addNode(document, document.rootId, "A title with varying width");
  const second = addNode(document, document.rootId, "B");
  addNode(document, first.id, "Nested one");
  addNode(document, second.id, "Nested two");

  for (const mode of ["balanced", "right", "left", "tree", "radial"] as const) {
    for (const alignment of ["level", "compact"] as const) {
      const layout = layoutTree(document, document.rootId, true, 200, mode, alignment);
      for (const node of layout.nodes) {
        assert.equal(Number.isInteger(node.x), true, `${mode}/${alignment}/${node.id} x`);
        assert.equal(Number.isInteger(node.y), true, `${mode}/${alignment}/${node.id} y`);
      }
    }
  }
});

test("all ten themes provide twelve colors and every style stays at one pixel", () => {
  const expected = {
    vibrant: "smooth",
    classic: "orthogonal",
    fresh: "smooth",
    ocean: "smooth-dashed",
    sunset: "smooth",
    midnight: "orthogonal-dashed",
    slate: "straight",
    flat: "smooth",
    minimal: "smooth",
    floating: "smooth"
  } as const;
  for (const [theme, style] of Object.entries(expected) as Array<[keyof typeof expected, typeof expected[keyof typeof expected]]>) {
    assert.equal(getThemePreset(theme).branches.length, 12);
    assert.equal(resolveThemeConnection(theme, "theme", 1).style, style);
    for (const configuredStyle of ["theme", "smooth", "smooth-dashed", "straight", "orthogonal", "orthogonal-dashed"] as const) {
      for (const depth of [0, 1, 2, 8, 100]) {
        assert.equal(resolveThemeConnection(theme, configuredStyle, depth).width, 1);
      }
    }
  }
  assert.equal(resolveThemeConnection("classic", "straight", 1).style, "straight");
  assert.equal(resolveThemeConnection("midnight", "theme", 1).dash, "6 4");
  for (const theme of ["flat", "minimal", "floating"] as const) {
    const preset = getThemePreset(theme);
    assert.equal(preset.nodes?.levelOne, "#4A4A4A");
    assert.equal(preset.nodes?.descendant, "#E2E0DB");
  }
});

test("compact alignment keeps node rectangles separate in every layout mode", () => {
  const document = createEmptyDocument("Root");
  for (let branchIndex = 0; branchIndex < 6; branchIndex += 1) {
    const branch = addNode(document, document.rootId, `Branch ${branchIndex} with varied width`);
    if (branchIndex % 2 === 0) branch.markers = [{ type: "progress", value: "inprogress" }];
    if (branchIndex % 3 === 0) {
      branch.resource = {
        type: "file", resourceId: `note-${branchIndex}`, pathHint: `Note ${branchIndex}.md`, fileKind: "note"
      };
      branch.titleSync = branchIndex === 0 ? "off" : "bidirectional";
    }
    for (let childIndex = 0; childIndex <= branchIndex % 3; childIndex += 1) {
      const child = addNode(document, branch.id, `Child ${branchIndex}.${childIndex} with content`);
      if (childIndex === 1) child.markers = [{ type: "priority", value: "yellow" }];
    }
  }

  for (const mode of ["balanced", "right", "left", "tree", "radial"] as const) {
    const layout = layoutTree(document, document.rootId, true, 220, mode, "compact");
    for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
      const left = layout.nodes[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
        const right = layout.nodes[rightIndex]!;
        const separated = left.x + left.width <= right.x
          || right.x + right.width <= left.x
          || left.y + left.height <= right.y
          || right.y + right.height <= left.y;
        assert.equal(separated, true, `${mode}: ${left.id} overlaps ${right.id}`);
      }
    }
  }
});

test("connection styles generate smooth, straight, and orthogonal paths", () => {
  const from = { id: "from", depth: 0, x: 0, y: 10, contentWidth: 100, width: 100, height: 40 };
  const to = { id: "to", depth: 1, x: 200, y: 80, contentWidth: 80, width: 80, height: 30 };

  assert.match(connectionPath(from, to, "right", "smooth"), / C /);
  assert.match(connectionPath(from, to, "right", "smooth-dashed"), / C /);
  assert.match(connectionPath(from, to, "right", "straight"), / L /);
  assert.match(connectionPath(from, to, "right", "orthogonal"), / H .* V .* H /);
  assert.match(connectionPath(from, to, "tree", "orthogonal-dashed"), / V .* H .* V /);

  // Connection geometry deliberately continues to use the complete outer box.
  const decoratedFrom = { ...from, width: 140 };
  assert.match(connectionPath(decoratedFrom, to, "right", "straight"), /^M 140 /);

  const close = { ...to, x: 120 };
  assert.match(connectionPath(from, close, "right", "smooth"), /C 114 30, 106 95/);
});

function createTestMeasurer(
  characterWidth: (character: string) => number,
  styles: readonly [NodeTextStyle, NodeTextStyle, NodeTextStyle] = [
    testTextStyle(18, "700", 23),
    testTextStyle(16, "400", 20),
    testTextStyle(13, "500", 17)
  ]
): NodeTextMeasurer {
  const styleAt = (depth: number): NodeTextStyle => styles[depth <= 0 ? 0 : depth === 1 ? 1 : 2]!;
  return {
    getStyle: styleAt,
    measure(title, depth, maximumWidth, mode = "title") {
      const style = styleAt(depth);
      const normalizedTitle = mode === "draft"
        ? title.replace(/\r\n?/g, "\n")
        : title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
      const lines: string[] = [];
      const lineWidths: number[] = [];
      for (const logicalLine of normalizedTitle.split("\n")) {
        const characters = Array.from(logicalLine);
        if (characters.length === 0) {
          lines.push("");
          lineWidths.push(0);
          continue;
        }
        let line = "";
        let width = 0;
        for (const character of characters) {
          const nextWidth = characterWidth(character) + style.letterSpacing
            + (/\s/u.test(character) ? style.wordSpacing : 0);
          if (line && width + nextWidth > maximumWidth) {
            lines.push(line);
            lineWidths.push(width);
            line = character;
            width = nextWidth;
          } else {
            line += character;
            width += nextWidth;
          }
        }
        lines.push(line);
        lineWidths.push(width);
      }
      return {
        normalizedTitle,
        lines,
        lineWidths,
        width: Math.max(...lineWidths, 1),
        style
      };
    }
  };
}

function testTextStyle(fontSize: number, fontWeight: string, lineHeight: number): NodeTextStyle {
  return {
    fontFamily: "Test",
    fontSize,
    fontStyle: "normal",
    fontWeight,
    fontKerning: "auto",
    fontStretch: "normal",
    fontVariantCaps: "normal",
    letterSpacing: 0,
    lineHeight,
    textRendering: "auto",
    wordSpacing: 0
  };
}
