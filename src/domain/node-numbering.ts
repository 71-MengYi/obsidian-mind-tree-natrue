import type {
  MindTreeDocument,
  MindTreeNode,
  NodeId,
  NodeNumbering,
  NodeNumberingFormat,
  NodeNumberingScope,
  NodeNumberingStart
} from "../types";

/**
 * Menu order of the numbering styles. The first two are hierarchical: a label
 * repeats every ancestor counter ("1.1.1", "（一）（1）"), so "从上层继续" is
 * observable. The last four number siblings only, which is how those style
 * guides are usually read ("i., ii., iii." restarting per parent).
 */
export const NODE_NUMBERING_FORMATS = [
  "decimal",
  "chinese",
  "lowerRoman",
  "upperRoman",
  "upperAlpha",
  "lowerAlpha"
] as const satisfies readonly NodeNumberingFormat[];

export function isNodeNumberingFormat(value: unknown): value is NodeNumberingFormat {
  return typeof value === "string" && (NODE_NUMBERING_FORMATS as readonly string[]).includes(value);
}

const START_VALUES: readonly NodeNumberingStart[] = ["restart", "continue"];
const SCOPE_VALUES: readonly NodeNumberingScope[] = ["level", "descendants"];

/**
 * Normalize one persisted configuration. Unknown formats are dropped rather
 * than coerced, so a hand-edited file can never switch a tree to a style the
 * release does not implement.
 */
export function normalizeNodeNumbering(value: unknown): NodeNumbering | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const format = record["format"];
  const scope = record["scope"];
  const start = record["start"];
  if (!isNodeNumberingFormat(format)) return undefined;
  if (!SCOPE_VALUES.includes(scope as NodeNumberingScope)) return undefined;
  if (!START_VALUES.includes(start as NodeNumberingStart)) return undefined;
  return { format, scope: scope as NodeNumberingScope, start: start as NodeNumberingStart };
}

const ROMAN_DIGITS: readonly [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
];

/** Uppercase Roman numeral; values above 3999 repeat M as plain magnitude. */
export function toRomanNumeral(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  let remaining = Math.floor(value);
  let output = "";
  for (const [amount, glyph] of ROMAN_DIGITS) {
    while (remaining >= amount) {
      output += glyph;
      remaining -= amount;
    }
  }
  return output;
}

/** Spreadsheet-style letters: 1 -> A, 26 -> Z, 27 -> AA. */
export function toAlphabeticNumeral(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  let remaining = Math.floor(value);
  let output = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    output = String.fromCharCode(65 + digit) + output;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return output;
}

const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
const CHINESE_UNITS = ["", "十", "百", "千"] as const;

/**
 * Numbers up to 9999 read naturally ("九十九"). Larger counters fall back to
 * decimal digits so a deep tree still renders something instead of throwing.
 */
export function toChineseNumeral(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  const number = Math.floor(value);
  if (number > 9999) return String(number);
  const digits = String(number).split("").map((character) => Number(character));
  let output = "";
  let pendingZero = false;
  digits.forEach((digit, index) => {
    const unit = CHINESE_UNITS[digits.length - 1 - index] ?? "";
    if (digit === 0) {
      pendingZero = output.length > 0;
      return;
    }
    if (pendingZero) {
      output += CHINESE_DIGITS[0];
      pendingZero = false;
    }
    output += CHINESE_DIGITS[digit] + unit;
  });
  // "一十" is written "十" for the teens, matching everyday Chinese numbering.
  return output.startsWith("一十") ? output.slice(1) : output;
}

/** One label for one counter path; exported so tests can pin every style. */
export function formatNodeNumberLabel(format: NodeNumberingFormat, path: readonly number[]): string {
  const last = path[path.length - 1] ?? 1;
  switch (format) {
    case "decimal":
      return `${path.join(".")}${path.length === 1 ? "." : ""} `;
    case "chinese": {
      const depth = path.length;
      if (depth <= 1) return `${toChineseNumeral(last)}、`;
      if (depth === 2) return `（${toChineseNumeral(last)}）`;
      if (depth === 3) return `（${last}）`;
      if (depth === 4) return `${last} `;
      return `${path.join(".")} `;
    }
    case "lowerRoman":
      return `${toRomanNumeral(last).toLowerCase()}. `;
    case "upperRoman":
      return `${toRomanNumeral(last)}. `;
    case "upperAlpha":
      return `${toAlphabeticNumeral(last)}. `;
    case "lowerAlpha":
      return `${toAlphabeticNumeral(last).toLowerCase()}. `;
  }
}

/**
 * Derive every visible label from live tree order.
 *
 * A configuration on a node governs its children. `restart` discards the
 * ancestor path, `continue` appends to it, so a child of an already-numbered
 * node reads "3.1" instead of "1.". Without an ancestor path, `continue`
 * behaves like `restart`, which keeps the action useful at the root.
 */
export function computeNodeNumbering(document: MindTreeDocument): Map<NodeId, string> {
  const labels = new Map<NodeId, string>();
  const visiting = new Set<NodeId>();
  /**
   * `owned` says whether `path` was produced by the active configuration. A
   * fresh configuration only inherits the ancestor path when it asks to
   * continue; once inside its own subtree every deeper level appends, so
   * `descendants` still reads "1." -> "1.1" -> "1.1.1".
   */
  const walk = (
    nodeId: NodeId,
    path: readonly number[],
    inherited: NodeNumbering | undefined,
    owned: boolean
  ): void => {
    const node = document.nodes[nodeId];
    if (!node || visiting.has(nodeId)) return;
    visiting.add(nodeId);
    const config = node.numbering ?? inherited;
    const continuation = node.numbering
      ? (node.numbering.scope === "descendants" ? node.numbering : undefined)
      : inherited;
    const ownsPath = node.numbering ? false : owned;
    node.childIds.forEach((childId, index) => {
      if (!document.nodes[childId]) return;
      const counter = index + 1;
      const childPath = config
        ? ((ownsPath || (config.start === "continue" && path.length > 0))
          ? [...path, counter]
          : [counter])
        : [];
      if (config) labels.set(childId, formatNodeNumberLabel(config.format, childPath));
      walk(childId, childPath, continuation, config !== undefined);
    });
    visiting.delete(nodeId);
  };
  walk(document.rootId, [], undefined, false);
  return labels;
}

/** Title as shown on the canvas, in exports and in the generated outline. */
export function numberedNodeTitle(
  node: Readonly<MindTreeNode>,
  labels: ReadonlyMap<NodeId, string>
): string {
  const label = labels.get(node.id);
  return label ? `${label}${node.title}` : node.title;
}

export function setNodeNumbering(
  node: MindTreeNode,
  format: NodeNumberingFormat,
  scope: NodeNumberingScope,
  start: NodeNumberingStart
): void {
  node.numbering = { format, scope, start };
}

/**
 * Remove numbering from the branch. `level` drops only this node's own
 * configuration, `all` also clears configurations deeper in the subtree so a
 * nested group cannot keep numbering its own children.
 */
export function clearNodeNumbering(
  document: MindTreeDocument,
  nodeId: NodeId,
  scope: "level" | "all"
): void {
  const visiting = new Set<NodeId>();
  const walk = (id: NodeId): void => {
    const node = document.nodes[id];
    if (!node || visiting.has(id)) return;
    visiting.add(id);
    delete node.numbering;
    if (scope === "all") for (const childId of node.childIds) walk(childId);
    visiting.delete(id);
  };
  walk(nodeId);
}
