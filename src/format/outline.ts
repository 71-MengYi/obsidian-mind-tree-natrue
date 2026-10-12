import { parseNodeTitle, nodeTitleMode, escapeTitleMarkdown } from "./node-title";
import type { MindTreeDocument, MindTreeNode, NodeId } from "../types";
import { renderNodeMarkerSuffix } from "../domain/markers";
import { DEFAULT_NODE_TITLE } from "../domain/tree";
import { collectNodeLinks, type NodeLinkEdge } from "../domain/node-link";
import { isSafeHttpUrl } from "../domain/url";

export const OUTLINE_START = "<!-- mtn:outline:start -->";
export const OUTLINE_END = "<!-- mtn:outline:end -->";
/** Marks the plain-text field that tells external readers about node links. */
export const OUTLINE_LINKS = "<!-- mtn:links -->";

/**
 * Outline block id derived from the node's own stable id. Obsidian block ids
 * only accept letters, digits and dashes, so a hand-edited or imported id is
 * reduced to that alphabet instead of emitting an unusable reference.
 */
export function outlineBlockId(nodeId: NodeId): string | undefined {
  const cleaned = nodeId.replace(/[^A-Za-z0-9-]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

export function renderOutline(document: MindTreeDocument, startId = document.rootId): string {
  const lines: string[] = [OUTLINE_START];
  const edges = collectNodeLinks(document);
  renderNode(document, startId, 0, lines, new Set(), linkParticipantIds(edges));
  // The link field belongs inside the outline markers: the serializer only
  // regenerates the text between OUTLINE_START and OUTLINE_END, so anything
  // written after them would accumulate as user prose across saves.
  const links = edges
    .map((edge) => ({ source: outlineBlockId(edge.sourceId), target: outlineBlockId(edge.targetId) }))
    .filter((edge): edge is { source: string; target: string } => Boolean(edge.source && edge.target));
  if (links.length > 0) {
    lines.push(OUTLINE_LINKS);
    for (const edge of links) lines.push(`${edge.source}->${edge.target}`);
  }
  lines.push(OUTLINE_END);
  return lines.join("\n");
}

/** Branch fragments carry the `^id` suffix but not the document link field. */
export function renderBranchMarkdown(document: MindTreeDocument, startId: NodeId): string {
  const lines: string[] = [];
  renderNode(document, startId, 0, lines, new Set(), linkParticipantIds(collectNodeLinks(document)));
  return lines.join("\n");
}

function linkParticipantIds(edges: readonly NodeLinkEdge[]): ReadonlySet<NodeId> {
  const participants = new Set<NodeId>();
  for (const edge of edges) {
    participants.add(edge.sourceId);
    participants.add(edge.targetId);
  }
  return participants;
}

function renderNode(
  document: MindTreeDocument,
  nodeId: NodeId,
  depth: number,
  lines: string[],
  visiting: Set<NodeId>,
  participants: ReadonlySet<NodeId>
): void {
  const node = document.nodes[nodeId];
  if (!node || visiting.has(nodeId)) return;
  visiting.add(nodeId);
  lines.push(`${"  ".repeat(depth)}- ${renderNodeLabel(node, nodeId === document.rootId, participants.has(nodeId))}`);
  for (const childId of node.childIds) renderNode(document, childId, depth + 1, lines, visiting, participants);
  visiting.delete(nodeId);
}

function renderNodeLabel(node: MindTreeNode, isRoot: boolean, linked: boolean): string {
  const source = node.title || DEFAULT_NODE_TITLE;
  const title = nodeTitleMode(node, isRoot ? 0 : 1) === "literal"
    ? escapeTitleMarkdown(source) : parseNodeTitle(source).markdown;
  const resource = node.resource;
  const suffix = renderNodeMarkerSuffix(node);
  // Only nodes that take part in a node link expose a block id, and it always
  // closes the line so `[[#^id]]` resolves from Markdown readers.
  const blockId = linked ? outlineBlockId(node.id) : undefined;
  const withMarkers = (label: string): string => {
    const withMarkers = suffix ? `${label} ${suffix}` : label;
    return blockId ? `${withMarkers} ^${blockId}` : withMarkers;
  };
  if (!resource) return withMarkers(title);
  if (resource.type === "url") return withMarkers(isSafeHttpUrl(resource.url) ? `[${title}](${escapeLinkTarget(resource.url)})` : title);

  const path = resource.pathHint.replace(/\\/g, "/");
  if (resource.fileKind === "image") return withMarkers(`![[${escapeWikiTarget(path)}|${title}]]`);
  if (resource.fileKind === "note") {
    const withoutExtension = path.replace(/\.md$/i, "");
    return withMarkers(`[[${escapeWikiTarget(withoutExtension)}|${title}]]`);
  }
  return withMarkers(`[[${escapeWikiTarget(path)}|${title}]]`);
}

function escapeLinkTarget(value: string): string {
  return value.replace(/\s/g, (character) => encodeURIComponent(character)).replace(/\)/g, "%29");
}

function escapeWikiTarget(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}
