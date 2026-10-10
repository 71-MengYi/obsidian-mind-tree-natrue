# memory

## 2026-10-10 · 自定义标记（Emoji + 文字标记）与「管理标记」设置页（`feat`，团队协作）

**需求**：设置页新增「管理标记」tab，管理自定义 Emoji 与文字标记（增减、拖拽排序、悬浮 ×），并在节点标记面板与节点尾部使用；内置进度/优先级/高亮不受影响。

**数据模型（关键设计，后续改前必读）**

- 全局定义在 `data.json` 的 `settings.customMarkers: { id, kind: "emoji"|"tag", value }[]`（`src/domain/custom-markers.ts`），**永不写入 `.mtn.md`**；节点只存 `{ type: "emoji"|"tag", value }`（`src/types.ts` 的 `NodeMarker` 扩展）。
- 解析方式是「值匹配注册表」：`ResourceBadgePresentation.resolveCustomMarkerDisplays(node)` 在每次渲染快照里把值解析为可见项。**删除定义只让值停止渲染，节点数据不被改写，重新添加同值即恢复**——这是刻意取舍，不要在 `normalizeNodeMarkers` 里删未知自定义值。
- 注册表上限是**每组 64**（不是整表 64），`normalizeCustomMarkerDefinitions` 按 kind 计数；`addCustomMarkerDefinition` 也按 kind 计数。

**落点**

- 领域：`src/domain/custom-markers.ts`（清理/校验/增删/排序/规范化/按 kind 分组）；`src/domain/markers.ts`（`NodeMarker` 类别扩到 5 个；新增 `getIconNodeMarkers` = 仅内置图标；`CATEGORY_ORDER` 固定为 progress→priority→highlight→emoji→tag，`setNodeMarker` 按此排序写回）。
- 呈现：`src/ui/resource-badges.ts` 的 `NodeMarkerGeometry` 变为 `{ markers, resourceBadges, width, height }`，`markers` = 自定义项（前）+ 派生资源徽标（后）；`customMarkerLabels` 保留在 presentation 上供无障碍名使用；`BrowserResourceBadgeMeasurer` 新增 emoji/tag probe。
- 画布：`node-renderer` 用 `getVisibleNodeMarkers` 过滤自定义类别后交给 `resolveCustomMarkerDisplays`；emoji 走 `.mtn-node-marker.is-emoji`（固定 18px 方框），文字标记走 `.is-resource-badge.is-tag`（实测宽度）。
- 设置页：`src/ui/settings-pages/custom-markers-settings-page.ts`（`src/settings.ts` 第四个 tab）；DOM 契约见 `docs/02` §「管理标记」。
- 导出：`src/services/export.ts` **一条统一游标**（内置图标 + 自定义 + 派生徽标），tag 用 `measure()` 宽度；`class="mtn-tag-marker"`。

**踩坑 / 已确认的口径（省下后来者的时间）**

- **标记列几何**：列左 = `nodeX + NODE_HORIZONTAL_PADDING + 标题宽`；首项再 +`NODE_MARKER_GAP`（来自 `.mtn-node-markers` 的 `padding-left: 2px`）；项间也是 `NODE_MARKER_GAP`（flex `gap: 2px`）；末项右边界 = 列左 + `geometry.width`。相邻两项**中心距 = 18 + 2 = 20**。`getNodeMarkerGeometry` 的 `width` 已含那个前导 2px，导出不要再加一次。
- **文字 tag 必须用 measurer 的实际宽高**：曾经把自定义项一律按 18px 预留，导致 tag 与相邻元素重叠、且只剩一个 tag 时高度为 0（`Math.max(0, ...[])`）。emoji 由 measurer 返回固定 18×18，文字 tag 返回真实盒。
- **大纲后缀是期望行为**：自定义标记与内置一样输出 `〔emoji:🔥〕`、`〔tag:绘图〕`（`renderNodeMarkerSuffix`），不要过滤；它没有反向解析器。
- **空分组不渲染**：标记面板与设置页网格都按「无定义则整组/整网格不占位」处理；设置页额外用 `hidden` 属性（CSS 里没有 `.mtn-custom-marker-empty` 的 display 规则）。
- 用例数从基线 539 增至 618；其中 3 条既有断言的语义随需求更新（`markers.test.ts` 的 emoji 值现被接受、`resource-badges.test.ts` 的几何多了 `markers` 字段、两处「整表 64」改为「每组 64」），均已同步需求文案，不是放宽。

**未完成 / 建议下一步**
- 未在真实 Obsidian 内做视觉验收（仓库无浏览器环境）：建议人工确认 emoji 网格、悬浮 ×、拖拽落点高亮、文字 tag 在节点上的观感。
- 移动端拖拽排序未验证：tile 已设 `touch-action: none`，但 HTML5 DnD 在触摸端不可用；如需移动端排序，应改为 pointer events 实现（`Alt+←/→` 键盘路径已可用）。
- `aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"` 已加在 tile 上，未做屏幕阅读器实测。

**后续修复（同日）**：Emoji 组一开始只校验长度，导致可以输入文字。现改为「只能从内置离线目录中选取」，因此**不存在输入文字的路径**：

- `src/ui/emoji-data.ts` 由 `scripts/generate-emoji-data.mjs` 生成（约 1300 项，字段 `g` 字形 / `n` 英文名 / `k` 中英关键词 / `c` 分类）。改目录必须改生成脚本再重跑，不要手改产物。
- `src/ui/emoji-search.ts`：**空查询返回完整目录（1299 项，不截断）**，有查询时返回全部命中项。haystack = 字形 + 小写名 + 每词 4 字符前缀 + 关键词 + 分类英文别名；前缀是**追加**而非替换，否则 `smiling face` 会把查询 `smile` 弄丢；`smile`→`smiling` 这类跨词形靠 `CATEGORY_ALIAS_TERMS` 显式补。查询 NFKC 归一 + 逐词交集，可直接粘贴 Emoji 查找。
- 设置页把 1299 个按钮**只构建一次**，筛选时仅切换 `hidden`（`.mtn-emoji-picker-item[hidden] { display: none }`，因为基样式有 `display: flex`），所以每按键约 0.3ms；不要改回「每次输入重建列表」。曾经因为截断成「前 120 项」被用户要求改回完整列表——浏览列表本身就是查找方式，截断会藏起用户猜不到关键词的项。
- `isSingleEmojiValue`（`Intl.Segmenter` 字素簇 + `\p{Extended_Pictographic}` / 区域指示符对）仍保留为 `data.json` 与 `addCustomMarkerDefinition` 的兜底；`cleanCustomMarkerValue(value, kind)` 按 kind 选不可见字符表，**Emoji 组必须保留 U+200D**，否则 `👨‍👩‍👧‍👦` 会被拆成四个人。

**测试踩坑（会浪费大量时间，务必记住）**：
- `test/custom-markers-settings-page.test.ts` 的 DOM 桩保留 `parent` 链，**对元素做 `assert.deepEqual` 会遍历环形对象图**，一条断言就能把单测从 0.4s 拖到 90s。比较派生出的字符串数组，不要比较元素本身。
- 该文件的 `group(kind, name)` 必须按「第 0 个 = Emoji 段、第 1 个 = 文字标记段」取值；用 contains/文档序推断会挑错元素，表现为「标签组的 handler 一个都没注册」。
- Emoji 组的 fixture 值必须是真实 Emoji 字形（测试里用 `EMOJI_CATALOG` 前 N 项），否则 picker 认不出「已添加」，`data.json` 规范化也会丢弃这些值——这是真实不可达状态。

## 2026-10-10 · 无选择时禁用节点工具栏操作（`fix`）

- 用户最终要求改为禁用按钮，不弹出“先选中节点”提示。范围为“节点标记、复制、导出”；展开/折叠仍可默认操作根节点，导入仍可默认添加到根节点下。
- `TopToolbarState.hasSelection` 由视图按当前文档、主选节点及选中集合派生；`TopToolbar` 对三个按钮设置原生 `disabled`，初始化时默认禁用。`MindTreeView.refreshTopToolbar()` 接入选择样式刷新、重绘、视口更新、文件加载与清空，避免取消选择或切换文件后残留可用状态。
- 同步 `docs/02` §5.3 与中英文 README。`test/top-toolbar.test.ts` 验证禁用/恢复/再次禁用及其余八个工具栏操作不受影响；`npm run check`、`npm test`（539/539）、`npm run build` 均通过，本轮未遇到 esbuild 的沙箱 spawn 问题。

## 2026-10-10 · 主题悬浮预览（`feat`，团队协作）

**需求**：树设置菜单里"主题"二级菜单的每一行支持悬浮预览——鼠标停在某行时在该行侧边弹出小窗口，用固定示例树实时渲染该主题；移到其他行实时切换，移开/菜单关闭立即消失。

**落点**

- `src/ui/components/theme-preview-model.ts`（纯逻辑，零 obsidian 依赖）：`themePreviewDocument(theme, titles)` 生成 4 节点示例树（根 → [分支一 → 子节点, 分支二]，`layoutMode: "right"`，固定 id 与时间戳，每次返回新对象以触发 `ReadOnlyTreePreview.update` 的引用比较）；`placeThemePreview(anchor, size, viewport, gap)` 右优先 → 放不下翻左 → 两轴夹进 8px 边距。
- `src/ui/components/theme-preview.ts`：`ThemePreviewPanel` 复用 `ReadOnlyTreePreview`（真实布局/测量/节点与连线渲染器，主题仍由 `data-mtn-theme` + styles.css 变量提供），挂 `document.body`，`pointer-events: none` + `aria-hidden` + `inert`，首次 `show` 才惰性创建内部预览，`hide()` 立即隐藏，`destroy()` 幂等。
- `src/ui/menus/theme-menu-hover.ts`：**在菜单容器上做事件委托**（不是逐行绑定）。`pointerover`/`pointerout` 每次事件实时取 `.menu-item` 列表、校验"非 label 行数 === 主题数"再按 DOM 顺序映射；`relatedTarget` 仍在本列表则只换主题不隐藏（不闪断）；`touch` 忽略；`matchMedia("(any-hover: hover)")` 为 false 时不绑定；`scroll`（capture）→ 立即隐藏。
- `src/ui/menus/tree-settings-menu.ts`：`TreeSettingsMenuActions` 新增可选 `previewTheme`/`endThemePreview`，仅主题项接线；主题子菜单 `setUseNativeMenu(false)` 并在父子菜单的 `onHide` 上收尾；两个回调缺失时行为与改动前逐行一致。
- `src/ui/mind-tree-view.ts`：`showThemePreview(theme, row)` 惰性创建面板（读 `plugin.settings.nodeWrapWidth/nodeAlignment`），`onClose`/`clear` 中 destroy 置空。
- `styles.css` 追加 `.mtn-theme-preview`（280×180、fixed、`z-index: calc(var(--layer-menu, 65) + 1)`）；i18n 新增 `theme.preview.root/branchA/branchB/leaf`。

**关于 Obsidian 菜单 DOM 的实测事实（对后续 agent 很重要）**

- 解包本机 `obsidian-1.14.4.asar`：`.menu` 容器在 **Menu 构造函数**里 `createDiv("menu")`，`showAtPosition` 中 `sort()` **同步**把行挂进 `.menu-scroll` 后才 append 菜单；`setTimeout(this.load, 0)` 延后的是 `Component.load`（outside-click/scope），**不负责挂行**。所以"show 返回后立刻取行"在 1.14.4 是可用的；但绑定时机依赖内部实现，**委托**才是稳的（同时抵御 `sort()` 的 `empty()` 重挂）。
- label 行是 `.menu-item.is-label`；`--layer-menu: 65`、`--layer-tooltip: 70`（不是 1000）；`.menu` 自带 `overflow: hidden`；`.menu-scroll` 会滚动且 `scroll` 不冒泡（必须 capture）。
- Obsidian 自己也在菜单根上做 `pointerover` 委托，可作为同版本行为的旁证。

**取舍与未覆盖**

- 复用 `ReadOnlyTreePreview` 时要注意：它的 `.mtn-canvas` 是绝对定位，**不会撑开**父容器；面板必须在 CSS 里给定尺寸，且 `show()` 里先取消 `hidden` 再渲染，否则 `clientWidth/Height` 为 0、首次 fit 永不生效。
- 面板位置按"悬浮行右侧"（用户要求"选项侧"），空间不足翻左时会盖住菜单（`pointer-events: none`，点击仍穿透）；菜单列表滚动即隐藏，不做跟随。
- 弹出窗口边界：`menu.showAtPosition` 未传 doc 时 Obsidian 用 `activeDocument`，若与 `anchor.ownerDocument` 不同则差集取不到容器 → 静默降级（无预览、无报错），符合降级契约。
- 备选方案未采用：`MenuItem.setTitle(DocumentFragment)` 自绘行（可在行上打 `data-mtn-theme`，彻底摆脱"第 N 行 = 第 N 个主题"的位置映射），代价是勾选态/视觉细节要自己维护。
- 仓库无 jsdom，组件级真实观感（深浅色边框、翻转、闪断）需在 Obsidian 里人工验收；本轮用 `esbuild buildSync + node:vm + EventTarget 假 DOM` 跑通了委托事件序列（绑定时 0 行、sort 重建、跨行不 leave、行数不匹配零回调、any-hover 闸、scroll→leave）。
- 示例标题要保持短：用仓库 fallback 测量器实测 `layoutTree`，EN 原标题 `Sample topic / Child node` 使布局宽 381px → fit zoom 0.577（14px 字实际约 8px）；改成 `Topic / Child` 后 275px → zoom 0.800（约 11px），与中文（0.821）持平。面板有效画布 = 280×180 减去 6px 内边距与 `ReadOnlyTreePreview` 固定的 48px 边距。
- 一次误报留档：曾有验证结论称 `read-only-tree-preview.ts` 经 `DisposableUiObject.listen()` 注册了 `.bind()` 过的监听器导致泄漏。实际源码里 `src/ui` 全域没有 `.bind(`，`listen()` 用同一个函数引用 add/remove，`removeEventListener` 按 (type, listener, capture) 身份匹配，不泄漏。看 bundle 里的闭包包装（如 `Closure(o, releasePointers)`）不能当成源码事实。

**环境坑（本沙箱）**

- `npm test` 需放宽沙箱（esbuild spawn 子进程，受限模式报 `spawn EPERM`）；放宽后 531 条全绿。

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

