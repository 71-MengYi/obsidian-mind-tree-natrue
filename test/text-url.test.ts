import test from "node:test";
import assert from "node:assert/strict";
import { parseTextLine } from "../src/services/text-links";

test("a single web URL is removed from prose without changing unrelated text", () => {
  for (const [source, title, target] of [
    ["学习资料 https://example.com", "学习资料", "https://example.com"],
    ["https://example.com 学习资料", "学习资料", "https://example.com"],
    ["前文 https://example.com 后文", "前文  后文", "https://example.com"],
    ["参考（https://example.com/docs）", "参考", "https://example.com/docs"],
    ["参考 ( https://example.com/docs )", "参考", "https://example.com/docs"],
    ["学习 <https://example.com/docs>", "学习", "https://example.com/docs"],
    ["学习 <https://example.com/path.!>", "学习", "https://example.com/path.!"],
    ["资料：https://example.com/docs。", "资料：。", "https://example.com/docs"],
    ["Read https://example.com/docs.", "Read .", "https://example.com/docs"],
    ["Read 'https://example.com/docs'", "Read", "https://example.com/docs"],
    ["Read https://example.com/wiki/Function_(math)", "Read", "https://example.com/wiki/Function_(math)"],
    ["Read (https://example.com/wiki/Function_(math))", "Read", "https://example.com/wiki/Function_(math)"],
    ["IPv6 https://[::1]/path", "IPv6", "https://[::1]/path"],
    ["  \tHTTPS://EXAMPLE.COM/docs  ", "HTTPS://EXAMPLE.COM/docs", "HTTPS://EXAMPLE.COM/docs"],
    ["https://example.com/path!", "https://example.com/path!", "https://example.com/path!"],
    ["https://example.com/path.", "https://example.com/path.", "https://example.com/path."],
    ["(https://example.com)", "https://example.com", "https://example.com"],
    ["（<https://example.com>）", "https://example.com", "https://example.com"],
    ["https://例子.测试/学习", "https://例子.测试/学习", "https://例子.测试/学习"]
  ]) {
    assert.deepEqual(parseTextLine(source!), [{ title, linkTarget: { type: "url", url: new URL(target!).toString() } }], source!);
  }
});

test("Markdown HTTP links retain labels and count their destination only once", () => {
  for (const [source, title, target] of [
    ["[Site](https://example.com)", "Site", "https://example.com"],
    ["Read [Site](https://example.com) later", "Read Site later", "https://example.com"],
    ["[https://example.com](https://example.com)", "https://example.com", "https://example.com"],
    ["[Nested [label]](https://example.com)", "Nested [label]", "https://example.com"],
    ["[A \\[B\\]](https://example.com)", "A [B]", "https://example.com"],
    ["[Site](https://example.com/wiki/A_(B))", "Site", "https://example.com/wiki/A_(B)"],
    ["[Site](<https://example.com/wiki/A_(B)> \"hover ) title\")", "Site", "https://example.com/wiki/A_(B)"],
    ["[Site](https://example.com/a\\(b\\) 'hover')", "Site", "https://example.com/a(b)"],
    ["![Image](https://example.com/image.png)", "Image", "https://example.com/image.png"],
    ["[](https://example.com)", "https://example.com", "https://example.com"],
    ["[](<https://example.com>)", "https://example.com", "https://example.com"]
  ]) {
    assert.deepEqual(parseTextLine(source!), [{ title, linkTarget: { type: "url", url: new URL(target!).toString() } }], source!);
  }
});

test("URL paths, query separators, fragments and query punctuation are never percent-decoded", () => {
  const urls = [
    "https://example.com/a%2Fb?x=a%26b&next=%2Fpath#section%23one",
    "https://example.com/search?q=why?",
    "https://example.com/search?q=hello!",
    "https://example.com/?next=https://other.example.com/path",
    "https://example.com/search?q=[[Local]]",
    "https://example.com/search?q=[Label](Local.md)",
    "https://example.com/docs#part:one"
  ];
  for (const url of urls) {
    for (const text of [`Title ${url}`, `[Title](${url})`]) {
      assert.deepEqual(parseTextLine(text), [{ title: "Title", linkTarget: { type: "url", url } }], text);
    }
  }
});

test("URL-looking syntax inside an outer link is never an independent resource", () => {
  const source = "https://example.com/search?q=[[Local]] [Other](https://other.example)";
  assert.deepEqual(parseTextLine(source).map((node) => node.linkTarget), [
    { type: "url", url: "https://example.com/search?q=[[Local]]" },
    { type: "url", url: "https://other.example/" }
  ]);
});

test("two or more URL occurrences create one sibling per occurrence and preserve prose", () => {
  for (const title of [
    "Read https://one.example and https://two.example",
    "https://same.example https://same.example",
    "[One](https://one.example) [Two](https://two.example)",
    "[One](https://one.example) https://one.example",
    "https://one.example [Two](https://two.example)",
    "<https://one.example>（https://two.example）",
    "https://one.example,https://two.example",
    "https://one.example;https://two.example",
    "https://one.example，https://two.example"
  ]) {
    const nodes = parseTextLine(title);
    assert.equal(nodes.filter((node) => node.linkTarget?.type === "url").length, 2, title);
    assert.deepEqual(nodes.filter((node) => !node.linkTarget).map((node) => node.title),
      title.startsWith("Read ") ? ["Read and"] : []);
  }
});

test("unsafe schemes, malformed URLs and ordinary Markdown stay literal", () => {
  for (const title of [
    "Plain text", "javascript:alert(1)",
    "[Unsafe](javascript:alert(1))", "file:///C:/note.md", "ftp://example.com",
    "www.example.com", "https://", "http://[invalid]", "prefixhttps://example.com",
    "Keep \\[escaped\\] **text**"
  ]) {
    assert.deepEqual(parseTextLine(title), [{ title }]);
  }
  assert.deepEqual(parseTextLine("[[笔记|别名]] https://example.com"), [
    { title: "别名", linkTarget: { type: "file", linkPath: "笔记", fallbackTitle: "[[笔记|别名]]" } },
    { title: "https://example.com", linkTarget: { type: "url", url: "https://example.com/" } }
  ]);
});
