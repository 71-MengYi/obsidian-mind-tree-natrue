export interface TextLinkSpan {
  start: number;
  end: number;
  /** Opaque spans protect malformed link syntax from partial URL extraction. */
  syntax: "wiki" | "markdown" | "url" | "opaque";
  target: string;
  label?: string;
}

/** Keep percent-encoded path/query separators intact; never decode an HTTP URL. */
export function normalizeSafeHttpUrl(value: string): string | undefined {
  if (!value || /\s/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shared lexical scan for Wiki, Markdown-file and web-link import. Explicit
 * links own their full range: a URL in an alias, destination or query is never
 * counted as a second resource. File/protocol validation belongs to the caller.
 */
export function scanTextLinkSpans(title: string): TextLinkSpan[] {
  const spans = collectLinkSpans(title);
  const result = spans.map((span) => span.syntax === "url"
    ? { ...span, ...includeUrlWrapper(title, span.start, span.end) }
    : span);
  const scheme = /https?:\/\//gi;
  let spanIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = scheme.exec(title))) {
    const start = match.index;
    while (spans[spanIndex] && spans[spanIndex]!.end <= start) spanIndex += 1;
    const enclosing = spans[spanIndex];
    if (enclosing && start >= enclosing.start) {
      scheme.lastIndex = enclosing.end;
      continue;
    }
    // Do not turn part of a filename or a longer ASCII word into a web link.
    if (start > 0 && /[a-z0-9_/@]/i.test(title[start - 1]!)) continue;
    const end = bareUrlEnd(title, start);
    scheme.lastIndex = Math.max(end, scheme.lastIndex);
    const target = title.slice(start, end);
    const url = normalizeSafeHttpUrl(target);
    if (!url) continue;
    const wrapped = includeUrlWrapper(title, start, end);
    result.push({ ...wrapped, syntax: "url", target });
  }
  // A bare URL may contain bracket-like path/query data. Its earlier, enclosing
  // range owns those bytes; never also associate a Wiki-looking query substring.
  result.sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: TextLinkSpan[] = [];
  for (const span of result) {
    if (!nonOverlapping.length || span.start >= nonOverlapping.at(-1)!.end) nonOverlapping.push(span);
  }
  return nonOverlapping;
}

/**
 * Scan bracket pairs iteratively instead of a nested-link regular expression.
 * Advancing past a complete destination also bounds work for long pasted lines.
 */
function collectLinkSpans(text: string): TextLinkSpan[] {
  const starts: number[] = [];
  const found: TextLinkSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "<" && /^https?:\/\//i.test(text.slice(index + 1, index + 9))) {
      let end = index + 1;
      while (end < text.length && !/[\s<>]/.test(text[end]!)) end += 1;
      if (text[end] === ">") {
        // Angle autolinks have an explicit end, so trailing path punctuation
        // belongs to the URL rather than to the surrounding prose.
        found.push({ start: index, end: end + 1, syntax: "url", target: text.slice(index + 1, end) });
        index = end;
        continue;
      }
      found.push({ start: index, end, syntax: "opaque", target: "" });
      index = end - 1;
      continue;
    }
    if (char === "[") { starts.push(index); continue; }
    if (char !== "]") continue;
    const start = starts.pop();
    if (start === undefined) continue;
    const outerStart = starts.at(-1);
    if (outerStart === start - 1 && text[index + 1] === "]") {
      starts.pop();
      found.push({
        start: imagePrefixStart(text, outerStart), end: index + 2, syntax: "wiki",
        ...readWikiDestination(text.slice(start + 1, index))
      });
      index += 1;
      continue;
    }
    if (text[index + 1] !== "(") continue;
    const destination = readMarkdownDestination(text, index + 2);
    if (!destination) {
      // An unfinished destination must stay verbatim, rather than associating a
      // URL from inside the broken syntax and dropping part of the user's text.
      const end = malformedDestinationEnd(text, index + 2);
      found.push({ start: imagePrefixStart(text, start), end, syntax: "opaque", target: "" });
      index = end - 1;
      continue;
    }
    found.push({
      start: imagePrefixStart(text, start),
      end: destination.end,
      syntax: "markdown",
      target: destination.target,
      label: unescapeMarkdown(text.slice(start + 1, index))
    });
    index = destination.end - 1;
  }
  // An unfinished Wiki link also owns its remaining text. This is iterative and
  // bounded even for pasted input with thousands of unmatched bracket pairs.
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] === starts[index - 1]! + 1) {
      found.push({ start: imagePrefixStart(text, starts[index - 1]!), end: text.length, syntax: "opaque", target: "" });
      break;
    }
  }
  // Nested labels may have produced inner spans first. Only their outermost
  // link owns that source range, so one rendered link contributes at most once.
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const spans: TextLinkSpan[] = [];
  for (const span of found) {
    if (!spans.length || span.start >= spans.at(-1)!.end) spans.push(span);
  }
  return spans;
}

/** Split the first unescaped pipe; escaped pipes/brackets remain literal text. */
function readWikiDestination(body: string): { target: string; label?: string } {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") { index += 1; continue; }
    if (body[index] === "|") {
      return {
        target: unescapeMarkdown(body.slice(0, index)).trim(),
        label: unescapeMarkdown(body.slice(index + 1)).trim()
      };
    }
  }
  return { target: unescapeMarkdown(body).trim() };
}

function imagePrefixStart(text: string, start: number): number {
  return text[start - 1] === "!" && text[start - 2] !== "\\" ? start - 1 : start;
}

/**
 * Keep an invalid, but closed, destination opaque without swallowing later
 * independent links. Unterminated parentheses/quotes own the rest of the line.
 */
function malformedDestinationEnd(text: string, from: number): number {
  let depth = 1;
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") { index += 1; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if ((char === "'" || char === '"') && /\s/.test(text[index - 1] ?? "")) { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  return text.length;
}

/** Read balanced URL parentheses and optional quoted Markdown titles. */
function readMarkdownDestination(text: string, from: number): { target: string; end: number } | undefined {
  let cursor = from;
  while (/[ \t]/.test(text[cursor] ?? "")) cursor += 1;
  const angled = text[cursor] === "<";
  if (angled) cursor += 1;
  const start = cursor;
  let depth = 0;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === "\\" && cursor + 1 < text.length) { cursor += 2; continue; }
    if (char === "\r" || char === "\n") return undefined;
    if (angled ? char === ">" : /\s/.test(char) || (char === ")" && depth === 0)) break;
    if (!angled && char === "(") depth += 1;
    else if (!angled && char === ")") depth -= 1;
    cursor += 1;
  }
  const target = unescapeMarkdown(text.slice(start, cursor));
  if (angled) {
    if (text[cursor] !== ">") return undefined;
    cursor += 1;
  }
  const separated = /[ \t]/.test(text[cursor] ?? "");
  while (/[ \t]/.test(text[cursor] ?? "")) cursor += 1;
  const quote = text[cursor];
  if (separated && (quote === '"' || quote === "'")) {
    cursor += 1;
    while (cursor < text.length && text[cursor] !== quote) {
      if (text[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    if (text[cursor] !== quote) return undefined;
    cursor += 1;
    while (/[ \t]/.test(text[cursor] ?? "")) cursor += 1;
  }
  return text[cursor] === ")" ? { target, end: cursor + 1 } : undefined;
}

/**
 * Bare prose URLs stop at whitespace/typographic punctuation. Balanced ASCII
 * parentheses and IPv6 brackets belong to the URL; unmatched closers do not.
 * Explicit Markdown destinations are not punctuation-trimmed, and query/fragment
 * suffixes are kept verbatim so values such as ?q=why? are never truncated.
 */
function bareUrlEnd(text: string, start: number): number {
  let end = start;
  let hasPayload = false;
  const stack: string[] = [];
  while (end < text.length) {
    const char = text[end]!;
    if (/[\s<>"`，。；：！？、（）【】《》“”‘’]/u.test(char)) break;
    if (!hasPayload && /[,;]/.test(char) && /^https?:\/\//i.test(text.slice(end + 1, end + 9))) break;
    if (char === "?" || char === "#") hasPayload = true;
    if (char === "(" || char === "[") stack.push(char);
    if (char === ")" || char === "]") {
      if (stack.at(-1) !== (char === ")" ? "(" : "[")) break;
      stack.pop();
    }
    end += 1;
  }
  // Quoted URLs may contain apostrophes internally, but the closing quote is
  // presentation syntax when it matches the character immediately before them.
  if (text[start - 1] === "'" && text[end - 1] === "'") end -= 1;
  // A whole-line URL is already explicit, like an angle autolink. Preserve its
  // legitimate trailing punctuation and its original title instead of leaving
  // a lone "!" or "." as the supposedly descriptive text.
  if (!hasPayload && (start > 0 || end < text.length)) {
    while (end > start && /[.,;:!]/.test(text[end - 1]!)) end -= 1;
  }
  return end;
}

/** Remove only paired wrappers whose entire contents are the chosen URL. */
function includeUrlWrapper(text: string, start: number, end: number): { start: number; end: number } {
  const pairs: Record<string, string> = { "(": ")", "（": "）", "<": ">", "[": "]", "【": "】", "\"": "\"", "'": "'", "“": "”", "‘": "’" };
  while (start > 0 && end < text.length) {
    let left = start - 1;
    let right = end;
    while (left >= 0 && /[ \t]/.test(text[left]!)) left -= 1;
    while (right < text.length && /[ \t]/.test(text[right]!)) right += 1;
    if (left < 0 || !pairs[text[left]!] || pairs[text[left]!] !== text[right]) break;
    start = left;
    end = right + 1;
  }
  return { start, end };
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\\[\]()*_`|<>])/g, "$1");
}
