# 右侧搜索窗口 · 接口契约（本轮并行开发的唯一事实来源）

> 状态：临时实现契约（本轮任务完成后可删）
> 需求来源：用户本轮原始需求 + `docs/requirements.md` 全局约束 7 / 20，`docs/02-interface-interactions.md` §5.3
> 目标基线：`docs/` 优先于本文件；本文件只固定"谁写哪个文件、暴露什么接口"，避免并行冲突。

## 0. 最终交互结果（验收口径）

1. `Ctrl/Cmd+F` 打开**右侧搜索窗口**（不是中央悬浮弹窗）。窗口常驻，**失焦不关闭**。
2. 关闭方式只有两种：右上角 `×`，或按 `Esc`。
3. 窗口高度有限（`max-height`），搜索结果区域**可滚动**。
4. 输入时实时（防抖后）在**输入框右侧**显示匹配到的内容数量。
5. 输入框下方用**卡片**实时列出"相关节点"：命中来源三选一或组合——节点名、文件名、文件内容（**只有 `.md` 文件解析内容**）。
6. 卡片标题 = 节点名称；正文 = 命中的文件内容。
7. 一个节点/文件有多个命中部分时，用**分割线**分隔每个命中部分。
8. 每个命中部分**只显示一行**，首尾被截断处用**省略号**标识，并**高亮关键字**。
9. 卡片标题行与每个卡片内容行都是**可单独悬浮高亮**的可点击行。
10. 点击标题行 → 跳转到节点并把视图聚焦到节点中心；点击内容行 → 直接打开对应文件并把光标聚焦到对应行。

## 1. 文件所有权（写范围，越界即冲突）

| 文件 | 所有者 |
| --- | --- |
| `src/ui/search/search-core.ts` | core 队友 |
| `test/search-core.test.ts` | core 队友 |
| `src/ui/search/search-panel.ts` | panel 队友 |
| `test/search-panel.test.ts` | panel 队友 |
| `styles.css`（只追加 `.mtn-search-*` 规则） | panel 队友 |
| `src/i18n/catalog.ts` | docs 队友 |
| `src/ui/menus/keyboard-help.ts` | docs 队友 |
| `docs/02-interface-interactions.md`、`docs/06-quality-roadmap.md`、`README.md`、`README.en.md`、`docs/memory.md` | docs 队友 |
| `src/ui/mind-tree-view.ts`、`src/ui/ui-contracts.ts`、`src/main.ts`、必要时 `src/services/*` | Lead |

任何人不得修改上表之外的文件；发现必须改别处时，先发消息给 Lead。

## 2. 共享类型契约

core 队友在 `src/ui/search/search-core.ts` **导出**下列类型与函数；panel 队友**只 import 类型**，不复制定义。

```ts
/** 精确命中区间：[start, end) 字符下标，start < end。 */
export type SearchRange = readonly [start: number, end: number];

/** 命中来源：节点标题 / 文件名 / 文件内容。 */
export type SearchHitSource = "title" | "file" | "content";

export interface SearchHit {
  readonly source: SearchHitSource;
  /** 1 起算的行号；标题与文件名命中为 1。 */
  readonly line: number;
  /** 单行展示文本：首尾截断处用 "…"（U+2026）标识。 */
  readonly text: string;
  /** text 中被高亮的字符区间，按 start 升序、互不重叠。 */
  readonly ranges: readonly SearchRange[];
}

export interface SearchCard {
  readonly nodeId: NodeId;
  /** 卡片标题：节点名；标题被命中时 titleHit 非空。 */
  readonly title: string;
  readonly titleHit?: Extract<SearchHit, { source: "title" }>;
  readonly resourceId?: ResourceId;
  readonly path?: string;
  readonly fileName?: string;
  /** 非标题命中，按渲染顺序排列；标题命中不重复出现在这里。 */
  readonly hits: readonly SearchHit[];
  /** 命中行被 SEARCH_HITS_PER_CARD_LIMIT 截断时为 true；未截断时字段缺席。 */
  readonly hitsLimited?: boolean;
}

export interface SearchResult {
  /** 输入框右侧显示的数量 = cards.length。 */
  readonly cards: readonly SearchCard[];
  /** 命中总数（含同一节点的多个命中部分）。 */
  readonly hitCount: number;
}

export interface SearchCandidate {
  readonly nodeId: NodeId;
  /** Markdown 源码标题，用于展示。 */
  readonly title: string;
  /** 纯文本标题，用于匹配。 */
  readonly plainTitle: string;
  readonly resourceId?: ResourceId;
  readonly path?: string;
  readonly fileName?: string;
}

export interface SearchContext {
  readonly candidates: readonly SearchCandidate[];
  /** key = `path`，value = 文件全文；只有 `.md` 文件提供。 */
  readonly fileContents: ReadonlyMap<string, string>;
}

export const SEARCH_RESULT_LIMIT: number;        // 建议 200
export const SEARCH_HITS_PER_CARD_LIMIT: number; // 30，单卡片命中行上限
export const SEARCH_SNIPPET_BEFORE: number;      // 建议 12
export const SEARCH_SNIPPET_AFTER: number;       // 建议 40

/** 大小写不敏感（NFKC 折叠后）找出 text 中所有非重叠命中。空 query 返回 []。 */
export function findMatches(text: string, query: string): readonly SearchRange[];

/** 单行片段：围绕 [start,end) 截取并按需加 "…"；ranges 相对返回文本。 */
export function buildSnippet(text: string, ranges: readonly SearchRange[]): { text: string; ranges: readonly SearchRange[] };

/** 纯函数搜索：不做任何 I/O、不写全局状态、可重复调用。 */
export function searchMindTree(ctx: SearchContext, query: string): SearchResult;
```

### 2.1 懒读入辅助（宿主导入用，core 一并导出）

大仓库不能每敲一个键就把全部 `.md` 读一遍。宿主按下面的流程懒读：

```ts
/** 折叠函数：NFKC + trim + toLowerCase；query 与文本都用它。 */
export function normalizeSearchText(value: string): string;
/** 折叠后的 query 按空白切词；空 query 返回 []。 */
export function queryTokens(query: string): readonly string[];
/** 折叠后字符串中的字面量区间，区间基于**原始** text 下标。 */
export function matchesInText(text: string, tokens: readonly string[]): readonly SearchRange[];
/** 折叠后是否包含所有 token（只判断"要不要读"）。 */
export function matchesSearchText(text: string, tokens: readonly string[]): boolean;
export function matchesSearchQuery(text: string, query: string): boolean;

export interface SearchFileBudget {
  /** 每次搜索最多读这么多文件；默认 400。 */
  readonly maxFiles?: number;
  /** 单文件最多读这么多字符；默认 512 * 1024。 */
  readonly maxCharactersPerFile?: number;
}

export interface SearchFileReader<T> {
  /** 节点顺序去重后的候选 `.md` 文件（排除当前视图自身）；`path` 是宿主解析出的规范路径。 */
  readonly resolve: () => Promise<readonly FileCandidate<T>[]>;
  readonly read: (file: T) => Promise<string>;
}
export interface FileCandidate<T> { readonly path: string; readonly file: T }

export interface SearchFileReadResult {
  /** key = path，value = 全文。 */
  readonly contents: ReadonlyMap<string, string>;
  /** 因预算或体积上限未读取的文件数（命中会少，但不报错）。 */
  readonly skipped: number;
}

/**
 * 按 path 去重顺序读取候选文件；跳过超过 maxCharactersPerFile 的文件
 * （计入 skipped，不截断内容）；单个文件读取失败只计入 skipped。
 * 不做缓存（缓存由宿主负责），不依赖 obsidian 类型。
 */
export function readSearchFiles<T>(
  reader: SearchFileReader<T>,
  matcher: (candidate: FileCandidate<T>) => boolean,
  budget?: SearchFileBudget
): Promise<SearchFileReadResult>;
```

行为细则（core 队友实现，测试固化）：

- 空/纯空白 query → `{ cards: [], hitCount: 0 }`。
- 匹配前先 `normalize("NFKC").toLowerCase()`（query 与文本各自折叠），大小写与全角/半角不敏感。
- 标题命中 → `titleHit`；文件名命中 → `hits` 中 `source: "file"`、`line: 1`；内容命中 → 每行每个命中一段 `source: "content"`，`line` 为该行 1 起算行号。
- 节点既命中标题又命中文件内容时：标题区已有信息，**同一行同一段不重复**放进 `hits`；其他命中部分照常保留。
- 节点命中标题但无文件：卡片只有标题命中，`hits` 为空；点击标题仍跳转节点（由 view 决定）。
- 卡片排序：标题命中优先，其次文件名命中，再按内容命中数量降序；同组内保持 candidates 原顺序。
- `SEARCH_RESULT_LIMIT` 只限制卡片数，不截断 `hitCount`。
- `SEARCH_HITS_PER_CARD_LIMIT`（30）限制**每张卡片的命中行数**（文件名命中占 1 条名额），防止大文件 + 高频单字 query 构造/渲染数万行；被截断的卡片带 `hitsLimited: true`，但 `hitCount` 仍是**真实命中总数**（输入框右侧计数必须真实），排序也按真实命中数，不受截断影响。
- 内容为空、行过长、`\r\n`（去 `\r`）、多命中同行都不得抛错。
- 禁止正则注入：query 一律按字面量匹配（不得把用户输入拼进 RegExp）。
- 纯函数：不 import `obsidian`，不读文件，不注册监听。

## 3. 面板组件契约

panel 队友在 `src/ui/search/search-panel.ts` 导出：

```ts
export interface SearchPanelLabels {
  readonly title: string;
  readonly placeholder: string;   // 同时用作 input 的 aria-label
  readonly close: string;         // × 的 aria-label
  readonly clear: string;         // 输入框内清除按钮 × 的 aria-label（点击清空输入与结果，不关闭窗口）
  readonly count: string;         // 形如 "{count} matches"，{count} 由 {count} 占位
  readonly empty: string;         // 无命中提示
  readonly loading: string;       // 搜索进行中
  readonly truncated: string;     // 单卡命中行被截断时的说明，形如 "Only the first {count} hits are shown"（{count} = 实际展示的命中行数）
}

export interface SearchPanelActions {
  /** 由宿主执行实际搜索；可返回 undefined 表示"输入已过期"。 */
  readonly search: (query: string) => Promise<SearchResult | undefined>;
  /** 点击卡片标题行：跳转到节点并聚焦节点中心。 */
  readonly jumpToNode: (nodeId: NodeId) => void;
  /** 路径行显示名：返回该节点的展示名；缺失或为空时 panel 回退显示 `nodeId`。 */
  readonly nodeTitle?: (nodeId: NodeId) => string | undefined;
  /** 点击卡片内容行：打开文件并把光标聚焦到 line（1 起算）。 */
  readonly openFileAtLine: (path: string, line: number) => void;
  /** 窗口打开/关闭后通知宿主（供无障碍与焦点管理）。 */
  readonly visibilityChanged?: (open: boolean) => void;
}

export interface SearchPanelClock {
  setTimeout(handler: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

/** 纯 DOM 组件，遵循 DisposableUiObject 生命周期；不 import 插件主类与 MindTreeView。 */
export class MindTreeSearchPanel extends DisposableUiObject {
  readonly element: HTMLElement;
  constructor(
    parent: HTMLElement,
    labels: SearchPanelLabels,
    actions: SearchPanelActions,
    options?: { readonly debounceMs?: number; readonly clock?: SearchPanelClock }
  );
  get isOpen(): boolean;
  open(): void;          // 已打开时只聚焦并全选输入
  close(): void;         // 关闭并清空结果
  toggle(): void;
  setContext(): void;    // 保留：宿主文档变化时使已缓存结果失效（重新搜索当前 query）
  destroy(): void;       // 幂等
}
```

DOM / 结构要求（`test/search-panel.test.ts` 固化，注意 `test/styles.test.ts` 会读 `styles.css`）：

```
.mtn-search-panel[hidden]
  .mtn-search-panel-header
    span.mtn-search-panel-icon        setIcon(..., "search")，位于标题左侧
    .mtn-search-panel-title           文本 = labels.title
    button.mtn-search-panel-close     aria-label = labels.close，内含 setIcon(..., "x")
  .mtn-search-panel-search              只含输入框包裹层与计数
    span.mtn-search-panel-input-wrap      position:relative; display:flex; flex:1; min-width:0；是清除按钮的绝对定位锚点
      input.mtn-search-panel-input        type="search"（`padding-right: 32px` 给清除按钮留白）
      button.mtn-search-panel-clear       setIcon(..., "x")、aria-label = labels.clear、type="button"、tabindex="-1"；position:absolute 叠在输入框内部最右侧（28×28），query 为空时 hidden
    .mtn-search-panel-count              文本 = labels.count 替换 {count}
  .mtn-search-panel-results            （可滚动容器；query 为空时整体 hidden，不留分割线与空白）
    .mtn-search-card
      .mtn-search-card-title           role="button" tabindex="0"
      nav.mtn-search-card-path         根 → … → 自身；仅 card.nodePath 非空时渲染（根节点命中没有这一行）；display:flex + flex-wrap:wrap，换行只发生在 segment 之间
        span.mtn-search-path-segment   不可拆分的 flex item（display:inline-flex; flex:0 0 auto; max-width:100%）；箭头与其引入的节点同属一段；第一段（根）只有 link、不带箭头
          span.mtn-search-path-arrow   文本 "→"、aria-hidden="true"；与同段 link 一起换行，不可能落在行尾
          span.mtn-search-path-link    role="button" tabindex="0"，文本 = actions.nodeTitle(id)（缺失回退 id），点击 / Enter / Space → jumpToNode(id)；超长名 max-width:100% + text-overflow:ellipsis
      .mtn-search-card-hit             一行命中，role="button" tabindex="0"
      hr.mtn-search-card-separator     命中部分之间的分割线（标题与路径之间没有；路径与下方内容之间有）
      .mtn-search-card-truncated       仅 card.hitsLimited 时：labels.truncated（{count}=实际展示行数），纯说明行
    .mtn-search-empty                  仅“有 query 且 0 命中”时的无结果文本
```

行为要求：

- 打开时聚焦输入框；关闭时结果清空、`hidden` 打开、`visibilityChanged(false)`。
- **失焦不关闭**：不得监听 `blur`/`focusout` 关闭窗口。
- `Escape` 在输入框或面板内按下 → `close()`，`preventDefault()` + `stopPropagation()`；由面板自己监听，不依赖宿主。
- 输入事件：`debounceMs`（默认 120ms）防抖后调用 `actions.search(query)`；`clock` 可注入以便测试同步推进。每次新搜索必须使其之前的结果失效（序号令牌或等价机制），过期结果不得渲染。
- **失效应答收起**：宿主返回 `undefined`（表示"输入已过期"）或调用抛错时，panel 执行 `clearResults()`——结果区 `hidden`、计数隐藏，**窗口保持打开**；不得无限停在 loading 空盒，与空 query 的收起口径一致。
- 输入框右侧 `.mtn-search-panel-count`：query 为空时不显示计数（`hidden`）；有结果时显示 `labels.count`；加载中显示 `labels.loading`。
- 每个 `.mtn-search-card-hit`：文本只占一行（CSS `white-space: nowrap` + 省略号），命中关键字用 `<mark class="mtn-search-mark">` 包裹；`title` 属性给全文做悬浮提示。
- 一行多段高亮 → 多个 `<mark>`。
- 命中部分之间插入 `hr.mtn-search-card-separator`（第一个之前不插）。
- 标题行与命中行都要：`click` 与 `keydown`（Enter / Space）触发；鼠标悬浮高亮由 CSS `:hover` 提供（标题行点击 → `jumpToNode`，命中行点击 → `openFileAtLine(path, line)`）。
- 无 `path` 的卡片只渲染标题行；标题行始终渲染（即使标题未命中），点击行为仍是 `jumpToNode`。
- 卡片标题行必须 `title` = 节点名，便于悬浮查看。
- 组件不得直接读写文档模型、不得 import `MindTreeView`/`main.ts`、不得硬编码用户可见文案。
- `destroy()` 幂等：清计时器、清 DOM、解绑监听。

## 4. i18n key（docs 队友加，EN 与 ZH 同一相对位置）

追加在 `status.invalidFile` 之后（EN 与 ZH 各自的对象末尾）：

| key | EN | ZH |
| --- | --- | --- |
| `search.panel.title` | `Search` | `搜索` |
| `search.panel.placeholder` | `Search nodes, file names and Markdown content` | `搜索节点名、文件名与 Markdown 内容` |
| `search.panel.close` | `Close search` | `关闭搜索` |
| `search.panel.count` | `{count} matches` | `{count} 项匹配` |
| `search.panel.empty` | `No matches` | `没有匹配` |
| `search.panel.loading` | `Searching…` | `正在搜索…` |
| `search.panel.truncated` | `Only the first {count} hits are shown` | `仅显示前 {count} 条命中` |
| `toolbar.search` | `Search nodes` | `搜索节点` |
| `search.panel.clear` | `Clear search` | `清空搜索` |

约束：占位符 `{count}` 两种语言必须一致；`test/i18n.test.ts` 要求 EN/ZH key 集合与非空文本一致。

## 4.5 第二轮细化（用户新反馈，最高优先级）

五个验收点：

1. **空 query 时结果区完全不占空间**：`.mtn-search-panel-results` 必须 `hidden`（不能只清空内容、不能留分割线和空白）。关闭窗口、清空输入、`setContext` 之后都回到"只有标题行 + 输入行"的紧凑卡片，上下间距对称。所以**取消上一轮"任何无结果状态都显示空状态占位"**：`.mtn-search-empty` 只在"有 query 但 0 命中"时显示。
2. **面板标题左侧有搜索图标**：header 结构改为 `span.mtn-search-panel-icon`（`setIcon(..., "search")`）+ `span.mtn-search-panel-title` + `button.mtn-search-panel-close`。
3. **输入有字时输入框内部最右侧显示清除按钮**：`button.mtn-search-panel-clear`（`setIcon(..., "x")`、`aria-label = labels.clear`、`type="button"`、`tabindex="-1"`，避免与 Tab 焦点顺序打架），query 为空时 `hidden`。点击只清空输入与结果，**不关闭窗口**，并把焦点还给输入框。
4. **卡片标题下方是节点路径**（根 → … → 命中节点）：
   - 模型：`SearchCandidate` 增加 `readonly ancestorIds?: readonly NodeId[]`（**从根节点开始、不含命中节点自身**；根节点自身的命中为空数组/缺席，此时不渲染路径行）；`SearchCard` 增加 `readonly nodePath?: readonly NodeId[]`（根 → … → 自身，**含自身**，仅当 `ancestorIds` 非空时由 core 写入）。**注意**：`SearchCard.path` 已经是"文件路径 string"（内容命中与 `openFileAtLine` 用），节点链路必须用 `nodePath`，不得复用 `path`。
   - 渲染：`nav.mtn-search-card-path`，放在标题行之后、第一个命中行/第一条分割线之前；**标题与路径之间没有分割线**，路径与下方内容之间保留 `hr.mtn-search-card-separator`（无内容命中时路径就是卡片最后一行，不加分割线）。
   - 结构（最终实现）：`.mtn-search-card-path` 的每个 flex item 是一个 `span.mtn-search-path-segment`（`display: inline-flex; flex: 0 0 auto; min-width: 0; max-width: 100%`），**箭头与它引入的节点同属这个 segment**：segment 内先 `span.mtn-search-path-arrow`（`text = "→"`、`aria-hidden="true"`），再 `span.mtn-search-path-link`（`role="button"`、`tabindex="0"`、`title` = 名称、点击/Enter/Space → `actions.jumpToNode(id)`，行为与卡片标题一致）。路径的第一个节点（根）直接是 link、不带箭头。
   - 换行规则：容器 `.mtn-search-card-path` 用 `display: flex; flex-wrap: wrap`，换行只发生在 segment 之间；因为箭头与节点在同一个不可拆分的 `flex: 0 0 auto` 片段里，**箭头不可能落在行尾**。测试固化该不变量（例如断言每个箭头元素与其后的可点击节点同属一个 segment）。
   - 显示名：路径段显示**节点名**，由宿主通过 `actions.nodeTitle(nodeId)` 注入；panel 取不到或为空时回退显示 `nodeId`。单个过长的节点名由 `max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` 省略号截断，不影响片段间换行。
   - 路径行样式：链接用 `var(--link-color, var(--text-accent))` 且 `text-decoration: underline`（下划线，超链接观感），悬浮时 `color: var(--text-accent)`；箭头用 `var(--text-faint)`；整行 `font-size: var(--font-ui-smaller)`、`line-height: 1.4`、`gap: 2px 4px`，**只按 segment 换行**（不出现横向滚动），单个过长的节点名按上面的规则省略号截断。
5. **卡片标题悬浮改为"轻微放大 + 下划线"，不要整行背景/阴影**：
   - `.mtn-search-card-title:hover`：`text-decoration: underline; transform: scale(1.02); transform-origin: left center;`，**不得**再给标题行 `background`（`--background-modifier-active-hover` 之类）或阴影。
   - 同时**删除卡片级 `.mtn-search-card:hover` 的整行背景**（用户要求不要整卡整行背景）；只有命中行（`.mtn-search-card-hit:hover`）保留整行背景悬浮。
   - 需要给标题行加 `transition: transform 120ms ease;`，并注意 `transform` 会创建层叠上下文，标题行本身不滚动所以可接受。

新增 i18n key（EN / ZH 同序追加在对象末尾）：

| key | EN | ZH |
| --- | --- | --- |
| `search.panel.clear` | `Clear search` | `清空搜索` |

面板新增 label 字段 `clear: string`（必填，与既有 label 一致）。

## 5. CSS 契约（panel 队友只追加）

- 前缀 `mtn-search-`；颜色只用 Obsidian CSS 变量（`--background-primary`、`--background-secondary`、`--background-modifier-border`、`--text-normal`、`--text-muted`、`--text-accent`、`--radius-s/m`、`--shadow-s`、`--font-ui-smaller/small` 等）；不写内联样式；不使用渐变（仓库硬规则）。
- `.mtn-search-panel`：**右侧圆角悬浮卡片**（不是贴边侧栏，不要 `bottom: 0` / `border-left` / 全高贴边），与 `.mtn-toolbar` 共用同一套描边、圆角、半透明背景、阴影与背景模糊：
  `position: absolute; top: 62px; right: 12px; z-index: 44; display: flex; flex-direction: column; box-sizing: border-box; width: min(360px, calc(100% - 24px)); max-height: calc(100% - 74px); overflow: hidden; border: 1px solid var(--background-modifier-border); border-radius: 13px; background: color-mix(in srgb, var(--background-primary) 92%, transparent); box-shadow: 0 8px 24px rgb(0 0 0 / 12%); backdrop-filter: blur(10px); color: var(--text-normal);`
  （`top: 62px` 用于让开顶部工具栏；`z-index` 低于 `--layer-modal` 且高于画布。）
- `.mtn-search-panel-results`：`flex: 1; min-height: 0; overflow-y: auto;`（滚动由这里负责），并用 `border-top: 1px solid var(--background-modifier-border)` 与查询行分隔；标题、输入框与关闭按钮固定不滚动。
- 空状态：`query` 为空时 `.mtn-search-panel-results` 整体 `hidden`（**不占空间、无分割线、无空白**）；只有“有 query 且 0 命中”时才渲染 `.mtn-search-empty`（文本 = `labels.empty`）。
- 卡片：`border: 1px solid var(--background-modifier-border)`、`border-radius: var(--radius-m)`、内边距；**不要给 `.mtn-search-card:hover` 加背景**（用户要求取消整卡整行背景，该规则已删除）。
- 悬浮：只有命中内容行 `.mtn-search-card-hit:hover` 保留整行 `background`；卡片**标题行**改为轻微放大 + 下划线（`transform: scale(1.02); transform-origin: left center; text-decoration: underline;`，**没有背景或阴影**）。`mark` 使用 `background: var(--text-highlight-bg)` 或主题高亮变量，保留可读前景色。
- 路径行：`nav.mtn-search-card-path` 用 flex + wrap，item 是 `span.mtn-search-path-segment`（箭头 + 其后的 `span.mtn-search-path-link` 同段），链接链接色 + 下划线、超长名省略号截断；详见 §4.5。
- 单行截断：`white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`（JS 侧还会按字符窗口加 `…`）。
- 移动端可用：不得依赖 hover 才能点击；触摸目标高度 ≥ 28px。

## 6. 宿主（Lead）负责的集成点

- `MindTreeViewShell` 之外由 view 创建/销毁面板；工具栏搜索按钮与 `Ctrl/Cmd+F` 都调用同一个 `openSearchPanel()`。
- `Scope` 注册 `["Mod"]+F`（与现有 `Mod+E`/`Mod+S`/`Mod+X` 同处）。
- 搜索数据来源：当前文档节点 + `plugin.resources` 解析出的文件；只有 `.md` 文件读内容；跳过当前视图自身的 `.mtn.md`。
- 点击标题：展开祖先 → `selectOnly` → `centerNodeInViewport`（复用既有私有方法）。
- 点击内容行：`.md` 直接 `leaf.openFile(file, { eState: { line, ch: 0 } })`；`.mtn.md` 走 `openLinkedFile` 打开导图（不跳行）。
- i18n key 见第 4 节（2026-10-11 起搜索入口复用 `toolbar.search`，原 `shortcut.search` 已合并删除）；`keyboard-help-menu.ts` 的快捷键帮助行由 docs 队友补。

## 7. 环境与验证（本沙箱）

- `npm run check` 可直接跑。
- `npm test` 在本沙箱**必失败**（esbuild `spawn EPERM`）。替代命令：
  `& "C:\Users\Dayiy\AppData\Local\Temp\dsh-mtn-hooks\run-tests.ps1"`（跑全量，输出 EXITCODE 与失败清单）；
  单文件：`& "C:\Users\Dayiy\AppData\Local\Temp\dsh-mtn-hooks\run-tests.ps1" -Pattern "test/search-core.test.ts"`。
- 新测试文件若直接 `import { buildSync } from "esbuild"` 会在本沙箱失败；需要真实打包的 DOM 级测试请用 `buildSync` 的既有先例（`test/adaptive-tooltip.test.ts`）**不要**照抄，改用直接 import + 假 DOM 的方式（`test/custom-markers-settings-page.test.ts` 是参考，但它内部有私有假 DOM；可在你的测试文件里自建最小假 DOM，不要修改既有测试文件）。
- 提交：不要 `git commit` / `git push`，Lead 统一收尾。
