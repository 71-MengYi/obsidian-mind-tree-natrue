import { DEFAULT_NODE_TITLE } from "../domain/tree";
import type { MindTreeDocument, MindTreeNode, NodeId } from "../types";
import { nodeTitleMode, parseNodeTitle } from "./node-title";

/** Fence that makes the copied block render directly inside a Markdown note. */
export const MERMAID_FENCE = "mermaid";
/** Mermaid mindmaps are indentation based; two spaces per level stay readable. */
const INDENT = "  ";

/**
 * Render one branch as a Mermaid mindmap inside a fenced code block.
 *
 * Only the hierarchy and one plain-text label per node are exported: the shape
 * carries the label, so markers, resources and the node id have no faithful
 * Mermaid equivalent and are deliberately left out. `startId` is the diagram
 * root, which is how a sub-branch keeps its own shape instead of being
 * re-rooted at the document root. A vanished start node renders nothing, so
 * callers must validate the node before copying the result.
 */
export function renderBranchMermaid(document: MindTreeDocument, startId: NodeId): string {
  const start = document.nodes[startId];
  if (!start) return "";
  const lines = ["```" + MERMAID_FENCE, "mindmap"];
  const visiting = new Set<NodeId>();
  let sequence = 0;
  const visit = (nodeId: NodeId, depth: number): void => {
    const node = document.nodes[nodeId];
    // Cyclic or dangling child ids in hand-edited data must not hang the copy.
    if (!node || visiting.has(nodeId)) return;
    visiting.add(nodeId);
    // Ids only anchor the shape; the visible text is the node title. Sequence
    // numbers stay stable for the copied block instead of leaking node ids.
    lines.push(`${INDENT.repeat(depth + 1)}n${sequence}${mindmapLabel(node, depth === 0)}`);
    sequence += 1;
    for (const childId of node.childIds) visit(childId, depth + 1);
    visiting.delete(nodeId);
  };
  visit(startId, 0);
  lines.push("```");
  return lines.join("\n");
}

/**
 * Mermaid mindmap labels are delimited by the shape that carries them: the
 * quoted square form keeps every character except a double quote, the rounded
 * form keeps the quote but not brackets or braces. Pick the form that needs no
 * rewriting, and only fall back to substituting the quote. Mermaid mindmaps do
 * not decode `#quot;`-style entities, so a substituted apostrophe stays
 * readable where an entity code would show up literally.
 */
export function mindmapLabel(node: Pick<MindTreeNode, "title" | "resource" | "titleSync">, isRoot: boolean): string {
  const source = node.title || DEFAULT_NODE_TITLE;
  const text = (nodeTitleMode(node, isRoot ? 0 : 1) === "literal"
    ? source
    : parseNodeTitle(source).plainText).replace(/[\r\n]+/g, " ").trim() || DEFAULT_NODE_TITLE;
  if (!text.includes('"')) return `["${text}"]`;
  if (!/[()[\]{}]/.test(text)) return `(${text})`;
  return `["${text.replace(/"/g, "'")}"]`;
}
