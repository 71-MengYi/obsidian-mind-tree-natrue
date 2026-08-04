import type { MindTreeDocument, MindTreeNode, NodeId } from "../types";
import { renderNodeMarkerSuffix } from "../domain/markers";

export const OUTLINE_START = "<!-- mtn:outline:start -->";
export const OUTLINE_END = "<!-- mtn:outline:end -->";

export function renderOutline(document: MindTreeDocument, startId = document.rootId): string {
  const lines: string[] = [OUTLINE_START];
  renderNode(document, startId, 0, lines, new Set());
  lines.push(OUTLINE_END);
  return lines.join("\n");
}

export function renderBranchMarkdown(document: MindTreeDocument, startId: NodeId): string {
  const lines: string[] = [];
  renderNode(document, startId, 0, lines, new Set());
  return lines.join("\n");
}

function renderNode(
  document: MindTreeDocument,
  nodeId: NodeId,
  depth: number,
  lines: string[],
  visiting: Set<NodeId>
): void {
  const node = document.nodes[nodeId];
  if (!node || visiting.has(nodeId)) return;
  visiting.add(nodeId);
  lines.push(`${"  ".repeat(depth)}- ${renderNodeLabel(node)}`);
  for (const childId of node.childIds) renderNode(document, childId, depth + 1, lines, visiting);
  visiting.delete(nodeId);
}

function renderNodeLabel(node: MindTreeNode): string {
  const title = escapeMarkdown(node.title || "未命名节点");
  const resource = node.resource;
  const suffix = renderNodeMarkerSuffix(node);
  const withMarkers = (label: string): string => suffix ? `${label} ${suffix}` : label;
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

export function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]()*_`])/g, "\\$1")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function escapeLinkTarget(value: string): string {
  return value.replace(/\s/g, (character) => encodeURIComponent(character)).replace(/\)/g, "%29");
}

function escapeWikiTarget(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
