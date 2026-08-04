import { normalizeNodeMarkers } from "./markers";
import { assertSafeRecordKey, createSafeRecord } from "../input-limits";
import type { MindTreeNode, NodeStyle, ResourceRef } from "../types";

export class RuntimeNodeDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeDataError";
  }
}

/** Normalize one persisted or clipboard node without trusting TypeScript casts. */
export function normalizeRuntimeNode(id: string, value: unknown): MindTreeNode {
  assertSafeNodeId(id);
  const record = asRecord(value);
  if (!record) throw new RuntimeNodeDataError(`Node ${id} must be an object.`);
  if (record["childIds"] !== undefined && !Array.isArray(record["childIds"])) {
    throw new RuntimeNodeDataError(`Node ${id} childIds must be an array.`);
  }
  const childIds = (record["childIds"] ?? []) as unknown[];
  if (!childIds.every((childId) => typeof childId === "string" && childId.length > 0)) {
    throw new RuntimeNodeDataError(`Node ${id} contains an invalid child ID.`);
  }
  for (const childId of childIds as string[]) assertSafeNodeId(childId);

  const createdAt = stringValue(record["createdAt"]) ?? new Date().toISOString();
  const node: MindTreeNode = {
    id,
    title: stringValue(record["title"]) ?? "",
    childIds: [...childIds] as string[],
    createdAt,
    updatedAt: stringValue(record["updatedAt"]) ?? createdAt
  };
  if (record["resource"] !== undefined) node.resource = normalizeRuntimeResource(record["resource"]);
  const markers = normalizeNodeMarkers(record["markers"]);
  if (markers.length > 0) node.markers = markers;
  if (typeof record["collapsed"] === "boolean") node.collapsed = record["collapsed"];
  if (record["titleSync"] === "off" || record["titleSync"] === "bidirectional") {
    node.titleSync = record["titleSync"];
  } else if (node.resource?.type === "file") {
    node.titleSync = "bidirectional";
  }
  const style = normalizeNodeStyle(record["style"]);
  if (style) node.style = style;

  const unknownFields = createSafeRecord<unknown>();
  const nestedUnknown = asRecord(record["unknownFields"]);
  if (nestedUnknown) copyUnknownFields(nestedUnknown, unknownFields, new Set());
  copyUnknownFields(record, unknownFields, new Set([
    "id", "title", "childIds", "resource", "markers", "collapsed",
    "titleSync", "style", "createdAt", "updatedAt", "unknownFields"
  ]));
  if (Object.keys(unknownFields).length > 0) node.unknownFields = unknownFields;
  return node;
}

export function normalizeRuntimeResource(value: unknown): ResourceRef {
  const record = asRecord(value);
  if (!record) throw new RuntimeNodeDataError("Node resource must be an object.");
  if (record["type"] === "url") {
    const url = requiredString(record, "url");
    if (!isSafeHttpUrl(url)) throw new RuntimeNodeDataError("URL resources only support http and https.");
    return { type: "url", url };
  }
  if (record["type"] === "file") {
    const fileKind = record["fileKind"];
    if (fileKind !== "note" && fileKind !== "image" && fileKind !== "attachment") {
      throw new RuntimeNodeDataError("File resource has an invalid fileKind.");
    }
    return {
      type: "file",
      resourceId: requiredString(record, "resourceId"),
      pathHint: requiredString(record, "pathHint"),
      fileKind,
      ...(record["fileSubtype"] === "excalidraw" ? { fileSubtype: "excalidraw" as const } : {})
    };
  }
  throw new RuntimeNodeDataError("Node resource has an invalid type.");
}

export function assertSafeNodeId(id: string): void {
  if (!id || id.length > 512 || id.includes("\0")) {
    throw new RuntimeNodeDataError("Node IDs must be non-empty strings of at most 512 characters.");
  }
  assertSafeRecordKey(id);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = stringValue(record[key]);
  if (!value) throw new RuntimeNodeDataError(`Missing required string property: ${key}`);
  return value;
}

function normalizeNodeStyle(value: unknown): NodeStyle | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const style: NodeStyle = {};
  if (typeof record["color"] === "string") style.color = record["color"];
  if (typeof record["background"] === "string") style.background = record["background"];
  return Object.keys(style).length > 0 ? style : undefined;
}

function copyUnknownFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  ignored: ReadonlySet<string>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (ignored.has(key)) continue;
    assertSafeRecordKey(key);
    target[key] = value;
  }
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
