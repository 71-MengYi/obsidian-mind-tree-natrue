import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "../src/i18n/catalog";

test("provides English and Chinese interface translations", () => {
  assert.equal(translate("menu.disableTitleSync", "en"), "Cancel association");
  assert.equal(translate("menu.disableTitleSync", "zh-cn"), "取消关联");
  assert.equal(translate("settings.openMode.splitRight", "zh"), "右侧竖向拆分");
  assert.match(translate("notice.duplicateResourceId", "zh", { paths: "A.mtn.md, B.mtn.md" }), /A\.mtn\.md, B\.mtn\.md/);
  assert.match(translate("notice.clipboardReadFailed", "zh"), /剪贴板/);
  assert.equal(translate("conflict.current", "zh"), "当前版本");
  assert.equal(translate("conflict.external", "en"), "Latest external version");
  assert.match(translate("conflict.storageError", "zh", { message: "test" }), /test/);
  assert.equal(translate("settings.fileBadges.heading", "en"), "File type labels");
  assert.equal(translate("settings.fileBadges.heading", "zh"), "文件类型标签");
  assert.equal(translate("menu.linkFile", "zh"), "关联已有文件");
  assert.equal(translate("menu.moveFiles", "en"), "Move linked files to");
  assert.equal(translate("statusBar.files", "zh", { count: 3 }), "3 个文件");
  assert.equal(translate("node.openLinkedResource", "zh"), "打开关联资源");
  assert.equal(translate("node.openLinkedResource", "en"), "Open linked resource");
  assert.match(translate("modal.import.ruleDesc", "zh"), /Wiki、Markdown 文件链接及 HTTP\/HTTPS 网址均自动关联/);
  assert.match(translate("modal.import.ruleDesc", "zh"), /多个链接拆为兄弟节点/);
  assert.match(translate("modal.import.ruleDesc", "en"), /Wiki, Markdown file links and HTTP\/HTTPS URLs/);
  assert.match(translate("modal.import.ruleDesc", "en"), /Multiple links become siblings/);
});

test("interpolates translated message variables", () => {
  assert.equal(translate("menu.deleteBranch", "en", { count: 3 }), "Delete branch (3)");
  assert.equal(translate("menu.deleteBranch", "zh-cn", { count: 3 }), "删除分支（3）");
});

test("file badge descriptions explain opt-in Markdown aliases in both languages", () => {
  for (const language of ["en", "zh"]) {
    assert.match(translate("settings.fileBadges.desc", language), /Markdown/);
    assert.match(translate("settings.fileBadges.alias.desc", language), /md.*plugin\.md/);
  }
  assert.match(translate("settings.fileBadges.desc", "en"), /only when an alias matches/);
  assert.match(translate("settings.fileBadges.desc", "zh"), /仅在匹配到别名时显示/);
  assert.match(translate("settings.fileBadges.ignore.desc", "en"), /do not affect dedicated labels/);
  assert.match(translate("settings.fileBadges.ignore.desc", "zh"), /不影响专用标签/);
});

test("template actions consistently describe files in both languages", () => {
  assert.equal(translate("menu.addFileFromTemplate", "zh"), "从模板添加文件");
  assert.equal(translate("menu.addFileFromTemplate", "en"), "Add file from template");
  assert.equal(translate("modal.template.title", "zh"), "从模板添加文件");
  assert.equal(translate("modal.template.title", "en"), "Add file from template");
  for (const language of ["zh", "en"]) {
    assert.doesNotMatch(translate("notice.noTemplates", language), /Markdown/);
    assert.match(translate("notice.templateCopyCleanupFailed", language, { path: "Copies/A.pdf" }), /Copies\/A\.pdf/);
    assert.match(translate("notice.createTemplateFileFailed", language, { message: "failure" }), /failure/);
    assert.match(translate("notice.openCreatedFileFailed", language, { message: "open failure" }), /open failure/);
  }
});

test("default-app opening and stale association failures provide Chinese and English UI messages", () => {
  assert.equal(translate("menu.openDefaultApp", "zh"), "使用默认应用打开");
  assert.equal(translate("menu.openDefaultApp", "en"), "Open with default app");
  for (const language of ["zh", "en"]) {
    for (const key of ["notice.associationTargetChanged", "notice.resourceTargetChanged", "notice.defaultAppDesktopOnly", "notice.defaultAppUnsupportedAdapter"] as const) {
      assert.notEqual(translate(key, language), key);
    }
    assert.match(translate("notice.defaultAppOpenFailed", language, { message: "Test failure" }), /Test failure/);
    assert.match(translate("notice.createdNoteNotLinked", language, { path: "Notes/A.md", message: "Changed" }), /Notes\/A\.md/);
  }
  assert.equal(translate("menu.disableTitleSync", "zh"), "取消关联");
  assert.equal(translate("menu.unlinkResource", "zh"), "移除关联");
});
