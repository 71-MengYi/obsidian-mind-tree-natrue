import test from "node:test";
import assert from "node:assert/strict";
import { parseTextLine } from "../src/services/text-links";

test("Wiki aliases, file titles, subpaths and escaped syntax produce pending file links", () => {
  for (const [source, title, linkPath] of [
    ["[[notes/Plan#Scope|Plan alias]]", "Plan alias", "notes/Plan#Scope"],
    ["[[notes/Plan#^block]]", "Plan", "notes/Plan#^block"],
    ["Read [[notes/Plan|Plan alias]] later", "Read Plan alias later", "notes/Plan"],
    ["![[images/diagram.png]]", "diagram", "images/diagram.png"],
    ["[[graphs/数学.mtn.md]]", "数学", "graphs/数学.mtn.md"],
    ["[[files/archive@Ab123.zip]]", "archive", "files/archive@Ab123.zip"],
    ["[[files/old~mtn-0123456789.pdf]]", "old", "files/old~mtn-0123456789.pdf"],
    ["[[目录/中文笔记|学习材料]]", "学习材料", "目录/中文笔记"],
    ["[[A\\|B|Alias \\[one\\]]]", "Alias [one]", "A|B"],
    ["[[notes/A|https://example.com]]", "https://example.com", "notes/A"],
    ["[[notes/My%20Note.md]]", "My Note", "notes/My%20Note.md"]
  ]) {
    assert.deepEqual(parseTextLine(source!), [{
      title, linkTarget: { type: "file", linkPath, fallbackTitle: source }
    }], source!);
  }
});

test("Markdown file and image links share balanced destination and alias handling", () => {
  for (const [source, title, linkPath] of [
    ["[Manual](assets/manual.pdf)", "Manual", "assets/manual.pdf"],
    ["![Image](images/picture.png)", "Image", "images/picture.png"],
    ["[Note](../notes/My%20Note.md#Heading)", "Note", "../notes/My%20Note.md#Heading"],
    ['[Name](<notes/Name (A).md> "Title )")', "Name", "notes/Name (A).md"],
    ["[Name](notes/Name_(A).md)", "Name", "notes/Name_(A).md"],
    ["[A \\[B\\]](notes/My\\(Note\\).md 'Title')", "A [B]", "notes/My(Note).md"],
    ["[https://example.com](notes/Local.md)", "https://example.com", "notes/Local.md"],
    ["[](assets/manual.pdf)", "manual", "assets/manual.pdf"],
    ["See [Manual](assets/manual.pdf) later", "See Manual later", "assets/manual.pdf"]
  ]) {
    assert.deepEqual(parseTextLine(source!), [{
      title, linkTarget: { type: "file", linkPath, fallbackTitle: source }
    }], source!);
  }
});

test("single web links keep existing prose, wrapper, query and empty-label behavior", () => {
  for (const [source, title, url] of [
    ["前文 https://example.com 后文", "前文  后文", "https://example.com/"],
    ["参考（<https://example.com>）", "参考", "https://example.com/"],
    ["Read [Site](https://example.com/wiki/A_(B)) later", "Read Site later", "https://example.com/wiki/A_(B)"],
    ["Read [](https://example.com)", "Read", "https://example.com/"],
    ["https://example.com/path!", "https://example.com/path!", "https://example.com/path!"],
    ["资料：https://example.com/docs。", "资料：。", "https://example.com/docs"],
    ["Title https://example.com/?next=https://other.example.com", "Title", "https://example.com/?next=https://other.example.com"],
    ["[Site](https://example.com/a%2Fb?x=a%26b#part%23one)", "Site", "https://example.com/a%2Fb?x=a%26b#part%23one"]
  ]) {
    assert.deepEqual(parseTextLine(source!), [{ title, linkTarget: { type: "url", url } }], source!);
  }
});

test("mixed links split into source-ordered siblings preceded by meaningful outside prose", () => {
  assert.deepEqual(parseTextLine("参考资料 [[A|笔记A]] [官网](https://example.com)"), [
    { title: "参考资料" },
    { title: "笔记A", linkTarget: { type: "file", linkPath: "A", fallbackTitle: "[[A|笔记A]]" } },
    { title: "官网", linkTarget: { type: "url", url: "https://example.com/" } }
  ]);
  assert.deepEqual(parseTextLine("前文 [[A]] 中间 [B](B.md) 后文").map((node) => node.title),
    ["前文 中间 后文", "A", "B"]);
  for (const source of [
    "[[A]]、[B](B.md)", "[[A]] | [B](B.md)", "[[A]]， [B](B.md)",
    "[[A]][B](B.md)"
  ]) assert.deepEqual(parseTextLine(source).map((node) => node.title), ["A", "B"], source);
});

test("all web occurrences split without double-counting destinations, aliases or nested query URLs", () => {
  for (const source of [
    "https://one.example https://two.example",
    "https://one.example,https://two.example",
    "https://one.example;https://two.example",
    "https://one.example，https://two.example",
    "<https://one.example>（https://two.example）",
    "[https://one.example](https://one.example) [Two](https://two.example)"
  ]) {
    const nodes = parseTextLine(source);
    assert.equal(nodes.length, 2, source);
    assert.deepEqual(nodes.map((node) => node.linkTarget), [
      { type: "url", url: "https://one.example/" }, { type: "url", url: "https://two.example/" }
    ]);
  }
  const mixed = parseTextLine("[[A|https://one.example]] [Site](https://two.example/?next=https://other.example)");
  assert.deepEqual(mixed.map((node) => node.linkTarget?.type), ["file", "url"]);
  assert.equal(parseTextLine("[[A]] [[A]]").length, 2);
  assert.equal(parseTextLine("https://same.example https://same.example").length, 2);
});

test("unsupported protocols, malformed syntax and escaped links stay literal", () => {
  for (const source of [
    "Plain text", "[Unsafe](javascript:alert(1))", "[Local](file:///C:/note.md)",
    "[FTP](ftp://example.com)", "[Obsidian](obsidian://open?vault=test)",
    "[Network](//server/share/file.pdf)", "[Encoded](javascript%3Aalert(1))",
    "[[https://example.com]]", "[[ ]]",
    "[Broken](https://example.com", "[[broken|https://example.com",
    "<https://example.com", "[Broken](path with spaces.md)",
    "[Empty]()",
    "http://[invalid]", "https://", "prefixhttps://example.com",
    "\\[[escaped]]", "\\[Site](notes/Local.md)", "Keep \\[escaped\\] **text**"
  ]) assert.deepEqual(parseTextLine(source), [{ title: source }], source);
  assert.deepEqual(parseTextLine("[Bad](ftp://example.com) [[A]] https://example.com").map((node) => node.title),
    ["[Bad](ftp://example.com)", "A", "https://example.com"]);
});

test("closed malformed syntax does not hide subsequent valid links", () => {
  const nodes = parseTextLine("[Bad](path with spaces.md) [[Good]] https://example.com");
  assert.deepEqual(nodes.map((node) => node.title), [
    "[Bad](path with spaces.md)", "Good", "https://example.com"
  ]);
  assert.deepEqual(nodes.map((node) => node.linkTarget?.type), [undefined, "file", "url"]);
});
