# memory

## 2026-10-11 · 行内公式与二元运算符重叠（`fix`）

**问题**：节点标题写 `$abccccc+a$` 这类含运算符的公式会错位——`+` 压住第一个 `a`，末尾 `a` 叠在 `c` 上并被放大。

**根因**：MathJax 默认给**每个二元运算符**插入行内断行机会（SVG 输出 `linebreaks.inline`），`handleInlineBreaks` 把一条公式拆成**多个兄弟 `<svg>`**（中间夹 `<mjx-break>`）。`src/ui/inline-math.ts` 当时用贪婪的 `/<svg\b[\s\S]*<\/svg>/` 从第一个 `<svg>` 取到最后一个 `</svg>`，把两段拼进一个字符串，且只按**第一段**的 viewBox 算宽高。调用方随后只给一个 `viewBox`：SVG 没有流式排版，第二段 `<svg>`（保留自己的 `width="3.46ex"`）默认落在 (0,0) 并按 ex 缩放，于是重叠且看起来更大；测得宽度也只覆盖第一段（`abccccc+a` 实测 3.123em，真实 4.874em）。

**落点**：`src/ui/inline-math.ts`
- `new SVG({ ..., linebreaks: { inline: false } })`：标题里一条公式就是一个原子 run，必须一次排完（顺带保住 `a + b` 的二元运算符间距；`gathered`/`matrix`/`aligned` 等环境不受影响）。
- 弃用正则切 markup，改为从容器 `adaptor.childNodes()` 取**直接子级** `<svg>`：`\overbrace` 的拉伸括号是**嵌套** svg，不能算多段；直接子级 ≠ 1 段时返回 `undefined` 走源码兜底（宁可不渲染也不输出重叠 markup）。
- 宽度护栏 `MAX_INLINE_FORMULA_EM_WIDTH = 1024`：行内 `\\` / `\newline` 会把行宽撑到容器（实测 viewBox 宽 1e8 单位），照它缩放会变成看不见的小点，此时显示 `$x\\y$` 源码。
- 属性清理改用 `adaptor.removeAttribute(root, "width"/"height"/"style")`；画布、预览、PNG/SVG 导出共用同一条路径，一处修复三处生效。

**验证**：`test/node-title.test.ts` 新增 2 条（单段 + 运算符间距 + `\overbrace` 嵌套 + 测量宽度 = 公式宽 × 字号 + 富文本 SVG 里只有 2 个 `svg` 根；以及 `x\\y` 源码兜底）。`npm run check` 0 错误；沙箱替代测试 **678 tests / 673 pass / 5 fail**（5 条仍是 esbuild `spawn EPERM` 既有环境失败）。用 headless Edge 渲染了修复前/后对照图人工确认。

## 2026-10-11 · Ctrl/Cmd+F 右侧搜索窗口（`feat`，团队协作）

**需求**：`Ctrl/Cmd+F` 或工具栏「搜索」打开视图**右侧**搜索窗口（不是中央悬浮弹窗）。并行接口契约是 `docs/search-sidebar-spec.md`（临时文件，本轮完成后可删）；`docs/` 产品基线优先于它。

**落点文件（最终）**

- 纯搜索逻辑 `src/ui/search/search-core.ts`（core 队友）：`findMatches` / `buildSnippet` / `searchMindTree`，NFKC + 小写折叠、按字面量匹配（禁止把 query 拼进 RegExp）、`SEARCH_RESULT_LIMIT` / `SEARCH_HITS_PER_CARD_LIMIT`（30）；文件正文懒读入辅助 `readSearchFiles`（预算默认 400 个文件 / 单文件 512 KiB，超限只计入 `skipped`、不截断）见契约 §2.1。
- 面板与载荷 `src/ui/search/search-panel.ts`、`src/ui/search/search-payload.ts`（panel 队友）；CSS 只追加 `.mtn-search-*` 规则到 `styles.css`——`.mtn-search-panel` 是**浮在画布之上的圆角卡片**（与 `.mtn-toolbar` 同参数），不是贴边侧栏。
- 宿主集成 `src/ui/mind-tree-view.ts`（Lead）：`Scope` 注册 `["Mod"]+F`，工具栏「搜索」与快捷键共用同一个打开入口；标题行点击 = 展开祖先 + 选中 + 聚焦节点中心；内容行点击 = `.md` 走 `leaf.openFile(file, { eState: { line: line - 1, ch: 0 } })`（打开位置沿用 `resourceOpenMode`），`.mtn.md` 只打开导图、不跳行。
- i18n：`src/i18n/catalog.ts` 在 EN/ZH 对象**末尾**追加 **9** 个 key：`search.panel.title` / `placeholder` / `close` / `count` / `empty` / `loading` / `truncated` / `clear`、`shortcut.search`（**2026-10-11 已合并为 `toolbar.search`**）；`{count}` 双语一致、两语言相对顺序一致。Lead 另行删除了随中央搜索弹窗一起废弃的 4 个 key（`notice.noMatch`、`modal.search.title`、`modal.search.placeholder`、`action.find`，EN/ZH 同步）。
- 快捷键帮助与契约：真实文件是 `src/ui/menus/keyboard-help-menu.ts`（任务书里的 `keyboard-help.ts` 不存在），在 `Mod+S` 之后追加 `Mod+F → shortcut.search`；`src/ui/ui-contracts.ts` 的 `KEYBOARD_HELP_ACTIONS` 已含 `"search"`（紧跟 `"save"`），`test/ui-modules.test.ts` 固化为断言（`indexOf("search") === indexOf("save") + 1`）。
- 文档：`docs/02` §5.1（信息架构「右侧搜索悬浮框」项 + 一段行为口径）、§5.3 工具栏「搜索」项、§6.3 快捷键列表；`docs/06` P0 验收第 20 条；`README.md` / `README.en.md` 快捷键表各加一行 + 一小段行为说明；契约 §3 的 `SearchPanelLabels` 与 §4 的 key 表补 `truncated` / `clear`，§3 的 DOM 块补搜索图标、清除按钮与路径行层级。

**行为口径（容易漏的点）**

- 窗口**失焦不关闭**，只有右上角 `×` 与 `Esc` 关闭；再次按 `Ctrl/Cmd+F` 只聚焦已打开的窗口。
- **样式口径（用户反馈后重做）**：搜索框**不是侧栏**，而是与顶部工具栏样式统一的**圆角悬浮卡片**——`.mtn-search-panel { position: absolute; top: 62px; right: 12px; width: min(360px, calc(100% - 24px)); max-height: calc(100% - 74px); overflow: hidden; border: 1px solid var(--background-modifier-border); border-radius: 13px; background: color-mix(in srgb, var(--background-primary) 92%, transparent); box-shadow: 0 8px 24px rgb(0 0 0 / 12%); backdrop-filter: blur(10px); z-index: 44 }`，与 `.mtn-toolbar` 共用圆角/描边/半透明/阴影/模糊参数（只差水平居中）。**曾按“右侧贴边侧栏”实现（`top: 0; right: 0; bottom: 0` + `border-left`），用户要求改成悬浮框后于 commit 之前重做样式**；不要再写回 `bottom: 0` / `border-left` / 全高贴边。
- 滚动与分隔：结果区 `.mtn-search-panel-results` 是唯一滚动容器（`flex: 1; min-height: 0; overflow-y: auto`），并与查询行之间用 `border-top: 1px solid var(--background-modifier-border)` 分隔；标题、输入框与关闭按钮固定不滚动。
- **空 query 时结果栏 `hidden`**：`query` 为空（刚打开、清空输入、`setContext` 之后）时 `.mtn-search-panel-results` 整体 `hidden`——**不占空间、不留分割线、不留空白**，卡片只保留标题行 + 输入行；只有“有 query 且 0 命中”才渲染 `.mtn-search-empty`（文本 = `labels.empty`）。（第二轮用户反馈**作废**了第一版的“任何无结果状态都显示空状态占位”。）
- 命中来源：节点名 / 文件名 / **已关联 `.md` 文件的正文**；思维树 `.mtn.md` 不解析正文。每次搜索对进入正文搜索的文件数量与单文件体积有上限，超限只减少命中、不阻塞界面、不读取未关联文件。
- 卡片：标题 = 节点名；同一节点/文件的多段命中用 `hr.mtn-search-card-separator` 分隔，每段单行 + 首尾省略号 + `<mark class="mtn-search-mark">` 高亮。**悬浮（第二轮定稿）**：`.mtn-search-card-title:hover` 只做 `transform: scale(1.02)` + `text-decoration: underline`（`transform-origin: left center`、`transition: transform 120ms ease`），**没有背景/阴影**；**卡片级 `.mtn-search-card:hover` 规则已被删除**（用户明确不要整行背景，取舍是取消整卡高亮、只留标题的放大+下划线与命中行的整行背景）；只有 `.mtn-search-card-hit:hover` 保留整行背景悬浮。
- **单卡命中行上限 30**（`SEARCH_HITS_PER_CARD_LIMIT`，文件名命中占 1 条名额）；被截断的卡片带 `hitsLimited: true`，面板渲染 `labels.truncated` 到 `.mtn-search-card-truncated`（“仅显示前 N 条命中”，N = 实际展示行数）；卡片排序仍按真实命中数，`hitCount` 也是真实总数。
- **点击标题可能改文档**：命中节点在折叠分支内时会先展开祖先，`collapsed` 是持久化字段 → 产生文档修改 + 正常自动保存 + 每个被展开祖先进一步撤销记录（`mind-tree-view.ts` 的 `jumpToSearchedNode` 用 `commit(...)` 落这一步）。文档口径是“搜索本身不修改文档”，不要写成“搜索绝不产生撤销”。

**第二轮细化（同日，用户反馈）**

- **面板标题图标**：`.mtn-search-panel-header` 内、标题左侧是 `span.mtn-search-panel-icon`（`setIcon(..., "search")`、`aria-hidden`）。
- **输入框内清除按钮**：输入有字时，输入框内部最右侧显示 `button.mtn-search-panel-clear`（**28×28**、`setIcon(..., "x")`、`aria-label = labels.clear`、`type="button"`、`tabindex="-1"` 以免打乱 Tab 顺序），query 为空时 `hidden`；点击清空输入与结果、**不关闭窗口**并把焦点还给输入框。输入框是 `padding: 0 32px 0 8px`（清除按钮叠在内部最右侧），并已隐藏浏览器自带的 `::-webkit-search-cancel-button`。i18n key `search.panel.clear`（EN `Clear search` / ZH `清空搜索`）。
- **节点路径——模型字段是 `nodePath`，别和 `path` 混**：`SearchCard.path` 是**文件路径 string**（内容命中与 `openFileAtLine` 用），节点链路必须用 `SearchCard.nodePath?: readonly NodeId[]`（根 → … → 自身，**含自身**；只有 `ancestorIds` 非空时才写入，根节点命中没有这一行）。`ancestorIds` 是 `SearchCandidate` 上**从根开始、不含自身**的快照；但 `SearchContext.nodeAncestorIds?: (nodeId) => readonly NodeId[] | undefined` 是**绝对权威**的惰性回调（宿主用实时父索引，只在存活卡片上调用），core 优先用它、拿不到才退回快照。渲染为 `nav.mtn-search-card-path`，位于标题行之后、第一条命中之前；**标题与路径之间没有分割线**，路径与第一个命中行之间有 `hr.mtn-search-card-separator`（`index > 0 || hasPath`）。
- **路径行显示节点名 + 换行不变量**：路径段文本由 `MindTreeView` 通过 `actions.nodeTitle(nodeId)` 注入（`parseNodeTitle(node.title).plainText`），panel 取不到或为空时回退显示 `nodeId`；没显示名就不会有空白行。结构上每个 flex item 是一个 `span.mtn-search-path-segment`（`display:inline-flex; flex:0 0 auto; max-width:100%`），**箭头与它引入的节点同属这一段**（先 `span.mtn-search-path-arrow`，再 `span.mtn-search-path-link`），第一段（根）只有 link、无箭头。容器 `flex-wrap: wrap`，因此**换行只发生在 segment 之间、箭头不可能落在行尾**；单个超长节点名由 `max-width:100% + overflow:hidden + text-overflow:ellipsis + white-space:nowrap` 省略号截断。样式：链接 `var(--link-color, var(--text-accent))` + 下划线（hover 转 `--text-accent`），箭头 `var(--text-faint)`，整行 `var(--font-ui-smaller)`、`gap: 2px 4px`。
- **命名语义（验收 F1 修）**：`search-payload.ts` 的 `searchedAncestorIds(document)` 原名 `searchedNodePaths`，**已改名**。它返回每个节点的祖先链 `Map<NodeId, readonly NodeId[]>`——**根 → … → 父，不含自身**，对应 `SearchCandidate.ancestorIds` 而**不是** `SearchCard.nodePath`；需要 root-to-self 的调用者必须自己补上自身。搜索路径优先用 `buildSearchParentIndex` + `nodeAncestorIds`（惰性、只算存活卡片），这个 eager map 给需要一次性全量链的调用者；不要把两者混用。
- **失效应答收起（验收 F3 修）**：`search-panel.ts` 的 `runSearch` 在宿主返回 `undefined`（“输入已过期”）**或抛错**时执行 `clearResults()`——结果区 `hidden`、计数隐藏、**窗口保持打开**，不再无限停在 loading 空盒；与空 query 的收起一致。对应测试断言 `results().hidden === true` + `count().hidden === true` + 面板仍打开。

**环境与验证（本沙箱，替代命令未变）**

- `npm run check` = **0 错误**（2026-10-11 最终态）。
- `npm test` 仍必失败（tsx → esbuild `spawn EPERM`）。替代：`& "C:\Users\Dayiy\AppData\Local\Temp\dsh-mtn-hooks\run-tests.ps1"`，单文件加 `-Pattern "test/xxx.test.ts"`（也接受 `test/search-*.test.ts` 这类 glob）；完整输出写到仓库根 `.mtn-test-run.log`（**未跟踪，提交前删除或忽略**）。
- `test/search-*.test.ts` = **101/101 全绿**（task-17 在 F1 改名 + F3 失效应答修完后复核仍为 101/101；第一轮收尾时为 80/80，中途曾出现 1 条新样式断言在 panel/CSS 落地前变红，落地后消失）。`test/i18n.test.ts` = **6/6 全绿**。
- 全量 = **676 tests / 671 pass / 5 fail**（task-17 复核值，与 F1/F3 修完前一致；第二轮落地后的最终实测值）。5 条失败全部是直接调 `esbuild buildSync` 的既有环境失败：`adaptive-tooltip`、`custom-markers-settings-page`、`marker-popover-custom`、`plugin-update-modal`、`top-toolbar`；逐个单独复跑都是 `spawn EPERM`、0 条用例执行，与仓库代码无关（历史快照：task-5 验收时 654/649/5、第二轮落地前 655/650/5）。
- **坑（重要，别被 EXITCODE=0 骗）**：`test/theme-menu-hover.test.ts` 也把 `buildSync` 放在模块顶层（第 101 行）。异常发生在用例注册之后，Node test runner 只统计已注册的前 7 条（全 pass），**其余 11 条（该文件共声明 18 条用例）被静默吞掉**，文件级异常也不计入 fail。它既不是本轮回归、也**不能**当通过证据；怀疑某文件没跑完时按文件单独跑并检查 `.mtn-test-run.log`。

**未完成 / 建议下一步**

- **真实 Obsidian 内的人工验收尚未做**（仓库无浏览器环境）：悬浮框滚动与不遮工具栏、标题图标与输入框内清除按钮（28×28、悬浮与点击命中区）、空 query 时结果栏是否完全收起（无分割线/空白）、卡片路径行显示节点名且逐段可点、长路径换行（箭头不落行尾）与超长节点名省略号截断、标题悬浮 scale+下划线且**卡片级没有整行背景**、命中行整行背景悬浮、点击内容行后 `leaf.openFile(eState)` 的光标是否落在正确行、`Ctrl/Cmd+F` 与宿主全局 find 的先后（view scope 应优先，需实测）、移动端触摸目标与窄屏表现。
- **view 集成没有自动化测试**：`openSearchPanel()` 的创建/销毁、`Mod+F` 注册、展开祖先与 `centerNodeInViewport` 的接线只经类型检查与人工验收兜底，后续回归需手工覆盖。
- 已知取舍：输入框右侧计数按契约显示**命中的结果（卡片）数量** `cards.length`，不是 `hitCount`（总命中段数）；卡片数另有 `SEARCH_RESULT_LIMIT = 200` 上限，超过 200 张时计数停在 200。`hitCount` 目前只用于排序，UI 未消费。
- 契约 `docs/search-sidebar-spec.md` 的 DOM 结构块已补 `.mtn-search-card-truncated`；该文件是**本轮临时契约**，后续可把长期有效部分并入 `docs/02`/`docs/05` 后删除。

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

## 2026-10-11 · 自定义标记 ZWJ 缺陷 + 节点文本/资源模块合并（`fix` + `refactor`）

**缺陷（`fix`）**：`cleanCustomMarkerValue(value, kind = "tag")` 全仓 7 个调用点里 5 个正确传 `kind`，只有 `src/domain/markers.ts` 的 `normalizeNodeMarkers` 与 `src/ui/resource-badges.ts` 的 `customMarkerKey` 漏传 → `kind="emoji"` 误用 tag 的严格 pattern（`\u200B-\u200F` **含零宽连接符 U+200D**）→ 家庭 emoji 👨‍👩‍👧‍👦 被剥成 4 个独立字形。

**纠正根因叙述（重要）**：1.1.7 的 `customMarkerKey` 与 `normalizeNodeMarkers` 用的是**同一个** cleaner，两侧键一致，**所以 1.1.7 徽标并不消失**；1.1.7 的真实症状是**载入时值与 Markdown 大纲被静默降级（ZWJ 丢失）并写回**。"徽标消失"是**修复之后**对**已被 1.1.7 降级过的存量文件**才出现的新现象——因为注册表键变成保留 ZWJ，而降级值没有 ZWJ。修这类问题**必须同时考虑存量降级数据的兼容**，否则修好"新数据"却打坏"旧数据"。

**落点**：`markers.ts` 传 `category`；`resource-badges.ts` 的 `customMarkerKey` 传 `kind`；并新增 `legacyCustomMarkerKey` + `lookupCustomMarker` 双键回退，`createResourceBadgePresentation` 建注册表时**同时登记 kind-aware 键与旧键**（`registerCustom`），使存量降级值仍能解析（不回写、不猜测、不误伤新值）。

**合并（`refactor`，纯搬迁）**：`src/ui/rich-title.ts`(104 行) → `text-measurer.ts`(503 行)，顺带把重复的 grapheme 分段器合一（复用 `splitGraphemes`，`Intl.Segmenter` 实例 2→1）；`src/ui/resource-controls.ts`(29 行) → `resource-badges.ts`。`src` 文件数 135 → 133。两者都只改 import 路径，**零测试断言改动**（仅 2 行 import 路径 + 3 行测试 import 合并）。

**等价性验证方法（可复用）**：`.audit/fingerprint.ts` —— 对 33 组纯函数输出做 sha256 行为指纹，合并前后 digest 必须逐字节相同。本轮的 digest 演变（复现假阴性时需要分清）：原始 blind harness（两段盲段都在）= `32c0ecc1…de86`，**修复前后完全相同 → 假阴性**；修好第一段后 = `939e39a0…5f02`（T2/T3/T4 三态一致，即合并等价性的可信证据）；两段都修好后 = `7afde70c…d51e11`（兼容性回退前后亦相同）。**该工具本身踩过两个坑**：① `normalizeNodeMarkers()` 收**marker 数组**、返回**marker 数组**，harness 曾把返回数组当 node 用 → 该段恒空、对 digest 零信号（**假阴性，已修**）；② `nodeTitleMode(value)` 把字符串当 node 传 → 该段恒 `"title"`（**仍有弱段，未修**）。另：指纹**绕过 settings→registry 归一化**，所以它**对兼容性修复完全盲**（pre/post fallback 同 digest）——**兼容性必须靠端到端往返测试**（审计员用 `.audit/t1/roundtrip.mjs` 复现 1.1.7 首存 / 降级重存 / 1.1.8 读取三种文件，并用 `probe-fallback.mjs` 九格矩阵验误报安全）。

**环境坑（本轮新增，重要）**：**禁止用 shell（`Set-Content`/`Out-File`）重写仓库内源文件**。本仓库中文文案极多，PowerShell 往返编码会把 `markers.ts`/`resource-badges.ts` 写成 U+FFFD 与 mojibake；本轮发生过一次，靠 `git checkout --` + edit 工具重做修复。判断 mojibake 必须看**字节**（`TextDecoder("utf-8",{fatal:true})` + U+FFFD 计数），不要看 Console 呈现（会出现假警报）。

**验证**：`npm run check` 0 错误；`npm test` **735 tests / 735 pass / 0 fail**（新增 3 条 ZWJ 相关回归：`markers.test.ts`、`export-custom-markers.test.ts` ×2，含"已被降级的旧值仍能解析"）。`manifest.json` 1.1.7 → 1.1.8 是**开工前既有的工作区改动，不是本轮产物**，需发布方确认。

## 2026-10-09 · 未决冲突记录的孤儿清理（`feature`）

**问题**：源文件被删除/移动后，`pending-conflicts/<本机标识>/*.json` 记录会永久保留，启动时反复提示"无法确定已保存版本对应的文件"，且活动会话的冲突锁（`mutationLocked`）因 `requireFile()` 抛 `file.missing` 而无法通过"保留版本"按钮解开。

**结论与落点**

- 创建记录的入口只有一个：`checkExternalVersion()` 发现磁盘文件不存在 → `enterVersionPreview()` → `VersionConflictCoordinator.enter()`。删除事件和重命名竞态都会走到这里。
- 决策纯函数：`resolvePendingConflict()`（`src/services/pending-conflict-store.ts`）——`live` / `rebind` / `stale-path` / `retain`，只看证据，不猜路径。
- 编排：`MindTreeNaturePlugin.reportUnlocatedPendingVersions()`（`src/main.ts`），启动时**等资源索引重建完成后**执行；`vault.delete` 与 `vault.rename` 事件用 800 ms 防抖再跑一次。
- 解锁：`VersionConflictCoordinator.discard()` / `abandon()`（`src/services/version-conflict-coordinator.ts`）清记录 + 清内存冲突态；清理失败也必须解锁。
- 新文案：`conflict.discarded`（中英各一条）；`conflict.unlocated` 仅保留给 `retain` 分支（**2026-10-11 复核为零引用，该 key 已删除**）。
- 文档同步：`docs/02` §冲突段、`docs/03` §7.6、`docs/06` 验收项。注意：本条实现后，第 1 条"删除即创建记录"的入口已由下一轮的删除修复移除，`pendingPaths`/`retain` 分支主要剩启动恢复与移动歧义两种来源。

**仍在的限制**

- 记录里的本地冻结版本（`currentSource`/`draft`）随记录一起丢弃，用户选择"不备份"；若源文件其实是被同步客户端移走且 `documentId` 不唯一，则保留记录并报错。
- 编排层（`main.ts`）没有单元测试：`npm run check` 覆盖类型，行为靠上述纯函数与 store/coordinator 测试守护。若要补集成测试，需要先有可注入的 App/vault 端口。**（2026-10-11 部分改善：未决冲突维护已提取为 `src/services/pending-conflict-maintenance.ts`，用 ports + 注入时钟，可脱离 Obsidian 测。）**

## 2026-10-11 · 模块「合并 / 简化」审计落地（`refactor`，团队协作）

**背景**：先由 5 人团队做只读审计（报告落在 `.audit/merge-simplify-audit-2026-10-11.md`，gitignored），再按「除不建议做外逐项落实」分成 9+ 个提交落地。基线未变：`src/` 141 个 `.ts`、`test/` 71 个 `*.test.ts`、**686 用例 / 681 pass / 5 条 esbuild `spawn EPERM` 环境失败**；`npm run check` 0 错误。

**落点（按提交顺序）**

1. 重复判定收敛：`input-limits.ts` 新增 `asRecord`/`stringValue`（5 份窄化 → 1）与 `exceedsNodeBudget`/`exceedsDepthBudget`（14 处手写上限比较 → 2 个谓词，边界与 `node-count`/`tree-depth` code 逐字保留）；新增 `domain/url.ts`（`parseSafeHttpUrl`/`isSafeHttpUrl`，收敛 3 份逐字相同实现，`clipboard-payload` 与 `text-url` 保留各自归一化语义）；`format/resource-id.ts` 新增 `sanitizeFileTitle` 与 **`isMindTreePath`**；会话注册表复用 `canonicalTreePath`；4 处 JSON 克隆改 `structuredClone`；新增 `payloadRootIds`。
2. `src/numeric.ts`（`clamp` 5→1）、`src/lru-cache.ts`（`evictOldest` 5→1）、`render/color.ts`（`readableTextColor`）；`export.ts` 与画布共用 `readableTextColor`/`escapeTitleXml`。
3. i18n：删 4 个死 key（`toolbar.layout`、`conflict.unlocated`、`notice.skippedFile`、`settings.layout.desc`），合并 10 组中英同值 key（5 份 `settings.*.desc` → `settings.defaultValue.desc`；`shortcut.search` → `toolbar.search`；folder 相关 → `folderPicker.*`）。
4. `ui/folder-picker.ts`（两个 modal 的文件夹选择器合一）、`ui/theme-dataset.ts`（主题 dataset 单一赋值）、`StatusIndicator` 并入 view-shell、`DocumentSafetyPanel` 并入 version-comparison；删除 `ui/clipboard-controller.ts`、`ui/modals.ts`、`components/status-indicator.ts`、`components/document-safety-panel.ts`。
5. 删死代码/过期导出：`escapeMarkdown`、`estimateTextWidth`、`searchedAncestorIds`、`get visible()`、`moveNode`/`extractBranch`/`insertBranch` 单数包装（测试改用复数版）、`countEmojiMatches` 复用 `searchEmoji`。
6. `main.ts` 882→779：`addViewCommand` 收敛 9 条命令壳、`createParseOptions` 单一映射、`PendingConflictMaintenance`（ports + 时钟注入）。`services/serial-lane.ts` 收敛 4 处尾指针：**A 族 `serial()` 保留失败尾、B 族 `serialNormalized()` 尾指针永不 reject**（`SettingsPersistence.flush()` 依赖它可 await/引用比较），两族语义显式命名而不是塞进一个布尔；`test/serial-lane.test.ts` 4 条直接覆盖。设置页改表驱动。
7. `ui/controllers/search-controller.ts`：搜索面板 + 候选/正文缓存下沉，视图 3870→3788 行；**陈旧读取三重判据（`viewClosed`、`documentSessionToken`、`document` 同一性）与 `searchRevision` 单调递增原样保留**。
8. 结构性：新增中性层 **`src/render/`**（9 模块）——`layout`/`presentation`/`theme-presets`/`color`/`inline-math`/`viewport` 整体迁入，`text-measurer`/`resource-badges`/`image-nodes` 拆成「纯逻辑在 `render/` + `Browser*` DOM 适配留在 `ui/`」；`services/export.ts` 不再 import `ui/`，**services → ui 反向依赖清零**（含 `workspace-update-host` 的 type-only `ViewportState`，已随 `render/viewport.ts` 归位）。

**环境坑（本轮新增，重要）**

- **⚠ 用户实测回归：搜索失效（同日 `fix` 修复，提交 `c14badb`）**。根因：`search-controller` 下沉时，`onLoadFile` 里原来的「清空 `searchCandidateCache`/`searchContentCache`」被改写成 `this.searchController?.destroy(); this.searchController = undefined;`，而控制器**只在 `buildShell()`（`onOpen` 时一次）创建并 `mount()`**，没有任何地方重建。于是打开任意导图后 `searchController` 恒为 `undefined`：`Mod+F` 命中 `if (!event.defaultPrevented || !this.searchController) return;` 直接返回，工具栏搜索按钮的 `searchController?.open()` 变成空操作。修复：`SearchController` 新增 `reset()`（只丢上一份文档的候选/正文缓存，**保留面板与 DOM**，语义等同旧的两行清理），`onLoadFile` 改调 `reset()`；`destroy()` 仍只在 `onClose` 与 shell 重建时出现。并新增 `test/search-view-wiring.test.ts` 三条源码级断言（已确认在修复前版本上会失败）。
  **教训（对所有重构都适用）**：`MindTreeView` 的接线没有 DOM/集成测试，凡是生命周期改写（销毁 / 重建 / 清缓存 / 注册），必须用 `git show <base>:src/ui/mind-tree-view.ts` **逐段对照**旧实现，不能只靠"类型检查 + 已有测试"通过就认为等价——这次 `npm run check` 与 686 条用例全绿，功能却坏了。
- **workspace-write 沙箱不允许删除文件，也不允许写 `.git/index`**：`Remove-Item` 与 `git add/commit` 都会报 "访问被拒绝 / Permission denied"。两者都需要一次性提权（工具参数 `sandbox_permissions: danger-full-access`），Lead 已用它将删除与提交各批量完成一次。给后续 agent：**不要**因为删除失败而用"清空文件"绕过。
- `edit` 偶发 `ReplaceFileW EIO (Win32 1175)`：这是并发读写导致的瞬时错误，**原样重试即可**（本轮出现 10 余次，重试全部成功）。
- 多 agent 并发改同一文件时行号会漂移，必须"重读再改"；`input-limits.ts`、`domain/tree.ts`、`resource-index.ts`、`mind-tree-view.ts` 被 2–3 条线改过。
- **`services/*.ts` 不能 `import { t } from "../i18n"`**（除已有 obsidian mock 的测试）：`node_modules/obsidian` 的 `main: ""`，会让直接 import 该服务的测试在**加载期** `ERR_MODULE_NOT_FOUND`。`export.ts` 因此无法用 `t("node.untitled")`，EN 空标题节点的导出仍按 `DEFAULT_NODE_TITLE`（中文）测量，与画布有细微差异——**待产品决策**（给导出加可选 `untitledTitle`，或给测试补 obsidian mock）。
- `test/theme-menu-hover.test.ts` 的"顶层 `buildSync` 吞掉 11 条用例"问题仍在（见上一轮记录），全量数字里它只贡献 7 条。

**未做 / 待办**

- docs 漂移已在本轮同步 `AGENTS.md`（结构、计数、依赖方向、落点表、shim 段落）与 `docs/search-sidebar-spec.md` 的 key 引用；`docs/search-sidebar-spec.md` 本身仍是**临时契约**，长期内容宜并入 `docs/02`/`docs/05` 后删除。
- 审计报告里明确「不做」的项：合并 `buildShell()`（235 行内约 120 处 `this.*`，是状态机不是装配层）、合并 `validateDocument`/`validateForest`、合并三处 Frontmatter 正则（拒绝条件不等价，数据安全红线）、`document-settings-state` 的 WeakMap 记账、视觉常量与格式字节。
- `.audit/` 仍是 gitignored 草稿区（含本次报告与旧等价性指纹工具），未清理。
- `manifest.json` 1.1.7→1.1.8 仍是开工前既有的未提交改动，**未提交**（由发布方确认）。

## 2026-10-12 · 关联节点：单向引用 + 跳转标志（`feat`）

**需求（中途变更，务必按最终口径读）**：最初讨论的是"软链接式映射、子节点完全复制、修改双向同步、关联/被关联双方都加标志、链接域 `id<-->id`"。**用户随后收窄为**：不复制、不同步、不改动任何一方的子节点；只在**发起关联的源节点**尾部（打开按钮之前）加一个可点击的链接标志，点击后跳转到被关联节点；链接域符号改为**单向** `idA->idB`；源节点已有关联资源时提示"该节点已存在笔记，无法关联"并拒绝。**镜像/同步引擎与"丢弃子节点确认弹窗"均未实现，不要再按旧描述补。**

**数据模型与格式**

- `MindTreeNode.nodeLink?: NodeId`（`src/types.ts`）：同文档内的**有向**引用，节点最多一条出边；入边可多条（枢纽场景），允许 A→B 与 B→A 并存（纯跳转，不构成数据共享）。只进压缩 JSON，**不提升 `schemaVersion`**、不进 YAML、不新增文档设置项。
- 创建前置条件（`createNodeLink` 内校验，UI 只是提前给提示）：源/目标存在、`sourceId !== targetId`、源 `resource === undefined`、源 `nodeLink === undefined`。**目标不做任何限制**。
- 大纲（`src/format/outline.ts`）：参与关联的节点行尾追加 ` ^<节点id>`（块 id 复用节点自身稳定 id，只保留 `[A-Za-z0-9-]`）；大纲列表之后、`OUTLINE_END` **之前**追加 `<!-- mtn:links -->`，每行 `<源id>-><目标id>`，无关联时整块不输出。**必须在 `OUTLINE_END` 之内**：`serializeMindTreeFile` 只重建 `OUTLINE_START..OUTLINE_END` 之间的内容，写在域外会被当成用户正文跨保存累积。`renderBranchMarkdown` 保留 `^id`、不带链接域。

**落点**

- 领域：`src/domain/node-link.ts`（新）：`NodeLinkEdge`、`NodeLinkError`(code)、`getNodeLinkTargetId`、`isNodeLinkParticipant`、`collectNodeLinks`（文档序）、`createNodeLink`、`removeNodeLinks`（清自身的出边 + 所有入边，返回条数；子节点一律不动）、`nodeTitlePath`（`根 → … → 节点`，供选择器/提示）。
- 引用修复（放在 `src/domain/tree.ts`，与 `updateFileReferencePaths` 同类，且避免 `node-link ↔ tree` 循环导入）：`pruneNodeLinksAfterRemoval`（`deleteBranch`/`deleteNodeOnly` 内调用）、`pruneDanglingNodeLinks`（`normalizeDocument` 加载期调用，丢弃自引用/指向不存在节点的值）；`insertBranches` 明确剥离副本里的 `nodeLink`。
- 持久化：`domain/runtime-node.ts` 读 `nodeLink` 并加入 unknownFields 忽略键；`format/document.ts` 的 `nodeToMachineData` 写出。
- 渲染：`render/resource-badges.ts` 的 `NodeResourceControls` 新增 `hasNodeLink`，控制列固定顺序 **同步关闭标志 → 链接标志 → 打开按钮**（打开按钮永远最后）；`node-render-model` 暴露 `hasResource`（是否真有资源）/`hasNodeLink`/`nodeLinkTargetId`/`nodeLinkMissing`，`hasResourceControls` 改为"控制列宽度 > 0"（否则只有 nodeLink 的节点不会渲染尾部）；`node-renderer` 渲染 `button.mtn-link-mark`（`setIcon "link"`，缺失目标加 `.is-missing`）。
- UI：`ui-contracts.ts` 的 `TOP_TOOLBAR_ORDER` 在 `markers` 后插入 `link-node`、`NodeMenuItemId` 加 `node-link`；`node-context-menu.ts` 在「节点标记」正下方加「关联节点/取消关联节点」（图标 `link` ↔ `CHAIN_BROKEN_ICON`）；`top-toolbar.ts` 新增按钮并在 `update()` 内切换图标与 `aria-label`；`models.ts` 的 `TopToolbarState` 加 `nodeLinked`；`touch-gesture.ts` 的控制动作联合加 `"node-link"`；`ui/modals/node-link-picker-modal.ts`（新）用 `FuzzySuggestModal` 按标题路径选目标；`mind-tree-view.ts` 新增 `toggleNodeLink` / `createNodeLinkFor` / `goToLinkedNode`，并把搜索跳转的"展开折叠祖先 → 选中 → 居中"抽成 `revealNode()` 供两处共用。
- i18n 13 个 key（EN/ZH 成对）：`menu.linkNode`、`menu.unlinkNode`、`toolbar.linkNode`、`toolbar.unlinkNode`、`node.goToLinkedNode`、`node.nodeLinkMissing`、`modal.nodeLink.*`（title/placeholder/empty）、`notice.nodeLinkCreated/Removed/BlockedByResource/Missing`。
- CSS：`.mtn-link-mark` 复用打开按钮的 20px 中性灰样式；宽度类组合 `has-node-link` / `has-resource.has-node-link` / `has-resource.is-title-sync-off.has-node-link` = 22 / 44 / 66px。

**踩坑（会直接弄红既有测试）**

- **尾部控制的 CSS 类名不要以 `.mtn-node` 开头**：`test/touch-routing.test.ts` 的 DOM 桩把 `selector.startsWith(".mtn-node")` 一律当作节点元素，`mtn-node-link` 会让 `targetFor()` 把普通节点误判为控制项，4 条 touch-routing 用例变红。改名 `.mtn-link-mark` 后全绿（与 `mtn-resource-open`、`mtn-fold-button` 同类命名）。
- `test/styles.test.ts` 是源码字符串断言：`node-renderer.ts` 里必须**原样保留** `if (!visual.hasResourceControls) return;`、`if (visual.titleSyncDisabled)`、`setIcon(openButton, SHARE_SQUARE_ICON)` 与打开按钮的点击处理器写法，且 `styles.css` 的 `.mtn-node-controls > .mtn-resource-open:active` 规则块不能改。
- `has-resource` 类保留"真的有资源"的语义（新增 `has-node-link`），否则只有 nodeLink 的节点会让 CSS 组合与实际控制数不一致。
- 只读预览会禁用 `.mtn-resource-open, .mtn-link-mark`（`ReadOnlyTreePreview` 的 `goToLinkedNode` 传 noop）。

**验证**：`npm run check` 0 错误；`npm test` **756 tests / 756 pass / 0 fail**（新增 `test/node-link.test.ts` 10 条、`test/resource-badges.test.ts` 1 条，并扩展 `ui-modules`/`top-toolbar` 契约断言）；`npm run build` 通过。

**未完成 / 待产品确认**

- 未在真实 Obsidian 内人工验收：图标观感、点击跳转的居中与折叠展开、移动端点按命中区。
- "状态栏的图标也改变"按"**顶部工具栏按钮图标** link ↔ 取消关联"实现，**底部左下角状态栏未改**；若用户确指底部状态栏，需补 `BottomStatusBarState.nodeLinked` + 面板第 4 个图标按钮 + CSS/i18n（纯增量）。
- 块 id 复用节点自身 id（不新增持久字段）；若要短块 id，可改为节点新增 `blockId`（首次参与关联时生成、取消关联时移除），其余契约不变。
- 未新增命令面板命令与快捷键（本轮范围外）。

## 2026-10-13 · 关联节点尾部错位 + 无效打开按钮（`fix`）

**用户报告**：关联后的节点尾部出现两个图标（链接标志 + 打开文件按钮），链接标志压在标题文字上；而且那个“打开文件”标志点了没反应。

**根因（一个，不是两个）**：`NodeRenderer.renderResourceControls()` 里**打开按钮是无条件创建的**——改动前整个方法只在节点有资源时被调用（`hasResourceControls === hasOpenButton`），所以没人注意。2026-10-12 把门禁改成“控制列宽度 > 0”（为了让只有 nodeLink 的节点也渲染尾部）之后，**只有 nodeLink 的节点也会多渲染一个打开按钮**：CSS 只预留一个 22px 槽位却塞进两个 20px 控件，flex `justify-content: flex-end` 让多出来的按钮向左侧溢出，于是链接标志盖住标题；而那个多出来的打开按钮背后没有资源，`openResource` 自然什么都不做。

**修复**

- `src/ui/renderers/node-renderer.ts`：打开按钮改为 `if (!visual.hasResource) return;` 之后才创建（`hasResource` = 真的有资源且未被节点关联顶掉）。`test/styles.test.ts` 断言的四段源码字符串（`if (!visual.hasResourceControls) return;`、`if (visual.titleSyncDisabled)`、`setIcon(openButton, SHARE_SQUARE_ICON)`、打开按钮点击处理器原文）全部保留。
- `src/render/resource-badges.ts`：**节点关联占用节点唯一的“关联槽位”**——`hasOpenButton = resource && !nodeLink`，`titleSyncDisabled` 也要求 `hasOpenButton`（同步关闭标志不能脱离打开按钮单独占位）。于是渲染出的控件数与预留宽度永远一致：只有 nodeLink = 22px/1 个，有资源 = 22 或 44px，两者并存 = 22px/1 个（链接标志优先）。
- `styles.css`：删掉因此不可达的 `.mtn-node.has-resource.has-node-link`（44px）与 `.mtn-node.has-resource.is-title-sync-off.has-node-link`（66px）两条规则，只留 `.mtn-node.has-node-link` 22px。
- `src/ui/ui-contracts.ts`：`nodeResourceMenuItemOrder()` 在 `!hasResource && !nodeLinked` 时才给出“添加笔记 / 从模板添加文件 / 关联已有文件 / 链接网页”——已被节点关联的节点不再提供创建资源的入口（`nodeLinked` 作为可选入参，既有调用无需改动）。
- `src/ui/association-target.ts`：`isAssociationTargetAvailable()` 增加 `!node.nodeLink`，从 `Ctrl/Cmd+E` 与菜单两条路径上阻止给已关联节点再加文件资源；失败走既有提示 `notice.associationTargetChanged`（“目标节点已变化或已有链接”）。
- 读取不做互斥清理：历史数据里 `resource` 与 `nodeLink` 并存时两者都保留，只由渲染/菜单体现互斥，不静默丢字段（`docs/03` 已写明）。

**新增回归测试（关键）**：`test/node-renderer.test.ts` —— 用 `esbuild buildSync + node:vm + 手写假 DOM`（照抄 `test/top-toolbar.test.ts` 的隔离手法，`require("obsidian")` 桩要提供 `setIcon` **和** `getLanguage`，否则 `t()` 在加载期抛错）真实跑 `NodeRenderer.render()`：
- 只有 `nodeLink` 时控制容器**只有 1 个子元素**且是 `.mtn-link-mark`，`.mtn-resource-open` 数量为 0（这条正是本次缺陷）；
- 点击链接标志触发 `goToLinkedNode`（修复“点了没反应”的证据链）；
- 有资源时只渲染打开按钮并触发 `openResource`；
- 资源 + 关联并存时只剩链接标志，且同步关闭标志也不渲染；
- 只读预览下图标 `disabled` / `tabIndex = -1`，点击不触发（假 DOM 的 `click()` 必须在 `disabled` 时直接返回，才是真实按钮语义）。

**验证**：`npm run check` 0 错误；`npm test` **760 tests / 760 pass / 0 fail**；`npm run build` 通过。

**这次的教训（可复用）**：把某个方法的**调用门禁放宽**时，必须逐个核对方法内部的**无条件副作用**（这里是“总是创建一个按钮”）。判据不是“类型检查过了”，而是“渲染出的元素数量与布局预留的数量必须一致”。带 DOM 的渲染器值得有至少一条真实渲染的断言，纯函数测试（`createNodeVisualState`）看不到这类缺陷。



