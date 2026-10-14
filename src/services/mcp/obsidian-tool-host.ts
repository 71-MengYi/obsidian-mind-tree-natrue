import { createMcpNodeView } from "./tree-reader";
import type { MindTreeReader } from "./tree-reader";
import type { MindTreeSessionWriter, MindTreeWriteOutcome } from "./session-writer";
import type {
  McpCreatedTree,
  McpHostEnvironment,
  McpNodeView,
  McpReadPort,
  McpToolHost,
  McpTreeLocator,
  McpWritePort
} from "./contracts";

/**
 * The Obsidian-facing implementation of the frozen tool host contract.
 *
 * Reads go straight to the reader (they need no view and never mutate anything),
 * writes go through the session writer (they share the open view's history and
 * write lane), and the locator turns the client's tree intent into exactly one
 * path. This class adds no policy of its own: every rule lives in the module
 * that owns it, and this file only adapts one interface to another — including
 * turning a write's resulting document into the same node view a read returns.
 */
export class ObsidianToolHost implements McpToolHost {
  readonly read: McpReadPort;
  readonly write: McpWritePort;
  readonly locator: McpTreeLocator;
  readonly environment: McpHostEnvironment;

  constructor(options: {
    reader: MindTreeReader;
    writer: MindTreeSessionWriter;
    locator: McpTreeLocator;
    environment: McpHostEnvironment;
  }) {
    this.read = options.reader;
    this.locator = options.locator;
    this.environment = options.environment;
    this.write = this.createWritePort(options.writer);
  }

  private createWritePort(writer: MindTreeSessionWriter): McpWritePort {
    const view = (outcome: MindTreeWriteOutcome): McpNodeView =>
      createMcpNodeView(outcome.document, outcome.nodeId);
    return {
      createTree: (input): Promise<McpCreatedTree> =>
        writer.createTree(input),
      moveNode: async (treePath, nodeId, targetId) =>
        view(await writer.moveNode(treePath, nodeId, targetId)),
      addNode: async (treePath, parentId, title, index) =>
        view(await writer.addNode(treePath, parentId, title, index)),
      renameNode: async (treePath, nodeId, title) =>
        view(await writer.renameNode(treePath, nodeId, title)),
      deleteNode: async (treePath, nodeId) => {
        const outcome = await writer.deleteNode(treePath, nodeId);
        return { removedId: outcome.removedId, promotedChildIds: outcome.promotedChildIds };
      },
      linkFile: async (treePath, nodeId, filePath) =>
        view(await writer.linkFile(treePath, nodeId, filePath)),
      unlinkFile: async (treePath, nodeId) =>
        view(await writer.unlinkFile(treePath, nodeId)),
      linkNode: async (treePath, sourceId, targetId) =>
        view(await writer.linkNode(treePath, sourceId, targetId)),
      unlinkNode: async (treePath, sourceId) =>
        view(await writer.unlinkNode(treePath, sourceId))
    };
  }
}
