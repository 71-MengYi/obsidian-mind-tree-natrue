import { isMap, parseDocument, stringify as stringifyYaml } from "yaml";

/**
 * Header properties the plugin owns. `undefined` means "remove the property";
 * every other value is written. Properties that are not named here are never
 * touched, so comments, blank lines, key order and user Frontmatter survive a
 * save byte for byte.
 */
export type YamlPropertyPatch = Record<string, string | number | boolean | null | undefined>;

const YAML_OPTIONS = { indent: 2, lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" } as const;
/**
 * Delimiters of a header. The line break after the closing `---` is
 * deliberately left outside the capture so the rebuilt header ends at the dash,
 * exactly like a generated one, and callers can join a body with one rule.
 */
const HEADER_DELIMITERS = /^(---\r?\n)([\s\S]*?)(\r?\n---)(?:\r?\n|$)/;

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Rewrite only the owned properties of a YAML header.
 *
 * The previous implementation re-serialized the whole header, which dropped
 * comments and reformatted properties the plugin does not own. Worse, when the
 * header could not be parsed it rebuilt one from nothing, discarding user data.
 * This function returns `undefined` instead whenever the text cannot be patched
 * safely, and the caller keeps the original bytes.
 */
export function patchYamlHeader(headerText: string, patch: YamlPropertyPatch): string | undefined {
  const delimiters = HEADER_DELIMITERS.exec(headerText);
  if (!delimiters) return undefined;
  const opening = delimiters[1] ?? "---\n";
  const inner = delimiters[2] ?? "";
  const closing = delimiters[3] ?? "\n---";
  const document = parseDocument(inner);
  if (document.errors.length > 0 || !isMap(document.contents)) return undefined;

  const edits: TextEdit[] = [];
  const insertions: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const node = document.get(key, true) as { range?: [number, number, number] } | undefined;
    const range = node?.range;
    if (value === undefined) {
      if (range) edits.push(removalEdit(inner, range));
      continue;
    }
    const pair = propertyPair(key, value);
    // A value that cannot be written on one line is left exactly as it is: a
    // stale or hand-edited property must never be replaced by a truncated one.
    if (!pair) continue;
    if (!range) {
      insertions.push(pair.line);
      continue;
    }
    if (inner.slice(range[0], range[1]) === pair.value) continue;
    edits.push({ start: range[0], end: range[1], text: pair.value });
  }

  const ordered = edits.sort((left, right) => right.start - left.start);
  for (let index = 1; index < ordered.length; index += 1) {
    // Overlapping ranges (flow style with two owned keys on one line) cannot be
    // patched positionally without guessing.
    if (ordered[index]!.end > ordered[index - 1]!.start) return undefined;
  }
  let text = inner;
  for (const edit of ordered) text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
  if (insertions.length === 0) return opening + text + closing;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${opening}${text}${separator}${insertions.join("\n")}${closing}`;
}

/** Remove the property together with its own line, including its line break. */
function removalEdit(inner: string, range: readonly [number, number, number]): TextEdit {
  const lineStart = inner.lastIndexOf("\n", range[0] - 1) + 1;
  const lineBreak = inner.indexOf("\n", range[1]);
  return { start: lineStart, end: lineBreak < 0 ? inner.length : lineBreak + 1, text: "" };
}

/** Split `key: value` into the exact value text so only the value is replaced. */
function propertyPair(key: string, value: string | number | boolean | null): { line: string; value: string } | undefined {
  const line = stringifyYaml({ [key]: value }, YAML_OPTIONS).replace(/\n+$/, "");
  // A multi-line rendering (block scalar, nested collection) cannot replace a
  // node range without shifting every later offset in the header.
  if (line.includes("\n")) return undefined;
  const separator = line.indexOf(":");
  return { line, value: separator < 0 ? line : line.slice(separator + 1).trimStart() };
}
