import { linkedFileTitle } from "../format/resource-id";
import type { ClipboardLinkTarget } from "../types";
import { normalizeSafeHttpUrl, scanTextLinkSpans, type TextLinkSpan } from "./text-url";

/** Pure, vault-independent description of one node produced by a source line. */
export interface ParsedTextNode {
  readonly title: string;
  readonly linkTarget?: ClipboardLinkTarget;
}

interface ResolvedTextLink extends TextLinkSpan {
  readonly linkTarget: ClipboardLinkTarget;
  readonly displayTitle: string;
}

/**
 * Combine all supported link syntaxes without choosing one at the expense of
 * another. One source occurrence becomes one node; repeated links are not
 * deduplicated. The first result also anchors any descendants of this line.
 */
export function parseTextLine(source: string): ParsedTextNode[] {
  const text = source.trim();
  if (!text) return [];
  const links = scanTextLinkSpans(text).flatMap((span): ResolvedTextLink[] => {
    const link = resolveTextLink(span);
    return link ? [link] : [];
  });
  if (links.length === 0) return [{ title: text }];
  if (links.length === 1) {
    const link = links[0]!;
    // Bare/angle URLs disappear from prose; explicit links retain their label
    // or file title. A pure URL still uses its original, non-normalized spelling.
    const replacement = link.linkTarget.type === "url" ? (link.label ?? "") : link.displayTitle;
    const title = (text.slice(0, link.start) + replacement + text.slice(link.end)).trim() || link.displayTitle;
    return [describeNode(link, title, text)];
  }

  const remaining: string[] = [];
  let offset = 0;
  for (const link of links) {
    remaining.push(text.slice(offset, link.start));
    offset = link.end;
  }
  remaining.push(text.slice(offset));
  // Joining with a space avoids merging words that were separated by links.
  // Preserve meaningful prose and unsupported/malformed syntax. Only plain
  // punctuation/whitespace separators between links may disappear.
  const prose = remaining.filter((part) => part.trim()).map((part) => part.trim()).join(" ");
  const nodes: ParsedTextNode[] = /[^\s\p{P}|]/u.test(prose) ? [{ title: prose }] : [];
  for (const link of links) {
    nodes.push(describeNode(link, link.displayTitle, text.slice(link.start, link.end)));
  }
  return nodes;
}

function describeNode(link: ResolvedTextLink, title: string, fallbackTitle: string): ParsedTextNode {
  return {
    title,
    linkTarget: link.linkTarget.type === "file"
      ? { ...link.linkTarget, fallbackTitle }
      : link.linkTarget
  };
}

/** File lookup is deferred; this boundary only rejects non-vault protocols. */
function resolveTextLink(span: TextLinkSpan): ResolvedTextLink | undefined {
  if (span.syntax === "opaque") return undefined;
  if (span.syntax !== "wiki") {
    const url = normalizeSafeHttpUrl(span.target);
    if (url) return {
      ...span, linkTarget: { type: "url", url },
      displayTitle: span.label?.trim() || span.target
    };
    if (span.syntax === "url") return undefined;
  }
  const linkPath = span.target.trim();
  let decoded = linkPath;
  try { decoded = decodeURIComponent(linkPath); } catch { /* Keep literal vault names. */ }
  // Wiki syntax never converts a URL-like filename/alias into a web node. URI
  // schemes, network paths and control characters are not vault-relative files.
  if (!decoded || /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    || /^(?:\/\/|\\\\)/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  const filePath = decoded.split("#", 1)[0]?.trim();
  if (!filePath) return undefined;
  return {
    ...span, linkTarget: { type: "file", linkPath },
    displayTitle: span.label?.trim() || linkedFileTitle(filePath) || filePath
  };
}
