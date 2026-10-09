import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import type { MindTreeNode } from "../types";
import { buildLinkedResourcePath } from "./resource-id";

export interface InlineStyle { readonly bold?: boolean; readonly italic?: boolean; readonly strike?: boolean; readonly highlight?: boolean }
export interface TitleRun extends InlineStyle { readonly kind: "text" | "code" | "math"; readonly text: string }
export interface SourceRange { readonly start: number; readonly end: number }
export interface NodeTitleContent {
  readonly source: string;
  readonly runs: readonly TitleRun[];
  readonly plainText: string;
  readonly formatted: boolean;
  readonly hasCodeOrMath: boolean;
  readonly protectedRanges: readonly SourceRange[];
  readonly markdown: string;
}
export type TitleCommitResult = "committed" | "rejected";
export type TitleError = "title.formattedSync" | "title.codeOrMath" | "title.invalidFileName";

const parser = new MarkdownIt("zero", { html: false }).enable(["escape", "backticks", "emphasis", "strikethrough"]);
parser.use(mark);
// Capture the parser's actual code ranges, including variable-length delimiters.
const backtick = parser.inline.ruler.getRules("").find((rule) => /backtick/i.test(rule.name))!;
parser.inline.ruler.at("backticks", (state, silent) => {
  const start = state.pos;
  const count = state.tokens.length;
  const accepted = backtick(state, silent);
  if (!silent && state.tokens.length > count && state.tokens.at(-1)?.type === "code_inline") {
    (state.env as { ranges: SourceRange[] }).ranges.push({ start, end: state.pos });
  }
  return accepted;
});
parser.inline.ruler.before("escape", "inline_math", (state, silent) => {
  const start = state.pos;
  const source = state.src;
  if (source[start] !== "$" || source[start + 1] === "$" || source[start - 1] === "$"
    || !source[start + 1] || /\s/.test(source[start + 1]!)) return false;
  let end = start + 1;
  while (end < state.posMax) {
    if (source[end] === "\\") { end += 2; continue; }
    if (source[end] === "$") break;
    end++;
  }
  if (end >= state.posMax || source[end + 1] === "$" || /\s/.test(source[end - 1]!)
    || /\d/.test(source[end + 1] ?? "")) return false;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = source.slice(start + 1, end);
    (state.env as { ranges: SourceRange[] }).ranges.push({ start, end: end + 1 });
  }
  state.pos = end + 1;
  return true;
});
const cache = new Map<string, NodeTitleContent>();

export function escapeTitleMarkdown(value: string): string {
  return value.replace(/([\\[\]()*_`$~=<>!])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

export function parseNodeTitle(source: string): NodeTitleContent {
  const cached = cache.get(source);
  if (cached) return cached;
  const env = { ranges: [] as SourceRange[] };
  const tokens = parser.parseInline(source, env)[0]?.children ?? [];
  const runs: TitleRun[] = [];
  const active: Record<string, number> = {};
  let formatted = false;
  let markdown = "";
  for (const token of tokens) {
    const style = { bold: Boolean(active.strong), italic: Boolean(active.em), strike: Boolean(active.s), highlight: Boolean(active.mark) };
    if (token.nesting) {
      active[token.tag] = Math.max(0, (active[token.tag] ?? 0) + token.nesting);
      formatted = true;
      markdown += token.tag === "strong" ? "**" : token.tag === "em" ? "*" : token.tag === "s" ? "~~" : "==";
    } else if (token.type === "code_inline") {
      runs.push({ ...style, kind: "code", text: token.content });
      formatted = true;
      const length = Math.max(0, ...(token.content.match(/`+/g) ?? []).map((v) => v.length)) + 1;
      const fence = "`".repeat(length);
      const padding = /^`|`$|^ .* $/.test(token.content) ? " " : "";
      markdown += fence + padding + token.content + padding + fence;
    } else if (token.type === "math_inline") {
      runs.push({ ...style, kind: "math", text: token.content });
      formatted = true;
      markdown += `$${token.content}$`;
    } else {
      const text = token.type === "softbreak" ? " " : token.content;
      if (text) runs.push({ ...style, kind: "text", text });
      markdown += escapeTitleMarkdown(text);
    }
  }
  const result: NodeTitleContent = {
    source, runs, formatted, markdown,
    plainText: runs.map((run) => run.text).join(""),
    hasCodeOrMath: runs.some((run) => run.kind !== "text"), protectedRanges: env.ranges
  };
  if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
  cache.set(source, result);
  return result;
}

/** Synced filenames are literal, even when an existing name resembles Markdown. */
export function nodeTitleMode(node: Pick<MindTreeNode, "resource" | "titleSync">, depth: number): "title" | "literal" {
  return depth !== 0 && node.resource?.type === "file" && node.titleSync === "bidirectional" ? "literal" : "title";
}

export function validateNodeTitle(value: string, node: MindTreeNode, isRoot: boolean): TitleError | undefined {
  if (value === node.title) return undefined;
  const content = parseNodeTitle(value);
  const syncing = node.resource?.type === "file" && node.titleSync === "bidirectional";
  if (isRoot && content.hasCodeOrMath) return "title.codeOrMath";
  if (!isRoot && syncing && content.formatted) return "title.formattedSync";
  if (isRoot || syncing) {
    try { buildLinkedResourcePath("title.md", isRoot ? content.plainText : value, node.id); }
    catch { return "title.invalidFileName"; }
  }
  return undefined;
}

export function fileTitleFromNode(value: string): string | undefined {
  const content = parseNodeTitle(value);
  return content.hasCodeOrMath ? undefined : content.plainText;
}
