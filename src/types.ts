export type NodeId = string;
export type ResourceId = string;

/** Supported presentation choices; their persistence scope is defined separately. */
export type MindTreeLayoutMode = "balanced" | "right" | "left" | "tree" | "radial";
/** Controls whether and where unlinked files beside a tree are collected. */
export type MindTreeCollectionMode = "off" | "ask" | "root" | "collect";
export type MindTreeNodeAlignment = "level" | "compact";
export type MindTreeTheme =
  | "vibrant"
  | "classic"
  | "fresh"
  | "ocean"
  | "sunset"
  | "midnight"
  | "slate"
  | "flat"
  | "minimal"
  | "floating";
/** `theme` uses the active tree theme's complete connection preset. */
export type MindTreeConnectionStyle = "theme" | "smooth" | "smooth-dashed" | "straight" | "orthogonal" | "orthogonal-dashed";
export type ResolvedMindTreeConnectionStyle = Exclude<MindTreeConnectionStyle, "theme">;
export type MindTreeNodeShape = "rounded" | "square" | "borderless";

/**
 * Options explicitly allowed to vary between individual mind trees.
 *
 * They live in YAML instead of the compressed machine payload, making the
 * settings easy to inspect while keeping them independent between trees.
 */
export interface MindTreeDocumentSettings {
  layoutMode: MindTreeLayoutMode;
  recursiveScan: boolean;
  collectionMode: MindTreeCollectionMode;
  theme: MindTreeTheme;
  connectionStyle: MindTreeConnectionStyle;
  nodeShape: MindTreeNodeShape;
}

export interface FileResourceRef {
  type: "file";
  resourceId: ResourceId;
  pathHint: string;
  fileKind: "note" | "image" | "attachment";
  /** Cached external format; the linked file's Frontmatter remains authoritative. */
  fileSubtype?: "excalidraw";
}

export interface UrlResourceRef {
  type: "url";
  url: string;
}

export type ResourceRef = FileResourceRef | UrlResourceRef;

export type NodeProgress = "todo" | "inprogress" | "done" | "cancelled";
export type NodePriority = "red" | "yellow" | "blue";
export type NodeHighlightColor =
  | "#75ACA6"
  | "#85A695"
  | "#C39E96"
  | "#F37B6A"
  | "#6B565D"
  | "#403721"
  | "#BF4830"
  | "#BF6730"
  | "#99723C"
  | "#E0CA9D";

/** Each marker category stores at most one value; categories remain independent. */
export type NodeMarker =
  | { type: "progress"; value: NodeProgress }
  | { type: "priority"; value: NodePriority }
  | { type: "highlight"; value: NodeHighlightColor };

export interface NodeStyle {
  color?: string;
  background?: string;
  /** Persisted display box for an image resource; never modifies the source file. */
  imageWidth?: number;
  imageHeight?: number;
}

export interface MindTreeNode {
  id: NodeId;
  title: string;
  childIds: NodeId[];
  resource?: ResourceRef;
  markers?: NodeMarker[];
  collapsed?: boolean;
  titleSync?: "off" | "bidirectional";
  style?: NodeStyle;
  createdAt: string;
  updatedAt: string;
  unknownFields?: Record<string, unknown>;
}

export interface MindTreeDocument {
  /**
   * Stable identity used only after another tree links this document. Fresh
   * schema-v2 trees intentionally omit it until that first association.
   */
  documentId?: string;
  settings: MindTreeDocumentSettings;
  title: string;
  rootId: NodeId;
  nodes: Record<NodeId, MindTreeNode>;
  createdAt: string;
  updatedAt: string;
  unknownFields?: Record<string, unknown>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: NodeId;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  unreachableNodeIds: NodeId[];
}

export interface ParsedMindTreeFile {
  document: MindTreeDocument;
  source: string;
  /** Set when an older supported schema was upgraded in memory while opening. */
  migratedFromSchemaVersion?: number;
  /** Set when absent/invalid current YAML settings were filled from defaults. */
  defaultedDocumentSettings?: boolean;
}

export type DropPosition = "before" | "inside" | "after";

export interface PositionedNode {
  id: NodeId;
  depth: number;
  x: number;
  y: number;
  /**
   * Width of the title-bearing part of the node, including the node's 2 px
   * left/right padding but excluding markers and file controls. Keeping this
   * separate from `width` lets trailing UI extend to the screen-right without
   * moving the title anchor.
   */
  contentWidth: number;
  /** Complete visible width, including markers and file controls. */
  width: number;
  height: number;
}

export interface BranchClipboardPayload {
  /** Runtime/source discriminator; unlinked trees fall back to their root ID. */
  sourceDocumentId: string;
  /** First root retained for simple/single-branch clipboard consumers. */
  rootId: NodeId;
  /** Multiple top-level roots are used by multi-selection and pasted lists. */
  rootIds?: NodeId[];
  nodes: Record<NodeId, MindTreeNode>;
  /** Runtime targets resolved before text imports/clipboard branches are inserted. */
  linkTargets?: Record<NodeId, ClipboardLinkTarget>;
}

export type ClipboardLinkTarget =
  | {
    type: "file";
    linkPath: string;
    /** Restore the literal source if lookup fails; never persisted in a node. */
    fallbackTitle?: string;
  }
  | { type: "url"; url: string };
