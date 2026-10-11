import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnippet,
  findMatches,
  matchesInText,
  matchesSearchQuery,
  matchesSearchText,
  normalizeSearchText,
  queryTokens,
  readSearchFiles,
  SEARCH_HITS_PER_CARD_LIMIT,
  SEARCH_RESULT_LIMIT,
  SEARCH_SNIPPET_AFTER,
  SEARCH_SNIPPET_BEFORE,
  searchMindTree,
  type SearchCandidate,
  type SearchContext,
  type SearchFileReader
} from "../src/ui/search/search-core";

function makeCandidate(overrides: Partial<SearchCandidate> & { nodeId: string }): SearchCandidate {
  const plainTitle = overrides.plainTitle ?? overrides.title ?? overrides.nodeId;
  return { title: plainTitle, plainTitle, ...overrides };
}

function makeContext(
  candidates: readonly SearchCandidate[],
  files: Readonly<Record<string, string>> = {}
): SearchContext {
  return { candidates, fileContents: new Map(Object.entries(files)) };
}

interface FakeReader {
  readonly reader: SearchFileReader<string>;
  readonly reads: string[];
}

function createFakeReader(
  paths: readonly string[],
  contents: Readonly<Record<string, string>>,
  failing: readonly string[] = []
): FakeReader {
  const reads: string[] = [];
  const reader: SearchFileReader<string> = {
    resolve: () => Promise.resolve(paths.map((path) => ({ path, file: path }))),
    read: (file) => {
      reads.push(file);
      if (failing.includes(file)) return Promise.reject(new Error(`cannot read ${file}`));
      const content = contents[file];
      if (content === undefined) return Promise.reject(new Error(`unknown file ${file}`));
      return Promise.resolve(content);
    }
  };
  return { reader, reads };
}

function cardIds(result: { cards: readonly { nodeId: string }[] }): string[] {
  return result.cards.map((card) => card.nodeId);
}

/* ------------------------------------------------------------------ *
 * normalizeSearchText / queryTokens
 * ------------------------------------------------------------------ */

test("normalizeSearchText folds width, case and surrounding whitespace", () => {
  assert.equal(normalizeSearchText("  ＡＢＣ  "), "abc");
  assert.equal(normalizeSearchText("Ａ\u3000ｂ"), "a b");
  assert.equal(normalizeSearchText(""), "");
});

test("queryTokens splits on whitespace and folds every token", () => {
  assert.deepEqual(queryTokens("  Alpha   ＢＥＴＡ "), ["alpha", "beta"]);
  assert.deepEqual(queryTokens("alpha alpha"), ["alpha"]);
});

test("queryTokens returns nothing for blank queries", () => {
  assert.deepEqual(queryTokens(""), []);
  assert.deepEqual(queryTokens("   \u3000 "), []);
});

/* ------------------------------------------------------------------ *
 * matchesInText / matchesSearchText / matchesSearchQuery
 * ------------------------------------------------------------------ */

test("matchesInText returns ranges anchored to the original text", () => {
  assert.deepEqual(matchesInText("foo bar", ["foo", "bar"]), [
    [0, 3],
    [4, 7]
  ]);
  assert.deepEqual(matchesInText("Foo ＢＡＲ", ["foo", "bar"]), [
    [0, 3],
    [4, 7]
  ]);
});

test("matchesInText merges overlapping token ranges and returns nothing without tokens", () => {
  assert.deepEqual(matchesInText("alpha beta", ["alpha", "pha"]), [[0, 5]]);
  assert.deepEqual(matchesInText("alpha", []), []);
  assert.deepEqual(matchesInText("alpha", [""]), []);
});

test("matchesSearchText requires every token to occur literally", () => {
  assert.equal(matchesSearchText("alpha beta", ["alpha", "beta"]), true);
  assert.equal(matchesSearchText("alpha beta", ["alpha", "gamma"]), false);
  assert.equal(matchesSearchText("alpha beta", ["alpha", "ph"]), true);
  assert.equal(matchesSearchText("a.c", ["a.c"]), true);
  assert.equal(matchesSearchText("abc", ["a.c"]), false);
});

test("matchesSearchText treats an empty token list as no match", () => {
  assert.equal(matchesSearchText("alpha", []), false);
  assert.equal(matchesSearchText("alpha", [""]), false);
});

test("matchesSearchQuery answers the should-we-read question", () => {
  assert.equal(matchesSearchQuery("Alpha Beta", "alpha beta"), true);
  assert.equal(matchesSearchQuery("Alpha Beta", "alpha gamma"), false);
  assert.equal(matchesSearchQuery("ＡＬＰＨＡ", "alpha"), true);
  assert.equal(matchesSearchQuery("Alpha", "   "), false);
});

/* ------------------------------------------------------------------ *
 * findMatches
 * ------------------------------------------------------------------ */

test("findMatches is case and width insensitive", () => {
  assert.deepEqual(findMatches("Alpha Beta", "alpha"), [[0, 5]]);
  assert.deepEqual(findMatches("ＡＬＰＨＡ", "alpha"), [[0, 5]]);
  assert.deepEqual(findMatches("alpha", "ＡＬＰＨＡ"), [[0, 5]]);
});

test("findMatches returns non-overlapping ranges based on the original text", () => {
  assert.deepEqual(findMatches("aaaa", "aa"), [
    [0, 2],
    [2, 4]
  ]);
  assert.deepEqual(findMatches("one two one", "one"), [
    [0, 3],
    [8, 11]
  ]);
});

test("findMatches never interprets the query as a regular expression", () => {
  assert.deepEqual(findMatches("a.c and abc", "a.c"), [[0, 3]]);
  assert.deepEqual(findMatches("abc", "a.c"), []);
  assert.deepEqual(findMatches("ab", ".*"), []);
  assert.deepEqual(findMatches("(x)", "("), [[0, 1]]);
});

test("findMatches returns nothing for an empty query or empty text", () => {
  assert.deepEqual(findMatches("abc", ""), []);
  assert.deepEqual(findMatches("", "abc"), []);
});

test("findMatches maps NFKC expansions back to one source code point", () => {
  // U+FB03 LATIN SMALL LIGATURE FFI expands to "ffi" under NFKC.
  assert.deepEqual(findMatches("\uFB03x", "ffi"), [[0, 1]]);
  assert.deepEqual(findMatches("\uFB03x", "f"), [[0, 1]]);
  // U+00BD VULGAR FRACTION ONE HALF expands to "1" + U+2044 FRACTION SLASH + "2".
  assert.deepEqual(findMatches("\u00BD cup", "1\u20442"), [[0, 1]]);
});

test("findMatches keeps combining sequences inside one range", () => {
  const decomposed = "e\u0301e\u0301";
  assert.deepEqual(findMatches(decomposed, "é"), [
    [0, 2],
    [2, 4]
  ]);
});

test("findMatches always returns ascending non-overlapping ranges", () => {
  const ranges = findMatches("\uFB03 \uFF21\uFF22 \uFB03", "f");
  assert.deepEqual(ranges, [
    [0, 1],
    [5, 6]
  ]);
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index]![0] >= ranges[index - 1]![1]);
  }
});

/* ------------------------------------------------------------------ *
 * buildSnippet
 * ------------------------------------------------------------------ */

test("buildSnippet keeps short text intact and rebases ranges", () => {
  const snippet = buildSnippet("hello world", [[6, 11]]);
  assert.equal(snippet.text, "hello world");
  assert.deepEqual(snippet.ranges, [[6, 11]]);
});

test("buildSnippet adds an ellipsis on the truncated leading side only", () => {
  const text = `${"x".repeat(50)}needle`;
  const snippet = buildSnippet(text, [[50, 56]]);
  assert.equal(snippet.text.startsWith("…"), true);
  assert.equal(snippet.text.endsWith("…"), false);
  assert.equal(snippet.text.slice(snippet.ranges[0]![0], snippet.ranges[0]![1]), "needle");
});

test("buildSnippet adds an ellipsis on the truncated trailing side only", () => {
  const text = `needle${"x".repeat(50)}`;
  const snippet = buildSnippet(text, [[0, 6]]);
  assert.equal(snippet.text.startsWith("…"), false);
  assert.equal(snippet.text.endsWith("…"), true);
  assert.equal(snippet.text.slice(snippet.ranges[0]![0], snippet.ranges[0]![1]), "needle");
});

test("buildSnippet marks both truncated ends of a hit inside a long line", () => {
  const text = `${"x".repeat(50)}needle${"y".repeat(50)}`;
  const snippet = buildSnippet(text, [[50, 56]]);
  assert.equal(snippet.text.startsWith("…"), true);
  assert.equal(snippet.text.endsWith("…"), true);
  assert.equal(snippet.text.length, 2 + SEARCH_SNIPPET_BEFORE + 6 + SEARCH_SNIPPET_AFTER);
  assert.equal(snippet.text.slice(snippet.ranges[0]![0], snippet.ranges[0]![1]), "needle");
});

test("buildSnippet keeps every range relative to the returned text", () => {
  const text = `${"a".repeat(20)}first${"b".repeat(60)}second${"c".repeat(60)}`;
  const snippet = buildSnippet(text, matchesInText(text, ["first", "second"]));
  assert.equal(snippet.ranges.length, 2);
  assert.equal(snippet.text.slice(snippet.ranges[0]![0], snippet.ranges[0]![1]), "first");
  assert.equal(snippet.text.slice(snippet.ranges[1]![0], snippet.ranges[1]![1]), "second");
  assert.equal(snippet.text.startsWith("…"), true);
  assert.equal(snippet.text.endsWith("…"), true);
});

test("buildSnippet returns the text unchanged without ranges", () => {
  const snippet = buildSnippet("abcdef", []);
  assert.equal(snippet.text, "abcdef");
  assert.deepEqual(snippet.ranges, []);
});

test("buildSnippet clips out-of-bounds and empty ranges instead of throwing", () => {
  const snippet = buildSnippet("abc", [
    [-5, 2],
    [1, 1],
    [2, 99]
  ]);
  assert.equal(snippet.text, "abc");
  assert.deepEqual(snippet.ranges, [
    [0, 2],
    [2, 3]
  ]);
});

/* ------------------------------------------------------------------ *
 * searchMindTree
 * ------------------------------------------------------------------ */

test("searchMindTree returns an empty result for blank queries", () => {
  const context = makeContext([makeCandidate({ nodeId: "n1", plainTitle: "Alpha" })]);
  assert.deepEqual(searchMindTree(context, ""), { cards: [], hitCount: 0 });
  assert.deepEqual(searchMindTree(context, "   "), { cards: [], hitCount: 0 });
  assert.deepEqual(searchMindTree(context, "\u3000"), { cards: [], hitCount: 0 });
});

test("searchMindTree reports a title hit outside hits", () => {
  const context = makeContext([makeCandidate({ nodeId: "n1", title: "**Alpha**", plainTitle: "Alpha" })]);
  const result = searchMindTree(context, "alpha");
  assert.equal(result.cards.length, 1);
  const card = result.cards[0]!;
  assert.equal(card.nodeId, "n1");
  assert.equal(card.title, "**Alpha**");
  assert.deepEqual(card.titleHit, { source: "title", line: 1, text: "Alpha", ranges: [[0, 5]] });
  assert.deepEqual(card.hits, []);
  assert.equal(result.hitCount, 1);
});

test("searchMindTree reports a file-name hit on line 1", () => {
  const candidate = makeCandidate({
    nodeId: "n1",
    plainTitle: "Document",
    fileName: "Alpha-notes.md",
    path: "notes/Alpha-notes.md"
  });
  const result = searchMindTree(makeContext([candidate], { "notes/Alpha-notes.md": "no keyword" }), "alpha");
  const card = result.cards[0]!;
  assert.equal(card.titleHit, undefined);
  assert.equal(card.fileName, "Alpha-notes.md");
  assert.deepEqual(card.hits, [
    { source: "file", line: 1, text: "Alpha-notes.md", ranges: [[0, 5]] }
  ]);
  assert.equal(result.hitCount, 1);
});

test("searchMindTree falls back to the path basename for file-name hits", () => {
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Document", path: "deep/Alpha.md" });
  const card = searchMindTree(makeContext([candidate]), "alpha").cards[0]!;
  assert.equal(card.fileName, "Alpha.md");
  assert.deepEqual(card.hits, [{ source: "file", line: 1, text: "Alpha.md", ranges: [[0, 5]] }]);
});

test("searchMindTree reports one content hit per line with 1-based line numbers", () => {
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Doc", path: "doc.md" });
  const context = makeContext([candidate], {
    "doc.md": "nothing here\nalpha on line two\nplain again"
  });
  const result = searchMindTree(context, "alpha");
  const card = result.cards[0]!;
  assert.equal(card.titleHit, undefined);
  assert.deepEqual(card.hits, [
    { source: "content", line: 2, text: "alpha on line two", ranges: [[0, 5]] }
  ]);
  assert.equal(result.hitCount, 1);
});

test("searchMindTree records every match on the same line as its own hit", () => {
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Doc", path: "doc.md" });
  const card = searchMindTree(makeContext([candidate], { "doc.md": "alpha alpha" }), "alpha").cards[0]!;
  assert.equal(card.hits.length, 2);
  assert.deepEqual(
    card.hits.map((hit) => hit.line),
    [1, 1]
  );
  assert.deepEqual(card.hits[0]!.ranges, [[0, 5]]);
  assert.deepEqual(card.hits[1]!.ranges, [[6, 11]]);
});

test("searchMindTree strips CRLF so rendered text never carries a carriage return", () => {
  const line = `${"x".repeat(100)}needle`;
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Doc", path: "crlf.md" });
  const card = searchMindTree(makeContext([candidate], { "crlf.md": `${line}\r\n` }), "needle").cards[0]!;
  const hit = card.hits[0]!;
  assert.equal(hit.line, 1);
  assert.equal(hit.text.includes("\r"), false);
  assert.equal(hit.text.slice(hit.ranges[0]![0], hit.ranges[0]![1]), "needle");
});

test("searchMindTree does not repeat a line-1 content segment the title row already shows", () => {
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Alpha", path: "a.md" });
  const context = makeContext([candidate], { "a.md": "Alpha\nother alpha line" });
  const result = searchMindTree(context, "alpha");
  const card = result.cards[0]!;
  assert.deepEqual(card.titleHit, { source: "title", line: 1, text: "Alpha", ranges: [[0, 5]] });
  assert.equal(card.hits.length, 1);
  assert.equal(card.hits[0]!.line, 2);
  assert.equal(result.hitCount, 2);
});

test("searchMindTree keeps content hits that differ from the title hit", () => {
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Alpha", path: "a.md" });
  const context = makeContext([candidate], { "a.md": "An Alpha story\nthe Alpha brand" });
  const card = searchMindTree(context, "alpha").cards[0]!;
  assert.equal(card.hits.length, 2);
  assert.deepEqual(
    card.hits.map((hit) => hit.line),
    [1, 2]
  );
});

test("searchMindTree folds case and width in every source", () => {
  const candidate = makeCandidate({
    nodeId: "n1",
    plainTitle: "ＡＬＰＨＡ",
    fileName: "Ａｌｐｈａ．ｍｄ",
    path: "a.md"
  });
  const context = makeContext([candidate], { "a.md": "full width ＡＬＰＨＡ here" });
  const result = searchMindTree(context, "alpha");
  const card = result.cards[0]!;
  assert.equal(card.titleHit!.text, "ＡＬＰＨＡ");
  assert.deepEqual(card.titleHit!.ranges, [[0, 5]]);
  const fileHit = card.hits[0]!;
  assert.equal(fileHit.source, "file");
  assert.equal(fileHit.text.slice(fileHit.ranges[0]![0], fileHit.ranges[0]![1]), "Ａｌｐｈａ");
  const contentHit = card.hits[1]!;
  assert.equal(contentHit.source, "content");
  assert.equal(contentHit.text.slice(contentHit.ranges[0]![0], contentHit.ranges[0]![1]), "ＡＬＰＨＡ");
});

test("searchMindTree treats regex metacharacters as literals", () => {
  const candidates = [
    makeCandidate({ nodeId: "literal", plainTitle: "a.c" }),
    makeCandidate({ nodeId: "regex-ish", plainTitle: "abc" })
  ];
  const result = searchMindTree(makeContext(candidates), "a.c");
  assert.deepEqual(cardIds(result), ["literal"]);
  assert.equal(result.hitCount, 1);
});

test("searchMindTree tolerates empty files and missing file contents", () => {
  const candidates = [
    makeCandidate({ nodeId: "empty", plainTitle: "Doc", path: "empty.md" }),
    makeCandidate({ nodeId: "unread", plainTitle: "Doc", path: "missing.md" })
  ];
  const result = searchMindTree(makeContext(candidates, { "empty.md": "" }), "alpha");
  assert.deepEqual(result, { cards: [], hitCount: 0 });
});

test("searchMindTree truncates a very long line instead of returning it whole", () => {
  const text = `${"x".repeat(200)}needle${"y".repeat(200)}`;
  const candidate = makeCandidate({ nodeId: "n1", plainTitle: "Doc", path: "long.md" });
  const hit = searchMindTree(makeContext([candidate], { "long.md": text }), "needle").cards[0]!.hits[0]!;
  assert.equal(hit.line, 1);
  assert.equal(hit.text.startsWith("…"), true);
  assert.equal(hit.text.endsWith("…"), true);
  assert.equal(hit.text.length, 2 + SEARCH_SNIPPET_BEFORE + 6 + SEARCH_SNIPPET_AFTER);
  assert.equal(hit.text.slice(hit.ranges[0]![0], hit.ranges[0]![1]), "needle");
});

test("searchMindTree omits a card when no source matches", () => {
  const candidates = [
    makeCandidate({ nodeId: "n1", plainTitle: "Doc", path: "n1.md" }),
    makeCandidate({ nodeId: "n2", plainTitle: "Other", fileName: "other.md", path: "n2.md" })
  ];
  const result = searchMindTree(makeContext(candidates, { "n1.md": "text", "n2.md": "text" }), "alpha");
  assert.deepEqual(result, { cards: [], hitCount: 0 });
});

test("searchMindTree orders title hits, then file hits, then content hits by count", () => {
  const candidates = [
    makeCandidate({ nodeId: "t1", plainTitle: "Beta one", path: "t1.md" }),
    makeCandidate({ nodeId: "t2", plainTitle: "Beta two" }),
    makeCandidate({ nodeId: "t3", plainTitle: "Beta three" }),
    makeCandidate({ nodeId: "f1", plainTitle: "Doc", fileName: "beta.md", path: "f1.md" }),
    makeCandidate({ nodeId: "c1", plainTitle: "Doc", path: "c1.md" }),
    makeCandidate({ nodeId: "c2", plainTitle: "Doc", path: "c2.md" })
  ];
  const context = makeContext(candidates, {
    "t1.md": "beta content",
    "f1.md": "nothing",
    "c1.md": "beta",
    "c2.md": "beta\nbeta"
  });
  const result = searchMindTree(context, "beta");
  assert.deepEqual(cardIds(result), ["t1", "t2", "t3", "f1", "c2", "c1"]);
  assert.equal(result.hitCount, 2 + 1 + 1 + 1 + 2 + 1);
});

test("searchMindTree caps cards at SEARCH_RESULT_LIMIT without truncating hitCount", () => {
  const candidates = Array.from({ length: SEARCH_RESULT_LIMIT + 1 }, (_, index) =>
    makeCandidate({ nodeId: `n${index}`, plainTitle: `Item ${index}` })
  );
  const result = searchMindTree(makeContext(candidates), "item");
  assert.equal(result.cards.length, SEARCH_RESULT_LIMIT);
  assert.equal(result.hitCount, SEARCH_RESULT_LIMIT + 1);
  assert.equal(result.cards[0]!.nodeId, "n0");
  assert.equal(result.cards[SEARCH_RESULT_LIMIT - 1]!.nodeId, `n${SEARCH_RESULT_LIMIT - 1}`);
});

test("searchMindTree caps hits per card while keeping hitCount truthful", () => {
  const lines = Array.from(
    { length: SEARCH_HITS_PER_CARD_LIMIT + 10 },
    (_, index) => `alpha line ${index}`
  );
  const candidate = makeCandidate({ nodeId: "big", plainTitle: "Doc", path: "big.md" });
  const result = searchMindTree(makeContext([candidate], { "big.md": lines.join("\n") }), "alpha");
  const card = result.cards[0]!;
  assert.equal(card.hits.length, SEARCH_HITS_PER_CARD_LIMIT);
  assert.equal(card.hitsLimited, true);
  assert.equal(result.hitCount, SEARCH_HITS_PER_CARD_LIMIT + 10);
  assert.deepEqual(
    card.hits.map((hit) => hit.line),
    Array.from({ length: SEARCH_HITS_PER_CARD_LIMIT }, (_, index) => index + 1)
  );
});

test("searchMindTree keeps a title hit out of the cap but in hitCount", () => {
  const lines = Array.from({ length: SEARCH_HITS_PER_CARD_LIMIT + 10 }, (_, index) => `alpha ${index}`);
  const candidate = makeCandidate({ nodeId: "big", plainTitle: "Alpha doc", path: "big.md" });
  const result = searchMindTree(makeContext([candidate], { "big.md": lines.join("\n") }), "alpha");
  const card = result.cards[0]!;
  assert.notEqual(card.titleHit, undefined);
  assert.equal(card.hits.length, SEARCH_HITS_PER_CARD_LIMIT);
  assert.equal(card.hitsLimited, true);
  assert.equal(result.hitCount, 1 + SEARCH_HITS_PER_CARD_LIMIT + 10);
});

test("searchMindTree counts a file-name hit against the per-card cap", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `alpha line ${index}`);
  const candidate = makeCandidate({
    nodeId: "big",
    plainTitle: "Doc",
    fileName: "alpha.md",
    path: "notes/alpha.md"
  });
  const result = searchMindTree(makeContext([candidate], { "notes/alpha.md": lines.join("\n") }), "alpha");
  const card = result.cards[0]!;
  assert.equal(card.hits.length, SEARCH_HITS_PER_CARD_LIMIT);
  assert.equal(card.hits[0]!.source, "file");
  assert.equal(card.hitsLimited, true);
  assert.equal(result.hitCount, 41);
});

test("searchMindTree omits hitsLimited when the card fits the cap", () => {
  const exactLines = Array.from(
    { length: SEARCH_HITS_PER_CARD_LIMIT },
    (_, index) => `alpha ${index}`
  );
  const exact = searchMindTree(
    makeContext([makeCandidate({ nodeId: "exact", plainTitle: "Doc", path: "exact.md" })], {
      "exact.md": exactLines.join("\n")
    }),
    "alpha"
  );
  assert.equal(exact.cards[0]!.hits.length, SEARCH_HITS_PER_CARD_LIMIT);
  assert.equal("hitsLimited" in exact.cards[0]!, false);

  const fewer = searchMindTree(
    makeContext([makeCandidate({ nodeId: "fewer", plainTitle: "Doc", path: "fewer.md" })], {
      "fewer.md": exactLines.slice(0, SEARCH_HITS_PER_CARD_LIMIT - 1).join("\n")
    }),
    "alpha"
  );
  assert.equal(fewer.cards[0]!.hits.length, SEARCH_HITS_PER_CARD_LIMIT - 1);
  assert.equal("hitsLimited" in fewer.cards[0]!, false);

  // A file-name hit plus 29 content hits fills the cap exactly.
  const withFile = searchMindTree(
    makeContext(
      [
        makeCandidate({
          nodeId: "with-file",
          plainTitle: "Doc",
          fileName: "alpha.md",
          path: "with-file.md"
        })
      ],
      { "with-file.md": exactLines.slice(0, SEARCH_HITS_PER_CARD_LIMIT - 1).join("\n") }
    ),
    "alpha"
  );
  assert.equal(withFile.cards[0]!.hits.length, SEARCH_HITS_PER_CARD_LIMIT);
  assert.equal("hitsLimited" in withFile.cards[0]!, false);
  assert.equal(withFile.hitCount, SEARCH_HITS_PER_CARD_LIMIT);
});

test("searchMindTree sorts capped cards by their true hit counts", () => {
  const manyLines = (count: number): string =>
    Array.from({ length: count }, (_, index) => `alpha ${index}`).join("\n");
  const candidates = [
    makeCandidate({ nodeId: "big2", plainTitle: "Doc", path: "big2.md" }),
    makeCandidate({ nodeId: "small", plainTitle: "Doc", path: "small.md" }),
    makeCandidate({ nodeId: "big1", plainTitle: "Doc", path: "big1.md" })
  ];
  const context = makeContext(candidates, {
    "big2.md": manyLines(40),
    "small.md": "alpha one\nalpha two\nalpha three",
    "big1.md": manyLines(60)
  });
  const result = searchMindTree(context, "alpha");
  // Capping the sort key would tie big2 and big1 at 30 and flip them.
  assert.deepEqual(cardIds(result), ["big1", "big2", "small"]);
  assert.equal(result.hitCount, 60 + 40 + 3);
  assert.equal(result.cards[0]!.hitsLimited, true);
  assert.equal(result.cards[1]!.hitsLimited, true);
  assert.equal("hitsLimited" in result.cards[2]!, false);
});

test("searchMindTree keeps resource metadata and repeats the same result", () => {
  const candidate = makeCandidate({
    nodeId: "n1",
    title: "Alpha",
    plainTitle: "Alpha",
    resourceId: "ab12C",
    path: "notes/a.md",
    fileName: "a.md"
  });
  const context = makeContext([candidate], { "notes/a.md": "alpha body" });
  const first = searchMindTree(context, "alpha");
  const second = searchMindTree(context, "alpha");
  assert.deepEqual(first, second);
  assert.equal(first.cards[0]!.resourceId, "ab12C");
  assert.equal(first.cards[0]!.path, "notes/a.md");
  assert.equal(first.cards[0]!.fileName, "a.md");
});

/* ------------------------------------------------------------------ *
 * readSearchFiles
 * ------------------------------------------------------------------ */

test("readSearchFiles reads each distinct path once", async () => {
  const { reader, reads } = createFakeReader(["a.md", "b.md", "a.md"], {
    "a.md": "one",
    "b.md": "two"
  });
  const result = await readSearchFiles(reader, () => true);
  assert.deepEqual([...result.contents.keys()], ["a.md", "b.md"]);
  assert.deepEqual(reads, ["a.md", "b.md"]);
  assert.equal(result.skipped, 0);
});

test("readSearchFiles preserves resolve order in the returned map", async () => {
  const { reader } = createFakeReader(["c.md", "a.md", "b.md"], {
    "a.md": "a",
    "b.md": "b",
    "c.md": "c"
  });
  const result = await readSearchFiles(reader, () => true);
  assert.deepEqual([...result.contents.keys()], ["c.md", "a.md", "b.md"]);
  assert.equal(result.contents.get("b.md"), "b");
});

test("readSearchFiles stops after maxFiles and counts the rest as skipped", async () => {
  const { reader, reads } = createFakeReader(["a.md", "b.md", "c.md"], {
    "a.md": "1",
    "b.md": "2",
    "c.md": "3"
  });
  const result = await readSearchFiles(reader, () => true, { maxFiles: 2 });
  assert.deepEqual([...result.contents.keys()], ["a.md", "b.md"]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(reads, ["a.md", "b.md"]);
});

test("readSearchFiles with maxFiles 0 reads nothing and skips every match", async () => {
  const { reader, reads } = createFakeReader(["a.md", "b.md"], { "a.md": "1", "b.md": "2" });
  const result = await readSearchFiles(reader, () => true, { maxFiles: 0 });
  assert.equal(result.contents.size, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(reads, []);
});

test("readSearchFiles counts only matcher-accepted files against the budget", async () => {
  const { reader, reads } = createFakeReader(["a.md", "b.md", "c.md"], {
    "a.md": "1",
    "b.md": "2",
    "c.md": "3"
  });
  const result = await readSearchFiles(reader, (candidate) => candidate.path !== "a.md", {
    maxFiles: 1
  });
  assert.deepEqual([...result.contents.keys()], ["b.md"]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(reads, ["b.md"]);
});

test("readSearchFiles ignores matcher-rejected candidates without counting them", async () => {
  const { reader, reads } = createFakeReader(["a.md", "b.md"], { "a.md": "1", "b.md": "2" });
  const result = await readSearchFiles(reader, (candidate) => candidate.path === "a.md");
  assert.deepEqual([...result.contents.keys()], ["a.md"]);
  assert.equal(result.skipped, 0);
  assert.deepEqual(reads, ["a.md"]);
});

test("readSearchFiles skips files above maxCharactersPerFile without truncating them", async () => {
  const { reader } = createFakeReader(["small.md", "big.md"], {
    "small.md": "abcde",
    "big.md": "abcdef"
  });
  const result = await readSearchFiles(reader, () => true, { maxCharactersPerFile: 5 });
  assert.deepEqual([...result.contents.keys()], ["small.md"]);
  assert.equal(result.contents.get("small.md"), "abcde");
  assert.equal(result.skipped, 1);
});

test("readSearchFiles applies the documented default budgets", async () => {
  const paths = Array.from({ length: 401 }, (_, index) => `f${index}.md`);
  const many: Record<string, string> = {};
  for (const path of paths) many[path] = "x";
  const limited = await readSearchFiles(createFakeReader(paths, many).reader, () => true);
  assert.equal(limited.contents.size, 400);
  assert.equal(limited.skipped, 1);

  const exact = "a".repeat(512 * 1024);
  const tooBig = "a".repeat(512 * 1024 + 1);
  const sized = await readSearchFiles(
    createFakeReader(["exact.md", "too-big.md"], { "exact.md": exact, "too-big.md": tooBig }).reader,
    () => true
  );
  assert.deepEqual([...sized.contents.keys()], ["exact.md"]);
  assert.equal(sized.skipped, 1);
});

test("readSearchFiles keeps going when one file fails to read", async () => {
  const { reader, reads } = createFakeReader(
    ["a.md", "boom.md", "c.md"],
    { "a.md": "one", "c.md": "three" },
    ["boom.md"]
  );
  const result = await readSearchFiles(reader, () => true);
  assert.deepEqual([...result.contents.keys()], ["a.md", "c.md"]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(reads, ["a.md", "boom.md", "c.md"]);
});

test("readSearchFiles counts failed and oversized reads against the budget", async () => {
  const { reader, reads } = createFakeReader(
    ["boom.md", "b.md"],
    { "boom.md": "x", "b.md": "y" },
    ["boom.md"]
  );
  const result = await readSearchFiles(reader, () => true, { maxFiles: 1 });
  assert.equal(result.contents.size, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(reads, ["boom.md"]);
});

test("readSearchFiles falls back to defaults for invalid budgets", async () => {
  const { reader } = createFakeReader(["a.md"], { "a.md": "one" });
  const result = await readSearchFiles(reader, () => true, {
    maxFiles: Number.NaN,
    maxCharactersPerFile: -1
  });
  assert.deepEqual([...result.contents.keys()], ["a.md"]);
  assert.equal(result.skipped, 0);
});

test("readSearchFiles feeds searchMindTree with content hits", async () => {
  const files: Readonly<Record<string, string>> = {
    "notes/a.md": "first\nalpha here",
    "notes/b.md": "beta only"
  };
  const { reader } = createFakeReader(["notes/a.md", "notes/b.md"], files);
  const candidates = [
    makeCandidate({ nodeId: "n1", plainTitle: "Doc", path: "notes/a.md", fileName: "a.md" }),
    makeCandidate({ nodeId: "n2", plainTitle: "Doc", path: "notes/b.md", fileName: "b.md" })
  ];
  const tokens = queryTokens("alpha");
  const { contents } = await readSearchFiles(reader, (candidate) =>
    matchesSearchText(files[candidate.path] ?? "", tokens)
  );
  const result = searchMindTree({ candidates, fileContents: contents }, "alpha");
  assert.deepEqual(cardIds(result), ["n1"]);
  assert.equal(result.cards[0]!.hits[0]!.line, 2);
});
