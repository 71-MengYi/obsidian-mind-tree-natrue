import { App, FuzzySuggestModal } from "obsidian";
import { t } from "../../i18n";
import { nodeTitlePath } from "../../domain/node-link";
import type { MindTreeDocument, NodeId } from "../../types";
import { collectBranchIds } from "../../domain/tree";

/** One selectable target: the node id plus its readable root-to-node path. */
export interface NodeLinkCandidate {
  readonly id: NodeId;
  readonly path: string;
}

/**
 * Build the picker list in document order. The source node is excluded because
 * a node can never link to itself; every other node is a valid target.
 */
export function nodeLinkCandidates(
  document: Readonly<MindTreeDocument>,
  sourceId: NodeId,
  untitled: string
): NodeLinkCandidate[] {
  return collectBranchIds(document, document.rootId)
    .filter((id) => id !== sourceId && Boolean(document.nodes[id]))
    .map((id) => ({ id, path: nodeTitlePath(document, id, untitled) }));
}

export class NodeLinkSuggestModal extends FuzzySuggestModal<NodeLinkCandidate> {
  constructor(
    app: App,
    private readonly candidates: readonly NodeLinkCandidate[],
    private readonly onChoose: (targetId: NodeId) => void
  ) {
    super(app);
    this.setPlaceholder(t("modal.nodeLink.placeholder"));
  }

  onOpen(): void {
    super.onOpen();
    this.titleEl.setText(t("modal.nodeLink.title"));
  }

  getItems(): NodeLinkCandidate[] {
    return [...this.candidates];
  }

  getItemText(item: NodeLinkCandidate): string {
    return item.path;
  }

  onChooseItem(item: NodeLinkCandidate): void {
    this.onChoose(item.id);
  }
}
