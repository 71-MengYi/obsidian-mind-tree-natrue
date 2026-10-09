# agent.md · Mind Tree Nature 仓库 Agent 规则

> 本文件是本仓库对 AI Agent（以及任何自动化协作者）的**唯一入口**：先在这里找到"该读什么、该改哪里、改完跑什么"，再动手。
>
> - 核对基线：2026-10-09，`master` @ `768bfc9`；远端 `git@github.com:71-MengYi/obsidian-mind-tree-natrue.git`（`natrue` 是历史拼写，**不要顺手改正**，改名会破坏安装链接）。
> - 规则优先级：`docs/` 产品与技术基线 **>** 本文件 **>** 其他约定。冲突时以 `docs/` 为准，并把本文件改对。
> - 目录/命令/规则发生变化时，请同步更新本文件。

---

## 目录

1. [快速事实与命令](#1-快速事实与命令)
2. [仓库结构](#2-仓库结构)
3. [代码结构（模块与类）](#3-代码结构模块与类)
4. [docs 目录导览](#4-docs-目录导览)
5. [测试结构](#5-测试结构)
6. [构建、发布与 CI](#6-构建发布与-ci)
7. [硬性规则](#7-硬性规则)
8. [编码约定](#8-编码约定)
9. [每个任务的固定流程](#9-每个任务的固定流程)
10. [常见任务 → 落点速查](#10-常见任务--落点速查)
11. [红线（禁止事项）](#11-红线禁止事项)
12. [容易踩的坑](#12-容易踩的坑)

---

## 1. 快速事实与命令

| 项 | 值 |
| --- | --- |
| 项目 | **Mind Tree Nature** —— Obsidian「离线优先」思维导图插件，以 `.mtn.md` 为载体 |
| 技术栈 | TypeScript（strict）+ 无 UI 框架的命令式 DOM/SVG + esbuild 打包 + `node:test` 单测 |
| 运行环境 | Obsidian ≥ **1.8.7**，桌面端与移动端（`manifest.json` 的 `isDesktopOnly: false`） |
| 包管理 | **npm**（CI 用 `npm ci`）。仓库里同时存在 `pnpm-lock.yaml` / `pnpm-workspace.yaml`，但以 npm 为准 |
| 版本号 | 发布版本看 `manifest.json`（当前 `1.1.5`）；`package.json` 的 `0.1.0` **不是**发布版本 |
| 程序入口 | `src/main.ts`（`MindTreeNaturePlugin`）→ `npm run build` → 根目录 `main.js`（构建产物，已 gitignore） |
| 最低 Node | ≥ 20（`.github/workflows/release.yml` 硬校验） |

常用命令：

| 命令 | 作用 | 何时跑 |
| --- | --- | --- |
| `npm install` | 安装依赖 | 首次 / 依赖变化 |
| `npm run check` | `tsc --noEmit` 类型检查 | **每次改动后必跑** |
| `npm test` | 全部单元测试（`tsx --test --test-isolation=none test/*.test.ts`） | **每次改动后必跑** |
| `npm run build` | 生产构建 `main.js` | 需要产物 / 发布前 |
| `npm run dev` | esbuild watch（调试用） | 本地调试 |
| `node .github/scripts/check-runs.mjs` | 查 GitHub Actions 运行状态与最新 Release（无需登录） | 排查 CI/发布 |
| `node .github/scripts/verify-release.mjs <tag>` | 按插件更新器规则自检线上 Release 资产 | 发布后 |

> 沙箱/受限环境下 `npm test` 与 `npm run build` 会失败：tsx 与构建都经 esbuild，而 esbuild 需要 spawn 子进程（`spawn EPERM`）；`test/adaptive-tooltip.test.ts`、`test/plugin-update-modal.test.ts` 直接调用 `buildSync`，因此这两条也会红。可复现的替代命令与原因见 `docs/memory.md`。

---

## 2. 仓库结构

```
mind-tree-nature/
├── agent.md                    ← 本文件：Agent 规则与索引
├── src/                        源码（121 个 .ts，唯一的开发区域）
├── test/                       单元测试（56 个 *.test.ts + test/helpers/）
├── docs/                       产品与技术基线文档（Agent 必读，见第 4 节）
├── assets/                     README 用图片（mind-tree-nature-header.png）
├── .github/
│   ├── workflows/ci.yml        每次 push/PR：check + build + 产物校验
│   ├── workflows/release.yml   推 X.Y.Z 标签：构建并发布 Release
│   └── scripts/                check-runs.mjs、verify-release.mjs（手工运维脚本）
├── styles.css                  ★ 全插件唯一样式表（48 KB，被 test/styles.test.ts 静态断言）
├── manifest.json               ★ 插件元数据与**发布版本号**
├── versions.json               版本 → Obsidian 最低版本映射（提交社区目录用）
├── package.json               脚本与依赖（scripts: build/dev/check/test）
├── tsconfig.json               strict + noUncheckedIndexedAccess，include = src/**、test/**
├── esbuild.config.mjs          打包配置（entry=src/main.ts，cjs，external=obsidian/electron/codemirror…）
├── package-lock.json           npm 锁文件（CI 使用）
├── pnpm-lock.yaml / pnpm-workspace.yaml   历史遗留，不作为构建依据
├── README.md / README.en.md    用户文档（中文 / 英文，改用户可见行为要同步两份）
├── LICENSE                     MIT
├── THIRD_PARTY_NOTICES.md      第三方声明（主题与部分布局改编自 Light Mindmap）
├── .gitignore                  忽略 node_modules/、main.js、*.map、coverage/、data.json、pending-conflicts
└── main.js                     ⚠ 构建产物，已 gitignore —— **不要提交、不要手工编辑**
```

`src/` 分层（`main.ts` 之外 9 个根文件）：

```
src/
├── main.ts                    插件入口：注册视图/命令/设置页/文件事件，编排各服务（752 行）
├── types.ts                   ★ 领域模型类型（MindTreeDocument、MindTreeNode、ResourceRef、NodeMarker…）
├── settings-model.ts          全局设置模型与默认值（DEFAULT_SETTINGS）
├── settings.ts                设置页 MindTreeSettingTab
├── plugin-data.ts             data.json 读写与规范化（只含 settings）
├── document-settings.ts       单树 6 项 YAML 设置的键名、默认值与规范化
├── document-settings-state.ts 运行时 YAML 归属（WeakMap，绝不进入文档/JSON）
├── input-limits.ts            ★ 所有不可信输入的硬上限（体积/节点数/深度/JSON 嵌套）
├── view-routing.ts            视图类型常量与 .mtn.md 路径判定
├── domain/      (5)  纯领域，零 Obsidian 依赖：tree.ts、tree-index.ts、markers.ts、runtime-node.ts、clipboard-payload.ts
├── format/      (5)  .mtn.md 格式：document.ts、outline.ts、migrations.ts、document-identity.ts、resource-id.ts
├── i18n/        (2)  catalog.ts（EN 真源 + ZH）、index.ts（t()）
├── services/   (20)  会话/冲突/资源/模板/导出/设置持久化等；updates/ 另有 7 个自更新文件
└── ui/         (23)  视图与全部 DOM/SVG：
    ├── components/     (13) view-shell、canvas-shell、工具栏、状态栏、预览、ui-object 基类
    ├── controllers/    (12) 画布交互、键盘、拖拽、触摸手势、剪贴板、图片缩放、键盘避让…
    ├── renderers/       (4) node-renderer、connection-renderer、node-render-model
    ├── menus/           (5) 节点右键菜单、树设置菜单、工具栏菜单、快捷键帮助
    ├── modals/         (10) 新建/删除/移动/导入/文件建议/更新提示等对话框
    └── settings-pages/  (6) 基础设置、思维导图、主题笔记、插件更新分区
```

---

## 3. 代码结构（模块与类）

### 3.1 依赖方向（只能向下，不可反向）

```
src/main.ts            插件编排：注册视图 / 命令 / 设置页 / 文件事件
    ↓
src/ui/                DOM 与 SVG；唯一可以碰 Obsidian View 的一层
    ↓
src/services/          会话、冲突、资源索引、模板、更新、导出、持久化
    ↓
src/format/ + i18n/    .mtn.md 解析/序列化/迁移/大纲；文案
    ↓
src/domain/ + types.ts 纯数据与树操作（可脱离 Obsidian 独立测试）
```

**硬约束**：`ui/` 内的组件**不得**反向导入 `MindTreeView` 或插件主类（`docs/05-technical-design.md` §9.1）。界面事件先转成命名操作 → 领域命令产生新文档状态 → 视图重算并调用组件 `update()`。组件不得直接改文档模型。

### 3.2 关键类与职责（约 85 个导出类，下列为改动热点）

**入口与视图**

| 名称 | 文件 | 职责 |
| --- | --- | --- |
| `MindTreeNaturePlugin` | `src/main.ts` | 注册视图/命令/设置页/文件事件，持有各服务，编排冲突清理与更新流程 |
| `MindTreeView` | `src/ui/mind-tree-view.ts` | 视图中枢（约 3.4k 行）：把文档会话映射为界面状态、派发命名操作。**改动前先读它调用的组件/控制器，不要在它里面新增独立逻辑** |
| `MindTreeViewShell` / `CanvasShell` / `ViewMenuBar` / `TopToolbar` / `BottomStatusBar` / `StatusIndicator` | `src/ui/components/*` | 视图外壳、画布宿主、左上菜单栏、顶部工具栏、左下状态栏、状态提示层 |
| `DisposableUiObject` / `DisposerBag` | `src/ui/components/ui-object.ts` | 所有 UI 对象的幂等销毁基类；新增 UI 模块必须接入 |

**控制器（`src/ui/controllers/`）**

| 名称 | 文件 | 职责 |
| --- | --- | --- |
| `CanvasInteractionController` | `canvas-interaction-controller.ts` | 框选、平移、缩放、多选 |
| `KeyboardController` | `keyboard-controller.ts` | 结构快捷键与编辑态分流 |
| `NodeDragController` | `node-drag-controller.ts` | 节点拖拽与落点提交 |
| `DragDropController` | `drag-drop-controller.ts` | 仓库/系统文件拖入，外部文件准入策略 |
| `ClipboardController` | `clipboard-controller.ts` | 结构化剪贴板 + 系统剪贴板兜底 |
| `TouchGestureController` / `TouchGestureMachine` | `touch-gesture-controller.ts` / `touch-gesture.ts` | 触摸手势识别与分流 |
| `ImageResizeController` / `KeyboardAvoidanceController` / `DeleteDetailsController` / `FileAssociationController` | 同名文件 | 图片缩放、移动端键盘避让、删除详情预览、Ctrl/Cmd+E 关联流程 |

**渲染与布局（`src/ui/`）**

| 名称 | 文件 | 职责 |
| --- | --- | --- |
| `NodeRenderer` | `renderers/node-renderer.ts` | 节点 DOM 渲染 |
| `ConnectionRenderer` | `renderers/connection-renderer.ts` | 连线 SVG 几何与主题样式 |
| `createNodeVisualState` | `renderers/node-render-model.ts` | 纯函数：节点 → 视觉状态 |
| `layoutTree` / `connectionPath` / `getNodeSize` | `layout.ts` | 五种布局、节点尺寸与路径计算 |
| `BrowserNodeTextMeasurer` | `text-measurer.ts` | 用 Canvas 实测标题宽度（画布与 PNG/SVG 导出共用） |
| `BrowserResourceBadgeMeasurer` | `resource-badges.ts` | 扩展名/专用徽标测量与派生 |
| `getNodeResourceControls` | `resource-controls.ts` | 节点尾部控件（打开按钮、同步关闭标志）统一来源 |
| `MindTreeThemePreset` / `getBranchColorSlots` | `theme-presets.ts` / `presentation.ts` | 十套主题、十二色分支色槽 |
| `ViewportState` 工具集 | `viewport.ts` | 缩放/平移（**会话状态，绝不写盘**） |

**服务（`src/services/`）**

| 名称 | 文件 | 职责 |
| --- | --- | --- |
| `MindTreeSessionRegistry` / `SharedMindTreeSession` | `mind-tree-session-registry.ts` | 按规范路径保证同一文件只有一份文档、历史、保存队列、冲突状态 |
| `DocumentSession` | `document-session.ts` | 串行保存、100 步历史、冻结与冲突锁定 |
| `VersionConflictCoordinator` | `version-conflict-coordinator.ts` | 外部机器数据变化时的双栏版本选择 |
| `PendingConflictStore` | `pending-conflict-store.ts` | 未决版本暂存（`pending-conflicts/<本机标识>/`） |
| `ResourceIndexService` | `resource-index.ts` | 创建/关联/移动文件与标题同步的唯一入口 |
| `ResourceCatalog` | `resource-catalog.ts` | 从真实文件身份建立验证快照、分批原子重建 |
| `LocalResourceCache` | `local-resource-cache.ts` | 仓库隔离的本机缓存（不是归属证明） |
| `TemplateFileService` | `template-files.ts` | 「从模板添加文件」：复制任意文件、分配独立身份、回收未关联副本 |
| `DefaultAppOpener` | `default-app-opener.ts` | 桌面端用系统默认应用/浏览器打开（延迟加载 Electron） |
| `renderBranchSvg` / `exportBranchPng` | `export.ts` | SVG/PNG 导出与安全图片嵌入 |
| `parseTextLine` / `parseTextImport` | `text-links.ts` / `text-import.ts` | 粘贴与导入共用的行级解析 |
| `SettingsPersistence` | `settings-persistence.ts` | 设置串行保存与外部更新接收 |
| `ReleaseClient` / `UpdateCoordinator` / `UpdateStore` / `WorkspaceUpdateHost` | `updates/*.ts` | 插件自更新：校验、事务安装、回滚、重启 |

**格式与领域（`src/format/`、`src/domain/`）**

| 名称 | 文件 | 职责 |
| --- | --- | --- |
| `parseMindTreeFile` / `serializeMindTreeFile` | `format/document.ts` | `.mtn.md` 解析与序列化（含 gzip+Base64 数据区） |
| `MindTreeMigrationFactory` / `mindTreeMigrationFactory` | `format/migrations.ts` | **唯一**版本迁移入口（v1→v2，逐级、失败不覆盖） |
| `renderOutline` / `escapeMarkdown` | `format/outline.ts` | 由机器数据单向下发 Markdown 大纲 |
| `restoreDocumentIdentity` | `format/document-identity.ts` | 只改身份标量的比较写入 |
| `createShortResourceId` / `extractNonMarkdownResourceId` | `format/resource-id.ts` | 5 位资源 ID、`@`/`%` 分隔符、历史 `~mtn-` 兼容 |
| 树操作：`addNode` / `moveNodes` / `deleteBranches` / `extractBranches` / `insertBranches` … | `domain/tree.ts` | 纯函数树命令（配合撤销栈） |
| `getDocumentTreeIndex` | `domain/tree-index.ts` | 父节点/深度/文档序索引（WeakMap 失效） |
| `normalizeRuntimeNode` / `normalizeNodeMarkers` | `domain/runtime-node.ts` / `domain/markers.ts` | 不可信数据的运行时校验 |

### 3.3 docs 概念名 ↔ 代码落点

`docs/05-technical-design.md` §9.1 用的是**概念名**，代码里没有同名标识符。检索时按下表换算：

| 设计文档中的名字 | 代码落点 |
| --- | --- |
| `MindTreeView` | `src/ui/mind-tree-view.ts` |
| `TreeCanvas` | `src/ui/components/canvas-shell.ts` + `ui/renderers/*` + `ui/controllers/*` + `ui/layout.ts` |
| `TreeCommandService` | `src/domain/tree.ts`（纯命令）+ `src/services/document-session.ts`（历史） |
| `DocumentRepository` | `src/format/document.ts`（+ `outline.ts`、`document-identity.ts`） |
| `MindTreeMigrationFactory` | `src/format/migrations.ts`（同名） |
| `OutlineRenderer` | `src/format/outline.ts` |
| `FileIndexRepository` | `src/services/resource-index.ts` + `resource-catalog.ts` + `local-resource-cache.ts` |
| `ResourceService` | `src/services/resource-index.ts` + `resource-identity.ts` + `linked-resource-sync.ts` |
| `TemplateFileService` | `src/services/template-files.ts`（同名） |
| `DefaultAppOpener` | `src/services/default-app-opener.ts`（同名） |
| `ClipboardService` | `src/services/clipboard.ts` + `src/ui/controllers/clipboard-controller.ts` |
| `ExportService` | `src/services/export.ts` |
| `SettingsService` | `src/settings-model.ts` + `src/settings.ts` + `src/services/settings-persistence.ts` |

### 3.4 领域模型（`src/types.ts`）

- `MindTreeDocument`：`schemaVersion?`、`documentId?`、`rootId`、`nodes`、6 项文档设置。
- `MindTreeNode`：`id`、`title`、`childIds`、`createdAt`/`updatedAt`、`resource?`、`titleSync?`、`markers?`、`style?`、`collapsed?`。
- `ResourceRef` = `FileResourceRef | UrlResourceRef`：文件用稳定 `resourceId` + `pathHint`；URL 只存地址。
- 运行时（不落盘）状态一律放视图/会话：选择、视口、折叠预览、标签派生视觉。

---

## 4. docs 目录导览

`docs/requirements.md` 是**导航页**（含 17 条全局交互与格式约束），其余文档按章节编号连续。

| 文件 | 章节 | 内容 | 何时读 |
| --- | --- | --- | --- |
| `docs/requirements.md` | 导航 + 全局约束 | 文档索引；**17 条全局交互与格式约束**（最高优先级的硬规则） | 任何任务开始前先扫一遍 |
| `docs/01-product-scope.md` | 1–4 | 产品定位、术语、用户场景、P0/P1/P2 功能范围与**非目标** | 判断某功能是否属于范围 |
| `docs/02-interface-interactions.md` | 5–6 | 主视图、左上菜单、工具栏、状态栏、节点视觉；打开/收集/选择编辑/新增/拖拽/右键菜单/创建关联/移动/删除/复制粘贴导入导出 | 改任何界面与交互 |
| `docs/03-document-format.md` | 7 | `.mtn.md` 文件头、示例、版本迁移、压缩序列化与校验、文档数据模型、大纲与外部编辑、保存与未决暂存 | 改文件格式、解析、序列化 |
| `docs/04-resource-index.md` | 8 | 稳定资源 ID、文件内表示、引用解析顺序、文件事件、手动重建、设置同步、批量关联结果 | 改资源索引与文件关联 |
| `docs/05-technical-design.md` | 9–12 | 模块划分、状态流、渲染与性能策略、版本迁移约束、设置设计、异常处理与数据安全、跨平台/可访问性/安全 | 改架构、性能、设置、冲突处理 |
| `docs/06-quality-roadmap.md` | 13–15 | 测试策略（单元/集成/视觉手工）、**19 条 P0 验收标准**、里程碑 M1–M4 | 判断"做完没有"、补测试 |
| `docs/memory.md` | — | **Agent 跨会话记忆位**（不是产品文档）：按日期记录结论、落点、未完成事项与环境坑。已有 2026-10-09「未决冲突孤儿清理」与沙箱测试替代命令两条 | 任务开始前扫一眼、收尾时追加 |

> 文档与代码不一致时：**以 `docs/` 为实现基线**，改代码对齐；若确认需求变更，先改 `docs/` 再改代码。

---

## 5. 测试结构

- 位置：`test/*.test.ts`（**平铺**，56 个文件，约 500 个用例）+ `test/helpers/`（1 个共享桩）。
- 框架：`node:test` + `node:assert/strict`，由 `tsx` 运行；所有文件在**同一进程**（`--test-isolation=none`），全局状态泄漏会互相污染。
- 命名：多数与源文件同名（`src/format/document.ts` ↔ `test/format.test.ts`）；少数按主题聚合（`exchange.test.ts` 覆盖导入导出与剪贴板、`safety.test.ts` 覆盖数据安全、`identity-repair.test.ts` 覆盖身份恢复）。
- 风格：优先**纯数据测试**——用注入端口/时钟替代真实 Obsidian；断言行为而不是实现细节。
- **测试即规则**，下列文件固化了产品约定，改对应代码前必读：

| 测试 | 固化了什么 |
| --- | --- |
| `test/ui-modules.test.ts` | 工具栏顺序、键盘帮助顺序、节点菜单分组与"已关联不再显示创建/关联入口"、UI 销毁语义 |
| `test/styles.test.ts` | 直接读取 `styles.css` 与 `src/ui/mind-tree-view.ts`、`src/ui/renderers/node-renderer.ts` 做静态断言（面板、标题轨道、无长期 GPU 层、徽标配色…） |
| `test/i18n.test.ts` | 中英双语齐全、文本非空、两语言占位符一致 |
| `test/layout.test.ts` | 三档字号/行高、只有根节点 32px 最小高度、十套主题十二色、所有连线 1px、五种布局方向 |
| `test/performance.test.ts` | 1000 节点"解析+索引+布局+序列化" < 2 秒基线 |
| `test/format.test.ts` / `test/document-conflict.test.ts` / `test/identity-repair.test.ts` | 格式拒绝、迁移逐级、失败不覆盖、身份保护 |

约定：**新增行为必须带测试**；不允许为了让测试变绿而删除或放宽既有断言（除非需求本身变化，并在 `docs/` 里写明）。

---

## 6. 构建、发布与 CI

**构建**：`esbuild.config.mjs` 以 `src/main.ts` 为入口打包为 CJS（target es2018、treeShaking），`external` 包含 `obsidian`、`electron`、`@codemirror/*`、`@lezer/*`。产物 `main.js` 与根目录 `manifest.json`、`styles.css` 一起构成插件包。

**体积上限**（`.github/workflows/release.yml` 与 `src/services/updates/release-client.ts` 的 `UPDATE_LIMITS` 保持一致，改一处必须同步另一处）：

| 文件 | 上限 |
| --- | --- |
| `main.js` | 10 MiB |
| `styles.css` | 2 MiB |
| `manifest.json` | 64 KiB |

**CI**（`.github/workflows/ci.yml`，push 与 PR 都跑）：`npm ci` → `npm run check` → `npm run build` → 校验三个文件存在且非空。
⚠ 工作流**不使用任何外部 action**（仓库 Actions 策略只允许本仓库自己的 action，用 `actions/checkout` 会导致 `startup_failure`）；只能用 runner 预装的 git/node/npm/gh/curl。

**发布**（`.github/workflows/release.yml`）：推 `X.Y.Z` 标签触发 → 校验标签严格等于 `manifest.json` 的 `version`（不接受 `v` 前缀或后缀）→ 构建 → **先建 draft、传完三个资产、再发布并标 Latest** → 跑 `.github/scripts/verify-release.mjs` 自检。插件内置更新器与 BRAT 都读 `releases/latest`，所以草稿/预发布资产不全会让用户拿不到更新。`versions.json` 记录 `版本 → Obsidian 最低版本`，提交社区目录时补齐。

---

## 7. 硬性规则

标注含义：**[测试守护]** = 有自动化测试或类型检查兜底；**[产品基线]** = 来自 `docs/`，人工评审判断。

### A. 数据安全（最高优先级，违反即为严重缺陷）

1. 解析失败、格式不认识、压缩数据损坏时：**只读打开并报错**，绝不用空数据覆盖原文件。 **[测试守护]**
2. 保存必须以**最新磁盘文本**为底稿，不能拿旧基线覆盖大纲、正文、未知 Frontmatter。 **[测试守护]**
3. 一切不可信输入（压缩数据、剪贴板、导入文本、拖拽路径、图片）都必须走 `src/input-limits.ts` 的体积/节点数/深度上限。 **[测试守护]**
4. 所有仓库文件写入走统一服务与文件级串行队列（`DocumentSession`、`ResourceIndexService`、`SettingsPersistence`）；不要在 UI 层直接 `vault.modify/create/delete`。 **[产品基线]**
5. 删除节点 ≠ 删除文件。真实文件删除必须用户确认并经 Obsidian 回收站；批量操作先展示影响范围、后给结果报告。 **[测试守护]**
6. 资源身份只认稳定 ID、规范路径与实际文件核对；重名/重复 ID 一律拒绝，**不猜测**同名文件。 **[测试守护]**
7. 不新建或扫描旧 Recovery 文件；未决版本一律走 `PendingConflictStore`（插件目录 `pending-conflicts/<本机标识>/`）。 **[产品基线]**
8. 任何自动修复都必须是可撤销的会话命令。 **[产品基线]**

### B. 文件格式与迁移

9. `.mtn.md` 结构 = 顶层 `schemaVersion` + 可选 `documentId` + 6 项文档设置 YAML + 无序列表大纲 + 分割线 + "这段话之后的内容是压缩json，无需读取和分析。" 提示 + gzip + Base64 数据块。改前必读 `docs/03-document-format.md`。 **[测试守护]**
10. 只有影响"导图识别 / 数据区定位 / 核心载荷解码"的不兼容结构变化才提升 `schemaVersion`，且必须登记进唯一入口 `MindTreeMigrationFactory`；其他模块不得散落旧格式判断。 **[测试守护]**
11. YAML 只允许 6 个文档设置（`layoutMode`、`recursiveScan`、`collectionMode`、`theme`、`connectionStyle`、`nodeShape`）+ `documentId`。**不得**把全局设置或机器数据写进 Frontmatter，不得引入 `format`/`version`/`revision` 等并行版本字段。 **[测试守护]**
12. 设置缺失只在运行时取默认值（全局默认 → 代码默认），**不标脏、不回写**；`document-settings-state` 的 WeakMap 记账不得进入文档或压缩 JSON。 **[测试守护]**

### C. 界面与产品基线

13. 所有用户可见文案必须走 i18n：`src/i18n/catalog.ts` 的 `EN` 是 key 真源，`ZH` 声明为 `Record<TranslationKey, string>`；漏一个 `npm run check` 就报错，`test/i18n.test.ts` 还要求非空、占位符两语言一致。**禁止硬编码界面字符串**。 **[测试守护]**
14. 不提供任何"打开导图源文件"的按钮、菜单项或命令。 **[测试守护]**
15. 视觉是产品规则，不是随手调整：节点无实体边框；字号/行高三档（深度二及以后一致）；只有根节点保留 32px 最小高度、所有层级无固定最小宽度；十二色按一级分支当前顺序循环并由后代继承；所有连线固定 1px；**禁止渐变**。 **[测试守护]**
16. 组件只通过命名操作与不可变文档状态通信（命令式 DOM + 单向数据流）；每个 UI 对象必须幂等销毁。 **[测试守护]**
17. 可访问性：控件要有可访问名称，主要操作可全键盘完成，焦点/选中不能只靠颜色区分。 **[产品基线]**
18. 范围红线：自由画布、流程图、任意图结构、多人协作、服务端同步**不做**（README 明确的非目标）。 **[产品基线]**

### D. 平台与隐私

19. 移动端必须可用：核心读写不得依赖 Node.js 专属 API；Electron/shell 只能在桌面端点按后延迟加载。 **[测试守护]**
20. 默认不发起网络请求、不上传库内容/文件名/URL；唯一例外是用户主动开启的插件更新器。 **[产品基线]**
21. 路径统一用 vault 相对 `/` 风格，比较时按平台处理大小写；节点标题、Markdown、SVG 导出必须转义。 **[测试守护]**
22. 日志不得记录笔记正文；调试日志默认关闭。 **[产品基线]**

---

## 8. 编码约定

- **TypeScript strict + `noUncheckedIndexedAccess`**：数组/索引访问要么判空、要么用 `!` 并确保不变量；**不要用 `as any`、`@ts-ignore` 让 check 变绿**。
- **命名**：文件与目录 `kebab-case`；领域类型/函数 `MindTree*`；UI 用 `*Controller` / `*Renderer` / `*Modal` / `*Menu` / `*Page`；纯函数动词开头。一个文件一个主类或一组紧密相关的纯函数；`index.ts` 只做转发 barrel。
- **依赖注入优先**：外部世界（vault、storage、shell、时钟、窗口）通过 ports 接口注入，便于纯数据测试（例：`DefaultAppShell`、`SettingsPagePort`、`LocalStoragePort`、`MindTreeOpenPorts`、`ReleaseClient` 的注入端口）。
- **语言**：代码注释用**英文**并解释"为什么"；测试名用英文描述行为；`docs/`、README、提交信息用**中文**。
- **导入**：相对路径（无路径别名），测试从 `../src/xxx` 导入。
- **样式**：全部写在根 `styles.css`，类名带 `mtn-` 前缀，使用 Obsidian CSS 变量适配浅色/深色/高对比；不写内联样式，不做全局选择器污染宿主。
- **依赖**：不轻易新增 npm 依赖——任何 `dependencies` 都会进 bundle 且受体积上限约束；确需引入时说明理由并检查 `external` 列表与 `THIRD_PARTY_NOTICES.md`。
- **注释/文档同步**：行为、格式、交互变化时同步更新对应 `docs/` 章节；用户可见变化同步 `README.md` 与 `README.en.md`。

---

## 9. 每个任务的固定流程

1. **定位**：用 grep 找符号 → 读 `docs/` 对应章节 → 读相关测试 → 读目标文件。不要凭猜测改代码。
2. **看工作区**：先 `git status`。若有未提交改动**不属于你**，不要覆盖、不要顺手提交，与用户确认后再动手。
3. **划定写范围**：只改必要文件；不做顺手重构、不重排格式、不改无关文案（评审成本高，且容易与并发改动冲突）。
4. **实现**：遵守第 7、8 节。
5. **验证（三件套）**：`npm run check` → `npm test` → 需要产物时 `npm run build`。CI 只跑 check + build，**测试必须本地补上**。
6. **同步文档**：见第 8 节末条。
7. **提交**：中文 Conventional Commits（`feat:` / `fix:` / `style:` / `chore:` / `ci:` / `refactor:` / `docs:`），一个提交只做一件事，信息写清"改了什么、为什么"。
8. **不要自行 `git push`、打标签或发 Release**（发布由维护者执行，除非用户明确要求）。
9. **收尾记忆**：把跨会话结论、踩坑与未完成事项写入 `docs/memory.md`，供下一位 Agent 接手。

---

## 10. 常见任务 → 落点速查

| 任务 | 主要落点 | 先读 | 必跑测试（除三件套外） |
| --- | --- | --- | --- |
| 新增/改界面文案 | `src/i18n/catalog.ts`（EN + ZH 同时加） | — | `test/i18n.test.ts` |
| 改全局设置项 | `src/settings-model.ts` → `src/settings.ts` → `src/ui/settings-pages/*` | `docs/05-technical-design.md` §10 | `test/settings-persistence.test.ts`、`test/settings-index-wiring.test.ts` |
| 改单树设置 | `src/document-settings.ts`、`src/document-settings-state.ts`、`src/ui/menus/tree-settings-menu.ts` | `docs/03-document-format.md` §7、`docs/05-technical-design.md` §9.4 | `test/document-settings-state.test.ts`、`test/format.test.ts` |
| 改文件格式/解析/迁移 | `src/format/document.ts`、`migrations.ts`、`document-identity.ts` | `docs/03-document-format.md` 全篇、`docs/05-technical-design.md` §9.4 | `test/format.test.ts`、`test/identity-repair.test.ts`、`test/document-conflict.test.ts` |
| 改树操作（增/删/移/复制） | `src/domain/tree.ts`、`src/domain/clipboard-payload.ts` | `docs/02-interface-interactions.md` §6.4–6.5、§6.10 | `test/tree.test.ts`、`test/exchange.test.ts` |
| 改布局/节点尺寸 | `src/ui/layout.ts`、`src/ui/text-measurer.ts` | `docs/05-technical-design.md` §9.3 | `test/layout.test.ts`、`test/performance.test.ts` |
| 改节点渲染/徽标/样式 | `src/ui/renderers/*`、`src/ui/resource-badges.ts`、`styles.css` | `docs/02-interface-interactions.md` §5.5 | `test/styles.test.ts`、`test/resource-badges.test.ts`、`test/ui-modules.test.ts` |
| 改画布交互/手势/拖拽 | `src/ui/controllers/*`、`src/ui/viewport.ts`、`src/ui/drop-placement.ts` | `docs/02-interface-interactions.md` §6.3、`docs/05-technical-design.md` §12.1 | `test/pointer-operations.test.ts`、`test/touch-gesture.test.ts`、`test/touch-routing.test.ts`、`test/drop-placement.test.ts` |
| 改文件关联/索引/缓存 | `src/services/resource-index.ts`、`resource-catalog.ts`、`resource-identity.ts`、`local-resource-cache.ts`、`linked-resource-sync.ts` | `docs/04-resource-index.md` 全篇 | `test/resource-index-service.test.ts`、`test/resource-catalog.test.ts`、`test/resource-identity.test.ts`、`test/local-resource-cache.test.ts` |
| 改冲突/未决版本/保存 | `src/services/version-conflict-coordinator.ts`、`pending-conflict-store.ts`、`document-conflict.ts`、`document-session.ts`、`mind-tree-session-registry.ts` | `docs/05-technical-design.md` §11 | `test/version-conflict.test.ts`、`test/pending-conflict-store.test.ts`、`test/safety.test.ts`、`test/document-session.test.ts` |
| 改模板文件流程 | `src/services/template-files.ts` | `docs/05-technical-design.md` §9.1 | `test/template-files.test.ts` |
| 改导入/粘贴 | `src/services/text-import.ts`、`text-links.ts`、`text-url.ts`、`clipboard.ts`、`src/ui/paste-routing.ts` | `docs/02-interface-interactions.md` §6.10 | `test/text-import.test.ts`、`test/text-links.test.ts`、`test/exchange.test.ts`、`test/paste-routing.test.ts` |
| 改导出（PNG/SVG/Markdown） | `src/services/export.ts` | `docs/02-interface-interactions.md` §6.10 | `test/exchange.test.ts` |
| 改主题/配色/连线 | `src/ui/theme-presets.ts`、`src/ui/presentation.ts`、`styles.css` | `docs/05-technical-design.md` §9.3 | `test/layout.test.ts`、`test/styles.test.ts` |
| 改插件自更新 | `src/services/updates/*` | `.github/workflows/release.yml` 注释、`docs/05-technical-design.md` | `test/plugin-updates.test.ts`、`test/update-workspace-host.test.ts` |
| 改设置持久化 / `data.json` | `src/plugin-data.ts`、`src/services/settings-persistence.ts` | `docs/05-technical-design.md` §11.1 末段 | `test/plugin-data.test.ts`、`test/settings-persistence.test.ts` |
| 改命令/菜单契约 | `src/main.ts`、`src/ui/ui-contracts.ts`、`src/ui/menus/*` | `docs/02-interface-interactions.md` §5.2–5.3、§6.6 | `test/ui-modules.test.ts` |

---

## 11. 红线（禁止事项）

- ❌ 提交 `main.js`、`node_modules/`、`data.json`、`pending-conflicts/`、`*.map`（`.gitignore` 已覆盖，不要用 `-f` 绕过）。
- ❌ 手工编辑 `main.js`、压缩数据区、`schemaVersion` 或版本号来"修好"文件。
- ❌ 删除、跳过或放宽既有测试来让流水线变绿。
- ❌ 用 `as any`、`@ts-ignore`、`@ts-expect-error` 掩盖类型错误（`npm run check` 必须零错误）。
- ❌ 在 `.github/workflows/*` 中引入任何外部 action。
- ❌ 新增遥测、上报或任何未经用户开启的网络请求。
- ❌ 硬编码界面文案（必须走 i18n 双语）。
- ❌ 把全局设置、视口、选择、运行时状态写进 `.mtn.md`。
- ❌ 覆盖他人未提交的改动：动手前先 `git status`，发现不属于你的改动先问。
- ❌ 未经用户明确要求就 `git push`、打标签或发布 Release。

---

## 12. 容易踩的坑

1. **版本号双轨**：`manifest.json` 是 `1.1.5`，`package.json` 是 `0.1.0`。发布版本只看 `manifest.json`，且必须与标签严格一致（`X.Y.Z`，无前后缀）。
2. **`test/styles.test.ts` 是"源码字符串测试"**：它直接读取 `styles.css` 与 `src/ui/mind-tree-view.ts`、`src/ui/renderers/node-renderer.ts`。改 CSS 类名、或改这两个文件里的类名字符串，可能连带弄红它——改前先看断言。
3. **i18n 占位符必须成对**：`{version}`、`{path}` 等在两语言中必须一致，缺一个 `test/i18n.test.ts` 就报错。
4. **`src/ui/clipboard-controller.ts`、`src/ui/modals.ts`、`src/ui/components/index.ts` 等是兼容 shim / barrel**（部分标记 `@deprecated`）：新代码请从 `ui/controllers/`、`ui/modals/*` 等真实模块导入，别再往 shim 里加逻辑。
5. **测试同进程**：`--test-isolation=none` 意味着不要依赖跨文件的全局状态；测试要用独立实例与可注入端口。
6. **视口与折叠是会话状态**：`viewport.ts` 的值永不落盘；折叠只影响展示，导出时展开。
7. **UI 组件禁止反向导入**：`ui/components`、`ui/renderers` 不得 import `MindTreeView` 或插件主类；渲染器只读渲染状态。
8. **移动端限制**：不要用 `fs`、`path`、`child_process` 等 Node 能力完成核心功能；Electron 只在桌面端点按后动态 `import`。
9. **设计文档名与代码名不同**（见 §3.3）：按概念名 grep 是找不到的，先换算再检索。
10. **`docs/memory.md` 是记忆位，不是产品文档**：追加简短结论、落点、未完成事项与环境坑，不要塞大段代码或临时调试输出；它已经记录了本沙箱下跑测试的替代命令，遇到 `spawn EPERM` 先看它。

---

*最后核对：2026-10-09 · `master` @ `768bfc9` · 目录与命令以 `package.json`、`tsconfig.json`、`.github/workflows/` 为准。*
