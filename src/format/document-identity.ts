import { parseDocument, isMap, isScalar } from "yaml";
import { parseMindTreeFile, type ParseMindTreeOptions } from "./document";

const HEADER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;

/** Compare-and-set one identity scalar; all other bytes, including gzip, stay intact. */
export function restoreDocumentIdentity(source: string, expected: string | undefined, original: string,
  options: ParseMindTreeOptions = {}): string {
  if (!original || parseMindTreeFile(source, options).document.documentId !== expected) {
    throw new Error("The document identity changed again. Recheck before restoring it.");
  }
  const match = HEADER.exec(source);
  if (!match) throw new Error("Missing YAML header.");
  const header = parseDocument(match[2]!);
  if (header.errors.length || !isMap(header.contents)) throw new Error("Invalid YAML header.");
  const identity = header.get("documentId", true);
  let text = match[2]!;
  if (isScalar(identity) && identity.range) {
    text = text.slice(0, identity.range[0]) + JSON.stringify(original) + text.slice(identity.range[1]);
  } else {
    if (header.has("documentId")) throw new Error("Cannot safely locate the identity property.");
    const newline = match[1]!.endsWith("\r\n") ? "\r\n" : "\n";
    text = `documentId: ${JSON.stringify(original)}${newline}${text}`;
  }
  const result = match[1] + text + match[3] + source.slice(match[0].length);
  // Validate before Vault.process receives the replacement, not only after a
  // write. Unusual YAML nodes must never let a scalar patch corrupt the file.
  if (parseMindTreeFile(result, options).document.documentId !== original) throw new Error("Invalid restored identity.");
  return result;
}
