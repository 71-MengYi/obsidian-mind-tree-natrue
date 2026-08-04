import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "../src/i18n/catalog";

test("provides English and Chinese interface translations", () => {
  assert.equal(translate("menu.disableTitleSync", "en"), "Cancel association");
  assert.equal(translate("menu.disableTitleSync", "zh-cn"), "取消关联");
  assert.equal(translate("settings.openMode.splitRight", "zh"), "右侧竖向拆分");
  assert.match(translate("notice.duplicateResourceId", "zh", { paths: "A.mtn.md, B.mtn.md" }), /A\.mtn\.md, B\.mtn\.md/);
  assert.match(translate("notice.clipboardReadFailed", "zh"), /剪贴板/);
});

test("interpolates translated message variables", () => {
  assert.equal(translate("menu.deleteBranch", "en", { count: 3 }), "Delete branch (3)");
  assert.equal(translate("menu.deleteBranch", "zh-cn", { count: 3 }), "删除分支（3）");
});
