import { getDepth } from "../domain/tree";
import { getNodeResourceControls } from "./resource-controls";
import type {
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  MindTreeNode,
  NodeId,
  PositionedNode,
  ResolvedMindTreeConnectionStyle
} from "../types";
import {
  estimateFallbackTextWidth,
  fallbackNodeTextMeasurer,
  fallbackNodeTextStyle,
  type NodeTextMeasurer
} from "./text-measurer";
import {
  fallbackResourceBadgePresentation,
  getNodeMarkerGeometry,
  type ResourceBadgePresentation
} from "./resource-badges";
import {
  fallbackImageNodePresentation,
  IMAGE_CAPTION_GAP,
  type ImageNodePresentation
} from "./image-nodes";

export interface LayoutConnection {
  from: NodeId;
  to: NodeId;
}

export interface TreeLayout {
  nodes: PositionedNode[];
  connections: LayoutConnection[];
  width: number;
  height: number;
}

/** The user-facing wrap width limits title text only, never trailing controls. */
export const DEFAULT_NODE_WRAP_WIDTH = 240;
export const MIN_NODE_WRAP_WIDTH = 160;
export const MAX_NODE_WRAP_WIDTH = 480;

/**
 * One shared node box model for layout, DOM rendering and SVG/PNG export.
 * Tail-item gaps remain independent because they separate sibling UI rather
 * than the title from the visible node edge.
 */
export const NODE_HORIZONTAL_PADDING = 5;
export const NODE_VERTICAL_PADDING = 3;
export const NODE_HORIZONTAL_INSETS = NODE_HORIZONTAL_PADDING * 2;
export const NODE_VERTICAL_INSETS = NODE_VERTICAL_PADDING * 2;

/** Keep malformed persisted settings from producing unusably small or huge nodes. */
export function normalizeNodeWrapWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NODE_WRAP_WIDTH;
  return Math.round(Math.min(MAX_NODE_WRAP_WIDTH, Math.max(MIN_NODE_WRAP_WIDTH, value)));
}

// These gaps deliberately stay independent from node dimensions. This lets short
// titles produce narrow nodes without leaving every depth in a fixed-width column.
const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 9;
const ROOT_HORIZONTAL_GAP = 45;
const RADIAL_MINIMUM_STEP = 90;
const RADIAL_SAFETY_MARGIN = 23;
const RADIAL_ANGULAR_MARGIN = 9;
const SMOOTH_MINIMUM_BEND = 14;

interface DepthMetrics {
  minHeight: number;
  fontSize: number;
  lineHeight: number;
  verticalPadding: number;
}

/**
 * Nodes use three visual tiers: root, direct children, and every deeper node.
 * Keep these values synchronized with styles.css and SVG/PNG export so layout
 * measurements always describe the rectangle users actually see.
 */
function getDepthMetrics(depth: number, textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer): DepthMetrics {
  const style = textMeasurer.getStyle(depth);
  return {
    // Only the root keeps a minimum height. Other tiers follow their actual
    // line box or trailing controls so compact nodes have no empty band.
    minHeight: depth <= 0 ? 32 : 0,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    verticalPadding: NODE_VERTICAL_PADDING
  };
}

/**
 * Space unavailable to the title: outer padding and optional controls.
 * Titles are left-aligned, so controls only reserve their actual right-hand width.
 * Keep these values aligned with node padding and --mtn-node-control-width in CSS.
 */
export function getNodeHorizontalInsets(
  node?: MindTreeNode,
  resourceBadges: ResourceBadgePresentation = fallbackResourceBadgePresentation
): number {
  const markerWidth = node ? getNodeMarkerGeometry(node, resourceBadges).width : 0;
  const controlWidth = getNodeResourceControls(node).width;
  return NODE_HORIZONTAL_INSETS + markerWidth + controlWidth;
}

/** Width appended after the title-bearing node box. */
export function getNodeTrailingWidth(
  node?: MindTreeNode,
  resourceBadges: ResourceBadgePresentation = fallbackResourceBadgePresentation
): number {
  return Math.max(0, getNodeHorizontalInsets(node, resourceBadges) - NODE_HORIZONTAL_INSETS);
}

/** Tallest visible tail item, excluding the node's own vertical padding. */
export function getNodeTrailingHeight(
  node?: MindTreeNode,
  resourceBadges: ResourceBadgePresentation = fallbackResourceBadgePresentation
): number {
  const markerHeight = node ? getNodeMarkerGeometry(node, resourceBadges).height : 0;
  const controlHeight = getNodeResourceControls(node).height;
  return Math.max(markerHeight, controlHeight);
}

export function getNodeFontSize(depth: number, textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer): number {
  return getDepthMetrics(depth, textMeasurer).fontSize;
}

export function getNodeLineHeight(depth: number, textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer): number {
  return getDepthMetrics(depth, textMeasurer).lineHeight;
}

/**
 * Compatibility helper for headless callers. The live view injects its Canvas
 * measurer and therefore does not use this character-ratio fallback.
 */
export function estimateTextWidth(value: string, fontSize: number): number {
  return estimateFallbackTextWidth(value, { ...fallbackNodeTextStyle(2), fontSize, letterSpacing: 0 });
}

/**
 * Split a title with the same injected measurer used by getNodeSize. The browser
 * uses overflow-wrap:anywhere, so grapheme-level wrapping is predictable and can
 * be reused by SVG export.
 */
export function wrapNodeTitle(
  title: string,
  depth: number,
  maxTextWidth: number,
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer
): string[] {
  return [...textMeasurer.measure(title, depth, maxTextWidth).lines];
}

/**
 * Calculate a compact node box from its title. nodeWrapWidth caps only the text
 * column; padding, markers, and file controls are added afterward so inserting a
 * marker can never shorten existing text or introduce an earlier line break.
 */
export function getNodeSize(
  depth: number,
  title = "",
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  horizontalInsets = NODE_HORIZONTAL_INSETS,
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer,
  trailingContentHeight = 0
): { width: number; height: number } {
  const metrics = getDepthMetrics(depth, textMeasurer);
  const insets = Math.max(NODE_HORIZONTAL_INSETS, horizontalInsets);
  const maximumTextWidth = normalizeNodeWrapWidth(nodeWrapWidth);
  const measurement = textMeasurer.measure(title, depth, maximumTextWidth);
  // Ceil only at the glyph boundary. The former arbitrary width allowance was
  // visible as unused space, especially after strings of narrow glyphs such as 1.
  const desiredTextWidth = Math.min(maximumTextWidth, Math.max(1, measurement.width));
  const width = Math.ceil(desiredTextWidth) + insets;
  const contentHeight = Math.max(measurement.lines.length * metrics.lineHeight, trailingContentHeight);
  const height = Math.ceil(Math.max(metrics.minHeight, contentHeight + metrics.verticalPadding * 2));
  return { width, height };
}

export interface NodeBoxSize {
  /** Complete visible width, including markers and file controls. */
  width: number;
  height: number;
  /** Title width plus the node's 5 px padding on both sides. */
  contentWidth: number;
  /** Markers and file controls appended to the screen-right. */
  trailingWidth: number;
  /** Image body above the compact caption; absent for ordinary nodes. */
  image?: { width: number; height: number };
  /** Inner height of the title/marker/control row. */
  captionHeight: number;
}

export interface NodeTitleEditorSize {
  /** Complete neutral editor surface, including its 5 px inline padding. */
  width: number;
  height: number;
  lineCount: number;
}

/**
 * Size only the floating title editor. It can grow beyond the frozen node box,
 * but follows the same font measurement and wrap limit as committed titles.
 */
export function getNodeTitleEditorSize(
  depth: number,
  title: string,
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer
): NodeTitleEditorSize {
  const measurement = textMeasurer.measure(title, depth, normalizeNodeWrapWidth(nodeWrapWidth), "draft");
  const lineCount = measurement.lines.length;
  const draftWidth = title.length === 0 ? 8 : measurement.width;
  return {
    // Eight pixels leave a usable caret target for an empty draft.
    width: Math.ceil(Math.max(8, Math.min(normalizeNodeWrapWidth(nodeWrapWidth), draftWidth)))
      + NODE_HORIZONTAL_INSETS,
    height: Math.ceil(lineCount * measurement.style.lineHeight + NODE_VERTICAL_INSETS),
    lineCount
  };
}

/**
 * Measure the title box independently from trailing UI. Layout algorithms use
 * contentWidth as the stable title anchor and width as the collision boundary.
 */
export function getNodeBoxSize(
  depth: number,
  title = "",
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  node?: MindTreeNode,
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer,
  resourceBadges: ResourceBadgePresentation = fallbackResourceBadgePresentation,
  imageNodes: ImageNodePresentation = fallbackImageNodePresentation
): NodeBoxSize {
  const contentSize = getNodeSize(
    depth,
    title,
    nodeWrapWidth,
    NODE_HORIZONTAL_INSETS,
    textMeasurer,
    getNodeTrailingHeight(node, resourceBadges)
  );
  const trailingWidth = getNodeTrailingWidth(node, resourceBadges);
  const image = node ? imageNodes.resolve(node) : undefined;
  const captionHeight = Math.max(0, contentSize.height - NODE_VERTICAL_INSETS);
  if (image) {
    return {
      // Both rows share the title's left anchor. A wide image therefore grows
      // only toward screen-right and never separates caption text from badges.
      width: Math.max(contentSize.width + trailingWidth, image.width + NODE_HORIZONTAL_INSETS),
      height: contentSize.height + IMAGE_CAPTION_GAP + image.height,
      contentWidth: contentSize.width,
      trailingWidth,
      image: { width: image.width, height: image.height },
      captionHeight
    };
  }
  return {
    width: contentSize.width + trailingWidth,
    height: contentSize.height,
    contentWidth: contentSize.width,
    trailingWidth,
    captionHeight
  };
}

export function getNodeSizeClass(depth: number): string {
  if (depth <= 0) return "mtn-depth-root";
  if (depth === 1) return "mtn-depth-1";
  if (depth === 2) return "mtn-depth-2";
  return "mtn-depth-3";
}

export function layoutTree(
  document: MindTreeDocument,
  startId = document.rootId,
  respectCollapsed = true,
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  layoutMode: MindTreeLayoutMode = "right",
  nodeAlignment: MindTreeNodeAlignment = "level",
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer,
  resourceBadges: ResourceBadgePresentation = fallbackResourceBadgePresentation,
  imageNodes: ImageNodePresentation = fallbackImageNodePresentation
): TreeLayout {
  const relativeDepthById = new Map<NodeId, number>();
  const startDepth = getDepth(document, startId);

  interface SubtreeBlock {
    nodes: PositionedNode[];
    connections: LayoutConnection[];
    height: number;
    root: PositionedNode;
  }

  const visibleChildren = (node: MindTreeNode): NodeId[] =>
    respectCollapsed && node.collapsed ? [] : node.childIds.filter((id) => document.nodes[id] !== undefined);

  const createPosition = (node: MindTreeNode, relativeDepth: number): PositionedNode => {
    const actualDepth = Number.isFinite(startDepth) ? startDepth + relativeDepth : relativeDepth;
    const size = getNodeBoxSize(
      actualDepth,
      node.title,
      nodeWrapWidth,
      node,
      textMeasurer,
      resourceBadges,
      imageNodes
    );
    relativeDepthById.set(node.id, relativeDepth);
    return {
      id: node.id,
      depth: actualDepth,
      x: 0,
      y: 0,
      contentWidth: size.contentWidth,
      width: size.width,
      height: size.height
    };
  };

  /**
   * Horizontal mind-map modes stack complete child subtrees vertically. Sibling
   * blocks keep a fixed minimum gap, so wrapped titles cannot overlap after moves.
   */
  const buildSideSubtree = (id: NodeId, relativeDepth: number): SubtreeBlock | undefined => {
    const node = document.nodes[id];
    if (!node) return undefined;
    const positioned = createPosition(node, relativeDepth);
    const childBlocks: SubtreeBlock[] = [];
    for (const childId of visibleChildren(node)) {
      const child = buildSideSubtree(childId, relativeDepth + 1);
      if (child) childBlocks.push(child);
    }

    const childrenHeight = childBlocks.reduce((sum, child) => sum + child.height, 0)
      + Math.max(0, childBlocks.length - 1) * VERTICAL_GAP;
    const blockHeight = Math.max(positioned.height, childrenHeight);
    positioned.y = (blockHeight - positioned.height) / 2;
    const nodes = [positioned];
    const connections: LayoutConnection[] = [];
    let childOffsetY = (blockHeight - childrenHeight) / 2;
    for (const child of childBlocks) {
      for (const childNode of child.nodes) childNode.y += childOffsetY;
      nodes.push(...child.nodes);
      connections.push({ from: id, to: child.root.id }, ...child.connections);
      childOffsetY += child.height + VERTICAL_GAP;
    }
    return { nodes, connections, height: blockHeight, root: positioned };
  };

  const applyRightColumns = (nodes: PositionedNode[], connections: LayoutConnection[]): number => {
    if (nodeAlignment === "compact") {
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const childrenById = collectConnectionChildren(connections);
      const placeBranch = (id: NodeId, x: number): void => {
        const node = nodeById.get(id);
        if (!node) return;
        node.x = x;
        for (const childId of childrenById.get(id) ?? []) {
          const gap = id === startId ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP;
          placeBranch(childId, x + node.width + gap);
        }
      };
      placeBranch(startId, 0);
      return nodes.reduce((maximum, node) => Math.max(maximum, node.x + node.width), 1);
    }

    const widths = collectDepthMaximums(nodes, relativeDepthById, "width");
    let x = 0;
    let maximumX = 1;
    const maximumDepth = maximumMapKey(widths);
    const columnX = new Map<number, number>();
    for (let depth = 0; depth <= maximumDepth; depth += 1) {
      columnX.set(depth, x);
      x += (widths.get(depth) ?? 0) + (depth === 0 ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP);
    }
    for (const node of nodes) {
      node.x = columnX.get(relativeDepthById.get(node.id) ?? 0) ?? 0;
      maximumX = Math.max(maximumX, node.x + node.width);
    }
    return maximumX;
  };

  /**
   * Place left-growing level columns from the outside in. A column's own width
   * is added only after its title anchor has been assigned, so trailing controls
   * move shallower columns to the right instead of pulling their own title left.
   */
  const applyLeftColumns = (nodes: PositionedNode[]): number => {
    const widths = collectDepthMaximums(nodes, relativeDepthById, "width");
    const columnX = new Map<number, number>();
    let x = 0;
    for (let depth = maximumMapKey(widths); depth >= 0; depth -= 1) {
      columnX.set(depth, x);
      if (depth > 0) {
        x += (widths.get(depth) ?? 0) + (depth === 1 ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP);
      }
    }
    let maximumX = 1;
    for (const node of nodes) {
      node.x = columnX.get(relativeDepthById.get(node.id) ?? 0) ?? 0;
      maximumX = Math.max(maximumX, node.x + node.width);
    }
    return maximumX;
  };

  /**
   * Compact left layout is solved from leaves toward the root. A node's own
   * trailing width never participates in its x coordinate; it only pushes its
   * ancestors right far enough to keep the requested parent/child gap.
   */
  const applyCompactLeft = (nodes: PositionedNode[], connections: LayoutConnection[], rootId: NodeId): number => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const childrenById = collectConnectionChildren(connections);
    const placeBranch = (id: NodeId): void => {
      const node = nodeById.get(id);
      if (!node) return;
      const childIds = childrenById.get(id) ?? [];
      let rightmostChildEdge = 0;
      for (const childId of childIds) {
        placeBranch(childId);
        const child = nodeById.get(childId);
        if (child) rightmostChildEdge = Math.max(rightmostChildEdge, child.x + child.width);
      }
      node.x = childIds.length === 0
        ? 0
        : rightmostChildEdge + (id === rootId ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP);
    };
    placeBranch(rootId);
    return nodes.reduce((maximum, node) => Math.max(maximum, node.x + node.width), 1);
  };

  const finish = (nodes: PositionedNode[], connections: LayoutConnection[], explicitHeight?: number): TreeLayout => {
    if (nodes.length === 0) return { nodes, connections, width: 1, height: 1 };
    // DOM nodes and SVG paths must share the same whole-pixel anchor. Keeping
    // layout coordinates deterministic prevents a freshly edited node from
    // landing on a different half-pixel raster boundary than its neighbours.
    for (const node of nodes) {
      node.x = Math.round(node.x);
      node.y = Math.round(node.y);
    }
    nodes.sort((left, right) => left.depth - right.depth || left.y - right.y || left.x - right.x);
    let width = 1;
    let height = explicitHeight ?? 1;
    for (const node of nodes) {
      width = Math.max(width, node.x + node.width);
      height = Math.max(height, node.y + node.height);
    }
    return { nodes, connections, width, height };
  };

  if (layoutMode === "tree") {
    interface TreeBlock {
      nodes: PositionedNode[];
      connections: LayoutConnection[];
      width: number;
      root: PositionedNode;
    }
    const siblingGap = HORIZONTAL_GAP;
    const buildTreeSubtree = (id: NodeId, relativeDepth: number): TreeBlock | undefined => {
      const node = document.nodes[id];
      if (!node) return undefined;
      const positioned = createPosition(node, relativeDepth);
      const children = visibleChildren(node)
        .map((childId) => buildTreeSubtree(childId, relativeDepth + 1))
        .filter((child): child is TreeBlock => child !== undefined);
      const childrenWidth = children.reduce((sum, child) => sum + child.width, 0)
        + Math.max(0, children.length - 1) * siblingGap;
      // Center the title-bearing box over the children. The complete node may
      // extend farther to the right, but its trailing UI never shifts the title.
      const childStartX = Math.max(0, (positioned.contentWidth - childrenWidth) / 2);
      positioned.x = Math.max(0, (childrenWidth - positioned.contentWidth) / 2);
      const nodes = [positioned];
      const connections: LayoutConnection[] = [];
      let childX = childStartX;
      for (const child of children) {
        for (const childNode of child.nodes) childNode.x += childX;
        nodes.push(...child.nodes);
        connections.push({ from: id, to: child.root.id }, ...child.connections);
        childX += child.width + siblingGap;
      }
      const blockWidth = Math.max(positioned.x + positioned.width, childStartX + childrenWidth);
      return { nodes, connections, width: blockWidth, root: positioned };
    };
    const root = buildTreeSubtree(startId, 0);
    if (!root) return { nodes: [], connections: [], width: 1, height: 1 };
    if (nodeAlignment === "level") {
      const rowHeights = collectDepthMaximums(root.nodes, relativeDepthById, "height");
      const rowY = new Map<number, number>();
      let y = 0;
      for (let depth = 0; depth <= maximumMapKey(rowHeights); depth += 1) {
        rowY.set(depth, y);
        y += (rowHeights.get(depth) ?? 0) + (depth === 0 ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP);
      }
      for (const node of root.nodes) node.y = rowY.get(relativeDepthById.get(node.id) ?? 0) ?? 0;
    } else {
      const nodeById = new Map(root.nodes.map((node) => [node.id, node]));
      const childrenById = collectConnectionChildren(root.connections);
      const placeChildren = (id: NodeId): void => {
        const parent = nodeById.get(id);
        if (!parent) return;
        for (const childId of childrenById.get(id) ?? []) {
          const child = nodeById.get(childId);
          if (!child) continue;
          child.y = parent.y + parent.height + (id === startId ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP);
          placeChildren(childId);
        }
      };
      placeChildren(startId);
    }
    return finish(root.nodes, root.connections);
  }

  if (layoutMode === "radial") {
    const nodes: PositionedNode[] = [];
    const connections: LayoutConnection[] = [];
    const childWeights = new Map<NodeId, Array<{ id: NodeId; weight: number }>>();
    const collect = (id: NodeId, relativeDepth: number): number => {
      const node = document.nodes[id];
      if (!node) return 0;
      nodes.push(createPosition(node, relativeDepth));
      const children = visibleChildren(node).map((childId) => ({ id: childId, weight: collect(childId, relativeDepth + 1) }));
      childWeights.set(id, children);
      for (const child of children) connections.push({ from: id, to: child.id });
      const weight = children.length === 0 ? 1 : children.reduce((sum, child) => sum + Math.max(1, child.weight), 0);
      return weight;
    };
    const totalLeafWeight = Math.max(1, collect(startId, 0));
    const angleById = new Map<NodeId, number>([[startId, 0]]);
    const angleSpanById = new Map<NodeId, number>([[startId, Math.PI * 2]]);
    const assignAngles = (id: NodeId, startAngle: number, endAngle: number): void => {
      const children = childWeights.get(id) ?? [];
      const total = children.reduce((sum, child) => sum + Math.max(1, child.weight), 0);
      let cursor = startAngle;
      for (const child of children) {
        const span = (endAngle - startAngle) * (Math.max(1, child.weight) / Math.max(1, total));
        angleById.set(child.id, cursor + span / 2);
        angleSpanById.set(child.id, span);
        assignAngles(child.id, cursor, cursor + span);
        cursor += span;
      }
    };
    // Light Mindmap begins the first weighted sector at the positive X axis.
    // With screen-space positive Y this places equal branches clockwise.
    assignAngles(startId, 0, Math.PI * 2);
    const maximumDiameterByDepth = new Map<number, number>();
    for (const node of nodes) {
      const depth = relativeDepthById.get(node.id) ?? 0;
      maximumDiameterByDepth.set(depth, Math.max(maximumDiameterByDepth.get(depth) ?? 0, Math.hypot(node.width, node.height)));
    }
    const radiusByDepth = new Map<number, number>([[0, 0]]);
    let previousRadius = 0;
    let previousDiameter = maximumDiameterByDepth.get(0) ?? 0;
    for (let depth = 1; depth <= maximumMapKey(maximumDiameterByDepth); depth += 1) {
      const diameter = maximumDiameterByDepth.get(depth) ?? previousDiameter;
      const circumferenceRadius = totalLeafWeight * (diameter + RADIAL_ANGULAR_MARGIN) / (Math.PI * 2);
      const separatedRadius = previousRadius
        + Math.max(RADIAL_MINIMUM_STEP, (previousDiameter + diameter) / 2 + RADIAL_SAFETY_MARGIN);
      const radius = Math.max(circumferenceRadius, separatedRadius);
      radiusByDepth.set(depth, radius);
      previousRadius = radius;
      previousDiameter = diameter;
    }
    const compactRadiusById = new Map<NodeId, number>([[startId, 0]]);
    if (nodeAlignment === "compact") {
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const childrenById = collectConnectionChildren(connections);
      const placeRadii = (id: NodeId): void => {
        const parent = nodeById.get(id);
        if (!parent) return;
        const parentRadius = compactRadiusById.get(id) ?? 0;
        const parentDiameter = Math.hypot(parent.width, parent.height);
        for (const childId of childrenById.get(id) ?? []) {
          const child = nodeById.get(childId);
          if (!child) continue;
          const childDiameter = Math.hypot(child.width, child.height);
          const branchRadius = parentRadius
            + Math.max(RADIAL_MINIMUM_STEP, (parentDiameter + childDiameter) / 2 + RADIAL_SAFETY_MARGIN);
          const halfSpan = Math.min(Math.PI / 2, Math.max(0.04, (angleSpanById.get(childId) ?? Math.PI * 2) / 2));
          const angularRadius = (childDiameter + RADIAL_ANGULAR_MARGIN) / (2 * Math.sin(halfSpan));
          compactRadiusById.set(childId, Math.max(branchRadius, angularRadius));
          placeRadii(childId);
        }
      };
      placeRadii(startId);
    }
    for (const node of nodes) {
      const depth = relativeDepthById.get(node.id) ?? 0;
      const radius = nodeAlignment === "compact"
        ? compactRadiusById.get(node.id) ?? 0
        : radiusByDepth.get(depth) ?? 0;
      const angle = angleById.get(node.id) ?? 0;
      // The polar point is the center of the title-bearing box. Markers and
      // controls always grow toward screen-right from that stable position.
      node.x = Math.cos(angle) * radius - node.contentWidth / 2;
      node.y = Math.sin(angle) * radius - node.height / 2;
    }
    shiftIntoPositiveCoordinates(nodes);
    return finish(nodes, connections);
  }

  if (layoutMode === "balanced") {
    const rootNode = document.nodes[startId];
    if (!rootNode) return { nodes: [], connections: [], width: 1, height: 1 };
    const rootPosition = createPosition(rootNode, 0);
    const branches = visibleChildren(rootNode)
      .map((childId) => buildSideSubtree(childId, 1))
      .filter((branch): branch is SubtreeBlock => branch !== undefined);
    const left: SubtreeBlock[] = [];
    const right: SubtreeBlock[] = [];
    let leftHeight = 0;
    let rightHeight = 0;
    // Port Light Mindmap's weighted balancing: place the tallest complete
    // subtrees first, always starting on the right, then restore document order
    // inside each side so branch order remains predictable.
    const originalIndex = new Map(branches.map((branch, index) => [branch.root.id, index]));
    const ranked = [...branches].sort((leftBranch, rightBranch) =>
      rightBranch.height - leftBranch.height
      || (originalIndex.get(leftBranch.root.id) ?? 0) - (originalIndex.get(rightBranch.root.id) ?? 0));
    for (const branch of ranked) {
      if (rightHeight <= leftHeight) {
        rightHeight += (right.length > 0 ? VERTICAL_GAP : 0) + branch.height;
        right.push(branch);
      } else {
        leftHeight += (left.length > 0 ? VERTICAL_GAP : 0) + branch.height;
        left.push(branch);
      }
    }
    const restoreDocumentOrder = (leftBranch: SubtreeBlock, rightBranch: SubtreeBlock): number =>
      (originalIndex.get(leftBranch.root.id) ?? 0) - (originalIndex.get(rightBranch.root.id) ?? 0);
    left.sort(restoreDocumentOrder);
    right.sort(restoreDocumentOrder);
    const totalHeight = Math.max(rootPosition.height, leftHeight, rightHeight);
    rootPosition.y = (totalHeight - rootPosition.height) / 2;
    const nodes = [rootPosition];
    const connections: LayoutConnection[] = [];
    const sideById = new Map<NodeId, "left" | "right">();
    const appendSide = (blocks: SubtreeBlock[], side: "left" | "right", sideHeight: number): void => {
      let offsetY = (totalHeight - sideHeight) / 2;
      for (const branch of blocks) {
        for (const node of branch.nodes) {
          node.y += offsetY;
          sideById.set(node.id, side);
        }
        nodes.push(...branch.nodes);
        connections.push({ from: startId, to: branch.root.id }, ...branch.connections);
        offsetY += branch.height + VERTICAL_GAP;
      }
    };
    appendSide(left, "left", leftHeight);
    appendSide(right, "right", rightHeight);
    if (nodeAlignment === "level") {
      const leftWidths = collectSideDepthMaximums(nodes, relativeDepthById, sideById, "left");
      const rightWidths = collectSideDepthMaximums(nodes, relativeDepthById, sideById, "right");
      let leftExtent = 0;
      for (let depth = 1; depth <= maximumMapKey(leftWidths); depth += 1) {
        leftExtent += (leftWidths.get(depth) ?? 0) + (depth === 1 ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP);
      }
      rootPosition.x = leftExtent;
      const leftX = new Map<number, number>();
      let cursorLeft = rootPosition.x - ROOT_HORIZONTAL_GAP;
      for (let depth = 1; depth <= maximumMapKey(leftWidths); depth += 1) {
        cursorLeft -= leftWidths.get(depth) ?? 0;
        leftX.set(depth, cursorLeft);
        cursorLeft -= HORIZONTAL_GAP;
      }
      const rightX = new Map<number, number>();
      let cursorRight = rootPosition.x + rootPosition.width + ROOT_HORIZONTAL_GAP;
      for (let depth = 1; depth <= maximumMapKey(rightWidths); depth += 1) {
        rightX.set(depth, cursorRight);
        cursorRight += (rightWidths.get(depth) ?? 0) + HORIZONTAL_GAP;
      }
      for (const node of nodes) {
        if (node.id === startId) continue;
        const depth = relativeDepthById.get(node.id) ?? 1;
        const side = sideById.get(node.id) ?? "right";
        if (side === "left") {
          node.x = leftX.get(depth) ?? rootPosition.x;
        } else {
          node.x = rightX.get(depth) ?? rootPosition.x;
        }
      }
    } else {
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const childrenById = collectConnectionChildren(connections);
      const placeRightChildren = (id: NodeId): void => {
        const parent = nodeById.get(id);
        if (!parent) return;
        for (const childId of childrenById.get(id) ?? []) {
          const child = nodeById.get(childId);
          if (!child || sideById.get(childId) !== "right") continue;
          const gap = id === startId ? ROOT_HORIZONTAL_GAP : HORIZONTAL_GAP;
          child.x = parent.x + parent.width + gap;
          placeRightChildren(childId);
        }
      };
      const placeLeftChildren = (id: NodeId): void => {
        const node = nodeById.get(id);
        if (!node) return;
        const childIds = (childrenById.get(id) ?? []).filter((childId) => sideById.get(childId) === "left");
        let rightmostChildEdge = 0;
        for (const childId of childIds) {
          placeLeftChildren(childId);
          const child = nodeById.get(childId);
          if (child) rightmostChildEdge = Math.max(rightmostChildEdge, child.x + child.width);
        }
        if (id !== startId) node.x = childIds.length === 0 ? 0 : rightmostChildEdge + HORIZONTAL_GAP;
      };
      for (const branch of left) placeLeftChildren(branch.root.id);
      const leftExtent = left.reduce(
        (maximum, branch) => Math.max(maximum, branch.root.x + branch.root.width),
        0
      );
      rootPosition.x = left.length > 0 ? leftExtent + ROOT_HORIZONTAL_GAP : 0;
      for (const branch of right) {
        branch.root.x = rootPosition.x + rootPosition.width + ROOT_HORIZONTAL_GAP;
        placeRightChildren(branch.root.id);
      }
    }
    return finish(nodes, connections, totalHeight);
  }

  const rootBlock = buildSideSubtree(startId, 0);
  if (!rootBlock) return { nodes: [], connections: [], width: 1, height: 1 };
  if (layoutMode === "left") {
    if (nodeAlignment === "compact") applyCompactLeft(rootBlock.nodes, rootBlock.connections, startId);
    else applyLeftColumns(rootBlock.nodes);
  } else applyRightColumns(rootBlock.nodes, rootBlock.connections);
  return finish(rootBlock.nodes, rootBlock.connections, rootBlock.height);
}

function collectDepthMaximums(
  nodes: PositionedNode[],
  depths: Map<NodeId, number>,
  dimension: "width" | "height"
): Map<number, number> {
  const result = new Map<number, number>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    result.set(depth, Math.max(result.get(depth) ?? 0, node[dimension]));
  }
  return result;
}

/** Build a traversal index once when compact placement follows parent geometry. */
function collectConnectionChildren(connections: LayoutConnection[]): Map<NodeId, NodeId[]> {
  const result = new Map<NodeId, NodeId[]>();
  for (const connection of connections) {
    const children = result.get(connection.from) ?? [];
    children.push(connection.to);
    result.set(connection.from, children);
  }
  return result;
}

function collectSideDepthMaximums(
  nodes: PositionedNode[],
  depths: Map<NodeId, number>,
  sides: Map<NodeId, "left" | "right">,
  side: "left" | "right"
): Map<number, number> {
  return collectDepthMaximums(nodes.filter((node) => sides.get(node.id) === side), depths, "width");
}

function maximumMapKey(values: Map<number, number>): number {
  let result = 0;
  for (const key of values.keys()) result = Math.max(result, key);
  return result;
}

function shiftIntoPositiveCoordinates(nodes: PositionedNode[]): void {
  let minimumX = 0;
  let minimumY = 0;
  for (const node of nodes) {
    minimumX = Math.min(minimumX, node.x);
    minimumY = Math.min(minimumY, node.y);
  }
  for (const node of nodes) {
    node.x -= minimumX;
    node.y -= minimumY;
  }
}

interface ConnectionPoint {
  x: number;
  y: number;
}

function centerOf(node: PositionedNode): ConnectionPoint {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function edgeToward(node: PositionedNode, target: ConnectionPoint): ConnectionPoint {
  const center = centerOf(node);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const scale = 1 / Math.max(Math.abs(dx) / Math.max(1, node.width / 2), Math.abs(dy) / Math.max(1, node.height / 2), 1);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function connectionPoints(from: PositionedNode, to: PositionedNode, mode: MindTreeLayoutMode): [ConnectionPoint, ConnectionPoint] {
  const fromCenter = centerOf(from);
  const toCenter = centerOf(to);
  if (mode === "tree") {
    return [
      { x: fromCenter.x, y: from.y + from.height },
      { x: toCenter.x, y: to.y }
    ];
  }
  if (mode === "radial") return [edgeToward(from, toCenter), edgeToward(to, fromCenter)];
  const opensLeft = mode === "left" || (mode === "balanced" && toCenter.x < fromCenter.x);
  return opensLeft
    ? [{ x: from.x, y: fromCenter.y }, { x: to.x + to.width, y: toCenter.y }]
    : [{ x: from.x + from.width, y: fromCenter.y }, { x: to.x, y: toCenter.y }];
}

/** Build SVG path data independently from dash styling, which is applied in CSS. */
export function connectionPath(
  from: PositionedNode,
  to: PositionedNode,
  mode: MindTreeLayoutMode = "right",
  style: ResolvedMindTreeConnectionStyle = "smooth"
): string {
  const [start, end] = connectionPoints(from, to, mode);
  if (style === "straight") return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  if (style === "orthogonal" || style === "orthogonal-dashed") {
    if (mode === "tree" || (mode === "radial" && Math.abs(end.y - start.y) > Math.abs(end.x - start.x))) {
      const middleY = (start.y + end.y) / 2;
      return `M ${start.x} ${start.y} V ${middleY} H ${end.x} V ${end.y}`;
    }
    const middleX = (start.x + end.x) / 2;
    return `M ${start.x} ${start.y} H ${middleX} V ${end.y} H ${end.x}`;
  }
  if (mode === "tree") {
    const bend = Math.max(SMOOTH_MINIMUM_BEND, Math.abs(end.y - start.y) * 0.48);
    return `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`;
  }
  if (mode === "radial") {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return `M ${start.x} ${start.y} C ${start.x + dx * 0.42} ${start.y + dy * 0.42}, ${end.x - dx * 0.42} ${end.y - dy * 0.42}, ${end.x} ${end.y}`;
  }
  const direction = end.x >= start.x ? 1 : -1;
  const bend = Math.max(SMOOTH_MINIMUM_BEND, Math.abs(end.x - start.x) * 0.48);
  return `M ${start.x} ${start.y} C ${start.x + bend * direction} ${start.y}, ${end.x - bend * direction} ${end.y}, ${end.x} ${end.y}`;
}
