# memory

## 2026-10-10 · 新建思维树默认不写入设置属性（`feat`）

**需求变更**：以前新建 `.mtn.md` 会把当时的全局默认配置（六项树设置）整体写入 Frontmatter；现在改为**默认不写入**，缺失项在运行时直接使用全局默认值，只有用户在树菜单主动选择某项时才写入该属性并固定为该树的值。

**落点**

- `serializeMindTreeFile` 的写入来源是 `document-settings-state`：`stateOf` 对**没有归属记录**的文档返回 `raw: {}`（以前返回全部六项），`settingsForSerialization` 删除了 "Brand-new document" 的整份回写分支。于是"没有归属 = 不拥有任何 YAML 属性"，保存时缺失项不会被补回。
- `createMindTreeFile(title)`（`src/format/document.ts`）不再接收全局设置参数，只写入 `schemaVersion`；`main.ts` 的 `createMindTree` 随之简化。
- 主动设置的链路不变：视图树菜单 → `markSettingsEdited(draft, [key])` → 序列化写入该字段；撤销可恢复缺失状态（`restoreTreeSettingsHistory`）。`documentSettingsToYaml`（原来"一次写全六项"的唯一入口）随之无人调用，已删除，避免以后再有代码整份回写默认值。
- 用户可见影响：未主动设置过的导图会跟随之后修改的全局默认值（此前新建时已被复制固定）；全局值只在**解析（打开/重新打开）时**生效，已打开的视图不会即时重排或重绘。文档已同步：`docs/02` §5.2/§6.1/§6.4、`docs/03` §7.1–7.3、`docs/05` §9.2/§9.4/§10、`docs/06` 验收项、`docs/requirements.md` 第 4/8 条、README 两份；全局设置页五个 "默认…" 说明文案改为"未在思维树中单独设置该项时使用此默认值"。

**测试口径变化（不是放宽断言）**

- 需要"文件里已有设置"的测试改用显式意图构造：`markSettingsEdited(document, TREE_SETTING_KEYS)` 后再序列化（`test/document-settings-state.test.ts` 的 `withSettings` 辅助、`test/identity-repair.test.ts` 的 fixture、`test/template-files.test.ts` 的模板、`test/document-conflict.test.ts` 的外部版本）。
- 新建流程新增端到端断言：新文件不含任何设置键、节点编辑与重开后仍缺失、显式选择后固定且其余项继续跟随全局（`test/format.test.ts`）。

**环境坑（本沙箱）**

- `npm test` 仍需放宽沙箱（esbuild spawn 子进程，受限模式报 `spawn EPERM`）；放宽后 500 条全绿（新增 2 条新建流程断言）。

**相关旧问题（未在本次修改）**

- 版本预览选择"保留当前版本"时 `rebaseTreeSettings(..., TREE_SETTING_KEYS)` 会用磁盘值覆盖全部六项并删除 pending，因此预览打开期间刚做的设置选择不会被写入。菜单在 `mutationLocked()` 下本就被禁用，窗口很窄，属既有设计取舍。

## 2026-10-09 · 打开期间删除源文件不再算异常关闭（`fix`）

**问题**：思维树标签页打开时删除源文件，会被当成保存失败/异常关闭处理。

**根因（三处都源于"把删除当失败"）**

1. `MindTreeView.checkExternalVersion()` 发现 `getFileByPath()` 为空 → `enterVersionPreview()`，于是**为一次删除创建未决冲突记录**（上一轮"孤儿清理"要处理的就是它）。
2. 关闭路径 `flushViewBeforeDetach()` 仍会 `save()`，或在冲突锁下 `settle()`；`Vault.process()` 对已删除路径失败 → `reportSaveFailure()` 把"思维树文件不存在：path"写成红色保存失败状态。
3. `queueTitleRename()` 的文件副作用（重命名/同步关联文件）会在文件消失后继续执行。

**落点**

- `MindTreeView.backingFilePresent()`（`src/ui/mind-tree-view.ts`）：用 `vault.getFileByPath()` 判定路径是否存在，父目录仍在才算"单个文件被删除"。
- 删除即正常结束：`checkExternalVersion()` 与 `flushViewBeforeDetach()` 命中缺失文件时调用 `SharedMindTreeSession.markDeleted()`（`src/services/mind-tree-session-registry.ts`），同步清 `restoring` / `restoreError` / 冲突态 / 草稿 / 待写标记，并 `history.markSaved()` 让文档不再是"未保存"。
- `save()`、`performQueuedSave()`、`scheduleSave()`、`queueTitleRename()` 都加了同一道护栏：不写、不重建、不改名已删除路径。
- 冲突态同步释放：`VersionConflictCoordinator.abandon()`（同步清内存态 + 后台清记录）替代只异步的 `discard()`——`onClose` 等不了队列，锁若比文件活得久就会阻断正常关闭。
- 回归测试：`test/mind-tree-session-registry.test.ts` 的「a deleted file closes the session without a pending-write or conflict lock」。

**设计取舍**

- 删除后视图保持只读打开（可撤销、可看），不再尝试任何写入；文件被恢复后按普通外部修改重新读取。
- 未落盘的内存修改不写入记录，也不伪造保存成功；文件确实不存在，无处可写。

**未覆盖**

- 全文件夹被删除时回退为原来的"保存失败"路径（父目录也不存在 → 无法证明文件是被单独删除的）。若需要，把 `backingFilePresent()` 的父目录判断也去掉即可，但会失去"文件夹整体变动"的保护。

**环境坑（本沙箱）**

- `npm test`（tsx → esbuild）在受限沙箱下必失败：esbuild 需要 spawn 子进程，报 `Error: spawn EPERM`。`test/adaptive-tooltip.test.ts`、`test/plugin-update-modal.test.ts` 直接调用 `buildSync`，因此这两条会红（与本仓库代码无关）。
- 等价替代（当前 483 条中 481 条通过）：用一个 `node:module` 的 `resolve` 钩子把无扩展名 / 目录 index 的 TS 导入解析到 `.ts`，再
  `node --experimental-transform-types --import <register.mjs> --test --test-isolation=none "test/*.test.ts"`。
  注意 Windows 下 `--import` 必须传 `file:///C:/...` URL，否则报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
- 该替代命令偶发额外失败（曾见 `text-import.test.ts` 2 条、`plugin-updates.test.ts` 1 条、`identity-repair.test.ts` 1 条，单独或按文件重跑必过），属替代运行时的非确定性，不是仓库回归：同一命令连跑 6 次，5 次为 481/483、1 次多出 2 条无关失败。判定回归前先单独重跑该文件。

## 2026-10-09 · 未决冲突记录的孤儿清理（`feature`）

**问题**：源文件被删除/移动后，`pending-conflicts/<本机标识>/*.json` 记录会永久保留，启动时反复提示"无法确定已保存版本对应的文件"，且活动会话的冲突锁（`mutationLocked`）因 `requireFile()` 抛 `file.missing` 而无法通过"保留版本"按钮解开。

**结论与落点**

- 创建记录的入口只有一个：`checkExternalVersion()` 发现磁盘文件不存在 → `enterVersionPreview()` → `VersionConflictCoordinator.enter()`。删除事件和重命名竞态都会走到这里。
- 决策纯函数：`resolvePendingConflict()`（`src/services/pending-conflict-store.ts`）——`live` / `rebind` / `stale-path` / `retain`，只看证据，不猜路径。
- 编排：`MindTreeNaturePlugin.reportUnlocatedPendingVersions()`（`src/main.ts`），启动时**等资源索引重建完成后**执行；`vault.delete` 与 `vault.rename` 事件用 800 ms 防抖再跑一次。
- 解锁：`VersionConflictCoordinator.discard()` / `abandon()`（`src/services/version-conflict-coordinator.ts`）清记录 + 清内存冲突态；清理失败也必须解锁。
- 新文案：`conflict.discarded`（中英各一条）；`conflict.unlocated` 仅保留给 `retain` 分支。
- 文档同步：`docs/02` §冲突段、`docs/03` §7.6、`docs/06` 验收项。注意：本条实现后，第 1 条"删除即创建记录"的入口已由下一轮的删除修复移除，`pendingPaths`/`retain` 分支主要剩启动恢复与移动歧义两种来源。

**仍在的限制**

- 记录里的本地冻结版本（`currentSource`/`draft`）随记录一起丢弃，用户选择"不备份"；若源文件其实是被同步客户端移走且 `documentId` 不唯一，则保留记录并报错。
- 编排层（`main.ts`）没有单元测试：`npm run check` 覆盖类型，行为靠上述纯函数与 store/coordinator 测试守护。若要补集成测试，需要先有可注入的 App/vault 端口。

