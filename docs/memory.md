# memory

## 2026-11-21 · 版本号提升脚本与 release commit 流程（`chore`）

**结论（为什么不再 amend）**：`manifest.json` 的 `version` 是「发布事件」的属性，不是某个功能提交的属性。以前把 bump 塞进收尾提交、事后 `git commit --amend` 有三个实伤：① 已 push 的提交需要 force-push，仓库有并发 session 时危险；② 标签可能落在 amend 之前的提交上，`manifest.json` 与 tag 不一致，release.yml 的 Preflight 直接失败；③ `git log -- manifest.json` 的时间线被折叠，看不出哪天发的版。

**落点**：新增 `scripts/bump-version.mjs`（`node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>`）——只替换 `manifest.json` 的 `version` 值（保留键序与格式）、把新版本按「新在前」写入 `versions.json`（值取 `minAppVersion`）、校验必须是合法 X.Y.Z 且严格大于当前版本。`package.json` 的 `0.1.0` 保持不动（`npm version` 会改它并自动建提交和标签，导致 manifest 与 tag 不一致，不要用）。

**标准发布流程**：平时 feat/fix/docs 不碰版本号 → 决定发布时跑脚本 → `git commit -m "chore(release): X.Y.Z"` → push → 打同名标签并 push。
`AGENTS.md` §1（版本号与命令表）、§6（发布）、§12.1 已同步；

## 2026-11-19 · 版本快照 / 反向引用 / Canvas 导出 / UI 测试装载器（`feat`，团队协作，纯文档同步收尾）

**用户决策（口径）**
- 版本快照写入库根 `.mind-tree-nature-data/snapshots/`，**不**进入 `.mtn.md`、`.obsidian` 或 `data.json`；建议用户在同步工具中排除该目录。快照随正常保存捕获（冲突选择写盘、MCP 写盘不捕获），恢复必须是可撤销的会话操作。
- 笔记里的 `mind-tree-ref` 反向显示在节点下方：≤5 个圆点 + `+N`，悬停/键盘聚焦展开为左对齐胶囊气泡，点击打开笔记并定位到引用行；只读、不写回、不参与布局。
- 导出菜单新增 Canvas；未选中节点时 PNG / Markdown / Canvas 都从根节点导出整棵树，工具栏「导出」不再要求先选择节点。
- 文档要求：行为 + 边界/失败态；中文；只改文档，不改代码。

**4 个工作树与合并顺序**（本轮实际落点）
1. `test-bundle-helper` → `92661b1`：用 `loadModule` 替换 esbuild `buildSync`。
2. `canvas-export` → `d3b571c`：Canvas 导出 + 无选中整树。
3. `snapshot-history` → `371d920`：`.mind-tree-nature-data/` 版本快照 + 版本历史弹窗。
4. `backlink-refs` → `0d41411`：节点反向引用圆点/胶囊。
5. `b4f6560`（收尾）：把装载器的 `tsc` emit 从系统临时目录改到仓库内 `.mtn-test-build/`，避免沙箱拒绝临时目录。

**测试装载器与 TS7 发现**
- `test/helpers/module-loader.ts` 的 `loadModule()` 在私有 VM realm 中加载真实 TS 源码，每次调用独立模块缓存；`obsidian` 桩与假 DOM 全局显式注入，不再依赖 esbuild。
- 仓库 pin 的是 **TypeScript 7 原生编译器**，其 npm 包只暴露 `tsc` CLI，没有 `ts.transpileModule`；装载器回退为一次性 `tsc` emit 到仓库根忽略目录 `.mtn-test-build/`（`.gitignore` 已含），stdio 走文件而非管道。不要再把 `buildSync` 写回测试。
- **坑**：Node 24 `--test-isolation=none` 会吞掉 `test()` 注册之后发生的顶层异常。`loadModule()` 与解构必须放在第一个 `test()` 之前；`test/theme-menu-hover.test.ts` 因此从被静默截断的 7 条恢复为 18 条，全量 1232 pass / 0 fail（112 个测试文件、2 个 helper）。
- 官方 `npm test`（`tsx`）在受限沙箱仍需提权（tsx/esbuild 走 spawn 管道）；装载器路径本身不依赖 esbuild。

**拆分进度**
- `src/ui/mind-tree-view.ts` 第 4 阶段完成：复制/导出/剪切（4431 → 4271，`b46e6c9`）、节点结构/删除（4271 → 4089，`33102f1`）、资源关联（4089 → 3828，`b230ac5`）、设置写入与剪切归并（3828 → 3792，`54cd165`）；累计 −639 行，拆出 `exchange-ops` / `node-ops` / `resource-ops` / `settings-ops` 四个命令模块。`refreshLayoutFromSettings`、`createTaskNoteForNode`、`linkUrl`、`openResource` 因静态测试钉住方法体保留在视图。
- 未做真实 Obsidian 手工验收：版本历史弹窗浏览/恢复、反链圆点与胶囊跳转、Canvas 在 Obsidian 中打开、移动端触摸展开圆点，都只到自动化测试层。

**文档落点**：`docs/02` §5.1/§5.3/§5.4/§5.5/§6.6/§6.10、`docs/03` §7.6/§7.7、`docs/05` §9.1/§9.3/§11/§12.3、`docs/06` §13.1/§14（新增 23–25 条）、`README.md` / `README.en.md`、`AGENTS.md` §1/§2/§3.2/§4/§5/§10/§12/文末核对。测试数字统一为 112 文件 / 1232 用例 / 0 失败。

## 2026-11-17 · 关联网页的标题默认填入节点文本（`feat`）

**需求（用户口径）**：右键「链接网页」时，标题输入框默认填入该节点的当前文本，不要因为链接一个网址就把节点名换成域名。

**落点**
- `src/ui/modals/text-prompt-modal.ts`：`UrlPromptModal` 构造签名扩为 `(app, onSubmit, initialTitle = "")`，`this.title = initialTitle.trim()`，标题输入框用 `setValue(this.title)` 预填；提交仍是 `this.title || parsed.hostname`（清空后才回退域名），URL 输入框仍默认 `https://`。
- `src/ui/mind-tree-view.ts` 的 `linkUrl()`：打开弹窗前读取 `this.document?.nodes[nodeId]?.title ?? ""` 作为第三个参数。节点标题是 Markdown 源文本（可能含 `**` 等），这里不转纯文本——预填值就是节点文本本身，用户不改就直接原样写回，节点显示不变。
- i18n `modal.linkWeb.titleDesc`（EN/ZH）改为说明「默认使用节点文本；留空时使用网站域名」；`docs/02` §6.7 关联网页补两条；README 中英「把笔记挂到树上」新增「链接网页」条目（此前 README 没写过这个入口）。
- 新增 `test/url-link-title.test.ts`（2 条源码接线断言：视图把节点文本传给弹窗、弹窗同时预填存储值与输入框、清空回退主机名不变）。

**测试**：`npm run check` 0 错误；全量 **1092 tests / 1085 pass / 7 fail**，7 条全部是已知的 `esbuild buildSync → spawn EPERM` 环境失败（`adaptive-tooltip`、`ai-settings-page`、`custom-markers-settings-page`、`marker-popover-custom`、`node-renderer`、`plugin-update-modal`、`top-toolbar`），无新增失败。

**环境坑**：`docs/memory` 里记的替代运行器 `C:\Users\Dayiy\AppData\Local\Temp\dsh-mtn-hooks\run-tests.ps1` 已不存在。本轮用 Node 原生 TS 执行替代 `tsx`：一个 `node:module` `resolve` 钩子把无扩展名/目录 index 的本地导入补成 `.ts`，再 `node --experimental-transform-types --import "file:///D:/.../register.mjs" --test --test-isolation=none @files`（`register.mjs` 里 `register("./hooks.mjs", import.meta.url)`）。钩子本轮临时放在 gitignored 的 `.mtn-test-build/`，跑完已删除；需要复跑时按此重建即可。工作区里的中文文件一律用 `edit`/`write` 工具改，不要用 PowerShell 往返编码。

## 2026-11-14 · MCP 访问令牌改为跨设备固定（`fix`）

**需求（用户口径）**：MCP 的鉴权字符串（Bearer token）总是变，Obsidian 同步后每个 MCP 服务都会失效；要求固定下来，不因同步换设备而失效。

**原因**：令牌原先只存设备本地存储（`${manifest.id}:mcp-server` / `:mcp-server:read`），每台设备首次启动各生成一个；`data.json` 同步只带端口偏好，不带令牌，所以另一台设备复制出的客户端配置必然对不上。

**落点**：
- `settings-model.ts` / `plugin-data.ts`：新增全局设置 `mcpToken`（`data.json`，空字符串为未生成；格式不合法清空）。
- `connection.ts`：`resolveSyncedMcpToken(synced, localRecords)` 选令牌——`data.json` 已有合法令牌直接用；否则沿用旧设备本地记录（当前键优先，其次 `:mcp-server:read`）；都没有返回 `undefined`。
- `main.ts`：`onload` 在 `loadSettings()` 后调用 `ensureSyncedMcpToken()`（桌面端）：解析上述令牌，缺失则 `crypto.randomUUID()` 生成并 `saveSettings()` 写回；移动端不生成/不启动 MCP，只通过同步接收。`McpServerController` 增加可选 `getToken()`，同步令牌优先于设备记录（测试不传时保留旧记录路径）。
- 端口实际生效值与绑定记录仍在设备本地存储；令牌与端口组合才是客户端配置，端口默认 `27321` 且回退策略不变。
- 安全口径改变：令牌现在随 `data.json` 同步（用户明确要求固定），拿到 `data.json` 即可取得读写权限；README/docs/05 已改为提醒把 `data.json` 当敏感文件，不再声称令牌仅设备本地。

**迁移**：首次桌面启动优先沿用旧设备本地令牌，已安装的客户端配置继续可用；写入 `data.json` 后同步到其他设备即固定。若多台桌面设备在同步前各自首次启动，最后一台同步值为准，需要重新复制一次配置。

**验证**：`npm run check` 0 错误；`npm test` **1153 / 1153 通过、0 失败**；`npm run build` 成功（`main.js` 5.00 MB、`styles.css` 86 KB）。新增 `resolveSyncedMcpToken`、controller `getToken` 优先、plugin-data `mcpToken` 保留/非法清空测试。

## 2026-11-13 · AI tab 新增「模型提供商」（`feat`，团队协作）

**需求（用户口径）**：把 obsidian-yolo 的“模型提供商”设置完整搬到本插件「设置 → AI」：在现有“MCP 服务”分区之后新增“模型提供商”分区，支持供应商列表（可展开）、添加/编辑/删除（卡片内二次确认）、每张卡片下的聊天模型与嵌入模型表、显式连通性测试，以及 ChatGPT / Gemini / Claude / GitHub Copilot 的 OAuth。预设覆盖 OpenAI、ChatGPT OAuth、Anthropic、Claude OAuth、Gemini、Gemini OAuth、GitHub Copilot、OpenRouter、Sidrune AI、xAI、Mistral、Perplexity、Groq、Cerebras、SambaNova、Together AI、Morph、DeepSeek、Moonshot、Zhipu、Doubao、SiliconFlow、StepFun、MiniMax、Hunyuan、Xiaomi MiMo、Azure OpenAI、Amazon Bedrock、Ollama、LM Studio 与自定义 OpenAI 兼容端点。当前插件没有聊天/推理消费方，这些设置只是外部模型接入的**配置层**，文档不得暗示已有聊天功能。

**落点**

- `src/services/ai/contracts.ts`：设置模型、校验码、设置页端口与硬上限（`64` 供应商 / `512` 聊天模型 / `128` 嵌入模型、`32` 自定义 headers、`64` 自定义参数、URL/名称/密钥长度上限）。
- `src/services/ai/presets.ts`：31 个预设的分类、默认 API 类型、默认 Base URL、可用 API 类型、是否需要 API Key/Base URL、是否支持嵌入、OAuth 类型与额外请求项；`presets.ts` 是预设数据的唯一真源。
- `src/services/ai/normalize.ts`：`data.json` 的不可信输入规范化（未知 preset/API 类型回落、越界数字丢弃、重复 ID 去重、单条坏记录只丢弃自身）、表单校验、`resolveProviderBaseUrl` / `resolvePrimaryRequestUrl` 请求预览。
- `src/services/ai/oauth.ts`：ChatGPT 设备码 + 浏览器 PKCE、Gemini 浏览器 PKCE、Claude 手动令牌、GitHub Copilot 设备码；凭据键 `ai-oauth:<providerId>`，宿主再加 `${manifest.id}:` 前缀，**只写设备本地存储**，不进 `data.json`；含过期刷新与 Copilot token 交换。
- `src/services/ai/connectivity.ts`：模型行“测试”按钮的最小非流式请求（OpenAI-compatible/Responses、Anthropic、Gemini）；Azure OpenAI 与 Amazon Bedrock 明确返回“不支持”。
- 宿主接线：`src/main.ts` 的 `aiSettings()`（`requestUrl`、`app.loadLocalStorage/saveLocalStorage`、`Platform.isMobile`、`saveSettings`、OAuth 管理器）；保存前走 `validateProvider` / `validateChatModel` / `validateEmbeddingModel`；删除供应商级联删除其模型与设备凭据，修改供应商 ID 时模型一起改挂并断开旧 ID 凭据。
- 持久化：`settings-model.ts` 增加 `aiProviders` / `aiChatModels` / `aiEmbeddingModels`（默认空数组）；`plugin-data.ts` 调用 `normalizeAiSettings`；三者进入 `data.json`。**API Key 以明文随 `data.json` 保存**（与 MCP 令牌不同），README 与 `docs/05` §10/§12.3 已提醒把 `data.json` 当作敏感文件。
- 设置页：`ai-settings-page.ts` 保留 MCP 分区；新增 `ai-providers-section.ts`、`ai-providers-view.ts`（纯视图模型）、`ai-provider-picker-modal.ts`、`ai-provider-form-modal.ts`、`ai-model-form-modal.ts`。首轮曾把 AI tab 限定为桌面端；第二轮已改为所有平台可见（见下方“第二轮”），MCP 不可用性改由页面内红字 notice 表达。
- i18n：`settings.ai.providers.*` / `settings.ai.models.*`（EN/ZH 同步）；预设品牌名属于产品数据，不翻译。
- 文档：README 中英新增“模型提供商”一节与网络/隐私条目；`docs/01` P1 与非目标、`docs/02` §AI 模型提供商、`docs/05` §9.1/§10/§12.3、`docs/06` 模型提供商验收；`THIRD_PARTY_NOTICES.md` 的 obsidian-yolo（MIT，commit `90f3e183e23304ed85e028175d31887e3827a958`）来源由 Lead 维护，本任务未改。

**OAuth client 常量来源与 MIT**：ChatGPT 设备码/浏览器 PKCE、GitHub Copilot 的 OAuth client 常量、预设与默认请求规则改编自 [obsidian-yolo](https://github.com/Lapis0x0/obsidian-yolo)（MIT），已记录在 `THIRD_PARTY_NOTICES.md`。**Gemini OAuth 不内置客户端**：`gemini-oauth` 预设把 `additionalSettings.oauthClientId/oauthClientSecret` 声明为必填，`validateProvider` 以 `provider-oauth-client-required` 拦截缺失，`oauth.ts` 只在用户填写的值存在时发起浏览器登录；仓库与发布包不得再写入任何 Google OAuth 客户端 ID 或客户端密钥常量（2026-11-16 因 GitHub Push Protection 拦截做过历史改写，见当日条目）。改动其他常量前先核对上游与许可声明。

**已知风险 / 取舍**

- **API Key 明文在 `data.json`**：插件数据会随用户同步/备份；界面不回显 Key 与令牌，日志与错误消息不记录它们。文档必须持续提醒 `data.json` 的敏感性。
- **AI tab 平台范围（第二轮已改）**：第二轮起 AI tab 在桌面端与移动端都渲染；MCP 分区仍只在桌面端可用，移动端以红字说明、控件禁用且不启动服务；模型提供商分区在移动端可用，OAuth 按钮禁用但手动令牌可用。不要再按“AI tab 桌面端专属”写文档。
- **无聊天/推理消费方**：除 OAuth 登录与用户点击模型“测试”外没有模型请求；打开 AI 设置页、保存配置、插件启动都不主动拉取模型或发送笔记内容。注意已连接 OAuth 的令牌在读取状态时可能自动续期一次（当前实现：Copilot 短期 token 过期/缺失时 `status()` 后台换取 token，`test/ai-oauth` 明确覆盖），属于登录会话维护，不是模型调用。搜索/写文件也不使用这些配置。
- 预设中的第三方品牌、默认端点与 OAuth 常量可能变化；文档只列名称与能力，不承诺具体模型目录、价格或可用性。

**验证（2026-11-13 01:2x）**

- `npm run check` = **0 错误**；`npm test` = **1150 / 1150 通过、0 失败**（在 `danger-full-access` 会话中运行，esbuild 的 `spawn` 可用；workspace-write 沙箱下 `tsx`/esbuild 仍会 `spawn EPERM`）；`npm run build` 成功，`main.js` 5.00 MB、`styles.css` 86 KB、`manifest.json` 235 B，均低于发布上限。
- 新增测试：`test/ai-settings-normalize.test.ts`、`test/ai-oauth.test.ts`、`test/ai-connectivity.test.ts`、`test/ai-providers-view.test.ts`、`test/ai-model-catalog.test.ts`；`test/ai-settings-page.test.ts` 补 `app`/`ai`/`Modal` 桩并保留原 MCP 断言；`test/settings-index-wiring.test.ts` 的样式检查拆成 MCP 段与 AI provider 段（后者允许 `var(--text-*)` 主题变量、仍禁止硬编码颜色与渐变）。
- **仍未做**：真实 Obsidian 桌面端人工验收（picker 分类/搜索、表单校验、卡片展开、5 秒删除确认、OAuth 真机流程、Claude 手动令牌、每模型测试的成功/失败/不支持、密钥不回显、移动端红字与手动令牌）。OAuth 与连通性测试均为注入假 HTTP 的单元测试，没有真实账号/真实网络验收，文档不得写成“已验证可用”。

**第二轮（同日）· AI tab 移动端可见 + 从供应商拉取远程模型目录**

**需求（用户口径）**：AI tab 改为移动端也显示；MCP 分区在移动端不可用，页面内用红字 notice 提示（`settings.ai.mcp.status.desktopOnly`，`--text-error`）；模型提供商分区在移动端可用，OAuth 连接/断开按钮禁用并提示，手动 token 仍可用。另把 YOLO 的“从供应商拉取远程模型目录/批量添加模型”搬到聊天模型区：卡片内有「拉取模型目录」按钮，打开即拉取；支持搜索、全选、批量添加；已配置（同 provider + 同 model）不可选/跳过并计数，配置 ID 冲突才加 `-2`/`-3`；`source: "fallback"` 时提示回退目录；批量失败逐条内联汇总，成功项照常落地。

**落点**

- `src/settings.ts`：AI 页 `availability` 从 `"desktop"` 改为 `"all"`；MCP 可用性仍由 `isMcpSupported` 在页面内部判定，不再隐藏整个 tab。
- `src/ui/settings-pages/ai-settings-page.ts`：MCP notice 按 `model.supported` 切换 `.is-error`（`styles.css` 中 `color: var(--text-error)`）；移动端总开关/端口禁用、客户端配置隐藏、状态行显示 `settings.ai.mcp.status.desktopOnly`；模型提供商分区照常渲染。
- `src/services/ai/model-catalog.ts`：`fetchChatModelIds()` 只读发现；OpenAI-compatible/Responses 走 `/models`（base 不以 `/v1` 结尾时同时尝试 `/v1/models`）、Anthropic `/v1/models?limit=1000`、Gemini `/v1beta/models`；ChatGPT / Gemini / Copilot / Claude OAuth 使用 token 或内置回退列表；Azure OpenAI 与 Amazon Bedrock 返回 `unsupported`；任何失败都返回 `{ source: "fallback", message }`，不抛错、不写设置。
- `src/ui/modals/ai-model-catalog-modal.ts`：打开即拉取；搜索、全选（只作用于当前可见且未配置项）、批量添加；已配置同 provider + model 的状态为禁用并标“已存在”，底部汇总已选/已配置；配置 ID 为 `<providerId>/<model>`，仅冲突时追加 `-2`/`-3`（跨聊天与嵌入配置 id 唯一）；逐条调用 `addChatModel`，成功项落地、失败逐条内联，全部成功且无跳过时关闭；“手动添加”转到普通模型表单。
- `src/ui/settings-pages/ai-providers-section.ts` / `ai-providers-view.ts`：聊天模型区“添加聊天模型”旁新增“拉取模型目录”按钮（动态 import modal）；新增 `modelConfigId()` 与 `inferReasoningType()`（按模型名粗略推断 reasoning 类型）。
- `src/services/ai/contracts.ts`：`AiRemoteModelList`、`AiSettingsPagePort.listRemoteModels`；`src/main.ts` 接线 `fetchChatModelIds(provider, http, oauth.credential(provider.id))`。
- i18n：`settings.ai.mcp.status.desktopOnly`、`settings.ai.models.catalog.*`、`settings.ai.providers.oauth.desktopOnly`（EN/ZH 同步）。
- 文档：README 中英、`docs/01`、`docs/02`、`docs/05` §9.1/§10/§12.3、`docs/06` 验收均已按第二轮口径更新。

**网络与隐私边界**：目录拉取只在用户点击后请求；GET 目录使用该供应商的 API Key 或设备本地 OAuth 凭据，不发送笔记内容、文件名或 URL；远程失败时使用本机内置回退列表，不再发额外请求；目录结果不持久化，关闭弹窗即丢弃。

**测试与验证**：新增 `test/ai-model-catalog.test.ts`；`test/ai-providers-view.test.ts`、`test/ai-settings-page.test.ts`、`test/settings-index-wiring.test.ts` 已随 UI 更新。收尾实测：`npm run check` 0 错误；`npm test` **1150 / 1150 通过、0 失败**；`npm run build` 成功（`main.js` 5.00 MB、`styles.css` 86 KB）。真实 Obsidian 移动端与真实供应商目录的人工验收仍未做。

## 2026-11-12 · 视图右下角小地图（`feat`，团队协作）

**需求（用户口径）**：在导图视图右下角加一个整棵树的小地图，标出当前可见区域，便于在大型导图中快速定位；尺寸按显示分辨率取 12%，小画布上再收缩；配色跟随当前树主题；可在「基础设置」关闭，默认开启。

**落点**

- 设置模型与持久化：`src/settings-model.ts`（`MindTreeSettings.minimapEnabled: boolean`，跨树偏好，`DEFAULT_SETTINGS.minimapEnabled = true`）；`src/plugin-data.ts` 用 `safeBoolean` 规范化——缺省为 `true`，只有布尔值保留，其余回落默认；不标脏、不回写。
- 设置页：`src/ui/settings-pages/basic-settings-page.ts` 在「基础设置」标题下、自动保存延迟之后加 `Setting` 开关；onChange 先 `port.settings.minimapEnabled = value`，`await port.save()`，再 `port.refreshOpenLayouts()`。保存失败时已打开视图不会先于 `data.json` 改变。
- 纯投影：`src/render/minimap.ts`（`computeMinimapSize`、`visibleWorldRect`、`unionWorldRects`、`createMinimapProjection`、`projectMinimapPoint` / `projectMinimapRect` / `unprojectMinimapPoint`、`minimapProjectionForScene`）。
- SVG 组件：`src/ui/components/mind-tree-minimap.ts`（`role="img"` + `minimap.aria`、点击/拖动、拖动期间冻结投影）；视图接线 `src/ui/mind-tree-view.ts` 在 `render` / `applyViewport` / `resize` 更新；`src/render/viewport.ts` 新增 `centerViewportOnPoint`（只改平移、缩放不变）；样式在 `styles.css` 的 `.mtn-minimap` 块。
- i18n（Lead 已加，本任务未改 catalog）：`settings.minimap.name`、`settings.minimap.desc`、`minimap.aria`（EN/ZH）。
- 测试：`test/plugin-data.test.ts` 新增 3 条（缺省 true、显式布尔保留、非布尔修复）；新增 `test/minimap-setting.test.ts` 3 条静态断言（设置模型/默认值存在、基础设置页渲染开关且按「赋值 → save → refreshOpenLayouts」顺序生效、双语 key 存在）。静态断言用 `process.cwd()` 读源码，因此能在编译回退目录里运行。
- 文档：`docs/02` §5.1（主视图信息架构第 8 项 + 行为口径）、`docs/05` §9.3（纯投影与性能口径）与 §10（全局设置表行）、`docs/06` P0 验收第 22 条、`README.md` / `README.en.md` 快速上手第 2 节各加一段。

**尺寸与指示框公式**

- 目标尺寸：`width = clamp(round(screenWidth * 0.12), 150, 320)`，`height = clamp(round(screenHeight * 0.12), 110, 240)`；再与画布上限取小：`width = min(width, floor(canvasWidth * 0.55), floor(canvasWidth - 24))`、`height = min(height, floor(canvasHeight * 0.45), floor(canvasHeight - 88))`；宽 `< 96` 或高 `< 72` 时整块隐藏（画布太小，缩略图已不可读）。内容绘制四周留 `6 px` 边距。即只在画布太小时缩小，**永不放大超过分辨率比例目标**。
- 内容包围盒 = 布局宽高的世界矩形，再与当前可见世界矩形（`visibleWorldRect`）并集（`unionWorldRects`）得到场景域；投影在场景域内等比缩放并居中。指示框 = 可见世界矩形经同一投影：整棵树大于画布时，树越大或放大越多指示框越小；整棵树完全小于画布时可见域即场景域，指示框接近铺满。并集保证指示框永远不会被裁到小地图边缘之外。
- 点击/拖动：`unprojectMinimapPoint(小地图坐标)` 得到世界坐标，`centerViewportOnPoint` 只改平移、缩放不变。

**拖动冻结投影的原因**：拖动时若按最新视口重算包围盒与缩放，缩略内容会在指针下方重新缩放（尤其拖到边缘时），指示框与指针互相追逐、产生抖动。冻结世界→缩略图投影后，拖动只移动画布中心，松手再按最终视口重算；代价是拖动期间缩略内容的缩放暂时不随视口变化，但树本身没变，符合「在同一张缩略图上移动指示框」的直觉。

**显隐**：设置关闭、解析失败、版本对比（根节点隐藏、画布不呈现整棵树）、缩略尺寸不可用（画布过小）时整块不渲染。小地图只持久化开关，视口（平移/缩放）仍是会话状态，绝不写盘。

**沙箱环境（与 2026-10-11 条目一致）**

- `npm test` / `tsx` 仍因 esbuild `spawn EPERM` 无法运行，不能用来判定本任务。
- 编译回退（2026-11-12 验证阶段实测）：
  1. `npx tsc -p tsconfig.json --noEmit false --outDir .mtn-test-build`（0 错误）；
  2. `.mtn-test-build/package.json` = `{"type":"module"}`；`.mtn-test-build/loader.mjs` = ESM resolve hook，把无扩展名的相对说明符先重试 `.js`，再重试 `/index.js`（目录 barrel，如 `../i18n`，否则 `ERR_MODULE_NOT_FOUND`）；`.mtn-test-build/register.mjs` = `import { register } from "node:module"; register("./loader.mjs", import.meta.url);`；
  3. `node --import ./.mtn-test-build/register.mjs --test-isolation=none --test .mtn-test-build/test/minimap.test.js …`（可一次传多个文件）。
- 有些测试用 `import.meta.url` 读 `styles.css` / `src/**.ts`：把 `styles.css` 和全部 `src/**.ts` **原样复制**到 `.mtn-test-build`（例如 `Copy-Item styles.css .mtn-test-build/`、`robocopy src .mtn-test-build/src *.ts /S`），读到的仍是仓库原文；只复制，不修改测试。
- `.mtn-test-build/` 已在 `.gitignore`；验证后必须整体删除，不要提交。

**验证（2026-11-12 独立验证阶段，实测结果）**

- `npm run check` = **0 错误**。
- `npm run build` = **失败，但与代码无关**：受限沙箱下 esbuild 需要 spawn，报 `Error: spawn EPERM`（`esbuild.config.mjs:6`）；根目录 `main.js` 未被改写（时间戳仍是 2026-11-11 00:07:48）。正式构建仍由 CI / 正常桌面环境负责。
- 生产 bundle 替代验证（绕开 Node esbuild API，直接执行打包好的二进制，参数与 `esbuild.config.mjs` 生产配置一致）→ EXIT=0，`main-verify.js` **4,769,387 B ≈ 4.55 MiB**（< 10 MiB 上限），与 Lead 的结果一致。
- 编译回退单测（`.mtn-test-build`）——本次验收要求的 10 个文件 **92 / 92 通过 / 0 失败**：
  - minimap 10/10、minimap-ui 9/9、minimap-wiring 4/4、minimap-setting 3/3、viewport 8/8、plugin-data 15/15、i18n 6/6、styles 16/16、settings-index-wiring 10/10、ui-modules 11/11；10 个文件同进程再跑一遍仍是 92/92（`--test-isolation=none`）。
- 补充证据：编译目录下全部 99 个测试文件一起跑 = **885 tests / 874 pass / 11 fail**；11 个失败全部是回退运行器/沙箱限制，与本次改动无关：
  - 7 个已知 `esbuild buildSync → spawn EPERM`：adaptive-tooltip、ai-settings-page、custom-markers-settings-page、marker-popover-custom、node-renderer、plugin-update-modal、top-toolbar；
  - 4 个测试自带的 `obsidian` resolve stub 只匹配 `parentURL.endsWith("*.ts")`，编译后父模块是 `.js` 导致 stub 不生效：mcp-session-writer、mcp-settings-page-model、mcp-tools、search-panel。
  - AGENTS 里的 1053−885 = 168 条即这 11 个文件在模块加载期失败而未注册的用例，属环境限制，不能算通过或失败结论。
- 契约核对（独立读 diff + 源码 + 纯数据测试）：右下角悬浮层、基础设置开关（保存成功后才 refresh 已打开视图）、主题沿用 `data-mtn-theme` 的 CSS 变量、12% 分辨率目标与画布/可读尺寸双重夹紧、节点增多自动缩放、指示框=可见区域投影、点击与拖动都只改平移（缩放不变）、无视口持久化、无硬编码 UI 文案（`minimap.aria` 与 settings keys 走 i18n）、`ui/components` 无 view/main 反向导入、解析失败/设置关闭/版本对比（`rootEl.hidden`）隐藏——**全部符合契约**。
- 尚未做：真实 Obsidian 内人工验收（开关后已打开视图立即显隐、主题切换后的实际配色、拖动跟手与点击/拖拽判定、窄分栏与移动端位置、版本对比时不可见）。自动化不覆盖这些。
- 补充观察（非缺陷）：指示框「放大变小」在整棵树大于画布时严格成立；整棵树完全小于画布时可见域即场景域，指示框接近铺满，文档已按此精确化。

**同日后续调整（用户反馈）**：小地图不再绘制节点之间的连线，节点也不再使用十二色分支调色板——节点框统一 `fill: var(--mtn-node-text)`，只保留根节点略高的不透明度。原因：缩略比例下连线只是噪声，彩虹配色让整棵树看起来像色块堆，反而看不出结构。`MindTreeMinimapState` 因此删除 `branchColorSlots`，内容缓存键只剩布局引用与像素尺寸；`styles.css` 删除 `.mtn-minimap-connection`，组件不再创建 `<line>`，视图也不再向小地图传分支配色。测试与 `docs/02` / `docs/05` 口径已同步；指示灯框另行加了 `rx/ry=4` 圆角。

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

## 2026-10-13 · 分支引用（`mind-tree-ref`）与笔记内嵌只读分支视图（`feat`，团队协作）

**需求**：节点右键菜单「复制分支」**正下方**增加「复制分支引用」；引用与「该思维树 + 该节点」绑定，树内移动节点不失效、不能跨文件跟随；引用粘贴到 Markdown 笔记后嵌入一个**只读、可交互**的思维树分支视图（点击节点打开按钮打开对应资源），视图右上角悬浮「打开原始思维树」按钮（鼠标悬浮出现）；节点失效（被删除或被剪切到其他树）时改为提示文字。

**用户逐条确认的 9 个决策（不要再按别的口径实现）**：① 载体是代码块 ```` ```mind-tree-ref ```` + 单行 JSON（**不是**嵌入链接：`.mtn.md` 是普通 `.md`，Obsidian 原生嵌入会直接渲染大纲与压缩数据块，且没有 API 能接管按文件类型的嵌入渲染）；② 视图只显示被引用节点的**分支**（该节点为布局起点，深度字号与分支配色保持它在原树中的样子，与「导出分支 PNG」同口径）；③ 交互 = 平移/缩放 + 临时折叠 + 节点打开按钮 + 悬浮打开原树；④ 失效区分「节点不存在」与「树文件不存在」，原树仍在时保留打开按钮；⑤ 树缺 `documentId` 时**首次复制引用自动写入一次**；⑥ 多选时始终引用**右键点击的那个节点**；⑦ 树文件变化时**自动刷新**（120ms 防抖）；⑧「不能跨文件移动」只是语义说明，**不改动**现有跨导图复制粘贴；⑨ 视图高度**按分支内容自适应**（实现为：按适配宽度缩放后的内容高度 + 32px，写进 `--mtn-embed-height`；CSS 兜底 `min-height:120px; max-height:min(80vh,4000px)`；用户缩放后不再改高度）。

**引用格式（冻结）**：```` ```mind-tree-ref \n {"tree":"<documentId>","node":"<nodeId>","path":"<仓库相对路径>"} \n ``` ````。`path` 可选、仅作快速定位；缺少 `tree`/`node`、类型错、总长 > 4 KiB（`MAX_BRANCH_REFERENCE_BYTES`）一律塌陷为 `undefined`（笔记里显示 `embed.invalidSyntax`）。单行 JSON 让路径里的反引号也无法构造出独立的关闭围栏。

**落点**

- 领域（纯函数）：`src/domain/branch-reference.ts`（`BRANCH_REFERENCE_LANGUAGE`、`createBranchReference`、`serializeBranchReference`、`parseBranchReference`、`parseBranchReferenceBlock`、`renderBranchReferenceBlock`）；`src/input-limits.ts` 新增 `MAX_BRANCH_REFERENCE_BYTES = 4 KiB`。
- 解析服务：`src/services/mind-tree-reference.ts`（`MindTreeReferenceService`，端口 `fileExists`/`read`/`parseOptions`/`indexedTreePaths`）。候选顺序 = `pathHint` → 索引里该 `documentId` 的全部 `.mtn.md`；**只接受解析出的 `documentId` 与引用一致的候选**（路径被别的树占用 → `missing-tree` 失败关闭）；命中 ≥2 → `ambiguous`；节点不存在 → `missing-node`（**带解析出的 path**，改名后按钮仍可用）；读/解析失败 → `unreadable`。按路径缓存 + in-flight 去重，**失败不缓存**，`notifyChanged/Removed/Renamed` 精准失效并广播给订阅者。
- 剪贴板：`src/services/clipboard.ts` 新增 `copyBranchReference()`（只写 `text/plain`，不带自定义 MIME，清空同会话内存副本）；`ClipboardPasteContent` 新增 `{ kind:"branch-reference" }`，`readClipboardEventContent`/`readClipboardTextContent` 只把**整段恰好是一个围栏块**的文本判为引用。
- 只读渲染层复用：`src/ui/components/read-only-tree-preview.ts` 新增可选 `startId`/`className`/`fit`/`allowResourceOpen`/`openResource`/`wheelPassThrough`/`onLayout`（**默认值让版本对比与主题悬浮预览逐字不变**）；`src/ui/renderers/node-renderer.ts` 新增 `NodeRenderState.resourceOpenEnabled`（默认 undefined 时只读行为不变：打开按钮与链接标志都禁用；opt-in 后只放开打开按钮，链接标志仍死）。
- 内嵌视图：`src/ui/components/mind-tree-reference-embed.ts`（`MindTreeReferenceEmbedPorts`、`MindTreeReferenceEmbed`、`MindTreeReferenceRenderChild`）；`styles.css` 追加 `.mtn-embed*`（悬浮按钮用 `opacity` 而非 `display:none` 以保留键盘可达，`@media (hover: hover)` 才隐藏）。
- 装配：`src/main.ts` 的 `registerMarkdownCodeBlockProcessor(BRANCH_REFERENCE_LANGUAGE, …)` + `referenceEmbedPorts()` + `openReferenceResource()`（URL 走浏览器、文件走 `resolveVerified` + `openLinkedFile`，沿用 `resourceOpenMode`）+ `buildBranchReference()`（`documentId ?? resources.ensureStableReference()`）+ 在 **onload**（不是 onLayoutReady）注册 vault `create/modify/delete/rename` 与 `metadataCache.changed` → `notify*`，因为笔记里的引用不依赖任何已打开的视图。
- UI 接线：`ui-contracts.ts` 加 `copy-branch-reference`；`node-context-menu.ts` 在「复制分支」后加项（图标 `file-symlink`，已在本机 Obsidian 1.14.4 的 `obsidian.asar` Lucide 注册表里确认存在）；`mind-tree-view.ts` 新增 `copyBranchReference(nodeId)`（会话令牌 + 节点双重校验）与 `branch-reference` 粘贴分支（只提示「只能粘贴到 Markdown 笔记中」，不插入节点）。
- 团队分工（Lead 契约 → 两个 teammate 并行 → Lead 装配 → 独立 verifier）：契约 `task-1`、菜单/视图 `task-3`（view-wiring）、渲染/内嵌 `task-2`（embed-surface）、装配+文档 `task-4`、独立验证 `task-5`；写范围互斥，`npm run check` 是彼此契约的仲裁。
- Lead 集成时补的两处契约修正（写者已停下，由 Lead 改并补断言）：`missing-node` 带上解析出的 `path`（否则树改名后失效态的打开按钮会指向过期 `pathHint`）；`openResource` 端口改为传**节点对象**（只有被渲染的文档知道自己指向哪个资源）。F2 之后这次「取节点」发生在只读预览内部，端口形状不变。

**验证（最终）**

- `npm run check` 0 错误；`npm test`（真命令，本会话是 danger-full-access，esbuild 可 spawn）**787 tests / 787 pass / 0 fail**；`npm run build` 通过（`main.js` ≈ 4.4 MiB < 10 MiB 上限）。
- 本轮新增 27 条用例：`branch-reference` 5、`mind-tree-reference-service` 9、`reference-embed` 5、`node-renderer` +2、`styles` +3、`exchange` +2、`fold-direction` +1。
- 受限沙箱里 `npm test` / `npm run build` 仍会因 esbuild `spawn EPERM` 失败（AGENTS §1 不变），替代命令 `& "C:\Users\Dayiy\AppData\Local\Temp\dsh-mtn-hooks\run-tests.ps1"` 仍可用；注意它在**受限模式下**可能把某文件整段吞成「0 条用例执行」，所以「失败像环境问题」必须用 HEAD 对照复现再下结论（见下面 F1）。

**独立验证（teammate verifier，task-5）发现并已修的 3 个缺陷**

1. **F1（P1，真回归，我一开始误判）**：全量出现 8 条失败，我先按历史经验判为「既有 esbuild 环境失败」；verifier 用「HEAD bundle 正常 / 工作区 bundle 崩 / 只加一行桩后真实用例 8/8 通过」三重证据证明是**本轮新引入**——`test/plugin-update-modal.test.ts` 的 obsidian 桩缺 `MarkdownRenderChild`，而新模块 `mind-tree-reference-embed.ts` 的类 `extends MarkdownRenderChild`，bundle 求值即抛 `TypeError: Class extends value undefined`。修法：桩里补 `MarkdownRenderChild: class {},`。**教训**：只要新增「从 Obsidian 取基类」的模块，所有用 `esbuild buildSync + 手写 obsidian 桩` 的测试都要同步补桩；并且**不能用文件级失败形态反推环境问题**。
2. **F2（P2，正确性）**：同路径刷新只 `preview.update(document)`，而 `previewOptions.openResource` 闭包捕获了旧文档 → 节点的关联文件从 A 改成 B 并保存后，视图显示 B 但打开按钮打开 A（新加资源时按钮点了没反应）。修法：`TreePreviewOptions.openResource` 改为收**节点对象**，由 `ReadOnlyTreePreview.render()` 从**本次渲染的文档**取（`const node = document.nodes[id];`）；宿主不再捕获文档，`test/reference-embed.test.ts` 的断言随之移到 preview 源码上。
3. **F3（P3，视觉）**：`resolveFoldDirections` 在 `positionedNodes` 不含文档根时提前返回空表，radial/balanced 布局下内嵌视图的折叠按钮恒为 `right`。修法：找不到文档根时回落到**最浅的已布局节点**（即预览自己的根）；`test/fold-direction.test.ts` 新增子树布局用例。
4. verifier 指出的「红线无自动守护」也已补：`test/reference-embed.test.ts` 新增源码断言——`main.ts` 的 `openTree` 处理器必须调 `activateMindTree`，且不得出现 `openFile(` / `vault.read(`（红线 C.14：任何入口都不得打开导图源文件）。

**残余风险（verifier 报告，供接手者）**

- 内嵌视图**没有 DOM 运行时测试**（只有源码断言 + 无 DOM 推理）：真实 Obsidian 的阅读模式 vs 实时预览差异、`MarkdownRenderChild` 卸载时序、`(hover)` 媒体查询、真机触摸都未验证。
- 改名解析依赖资源索引（`resources.entries()`）：索引未就绪或刚改名未入库时，合法引用会短暂显示 `missing-tree` 且没有打开按钮，直到下一次 vault/metadataCache 事件。
- `ambiguous` / `unreadable` 的失效提示只有在引用带 `path` 时才有打开按钮（插件自己产出的引用必带 `path`，手改块可能缺）；`pathHint` 过期时点击只会提示「找不到文件」。
- 内嵌视图不读本机全局显示偏好（文件类型徽标忽略/别名、节点换行宽度、节点对齐都用默认值）——刻意让「同一引用处处一致」，已在 `docs/02` §6.6 写明。
- `fitted` 从不重置：用户缩放或改变笔记宽度后不再重新适配（只承诺用户缩放后不改容器高度）。
- `edit` 本轮的 `ReplaceFileW EIO (Win32 1175)` 依然高频（单个文件批量编辑时**第一条**几乎必失败，原样重试即成功）——并发写同一文件的 teammate 越多越明显。
- 未在真实 Obsidian 内人工验收（沙箱无法启动）：悬浮按钮观感与 hover 渐隐、`git-fork` 图标像素、移动端触摸行为。已知取舍：内嵌画布沿用只读预览的触摸隔离（`touchmove` 被 `preventDefault`），因此在视图内纵向拖动是**平移分支**而不是滚动笔记；普通滚轮已透传给笔记，`Ctrl/Cmd + 滚轮` 才缩放。若移动端要「拖动即滚动」，需要新的契约。
- 未做：`manifest.json` 版本号（发布方决定）、命令面板入口、工具栏「复制」下拉的对应项（按需求只改右键菜单）。

**用户实测反馈（同日两处，已修）**

1. **悬浮「打开思维树」按钮与代码块自带的动作按钮重叠**（实时预览下的「编辑区块」）。修法：`styles.css` 的 `.mtn-embed-open` 改为 `top: var(--mtn-embed-open-top, calc(--size-2-2 + --size-2-2 + --icon-m + --size-2-2 + --size-4-1))`（默认 32px）与 `inset-inline-end: var(--mtn-embed-open-right, var(--size-2-2, 4px))`：落到宿主动作行**下方**、共用行末边缘，偏移随主题 token 自动跟随，两个变量仍可覆盖。**关键 ground truth（第一轮我找错了类名）**：宿主动作真正的类名是 `.embed-actions` / `.embed-action`（`.edit-block-button` 只是 JS 侧的 hook），明文 CSS 就在本机 `obsidian.asar` 里——`top: var(--size-2-2)`、`padding: var(--size-2-2) var(--size-2-3)`、`inset-inline-end: var(--size-2-2)`，token `--size-2-2: 4px`、`--icon-m: 16px` → 宿主行占 y∈[4,28]、右内缩 4px。更要紧的是 `.cm-embed-block:hover .embed-actions { opacity: 1 }`：**我们的按钮被 hover 时宿主按钮必然同时可见**（`opacity:0` 仍参与命中测试，还会吃掉点击），所以几何避让是硬需求而不是"有时重叠"。教训：量宿主几何要按行为找类名，别按直觉猜类名。
2. **分支没有在引用视图里居中**。根因是时序而不是几何：`layoutTree` 末尾 `shiftIntoPositiveCoordinates()` 归一化、`finish()` 用 `max(x+width)/max(y+height)` 给出包围盒，verifier 用 5 种布局 × {文档根, 子分支} 共 10 组实测 `layout rect == 节点包围盒 且原点 (0,0)`，所以 `centerViewportOnRect(…,{0,0,w,h})` 本身没错；真正的问题是**首次 fit 量到 CSS 兜底的 320px**，随后盒子被 `--mtn-embed-height` 改成真实高度而 `fitted` 已为 true 不再重算——数值模拟：小分支只露 22px 且偏下、极小分支**完全看不见**、大分支偏上。修法：`TreePreviewOptions` 新增 `refitOnResize`（默认 false，版本对比/主题悬浮预览不变），fit 抽成 `fitToContainer()` 并记录 `fittedWidth/fittedHeight`；新增 `userAdjusted`（滚轮/指针/键盘三处置位），仅当宿主开启该选项且读者尚未平移/缩放时，容器尺寸变化（含 `min-height`/`max-height` 夹紧、宽度回流、折叠改高）就重新适配并居中；高度差 < 2px 忽略以避开「笔记滚动条改变宽度」的理论反馈环。该选项只适用于 `fit: "width"`（`contain` 的 zoom 依赖高度会自成反馈），已在选项注释里写明。

**验证（这两处修复）**：`npm run check` 0 错误；`npm test` **787 / 787 / 0 fail**（新增断言都嵌在既有测试里：`reference-embed` 钉 `refitOnResize`/`fitToContainer`/三处 `userAdjusted`，`styles` 钉新的按钮定位）；`npm run build` 通过。

3. **悬浮按钮外观来回三轮，最终形态：空闲全透明 / 悬浮 = 原生半透明灰底**。最终规则：`.mtn-embed-open` 去掉自己那套 `width/height: 28px`、`border`、`background: var(--background-primary)`、`box-shadow`，整条镜像 Obsidian 的 `.embed-action`（asar 明文可查）：`display: flex`、`padding: var(--size-2-2) var(--size-2-3)`（4px 6px → 与原生同尺寸 28×24）、`color: var(--embed-action-color, var(--icon-color, var(--text-muted)))`、`border-radius: var(--embed-action-radius, var(--clickable-icon-radius, var(--radius-s, 4px)))`、`cursor: pointer`；**空闲态强制透明**：`border: 0 !important; background: transparent !important; box-shadow: none !important;`；**悬浮态就是原生那一条**：`background-color: var(--mtn-embed-open-hover, var(--background-modifier-hover)) !important`（默认主题 `color-mix(in oklch, var(--mono-100) 6.7%, transparent)`，即半透明灰；深浅由 `--mtn-embed-open-hover` 一个变量控制，用户改深浅不需要碰插件文件、也不需要 `!important`）。两条都带 `!important` 时由特异性决胜（`:hover` 胜出），因此既压得住宿主/主题更具体的按钮规则（也会出现点过之后 `:hover`/`:focus` 残留），又保留原生悬浮底色；`test/styles.test.ts` 断言「padding 派生尺寸 + 空闲三处 `!important` 透明 + 悬浮是那一条 `--background-modifier-hover`」。教训：① 要「像原生」就把宿主自己的类（`.embed-action`）整条规则抄过来复用变量，别自配 `--background-primary`/`--radius-s` 拼近似外观；② 「空闲无底色」必须假设宿主/主题能用更高优先级给你画盒子，`!important` 是正确的工具（`.mtn-visually-hidden` 已有先例），但**只在空闲态**加，否则会连自己的悬浮底色一起屏蔽（`!important` 跨状态生效，这也是第二轮误判「悬浮也要透明」的技术原因）；③ **改 `styles.css` 必须在 Obsidian 里重载插件/重启才生效**，用户反馈样式没变时先排除这一条。

## 2026-10-15 · 本机 MCP 服务（`设置 → AI`，桌面端专属，团队协作）

**需求**：让插件把思维树开放给 MCP 客户端，一键复制客户端配置 JSON；工具含读取节点/父/子，以及创建思维树、移动/新增/重命名/删除节点、关联/取消关联文件；**移动端自动禁用**。用户逐条确认的三个选型：复制的是**客户端配置 JSON**（不是节点快照）、传输用**插件内本地 HTTP 服务**、写操作**默认关闭需显式开启**。另按用户要求把配置放在新增的 **「AI」tab**（不是 MCP 专属 tab）。

**落点**（新目录 `src/services/mcp/`，按「纯协议 / 宿主接线」两半分）

- 纯模块（**零 Obsidian 依赖**，`node:test` 直接可测）：`contracts.ts`（冻结边界）、`tool-error.ts`、`connection.ts`、`availability.ts`、`settings-page-model.ts`、`json-rpc-core.ts`、`tool-schemas.ts`（18 工具目录）、`mcp-core.ts`、`client-config.ts`。
- 宿主接线（唯一可以碰仓库/会话/设置）：`tree-reader.ts`、`tree-locator.ts`、`session-writer.ts`、`obsidian-tool-host.ts`、`http-transport.ts`、`mcp-server.ts`；`src/services/tree-creation.ts` 抽出**唯一的建树路径**，Ribbon/命令/MCP 共用（MCP 传 `focus: false`，**绝不抢焦点**）。
- 接线：`src/main.ts`（`initializeMcpServer()` 只在 `!Platform.isMobile` 时构造；`mcpSettings()` 返回 `McpSettingsPagePort`，**永不返回 undefined**，不支持时给 `unsupportedMcpSettingsPort()`）、`src/settings.ts`（`SETTINGS_PAGES` 表项 + `availability`/回落，`isSettingsPageAvailable` 复用 `isMcpSupported` 作为唯一平台判定）、`src/ui/settings-pages/ai-settings-page.ts`、`src/settings-model.ts`（`mcpEnabled`/`mcpAllowWrites`/`mcpPort`）、`src/plugin-data.ts`、`src/i18n/catalog.ts`（`settings.ai.mcp.*`、`mcp.error.*`）、`styles.css`（`mtn-settings-ai-*`，无任何颜色声明）。

**关键设计决定（后续勿推翻）**

1. **不引入 `@modelcontextprotocol/sdk`**（整棵依赖树 + 体积上限），手写传输子集：单一 `POST /mcp`、`application/json` 响应、`Accept` 必须同时含 `application/json` 与 `text/event-stream`（否则 406）、通知/响应 202、未提供 SSE 时 `GET` 405、`Mcp-Session-Id`（`initialize` 签发，缺失/未知 404）、未知方法 `-32601`。依据 [MCP 2025-06-18 Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。
2. **`tools/list` 在写权限关闭时仍列出全部 18 个工具**，闸门在 `tools/call`（这样 `writes-disabled` 对客户端可见）；被拒绝的调用**在任何端口被触碰之前**返回（用 recording fake 钉死）。
3. **错误文案归属：谁抛谁本地化。** 宿主抛的 `McpToolError{code,message}` 由协议层**原样透传**（测试钉死 pass-through）；协议层只为自己产生的 `writes-disabled` / `invalid-arguments` 调 `t()`。
4. **工具描述是静态英文、不走 i18n**——工具目录是给模型读的协议面，不是用户界面文案。
5. **安全五条**：只绑 `127.0.0.1`；`Host`/`Origin` 必须在回环集合内（防 DNS rebinding）；每请求 `Authorization: Bearer <token>`；请求体 64 KiB 上限；写权限是**独立第二开关**。**端口与 token 存设备本地存储**（`${manifest.id}:mcp-server`），**不进 `data.json`**，避免被 Sync 复制到别的设备。进插件设置的只有 `mcpEnabled`/`mcpAllowWrites`/`mcpPort`。
6. **移动端策略是「缺席而非不可用」**：`isMcpSupported` 是唯一判定点，移动端不构造启动器，因此**永不执行 `require("node:http")`**；`activePage === "ai"` 在移动端回落到首个可用页；平台门禁优先于设置值（桌面开启后把 `data.json` 同步到手机也不启动）。（注：2026-11-13 第二轮起 AI tab 改为移动端也渲染，MCP 分区在页面内显示红字不可用说明；本条记录的是当时“整页缺席”的旧策略。）
7. **`link_file` 与界面关联保持同一条路径**（`resources.ensureStableReference`），因此一个**尚无资源身份的非 Markdown 文件会在原目录补 `@`/`%` 身份后缀**——这是获得可引用身份的必要步骤，不是复制/移动。据此已修正 README 与 docs 里「不重命名任何文件」的过度承诺（原措辞不准确）。`link_file` 刻意**不**镜像 `associateFileWithTarget` 的标题改写，并设 `titleSync: "off"`，使一次工具调用无法开启双向改名。
8. **`require("node:http")` 必须写成函数内的非字面量加载**：`loadNodeHttp()` 里 `loader(NODE_HTTP_SPECIFIER)`。字面量 `require("node:http")` 会让真实构建报 `Could not resolve "node:http"`（`esbuild.config.mjs` 的 `external` 没有 node 内建，且该文件不在本任务写范围）。这个写法比 `default-app-opener.ts` 的字面量 `require("electron")` **更保守**：字面量会生成模块作用域的 `const electron = require("electron")`（移动端加载期就会解析），而非字面量只在函数被调用时解析。行为等价、移动端永不触发，已在产物中复核。
9. **`MCP_SERVER_VERSION` 硬编码已删除**：版本由 `McpHostEnvironment.version?.()` 提供，缺省回落 `"0.0.0-dev"`（刻意看起来不像发布版），两分支都有测试钉死。

**验证（本轮实测，Lead 独立复跑）**

- `npm run check` **0 错误**。
- `test/mcp-*.test.ts` **142/142**；`test/tree-creation.test.ts` **8/8**；`test/plugin-data.test.ts` **8/8**。
- `npm run build` 在受限沙箱不可用（esbuild JS API spawn `EPERM`）；改用**同参数的内置 esbuild 二进制**产出到临时目录（未触碰仓库 `main.js`）：**exit 0，4,728,847 字节 ≈ 4.51 MiB**（上限 10 MiB）。产物中 `node:http` 只作为字符串常量 `NODE_HTTP_SPECIFIER` 出现，**无字面量 `require("node:http")`**。
- **安全关键性质已证明**：`session-writer` 测试断言 `mutationLocked` 拒绝后文件**逐字节相同**、`Vault.process` **从未被调用**（CAS 回调都没进），并覆盖外部改写→保留外部字节、读回被篡改→`file-changed`。

**测试基线（按这个读，别把环境失败当回归）**：全量 `888 tests`，其中 **7 个必然失败**，全部是 `Error: spawn EPERM`（直接调 `esbuild buildSync` 的 DOM 测试无法 spawn 子进程）：`adaptive-tooltip`、`ai-settings-page`（本轮新增）、`custom-markers-settings-page`、`marker-popover-custom`、`node-renderer`、`plugin-update-modal`、`top-toolbar`。**其余必须全 pass**，因此正常基线是 **881/888**。任一 DOM 测试文件失败都会**整文件 0 用例执行**，别用文件级失败形态反推环境问题。

**已知待办 / 遗留坑（重要）**

1. **`registerHooks` 在 Node 20 上会抛**（它需要 Node ≥ 22.15，而 `AGENTS.md` §1 与 release workflow 钉的是 ≥ 20）。本轮 `protocol-core` 已把它换成 `module.register(<data: URL>)`（Node ≥ 20.6）并**按 `context.parentURL.endsWith("/i18n/index.ts")` 窄化作用域**，留下 WHY 注释。仍有 **6 个文件**在用 `registerHooks`：`resource-index-service`、`search-panel`（历史）与 `mcp-session-writer`、`mcp-tree-locator`、`tree-creation`（本轮）。**尚未修**，属仓级统一清理项。
2. **`--test-isolation=none` 下 mock URL 会互相污染**：ESM 模块缓存按 **URL** 键且是进程级的，多个测试文件若把 `obsidian` 解析到**同一个** `file:///mind-tree-test-host/obsidian.mjs` 但导出集合不同（谁窄谁污染），就会让后加载的文件报 `does not provide an export named 'App'`，而且**是否复现取决于文件调度顺序**。本轮 `host-wiring` 的三个新文件撞上这个坑（表现为 `test/resource-index-service.test.ts` 间歇性失败，非确定性）。修法：**每个测试文件用自己独立的 mock URL**；仅按 `parentURL` 窄化 hook **不能**解决（缓存键是 URL）。这是新增「obsidian 桩」时必踩的坑。
3. **测试运行器非确定性**：`run-tests.ps1` 历史上偶发额外失败；本轮也观察到「**被测文件正在被写**」时整批炸开（一次 125 fail，原因是并发编辑 `document.ts` 写到一半）。**判定回归前先单独重跑该文件**，并用 mtime 排除「有人正在写」。

**⚠ 并发写者警告（本轮实际发生，后续 agent 务必先看 git status）**：本会话进行中，`src/format/document.ts`、`src/types.ts` 与**新建** `src/format/regions.ts` 被**本任务三个 teammate 之外**的写者改动（mtime 01:45:46–01:45:53，晚于全部 teammate 收工）。那是一轮把 header/data-region 解析抽到 `regions.ts`、新增 `MindTreeHeaderStatus` + `ParsedMindTreeFile.headerStatus`（`unreadable` 时冻结身份、保留 header 字节）的重构。它与 MCP 代码**完全解耦**（`regions.ts` 只被 `document.ts` import，无 MCP 文件引用），但**回归了 7 条既有测试**（`document-settings-state` 3 条、`document-conflict`/identity/`node-title` 等），使全量从 881/888 掉到 874/888。**本任务未触碰、未修复、也未被授权处理这三个文件**；收尾时已把该状态如实上报用户，由用户决定保留/回退/交由原作者收尾。**不要把这三个文件当成 MCP 任务的一部分，也不要在未确认前回退它们**（可能属于另一个正在进行的会话）。

**↳ 该写者的更正与收尾（2026-10-15 02:0x，本人补记，仅更正上面这条的时效）**：上面观察到的 874/888 是**中间态**（当时正在改 `serializeMindTreeFile` 的 header/body 接缝，`---` 与正文之间少一个空行导致 YAML 序列化后重新解析失败）。**该轮工作现已完成并全绿**：`npm run check` 0 错误；全量 **911 条、失败 9 条 = 7 条既有 esbuild `spawn EPERM` + 2 条 `test/mcp-http-transport.test.ts` 端口占用抖动**（单独跑该文件会挂住并占端口，可能是它自己的非确定源），`874` 已不复现。落点见下方 2026-10-15 条目；**不需要回退这三个文件**。

## 2026-10-15 · `.mtn.md` 读写契约收敛到数据区（`refactor` + `fix`，用户提问驱动）

**问题（用户实测）**：偶尔提示"文件无法解码 / 思维树损坏"，最近一次是外部拖动文件夹并触发 Obsidian「更新双链」，**关闭后重开就正常**。用户提问：校验是否只该看 json 数据块、忽略前面的大纲文段；并认为"思维树只能同时打开一个，所以数据区不会被多方同时改"。

**核实结论（对照代码，避免重复劳动）**
- 冲突判定**早就不看大纲**（`mindTreeMachineDataFingerprint` 只比机器数据，`test/document-conflict.test.ts` 已冻结）；收益不在"减少冲突"，而在**消除假损坏**。
- "只能同时打开一个"**不成立**：代码明确支持同一文件多标签共享会话（`docs/05` §11.1、`MindTreeSessionRegistry`）。结论仍近似成立——插件内每路径只有一个写队列，且 Obsidian 的链接改写只动 `[[...]]`（base64 字母表无方括号），数据区内容只有插件写。
- 真正的三个缺口：① 文件头或围栏标记坏了就判整文件损坏（假损坏）；② `serializeMindTreeFile` 重建整段文件头（丢注释），且 `stripMachineDataSection` 在标记残缺时不剥离旧数据区 → 追加出**两个数据区**，之后每次读回都是旧的；③ 物理撕裂读被当成损坏。

**落点**
- 新增 `src/format/regions.ts`：`locateDataRegion()`（容错定位；0 个 = missing、≥2 个 = ambiguous 失败关闭）、`payloadSectionStart()`（按行回退吃掉生成的分割线/提示/注释标记，标记残缺也整段替换）；未闭合围栏由 `damagedSectionStart()` 连同装饰一起切掉，避免残留两个数据区。
- 新增 `src/format/yaml-patch.ts`：`patchYamlHeader()` 按 YAML 节点 range 只补丁插件拥有的键（`documentId`/`schemaVersion`/六项设置），**注释、空行、键序、无关 Frontmatter 逐字节保留**；无法安全补丁（range 重叠、多行值、非映射头）返回 `undefined`，调用方保留原字节。
- `src/format/document.ts`：`parseMindTreeFile()` 改为**数据区优先**（数据区是唯一硬契约），文件头三态 `ok | missing | unreadable`（`unreadable` → 按 v1 解析、设置取运行时默认、`documentId` **不自动分配**、保存原样保留文件头）；`serializeMindTreeFile()` 只替换自己拥有的区域。**本轮唯一的坑**：header 与 body 的接缝必须归一到 `\n\n`，少一个空行会让 `---` 与正文粘成 `---# 标题`，重新解析立刻变 `unreadable`（当时表现为 7 条既有测试失败）。
- 新增 `src/services/stable-source-read.ts`：`readStableSource()` / `confirmUsableSource()` 要求读取前后 `path:ctime:mtime:size` 不变，未稳定按 120/400/1000 ms 退避重读；未稳定的字节**不作为版本、也不判损坏**。
- 接线：`mind-tree-view.ts` 的 `checkExternalVersion()`（稳定读取 + 路径短暂消失的宽限 `confirmBackingFileGone()`，顺带修掉"文件缺失时 `enterVersionPreview()` 会为一次删除建未决记录"）、`setViewData()` 解析失败后台 `scheduleParseRecheck()` + `SharedMindTreeSession.initializeOrRepair()`（只修复"从未持有文档"的会话）、`main.ts` 协调器 `read` 端口。
- i18n 新增 `status.rereading`、`conflict.unstableRead`（EN+ZH 成对）。docs：`03` §7.1/§7.2/§7.4、`05` §11.1/§11.2、`06` 验收第 10 条。

**验证**：`npm run check` 0 错误；全量 **911 条 / 失败 9 = 7 条既有 esbuild `spawn EPERM` + 2 条 `test/mcp-http-transport.test.ts` 端口抖动（与本轮无关）**；新增 `test/format-regions.test.ts` 15 条、`test/stable-source-read.test.ts` 8 条全通过；`format` / `document-conflict` / `version-conflict` / `document-settings-state` / `identity-repair` 等既有断言**未放宽任何一条**。

**未做（与用户讨论过的后续项，建议按此顺序）**
1. 干净会话自动刷新为外部版本（`adopt-external`）："干净会话也要选择"是 `test/version-conflict.test.ts:45` 冻结的行为，属需求变更，要改测试并同步 `docs/02`。
2. `pending-conflicts/<本机标识>/*.json` 改为内存 + 有界 localStorage（用户要求"不往仓库写冲突文件"；`.obsidian` 在 vault 目录内，是否算"仓库"仍需用户拍板）。
3. 真损坏时的"恢复上一次成功数据"命令（内存 last-good，不落任何文件）。

**环境坑（本轮新增）**
- `edit` 的 `ReplaceFileW EIO (Win32 1175)` 在 `src/format/document.ts`、`src/format/regions.ts`、`src/ui/mind-tree-view.ts` 上都出现过，**原样重试即成功**（与 2026-10-13 条目一致）。
- 本会话与另一个 session（MCP 任务）**并发改同一工作区**：开工时 `npm run check` 的基线是红的（`src/settings.ts` 引用不存在的 `mcpSettings`），几分钟后对方改完自愈。`git status` 里的 README/docs/catalog/settings-* 与 `src/services/mcp/` 都不是本轮的改动，**未触碰、未提交**。

## 2026-10-15 · 统一「复制 / 导出」为嵌套菜单 + 复制为 Mermaid 代码（`feat`）

**需求（用户原话）**：把节点右键菜单里的导出和工具栏里的导出统一，都是展开菜单，然后导出 PNG 或导出 markdown 选项；复制选项除了复制分支外，新增一个「复制为…」的展开按钮，里面选项是：复制分支引用、复制为大纲、复制为 mermaid 代码。

**关键决策（不要按别的口径重修）**

1. **嵌套菜单用宿主自带的 `MenuItem.setSubmenu()`**（不是自造 DOM，也不是「点父行再在锚点旁开第二个 Menu」）。本机 Obsidian 1.14.4 的 `obsidian.asar` 里可读到实现：`setSubmenu()` 给行加 `has-submenu` + chevron；`handleEvent` 命中带 submenu 的行时**不调用 onClick、不关闭父菜单**，桌面 `selectElement(row, true)`（悬浮展开）、手机把子菜单从左滑入；原生桌面菜单也会转成真正的 Electron submenu。该 API **未出现在 `node_modules/obsidian/obsidian.d.ts`**（属未公开 API，论坛 2023-05 起就有使用），因此：`ui/menus/menu-groups.ts` 用 `as unknown as { setSubmenu?: () => Menu }` 窄结构视图调用 + **`supportsSubmenus(() => new Menu())` 能力探测**；探测不到时同一批命令**平铺进父菜单**（父行不再出现，避免出现一条点了没反应的死行）。探测必须在**一次性 Menu** 上做（`Menu.addItem` 会把探针项加进那个实例）。
2. **两个入口共用一份菜单描述**：`ui/menus/copy-export-menu.ts` 的 `copyBranchRow` / `copyAsGroup` / `exportGroup` / `exportRows`，节点右键菜单与工具栏都从它取行序、图标与命令；行序常量 `COPY_AS_MENU_ORDER` / `EXPORT_MENU_ORDER` 在 `ui/ui-contracts.ts`（`test/ui-modules.test.ts` 钉死）。工具栏「导出」下拉=直接列出两条导出；节点菜单「导出」=同名子菜单。
3. **导出两端统一为同一批命令**：`exportPng` → `exportSelectedPng()`、`exportMarkdown` → `exportSelectedMarkdown()`，即节点右键菜单第一次拥有「导出 Markdown」，`menu.exportBranchPng` 与 `menu.copyMarkdown` 两个旧 key 随之删除。
4. **Mermaid 形态 = `mindmap` 围栏代码块**（不是 flowchart）：```` ```mermaid ```` + `mindmap` + **2 空格缩进**，节点一律 `n<i>["标签"]`；标签取**标题纯文本**（`parseNodeTitle().plainText`，同步文件名节点走 `nodeTitleMode` 的 literal 分支），只导出**层级与标题**——资源链接、节点标记、节点 id 在 Mermaid 里没有对应表达，刻意不导出。被复制的节点自己当 mindmap 根（子分支不会被重排到文档根）。
5. **Mermaid 转义按 shape 分隔符选形**：mindmap 的标签由 shape 承载，`["…"]` 能容纳除 `"` 以外的一切；因此含 `"` 时改用圆括号形状 `(…)`，**同时**含 `"` 与 `()`/`[]`/`{}` 时才把 `"` 换成 `'`。**不要用实体码**：mindmap 的 `sanitizeText` 不解码 `#quot;`，写了会原样显示（flowchart 才解码，所以这里不能照抄 flowchart 的转义惯例）。
6. **多选语义沿用分支引用那一套**：节点右键菜单里「复制为 mermaid 代码」与「复制分支引用」都针对**右键点击的那个节点**；工具栏入口没有右键目标，用主选节点（`primarySelectedId`）。「复制分支 / 复制为大纲 / 导出 PNG / 导出 Markdown」仍按现有选择语义（`copySelected` / `exportSelected*`）。

**落点**

- 新增纯函数 `src/format/mermaid.ts`：`renderBranchMermaid(document, startId)`（起点节点不存在返回 `""`；`visiting` 集合防环、悬空 childId 跳过）、`mindmapLabel(node, isRoot)`。
- 新增 `src/ui/menus/menu-groups.ts`：`attachSubmenu` / `supportsSubmenus` / `addMenuRow` / `addMenuGroup`（`import type` 引 obsidian，运行期零 obsidian 依赖，可被 tsx 直测）。
- 新增 `src/ui/menus/copy-export-menu.ts`：`CopyAsActions` / `CopyMenuActions` / `ExportMenuActions` 与四个行/组构造器。
- 改写 `src/ui/menus/node-context-menu.ts`（actions 改名 `copyOutline`/`exportPng`/`exportMarkdown`，新增 `copyMermaid`；尾部改为「复制分支」+「复制为…」+「导出」）与 `src/ui/menus/toolbar-menus.ts`（`CopyMenu`/`ExportMenu` 改收 actions 对象，`CopyMenu` 增加「复制为…」）。
- `src/services/clipboard.ts` 抽出 `copyPlainText()`；`copyBranchReference()` 改为它的调用方（行为逐字不变）。
- `src/ui/mind-tree-view.ts`：`showCopyMenu` 捕获 `primarySelectedId` 后同时接线「复制分支引用/复制为大纲/复制为 mermaid 代码」；新增 `copyMermaid(nodeId)`（会话令牌 + 节点双校验后 `copyPlainText`）+ `notice.mermaidCopied`。
- i18n：新增 `menu.copyAs`/`menu.copyAsOutline`/`menu.copyAsMermaid`/`menu.export`、`notice.mermaidCopied`；改写 `menu.exportPng`/`menu.exportMarkdown` 为「导出 PNG / 导出 Markdown」；删除 `menu.copyMarkdown`/`menu.exportBranchPng`。
- 图标（已在本机 `obsidian.asar` 的 Lucide 注册表里确认存在）：`copy-plus`（复制为…）、`file-symlink`、`list-tree`、`workflow`（mermaid）、`download`（导出）、`image-down`、`file-down`。
- 测试：新增 `test/mermaid.test.ts`（7 条）、`test/menu-groups.test.ts`（3 条），`test/ui-modules.test.ts` 增加共享行序断言并改写旧的「复制分支引用紧跟复制分支」断言（需求变更，已在 `docs/` 写明）。
- 文档：`docs/02` §5.3 / §6.6 / §6.10、`docs/requirements.md` 第 20 条、`docs/06` P0 第 21 条、`docs/01` 功能清单、`docs/05` §9.1 菜单段落、`AGENTS.md` §2/§3.2/§5/§10、中英文 README §4。

**验证**：`npm run check` **0 错误**；全量 **922 条 / 915 pass / 7 fail**，7 条全部是既有 esbuild `spawn EPERM` 环境失败（`adaptive-tooltip`、`ai-settings-page`、`custom-markers-settings-page`、`marker-popover-custom`、`node-renderer`、`plugin-update-modal`、`top-toolbar`），**没有新增失败**；`npm run build` 在受限沙箱仍是 `spawn EPERM`，改用同参数的内置 esbuild 二进制产出到临时目录：**exit 0，4,746,455 字节 ≈ 4.53 MiB**（上限 10 MiB），临时目录已删除、仓库 `main.js` 未触碰。

**未做 / 待真机确认**

- **未在真实 Obsidian 内人工验收**（沙箱无法启动）：子菜单的悬浮展开与键盘上下键、原生桌面菜单（macOS 默认 `nativeMenus`）下 `setSubmenu` 的观感、移动端从左滑入、以及深色主题下 chevron 的可见性。
- `setSubmenu` 是未公开 API：探测失败只会平铺（功能不丢），但若未来版本改名，需要更新 `ui/menus/menu-groups.ts` 一处。
- Mermaid 复制不含资源链接与节点标记（按「minimal / 可解析」取舍）。若用户要求带资源，需要先确定 mermaid 侧的承载形式（`click` 行只对 flowchart/graph 有效，mindmap 不支持）。
- `edit` 的 `ReplaceFileW EIO (Win32 1175)` 本轮在 `src/ui/mind-tree-view.ts`、`README.en.md`、`AGENTS.md` 上各出现一次，原样重试即成功；AGENTS.md 每次编辑后会被重新注入指令（正常现象）。

## 2026-10-16 · MCP 两个独立权限：修改节点 / 创建思维树（`feat`）

**需求（用户追加）**：把「写入思维树」的 MCP 拆成独立权限。原先 `create_tree` 与修改节点的工具共用 `mcpAllowWrites` 一个开关，用户希望**创建整棵思维树**是一条**独立授权**。

**口径（按「改动已有文件」与「产出新文件」是两种不同风险来切）**
- **读**：9 个只读工具，永远可用，不受任何开关影响。
- **修改节点**（`mcpAllowWrites`）：`move_node`、`add_node`、`rename_node`、`delete_node`、`link_file`、`unlink_file`、`link_node`、`unlink_node`。
- **创建思维树**（新设置 `mcpAllowTreeCreation`）：只有 `create_tree`。
- **`add_node` 属于「修改」而不是「创建」** —— 它改动的是一棵已存在的树。判据是「是否产出新文件」，不是「名字里有没有 create」。
- 两个开关**默认都关、互不牵连**：任何一个都不启用或禁用另一个。

**落点**
- `contracts.ts`：`McpToolAccess` 由 `"read" | "write"` 扩展为 `"read" | "write" | "create-tree"`；`McpHostEnvironment` 新增 `allowsTreeCreation()`（与 `allowsWrites()` 并列，均在 **call time** 读取，因此用户改开关后下一次调用就生效）。
- `tool-schemas.ts`：`create_tree` 声明 `access: "create-tree"`；**`isWriteTool(name): boolean` 已删除并替换为 `accessOfTool(name): McpToolAccess | undefined`** —— 三档能力用一个布尔已经答不出「归哪个开关管」，这是必须换 API 的原因。
- `mcp-core.ts`：新增 `permissionRefusal(definition, host)` 作为**唯一闸门表**（`switch (definition.access)`，穷尽分支），在**参数校验之前**执行，所以被拒的调用连一个端口都不会碰。
- `tool-error.ts`：新增错误码 `"tree-creation-disabled"`。
- `settings-model.ts` / `plugin-data.ts`：新增 `mcpAllowTreeCreation`；**旧配置缺该键时回落为 `false` 而不是继承 `mcpAllowWrites`** —— 升级只能**少**授权，绝不能默默放开建文件。
- `settings-page-model.ts`：`McpPageState`/`McpPageModel` 增加 `allowTreeCreation`/`treeCreation`；两个开关都只受「服务是否开启」禁用，**不互相禁用**。
- `ai-settings-page.ts`：新增第三个开关；`ports.ts` 增加 `setAllowTreeCreation`。
- i18n：`settings.ai.mcp.writes` 措辞改为「允许修改节点的工具」，新增 `settings.ai.mcp.treeCreation(.desc)` 与 `mcp.error.treeCreationDisabled`，并同步改写 `writesDisabled` 与 README 段落（两语言占位符一致）。

**⚠ 本轮抓到并修掉一个真缺陷（跨 realm 的 `instanceof`）**
`ai-settings-page.ts` 的 `describeError()` 原本是 `error instanceof Error ? error.message : String(error)`。当页面被 `esbuild buildSync + node:vm` 在一个**新 realm** 里求值时，测试（另一个 realm）抛出的 `Error` **不满足该 realm 的 `instanceof Error`**，于是走 `String(error)` 兜底，状态行变成 **`Could not start: Error: address already in use`**（多一个 `Error:` 前缀）。改为鸭子类型读 `message` 后不再依赖 realm。
**教训**：`instanceof` 是 realm 局部的，任何**跨 realm 传错误对象**的代码都不能用它；这类缺陷只在「把该模块放进独立 realm 求值」的测试里才暴露——**而它直到本轮沙箱变成 `danger-full-access`、`buildSync` 终于能跑时才第一次被发现**（此前该测试文件整段是 `spawn EPERM`，0 用例执行）。凡是「文件级失败看起来像环境问题」的测试，都是长期盲区。

**验证（本轮沙箱已放宽为 danger-full-access，因此是全量真跑）**
- `npm run check` **0 错误**。
- `npm test`（真命令）→ 实际用替代运行器：**1002 tests / 1002 pass / 0 fail**（此前 7 条 `spawn EPERM` 的 DOM 测试这次全部真实执行，`ai-settings-page` 15 条全过）。
- `npm run build`（真命令，本轮可跑）：**exit 0，`main.js` 4,750,162 字节 ≈ 4.53 MiB**（上限 10 MiB），产物中 `node:http` **无字面量 `require`**（仍只有字符串常量），移动端加载不受影响。
- 新增/改写测试：`mcp-tools` 新增「四种权限组合」断言（只开修改时 `create_tree` 被拒、只开创建时修改类被拒、两个都关时各自报自己的码）；`mcp-settings-page-model` 新增两开关互不牵连；`ai-settings-page` 新增行序 + 两开关独立过渡；`plugin-data` 新增「旧配置不继承创建权限」。

**环境变化（对后续 agent 很重要）**：本轮沙箱策略已从 `workspace-write` 变为 **`danger-full-access`**，`npm test` 与 `npm run build` 都能直接跑通，`esbuild spawn EPERM` 的旧替代方案可以不用了；但 `AGENTS.md` §5 里记的「7 条必然失败」基线仍适用于**受限**沙箱，别把环境差异当成回归。

## 2026-10-17 · MCP 改为**两个服务器**（只读 / 写入），去掉插件级权限开关（`feat`）

**↳ 2026-11-10 更新：该设计已被用户要求撤销，改回一个服务器；见 2026-11-10 条目。以下保留为历史记录。**

**需求（用户两次纠正后的最终口径）**：用户的原话是「写入和创建都是一个服务器，不保留插件级开关」——即把 MCP 拆成**两个服务器**：一个只读、一个承载全部会改动的工具（含 `create_tree`）。理由是**有些 agent 插件的审核强度只能以 MCP 服务器为单位配置**，所以「读工具完全放行、写与创建需要审批」只能在服务器这一层切开。用户另外确认：**两个端口**（客户端按 host:port 区分，避免被去重成同一个）、**升级后只开只读**。

**这里的关键认知（不要退回去）**：MCP 客户端的工具审批策略挂在**服务器**上，不是单个工具上。所以「一个服务器 + 按工具的权限开关」这个思路本身是错的——插件若在服务端拒绝写工具，客户端里那条「我批准了」的调用就永远失败，用户体验是坏的。**分权必须落在服务器边界上**，插件不再对工具调用做任何权限判断。

**口径**
- `read` 服务器（`mind-tree-nature-read`，默认 27321）：9 个只读工具，**不含任何会写入的工具**，随总开关开启，可免审批运行。
- `write` 服务器（`mind-tree-nature-write`，默认 27322）：8 个节点/文件工具 + `create_tree`（共 9 个），**默认关闭**，有自己的开关。
- **`add_node` 属于 write**：它改动一棵已存在的树。判据是「是否改动文件」，不是名字里有没有 create。
- 两个服务器的工具清单**完全不重叠且合起来是全部 18 个**，由 `tool-schemas.ts` 的 `server` 字段声明。
- 调用不属于当前服务器的工具 = **该服务器上的未知工具**（`invalid-arguments`），不是「权限不足」。`McpToolErrorCode` 里的 `writes-disabled` / `tree-creation-disabled` 已删除——**插件不再有「拒绝但工具存在」这个状态**。

**落点**
- `connection.ts`：`McpServerGroup = "read" | "write"`、`mcpServerName(group)`、`mcpServerRecordKey(pluginId, group)`（键 `${manifest.id}:mcp-server:<group>`）。两个服务器**端口与令牌都不同**，只读配置拿不到写入权限。
- `tool-schemas.ts`：`access` 字段改为 `server`；`getToolDefinitionsFor(server)` / `getToolDefinitionFor(name, server)` / `serverOfTool(name)`。`accessOfTool`、`isWriteTool` 删除。
- `mcp-core.ts`：`handleMcpMessage(raw, host, server)` 与 `callTool(host, server, name, args)` 都带服务器；删除整个 `permissionRefusal` 闸门表；`initialize` 的 `serverInfo.name` 用 `mcpServerName(server)`，让客户端能把两个服务器区分开。
- `contracts.ts`：`McpHostEnvironment` 变成 `isSupported()` + `connection(group)` + `version?()` + `logger?`，`allowsWrites`/`allowsTreeCreation` 删除。
- `session-writer.ts`：删掉 `allowsWrites` 端口与其两处检查——**边界是「写入服务器是否在监听」，不是逐工具开关**。
- `mcp-server.ts`：`McpServerController` 增加 `group`（注意用 getter 而不是字段：`useDefineForClassFields` 会在构造函数体之前初始化字段，字段写法会读到 `undefined`），`storageKey` 按 group 派生，新增 `boundPort` getter。
- `settings-model.ts`：`mcpEnabled` / `mcpReadPort`(27321) / `mcpWriteEnabled`(false) / `mcpWritePort`(27322)；删除 `mcpAllowWrites` / `mcpAllowTreeCreation` / `mcpPort`。`DEFAULT_MCP_PORT` → `DEFAULT_MCP_READ_PORT`。
- `plugin-data.ts` 迁移：**旧 `mcpPort` 沿用为 `mcpReadPort`**（既有客户端配置仍指向一个存在的服务器），**旧 `mcpAllowWrites` 一律不继承**（`mcpWriteEnabled` 默认 false）——升级只能收窄授权，绝不能默默新增一个入站服务。
- `main.ts`：两个 `McpServerController` 实例；`applyMcpServers()` 是**唯一**的协调点（先停两个，再按 `mcpEnabled` / `mcpWriteEnabled` 启动），所有开关与端口变更都走它，避免出现「设置说关闭但还在监听」。
- `client-config.ts`：`buildMcpClientConfig(connections: readonly {group, port, token}[])`——只列出调用方传入的服务器，因此配置永远不会广告一个没有在服务的端点。
- `settings-page-model.ts`：`McpPageState = { supported, enabled, read, writeEnabled, write }`，每个端点带 `port`/`boundPort`/`status`/`token`；`enabledConnections(state)` 决定配置里出现哪几条。
- `ai-settings-page.ts`：总开关 → 只读块（小标题/范围/端口/状态）→ 写入块（同样 + 自己的开关）→ 配置 → 令牌提醒。

**一个分层修正（Lead 收尾做的）**：`McpServerModel` 原本只有 `value` 没有 `disabled`，页面为了禁用写入开关，自己拼了 `model.enable.disabled || !model.enable.value`。这是把**策略**放回了视图层，所以给模型加了 `disabled` 字段（含义是「总开关关着或平台不支持」，**不包含**写入开关自身关闭——否则用户就没法打开它了）。

**验证**
- `npm run check` **0 错误**；`npm test`（真命令）**1010 tests / 1010 pass / 0 fail**（92 个文件，全部声明都真实执行）；`npm run build` **exit 0，`main.js` 4.53 MiB**（上限 10 MiB），产物中 `node:http` **仍无字面量 require**。
- 安全边界有测试钉死：两个目录恰好 9+9、**不重叠且并集为全部 18**；把 9 个写工具全部打到只读服务器（以及 9 个读工具打到写入服务器）逐个得到 `isError` 的「未知工具」，且 recording fake 证明**端口调用数为 0**；另有**正向对照**证明「同样这 18 个调用在拥有该工具的服务器上成功」，排除「拒绝是因为工具体坏了」。
- 两个服务器**记录键/令牌/端口互不相同**（`…:mcp-server:read` / `…-write`），只读令牌拿不到写入权限。
- 迁移测试：`{mcpPort:30000, mcpAllowWrites:true, mcpAllowTreeCreation:true}` → `mcpReadPort:30000` + `mcpWriteEnabled:false`。

**被移除的断言（已复核，均有更强的替代）**：旧「按开关门禁工具」的 12 条（`mcp-tools`，前提已不存在，由两个方向的边界测试 + 正向对照取代）；`resolveConfiguredPort` / `buildMcpConfigText` 两个已删除函数的函数级断言（范围回退改由 `plugin-data` 的两个端口 + `normalizeMcpPort` 覆盖）；`mcp-session-writer` 中「写权限关闭时 create_tree 被拒」一条（生产者已删除）。**注意**：`test/ai-settings-page.test.ts` 与 `test/settings-index-wiring.test.ts` 里曾断言旧端口 API 的两处源码字符串，已随本轮同步更新（前者由页面负责人发现并上报，后者由 Lead 改）。

**未做 / 待真机确认**
- 未在真实 Obsidian 里人工验收：两个端口同时在网、客户端里两条服务器记录分别设置审批策略后的实际观感、以及只读那条免审批时是否真的不弹确认。
- 若用户把两个端口填成同一个值，后启动的那个会回退到邻近端口（状态行显示实际地址）。这是可接受的降级，但没有在 UI 上专门提示「两个端口撞了」。
- `mcp-tree-locator` / `mcp-tree-reader` / `tree-creation` / `resource-index-service` / `search-panel` 这 5 个文件仍用 `module.registerHooks`（需 Node ≥ 22.15，而项目钉 ≥ 20）。本轮 `mcp-session-writer` 已改成 `module.register`（Node ≥ 20.6），其余 5 个仍待清理。

**同日追加：去掉配置 JSON 的只读文本框（用户反馈，`feat`）**

用户反馈「复制 JSON 的文本框宽度太小了，快被挤没了；没必要留文本框，只保留复制按钮即可」。原因是 Obsidian 设置页的**控件列**本身很窄（`Setting.controlEl`），一个 `width: 100%` 的 textarea 挤在里面只剩一条。

**改动**：删除 `ai-settings-page.ts` 里的 `addTextArea` 与 `configText` 字段、`applyModel` 里的回填、以及失败时「露出文本框」的分支；删除 `styles.css` 的 `.mtn-settings-ai-config-text` 与它那条 `[hidden]` 规则；`settings.ai.mcp.config.copyFailed` 的措辞改成不指向「下方文本」（原文案是「请选中下方文本手动复制」，文本框没了就成了误导）。

**关键取舍：移除文本框就移除了唯一的手动兜底，所以把复制本身做成两条路径**。`main.ts` 新增模块级 `copyToClipboard(text)`：先 `navigator.clipboard.writeText`（需要焦点与安全上下文，桌面端可能 reject），失败时回退 `copyViaTemporarySelection()`——**临时离屏 textarea + `execCommand("copy")`，用完立即 `remove()`，用户看不到该元素**（注意必须离屏而不是 `display:none`：隐藏节点无法被 `select()`）。这样「把凭据渲染到界面上」这件事彻底没有了，而复制途径反而比原来更稳。

**测试**：`test/ai-settings-page.test.ts` 从 20 条改为 21 条。删掉文本框相关断言，改为两条更强的：① 配置区块里 `querySelectorAll("textarea")` 必须为 0，且渲染文本中**不得出现**服务器键名、`Bearer` 或任一令牌——即「凭据只作为剪贴板内容存在」这条性质被钉住；② 按钮交给剪贴板的内容仍等于模型产出的两服务器 JSON（用 `h.copied` 断言，覆盖「只开只读」「总开关关闭时为空对象」两种情形）。失败路径测试改为断言说明文案自洽（不含「下方/below」）且仍无 textarea。**注意 `TestTextArea`/`addTextArea` 这个桩要保留**：它是上面那条「没有 textarea」断言能成立的前提（页面若重新用上 `addTextArea`，桩就会真的生成一个 `textarea` 元素）。

**验证**：`npm run check` 0 错误；`npm test` **1011 / 1011 / 0 fail**；`npm run build` exit 0，`main.js` 4.54 MiB。

## 2026-10-17 · 关联节点改为「粘贴分支引用」创建，移除工具栏与选择窗口（`feat`）

**用户口径（3 项确认，务必按此读）**：① 分支引用允许粘贴到思维树，粘贴结果是**新增一个节点**（标题取目标节点当前标题）并让它单向关联到引用里的目标节点；② 只支持**同一棵树内**，跨文件只提示（`nodeLink` 只是同一文档内的 id）；③ 右键菜单里的「关联节点」创建项移除（已参与关联时仍保留「取消关联节点」），**工具栏入口与节点选择窗口一并删除**。

**落点**

- `services/clipboard.ts`：新增 `BranchReferenceTarget` + `resolveBranchReferenceTarget(document, reference)`（按 `documentId` 比较身份而不是路径，因此改名后的树仍认自己的引用；当前树没有身份也算“别的树”）与 `insertBranchReferenceNode(document, parentId, reference, untitledTitle)`（`addNode` + `createNodeLink`；被拒时返回 `undefined`，**一个节点都不插**）。
- `ui/mind-tree-view.ts`：`applyClipboardPasteContent` 的 `branch-reference` 分支改为 `pasteBranchReference()`——先用 `resolveBranchReferenceTarget` 快检（避免为一次被拒的粘贴开出撤销记录），命中才在一次 `commit` 里插入并建边，随后选中并居中；`toggleNodeLink` / `createNodeLinkFor` / `describeNodeLinkError` 删除，`unlinkNode(nodeId)` 只负责移除；`refreshTopToolbar` 不再上报 `nodeLinked`。
- `ui/menus/node-context-menu.ts`：`toggleNodeLink` → `unlinkNode`，且**只在 `state.nodeLinked` 时渲染**；`ui/ui-contracts.ts`：`TOP_TOOLBAR_ORDER` 去掉 `link-node`，`nodeMenuItemOrder` 改成 `push("markers")` + 条件 `push("node-link")` + `push("add-child")`。
- `ui/components/top-toolbar.ts` + `models.ts`：删除 `linkButton`、`TopToolbarLabels.linkNode/unlinkNode`、`TopToolbarActions.linkNode`、`TopToolbarState.nodeLinked`。
- 删除 `ui/modals/node-link-picker-modal.ts`（`NodeLinkSuggestModal` / `nodeLinkCandidates`）及其 barrel 导出。**保留** `domain/node-link.ts` 的 `nodeTitlePath`（现在只有测试在用，MCP/后续视图可复用）与 `createNodeLink`（MCP 的 `linkNode` 写入工具仍在用），`notice.nodeLinkBlockedByResource` 也仍被 MCP 的 `session-writer` 使用。
- i18n：删 8 个死 key（`toolbar.linkNode`、`toolbar.unlinkNode`、`menu.linkNode`、`modal.nodeLink.*`×3、`notice.nodeLinkCreated`、`notice.branchReferencePasteInTree`），新增 `notice.branchReferenceOtherTree`，并把 `notice.branchReferenceCopied` 改成同时提示“可粘到笔记 / 可粘回本树”。

**测试**：新增 `test/branch-reference-paste.test.ts` 6 条（身份比较三种结果、目标被删只报告、成功插入且目标子树不动、被拒时文档字节不变、空标题回落、以及视图接线源码断言——`NodeLinkSuggestModal|nodeLinkCandidates|createNodeLinkFor|toggleNodeLink` 一律不得出现、`ui-contracts` 不得再有 `"link-node"`）；`test/top-toolbar.test.ts` 把“一个按钮两种状态”改成“工具栏不再有 link 入口”；`test/ui-modules.test.ts` 改成 `plain` 不含 `node-link`、`linkedRoot` 仍在 `markers` 之后。

**验证**：`npm run check` 0 错误；`npm test` **1017 / 1017 / 0 fail**；`npm run build` 通过。

**留给下一任**：创建关联现在只有一条路径（复制分支引用 → 粘到它所属的树），不要再加回选择窗口或工具栏按钮——`AGENTS.md` §12 第 14 条与上述测试会拦住。用户曾明确讨论“跨文件关联”但选择了“只支持同一棵树”；将来若要做，需要把 `nodeLink` 从“只存节点 id”扩展为“树身份 + 节点 id”，并同步大纲链接域、尾部渲染与旧数据兼容。

## 2026-10-17 · 紧凑布局向左时一级节点被钉到叶子列（`fix`）

**问题（用户截图）**：节点对齐 = 紧凑时，向右布局正常；向左（`left`，以及 `balanced` 的左半边）时，除最下方（最长）分支外，上方的一级节点被摆到画布最左侧，和最深叶子挤在同一列，并且拖出一条横跨整张画布的连线。

**根因**：`src/render/layout.ts` 的紧凑左布局是**自叶子向上求解**的——`applyCompactLeft()` 与 `balanced` 分支里的 `placeLeftChildren()` 都把「没有子节点的节点」定为 `x = 0`，再让父节点贴在自己子树的右缘。锚点是叶子而不是根，所以**无子节点的一级节点直接落到最左列**，其余一级节点按各自最深路径错开。紧凑右布局（`applyRightColumns`）恰好相反：它自根向下锚定，同级节点天然成列——两侧原本不对称。

**修复**：左布局改成右布局的镜像——自根/分支一级节点向下放置，`child.x = parent.x - gap - child.width`（gap：一级 45、更深 32），放置完再整体平移到 `min(x) = 0`（新增 `shiftIntoPositiveX()`，`shiftIntoPositiveCoordinates()` 复用它）。`balanced` 左半边先用「虚拟根 x = 0」放置，再用 `leftMinimumX` 反推 `rootPosition.x`；右侧逻辑与根坐标不变。

**回归测试**：`test/layout.test.ts` 新增「compact left placement anchors first-level nodes to the root column, not the leaves」：`left` 与 `balanced` 下所有一级节点共享一列（左：右缘 = 根左缘 − 45；右：左缘 = 根右缘 + 45），无子节点的一级节点不再落在 `x = 0`，父子间距 32，且所有节点不越界。

**验证**：`npm run check` 0 错误；`npm test` **1018 / 1018 / 0 fail**（新加 1 条）；临时可视化 `.layout-before-after.png`（可删）。

## 2026-11-04 · 未修改的思维树不再写盘（`fix`）

**问题（用户口径）**：只是打开、关闭、切换标签、按 `Ctrl/Cmd+S` 或让更新器刷新，`.mtn.md` 也会被重写。同步客户端把 mtime 变化当内容变化，于是反复上传、产生版本历史/冲突副本 —— “不修改思维树时，不要编辑文件，导致重复同步”。

**根因**：`MindTreeView` 覆写了 `TextFileView.save()`，却没有复刻基类的两层短路。
1. 基类 `TextFileView.onUnloadFile(file)` 每次都调 `this.save(true)`（关闭标签/切换文件必走），插件版 `save()` 只看“能不能写”，不看“有没有要写”。
2. 基类 `save()` 在 `getViewData() === this.lastSavedData` 时跳过 `vault.modify`；插件版直接 `Vault.process()`，而 `Vault.process()` **只在回调返回与入参相同的字符串时才不写文件**（本机 Obsidian 1.14 `resources/obsidian.asar` 反编译确认：adapter.process 里 `if ((o = t(r)) === r) return r;` 之后才是 writeFile）。
   于是“干净会话关闭/切换/主动保存”和“脏但序列化结果与磁盘一致”都会真实写盘。

**落点**

- 新增 `src/services/save-plan.ts`：`planMindTreeSave(baselineSource, document, diskSource, options)` → `deferred | identical | write`。`identical` 把磁盘字节原样回传（让 `Vault.process` 跳过写入），`deferred` 表示外部版本/身份/格式阻止自动写、交给外部变更路径，只有 `write` 才带出真正要写的字节与 `changedSettings`。
- `src/ui/mind-tree-view.ts`：
  - `save()` 在 `!this.hasUnsavedState()`（`documentSession.dirty || sharedSession.draft`）时直接返回 —— 关闭、切换、更新器刷新、主动保存一个未修改的树都不再写盘。
  - `performQueuedSave()` 的 `vault.process` 回调改用 `planMindTreeSave`；只有 `write` 才设置 `pendingSerializedSource` 并 `session.beginWrite()`，`identical` 分支在发布写回执之前返回 `disk`。新增 `wroteBytes` 控制 `finally` 里的 `endWrite()`，避免为未发生的写入发回执。
- 文档：`docs/03` §7.6、`docs/05` §11.1/§11.2、`docs/06` P0 第 10 条补“未修改不写盘 / 不改变 mtime 与同步历史”。

**测试**：新增 `test/save-persistence.test.ts` 5 条 —— 未改树 → `identical` 且 `source === disk`；改树 → `write` 且写出的文件是再保存的不动点（`serialize(parse(source), source) === source`）；外部机器数据变化 → `deferred`；只改文档设置 → `write`；视图接线源码断言（clean 守卫在 `requestSave` 之前、`identical` 在 `pendingSerializedSource`/`beginWrite` 之前、view 只有一处 `vault.process`）。

**验证**：`npm run check` 0 错误；`npm test` **1023 / 1023 / 0 fail**（含新 5 条）；`npm run build` 通过，`main.js` 4,753,718 B ≈ 4.53 MiB（上限 10 MiB）。

**环境坑（本会话，后续 agent 先看这里）**

- 本会话沙箱是 `workspace-write`，开始时 pwsh 完全无法启动（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`）。用 `diagnose-windows-sandbox-acl` 技能的一条命令（一次性 `danger-full-access`）修好：工作区根缺 `WRITE_OWNER`，补了当前用户 FullControl；备份与回滚命令在 `D:\Code\dsh-acl-recovery-mind-tree\`。
- 受限沙箱下 `npm install` 会因生命周期脚本 `spawn EPERM` 与写 `package-lock.json` 被拒而失败；可用 `npm install --ignore-scripts --package-lock=false --no-save`，并把 `npm_config_cache`/`npm_config_logs_dir` 指到工作区内（本次用 `.dsh-tmp/`，收尾已删）。`npm test` 与 `npm run build` 仍要一次 `danger-full-access`（esbuild 需 spawn 子进程），跑完一切正常。
- `edit` 的 `ReplaceFileW EIO (Win32 1175)` 仍会偶发，原样重试即成功（本次一次命中）。

**留给下一任**：不要用 `getViewData()`/`lastSavedData` 去“恢复”基类短路——插件已经绕开基类保存逻辑，判断依据是 `DocumentSession.dirty`/`hasUnsavedState()` 与序列化字节比较。改 `performQueuedSave()` 时保持“`identical` 分支先返回、再发布写回执”的顺序：先 `beginWrite()` 会让其他视图把这次不存在的写入当成外部写入。

## 2026-11-06 · 干净会话自动采用外部版本（`fix`）

**需求（用户口径）**：思维树文件在磁盘上被外部修改（同步客户端、其他编辑器）时，如果当前打开的会话**没有未保存修改**，就直接按磁盘内容更新当前画布；只有存在本地修改时才提示冲突（原来的双栏选择）。这是 2026-10-15 条目里“留给下一任”第 1 条 `adopt-external` 的正式实现，也作废了 `docs/05` §11.2 与 `docs/06` 里“干净会话也要选择 / 更旧的同步版本也要选择”的旧口径。

**落点**

- `src/services/document-conflict.ts`：新增 `ExternalChangeDecision` + `decideExternalChange(assessment, hasLocalWork)` → `merge`（`unchanged`，仅设置/正文变化）/ `adopt`（`choose` 且无本地工作）/ `conflict`（其余，含身份/格式不安全）。决策带 assessment，视图不需要再手动窄化。
- `src/services/mind-tree-session-registry.ts`：`SharedMindTreeSession.adoptExternalVersion(source, document)` 复用 `acceptVersion({ choice: "external" })`——重建文档、基线、设置状态与历史（清空旧撤销栈），与用户显式选择“外部版本”是同一条状态迁移；新增 `get hasActiveEditor`（别的标签仍占着标题编辑框时不能静默替换文档）。
- `src/ui/mind-tree-view.ts`：`acceptExternalSource()` 改为 `decideExternalChange(assessment, this.hasLocalWork())` 分流；新增 `adoptExternalVersion()`（无共享会话时本地回退）与 `hasLocalWork()`（`hasUnsavedState()`、未完成的文件改名副作用、正在使用的标题编辑框）；`conflict` 才调用 `enterVersionPreview()`。
- 文档：`docs/02` §6.1.1（标题改为「外部同步与版本选择」）、`docs/03` §7.6、`docs/05` §11.1/§11.2、`docs/06` §14 P0 第 10 条、`docs/requirements` 第 15 条、`AGENTS.md` §3.2/§5/§10/§12/页脚。

**测试**：新增 `test/external-adopt.test.ts` 4 条（决策表、身份/格式安全永远 conflict、共享会话 adopt 重建基线历史、视图接线）；`test/version-conflict.test.ts` 首条测试名改为评估层分类并在注释指向新决策函数（断言未放宽）。**全量 1027/1027 pass / 0 fail**；`npm run check` 0 错误；受限沙箱用内置 esbuild 二进制按 `esbuild.config.mjs` 同参数打包验证通过（`.dsh-tmp/main-check.js` 4,755,618 B ≈ 4.54 MiB，未触碰 `main.js`，临时目录已删）。

**环境坑（本会话）**

- 本会话初始 pwsh 无法启动（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`），按 `diagnose-windows-sandbox-acl` 技能修复工作区根权限（备份/回滚记录在 `D:\Code\dsh-acl-recovery-mind-tree\`）；修复后 `workspace-write` 正常。
- `npm test` 仍需一次 `danger-full-access`（esbuild spawn 子进程）。中途一次提权被用户拒绝，**不要换方案绕过拒绝**：用 `ask_user_question` 说明原因并等到明确批准后再跑。`git add/commit` 同样要写 `.git/index`，也需一次提权。
- `npm install` 在受限沙箱会因生命周期脚本 `spawn EPERM` 与写 `package-lock.json` 失败；用 `npm install --ignore-scripts --package-lock=false --no-save`，`npm_config_cache`/`npm_config_logs_dir` 指向工作区内 `.dsh-tmp/`（收尾删除）。
- `edit` 偶发 `ReplaceFileW EIO (Win32 1175)`，原样重试即成功（本会话命中 2 次）。

**留给下一任**

- 旧版插件创建的未决 `pending-conflicts` 记录仍按原流程恢复（迁移期兼容）；新流程下干净会话不会再创建这类记录。
- 如果要给“更旧的同步版本”加保护（例如提示而非采用），只改 `decideExternalChange()` 一处并同步 `docs/05` §11.2 与 `test/external-adopt.test.ts`；不要在视图里另写分支。
- 未在真实 Obsidian/同步环境人工验收：建议实测「打开未修改的树 → 另一设备修改并同步 → 画布原地刷新、无选择框、无写盘」与「有未保存修改时仍出现双栏选择」。

## 2026-11-10 · MCP 合并回**一个服务器**（只读与修改不再分开）（`docs`）

**需求原话**：用户要求「把 MCP 只读和修改合并起来，不分开了。」——撤销 2026-10-17「两个 MCP 服务器（read / write）」的设计，改回一个本地 MCP 服务器。

**最终口径**：唯一服务器名 `mind-tree-nature`，单一总开关、单一端口（默认 27321）、单一访问令牌、单条客户端配置；承担全部 18 个工具（9 个只读 + 9 个会改动），工具目录不再有 `server` 字段。设置页顺序：大标题 → 说明 → 「开启 MCP 服务」总开关 → 服务器（小标题、范围说明、端口、状态）→ 客户端配置（复制按钮）→ 令牌提醒。插件不再按工具做权限拦截；MCP 客户端只能把审批策略挂在服务器上，所以**读与写共用同一条客户端审批策略**，不能再写「读取免审批、写入需确认」可行——这是用户明确要求的取舍。

**迁移**：设备本地记录键改为 `${manifest.id}:mcp-server`；升级时若无新记录，沿用旧只读记录（`:mcp-server:read`）的端口与令牌，旧客户端配置里的地址与令牌仍然可用，但该配置从此也带写工具的权限。设置里 `mcpEnabled` 保留；新字段 `mcpPort` 读取时兼容旧配置端口（优先只读服务器 `mcpReadPort`，最后一档保留 `mcpWritePort` 作防御性兜底），都没有时回落默认 27321；`mcpWriteEnabled` / `mcpWritePort` 从设置模型删除。**注意：原本只开只读服务器的用户，升级后同一端点会同时暴露写工具——这是本轮用户明确改变授权口径，不是收窄授权，不要套用旧条目的「升级只能收窄授权」。**

**落点**：README.md / README.en.md（§6 安装与设置段）、docs/01（术语表、场景 7、P1 功能范围）、docs/02（§AI：MCP 服务全节）、docs/05（§9.1 服务器形态、§10 设置表与设置持久化段、§12.3 安全）、docs/06（MCP 自动化/手工验收与「MCP 服务验收」第 6 条）。`AGENTS.md` 经 grep 无 MCP 双服务器事实错误（只提到 `services/mcp/` 目录），未改。安全约束不变：只绑 `127.0.0.1`、Host/Origin 回环校验、Bearer 令牌、请求体 64 KiB 上限、桌面端专属、默认关闭、移动端不加载 `node:http`、不监听。

**验证（2026-11-11 00:1x）**：`npm run check` 0 错误；`npm test` **1023 条全部通过 / 0 失败**（在 `danger-full-access` 会话中运行，esbuild 的 `spawn` 可用；workspace-write 沙箱下 `tsx`/`esbuild` 仍会 `spawn EPERM`，属既有环境限制）；`npm run build` 成功，`main.js` 4.75 MB、`styles.css` 71 KB、`manifest.json` 235 B，均低于发布上限。MCP 相关测试：`test/mcp-tools.test.ts`、`test/mcp-client-config.test.ts`、`test/mcp-http-transport.test.ts`、`test/mcp-settings-page-model.test.ts`、`test/ai-settings-page.test.ts`、`test/plugin-data.test.ts`、`test/settings-index-wiring.test.ts`。本轮测试改动删除的断言均为“前提已不存在”（服务器分组/第二端口/写入开关），未放宽其他覆盖。

## 2026-11-15 · 节点右键菜单「创建 TaskNote」接入 TaskNotes（`feat`，未提交）

**需求（用户原话）**：节点右键菜单里，未关联节点在「添加笔记」下方增加「创建 TaskNote」；接入 TaskNotes（https://github.com/callumalpass/tasknotes）；未安装 TaskNotes 时点击弹出 notice 提示安装。

**口径**：菜单项**始终**对未关联节点显示（不按安装状态动态隐藏），点击后才判可用性；未安装/未启用 → 安装提示；已安装但 API 不合格 → 更新提示；两种提示都带仓库地址且不创建文件。TaskNotes 只通过其公开运行时 API v1 使用：`app.plugins.getPlugin("tasknotes").api`，要求 `apiVersion === 1`、`hasCapability("tasks.write")`、`tasks.create` 为函数（指定目录时还要求 `hasCapability("tasks.move")` 与 `tasks.move` 函数）；不导入 TaskNotes 内部模块、不新增依赖、不发起网络请求。

**落点**
- `src/services/tasknotes.ts`（新，零 Obsidian 依赖）：`TASKNOTES_PLUGIN_ID` / `TASKNOTES_RUNTIME_API_VERSION` / `TASKNOTES_WRITE_CAPABILITY`（后续追加 `TASKNOTES_MOVE_CAPABILITY`）、`pluginRegistryOf(app)`、`findTaskNotesPlugin(registry)`（`getPlugin` 优先，异常或空值回退 `plugins` map）、`resolveTaskNotesApi(plugin)`（fail closed）、`TaskNotesService`（每次调用重新解析；`createTask(title, { targetFolder })` → `api.tasks.create({ title }, { source, correlationId, reason })`，指定目录时再 `api.tasks.move(path, targetFolder, context)`；移动失败返回 `{ path: 原路径, moved: false, moveError }` 而不是抛错；拒绝空 `path`）。
- `src/ui/ui-contracts.ts`：`NodeResourceMenuItemId` 加 `create-task-note`；`nodeResourceMenuItemOrder()` 在 `!hasResource && !nodeLinked` 分支内排 `add-note → create-task-note → add-file-template → link-file → link-web`。
- `src/ui/menus/node-context-menu.ts`：新增 `createTaskNote` 动作与菜单行（`list-todo`）。
- `src/ui/mind-tree-view.ts`：`createTaskNoteForNode(nodeId)`——沿用 `captureAssociationTarget` / `requireAssociationTarget` / `associateFileWithTarget` / `openCreatedFile`；无标题时 `TextPromptModal`；在途键 `tasknote:<token>:<nodeId>`（与「添加笔记」区分，避免两条命令互相吞并）；成功后 `ensureStableReference(file)` 再以 `file.basename` 关联（默认启用双向同步）并产生一次撤销。失败分型：`TaskNotesUnavailableError` → `notice.taskNotesMissing`；已拿到 `taskPath` 但取文件/身份/关联失败 → `notice.createdTaskNoteNotLinked`（不删除任务文件）；其他 → `notice.createTaskNoteFailed`；vault 暂时看不到文件 → `notice.taskNoteFileMissing`。
- `src/main.ts`：`readonly taskNotes = new TaskNotesService(() => pluginRegistryOf(this.app), () => this.manifest.id)`。
- i18n 新增 10 个键（EN+ZH）；`docs/02` §6.6/§6.7（新增「创建 TaskNote（可选集成）」小节）、`docs/01` P1、`docs/05` §9.1、`docs/06` §13.1、`docs/requirements` 第 6 条、中英 README §3、`AGENTS.md` §3.2/§3.3/§10。

**测试**：新增 `test/tasknotes.test.ts` 12 条（注册表两路查找与回退、app 端口容错、API 版本/能力/`tasks.create` 拒绝表、标题与 mutation context、缺失/降级、抛错/无 path、创建后移动到树目录、根目录空串、缺 `tasks.move` 创建前拒绝、移动失败保留路径、菜单顺序与视图接线、双语占位符）；`test/ui-modules.test.ts` 的菜单顺序期望同步为 5 项，未放宽“已关联/已节点关联隐藏创建入口”的既有断言。

**验证（2026-11-15）**：`npm run check` 0 错误；全量 **1165 tests / 1165 pass / 0 fail**（含同日追加的 4 条目录用例）；`npm run build` 成功，`main.js` 5,009,164 B ≈ 4.78 MiB（上限 10 MiB）。`main.js` 与 `.mtn-test-run.log` 均已被 `.gitignore` 忽略，未提交。

**环境坑（本会话）**：`workspace-write` 下 `npm test` 必失败——`node:test` 多文件 runner 与 tsx/esbuild 都要 spawn 子进程（`spawn EPERM`）；`npx tsx test/xxx.test.ts` 也会在 esbuild 同步服务启动时 EPERM。全量测试需一次 `danger-full-access`。删除临时日志 `.mtn-test-run.log` 的提权被用户拒绝：**不要绕过**，该文件已在 `.gitignore` 第 9 行，留在工作区不影响 `git status`。

**留给下一任**：未在真实 Obsidian + TaskNotes 内人工验收（本机未装两者）；TaskNotes 若升级 API 版本，只改 `src/services/tasknotes.ts` 的版本/能力判断并补 `test/tasknotes.test.ts`；若希望 TaskNote 标题不跟随文件名双向同步，可在 `createTaskNoteForNode` 里传入节点标题并显式 `titleSync: "off"`，但要先确认产品口径。

**↳ 同日追加 · 任务笔记放入思维树目录（用户追问后的口径）**：用户问「能否指定创建任务笔记的位置，能的话指定为思维树目录」。结论：**TaskNotes 的 `tasks.create` 没有任何目录参数**（`TaskCreationService.resolveTargetFolder` 只读设置里的 `tasksFolder` 与 inline 上下文），但公开运行时 API 有 `api.tasks.move(path, targetFolder)`，所以实现为「创建后立即移动」。已核对 TaskNotes 源码语义（`src/api/TaskNotesAPI.ts` 的 `moveTask`）：`normalizePath("")` → `newPath = file.name`（仓库根目录）；`newPath === task.path` 时直接返回 no-op；目标已存在同名文件时抛 `file_already_exists`（409）；移动完成会更新缓存并发出 `task.moved` 事件。实现要点：
- `src/services/tasknotes.ts`：`TASKNOTES_MOVE_CAPABILITY = "tasks.move"`；`TaskNotesRuntimeApi.tasks.move?` 为可选；`createTask(title, { targetFolder })` 在提供目录时先要求 `tasks.move` 能力（缺失 → `TaskNotesMoveUnavailableError`，**创建前**拒绝），创建成功后用同一 correlationId 调 move；成功返回 `{ path, moved: true }`，失败返回 `{ path: 原路径, moved: false, moveError }`（不抛，便于视图仍建立关联）。
- `src/ui/mind-tree-view.ts`：目录取 `this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? ""`（仓库根目录传空串）；移动失败时照常完成 `ensureStableReference` 与关联，并用 `notice.taskNoteMoveFailed` 提示真实路径与原因（用户可再用右键菜单「将关联文件移动到」）；新增 i18n 键 `notice.taskNotesMoveUnsupported`、`notice.taskNoteMoveFailed`。
- `test/tasknotes.test.ts` 增 4 条：移动与 correlationId、根目录空串、缺 move 能力创建前拒绝（含能力位与函数两条判据）、移动失败保留原路径；`test/ui-modules.test.ts` 未改。

## 2026-11-16 · 移除内置 Google OAuth 客户端并改写未推送历史（`fix` + `docs`）

**起因**：用户执行 `git push` 被 GitHub Push Protection（GH013）拒绝：待推送的 `393135a`（AI 模型提供商设置）在 `src/services/ai/oauth.ts:46-47` 与 `test/ai-oauth.test.ts:376/399` 含有 Gemini CLI 的公开 Google OAuth Client ID 与 Client Secret。GitHub 只要在待推送提交里扫到就拒绝整个 ref。用户选择方案 B（不使用 GitHub 白名单），改写未推送历史移除字面量。

**口径**：工程上无法既保留内置凭据又通过扫描，因此把 Gemini OAuth 改为**使用用户自备的 Google OAuth 客户端**：
- `src/services/ai/oauth.ts`：删除 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`；新增 `geminiCredentials(provider)`（读 `additionalSettings.oauthClientId/oauthClientSecret`，缺失抛 `AiOAuthError("unsupported", …)`）；`beginGeminiBrowser` 在 `requireDesktop` 之后、打开回调服务器之前校验凭据，`buildGeminiAuthorizeUrl` 改为接收 clientId；`completeGemini` 同样解析凭据后用于 token 交换。桌面/移动端限制保持不变（移动端仍先报 `not-desktop`）。
- `src/services/ai/presets.ts`：`gemini-oauth` 的额外设置新增必填 `oauthClientId`/`oauthClientSecret`（标签沿用既有 i18n 键，表单以密码框渲染密钥）。
- `src/services/ai/normalize.ts`：`validateProvider` 对 Gemini OAuth 缺失凭据发出 `provider-oauth-client-required`（错误码与文案此前已存在但无人使用），并让通用 required 循环跳过这两个键避免重复报错。
- 测试：`test/ai-oauth.test.ts` 用测试凭据驱动 Gemini 流程并断言 authorize/token 两处 client_id/secret，新增“缺失凭据不打开浏览器”用例；`test/ai-settings-normalize.test.ts` 新增 Gemini OAuth 校验用例。

**历史改写（关键）**：当时 `master` 领先 `origin/master` 7 个提交。在 `393135a`（父 `384e6df`）上直接修改并 `git commit --amend` 成 `e4a9b47`（原提交信息追加 Gemini OAuth 不内置凭据说明），再 `git rebase --onto e4a9b47 393135a master`，把 `2135a30`→`7a5947b`、`348ed0b`→`d0e3bb4`、`9807c95`→`4ac9345` 重放；因后续提交未触碰上述 AI 文件，重放无冲突。验证方式：对 `git rev-list origin/master..HEAD` 的每个提交逐一 `git grep` 搜索旧 Google OAuth 客户端 ID/Secret 的前缀，全部无命中（旧对象仅在本地 reflog/悬空对象里，普通 push 不会发送）。**教训**：不要用新增提交删除 secret（历史仍在、依旧被拦）；不要在未核对上游来源的情况下把公开 CLI 凭据的常量搬进仓库；也不要把被拦凭据的具体值或可识别片段写进文档。

**文档**：README 中英的模型提供商表单/OAuth 段说明 Gemini 需自备 OAuth 客户端且仓库不内置凭据；`docs/01` P1、`docs/02` 表单字段与必填规则、OAuth 面板、`docs/05` §9.1、`docs/06` 模型提供商验收第 7 条同步；`THIRD_PARTY_NOTICES.md` 的 OAuth client 来源改为仅 ChatGPT/Copilot；并更新上方 2026-11-13 条目的“OAuth client 常量来源”段落。

**验证（2026-11-16 00:2x）**：`npm run check` 0 错误；全量 **1167 tests / 1167 pass / 0 fail**；`npm run build` 成功，`main.js` 5,010,853 B ≈ 4.78 MiB（上限 10 MiB）。仍未在真实 Obsidian 内做 Gemini OAuth 人工验收（无 Google OAuth 客户端与真实账号）；文档不得写成“已验证可用”。

## 2026-11-17 · Tab 把焦点交给别的笔记（`fix`）

**起因**：用户反馈「在思维树视图里按 Tab，另一篇笔记的文字一直被缩进，只有重启 Obsidian 才恢复」。定位结论（静态可证）：`KeyboardController.keyDown` 只把 `event.key === "Tab"` 放在 `hasPrimary` 之后处理，**没有主选节点时既不 `preventDefault` 也不做任何事**，于是浏览器执行默认的顺序焦点导航：焦点从 `.mtn-canvas`（`tabIndex = 0`，`role="application"`）走到树内按钮、视图外宿主控件，最终落进 `.cm-content`（`contenteditable` 可聚焦）；此后每次 Tab 都是 CodeMirror 的缩进 —— 表现就是「另一篇笔记一直被缩进」。而「空选中」很容易误触：**在画布空白处单击/框选 0 个节点时 `CanvasInteractionController.updateMarquee` 会立刻 `replaceSelection(new Set(), undefined)`**，`primarySelectedId` 直接变 undefined，紧接着按 Tab 就出事。

**落点**：
- `src/ui/controllers/keyboard-controller.ts`：`Tab` 分支移出 `hasPrimary` 门槛 —— 只要画布收到 Tab 就先 `preventDefault()`（长按 repeat 同样消费但不建节点），`Shift+Tab` 无主选时不执行 `addParent`（插入父节点必须有目标）。**不要在控制器里复刻「无选中 → 根节点」**：`MindTreeView.addChildNode()` 已有该兜底（`primarySelectedId && document.nodes[...] ? … : document.rootId`），命令面板的 `add-child-node` 也走同一条命令；顺手把 `docs/02` §6.4 里过时的「工具栏『添加』」改成「命令面板『添加子节点』与 `Tab`」（§5 早已写明顶部不再有添加按钮）。
- `test/keyboard-controller.test.ts`（新增 7 条）：无选中时 Tab 被消费且调用 `addChild`、无选中时 Shift+Tab 被消费但不建节点、有选中时 Tab/Shift+Tab 语义不变、repeat 消费但不建节点、`Ctrl+Tab` 无选中时仍交还宿主标签切换、标题输入框/弹窗内 Tab 保留控件原生行为、已 `defaultPrevented` 的事件不重复处理。此前 `KeyboardController` **没有任何测试文件**（`test/keyboard-navigation.test.ts` 只覆盖 `shouldHandleStructuralCreationKey` 与方向键）。
- 文档：`docs/02` §6.3 的 Tab/Shift+Tab 两条、`docs/06` 验收第 15 条写明「未选中时作用于根节点」「Tab 由画布消费，不交给宿主焦点顺序」。

**验证（2026-11-17）**：`npm run check` 0 错误；全量（沙箱替代运行器，见下）**1099 tests / 1092 pass / 7 fail**，7 条全部是既有 esbuild `spawn EPERM` 环境失败（`adaptive-tooltip`、`ai-settings-page`、`custom-markers-settings-page`、`marker-popover-custom`、`node-renderer`、`plugin-update-modal`、`top-toolbar`），**无新增失败**。`workspace-write` 下 `npm test` / `npx tsx` 仍 `spawn EPERM`；本轮用 Node 原生 TS 跑通：`.mtn-test-build/`（gitignored）里放 `hooks.mjs`（`node:module` resolve 钩子，把无扩展名/目录 index 的本地导入补成 `.ts`）+ `register.mjs`（`register("./hooks.mjs", import.meta.url)`），命令为 `node --experimental-transform-types --import "file:///…/.mtn-test-build/register.mjs" --test --test-isolation=none "test/*.test.ts"`，跑完已删除该目录。**注意**：不带 `--test` 直接 `node file1.ts file2.ts` 只会统计第一个文件的用例（后续文件注册被丢弃），判基线必须带 `--test --test-isolation=none`。

**未完成 / 待确认**：① 未在真实 Obsidian 里人工复现用户场景（本机没有可运行的插件环境）；② 若用户的实际前提是「焦点本来就不在画布上」（例如用鼠标点标签页切回思维树、DOM 焦点仍留在笔记编辑器），本次修复无效 —— 那需要在 `active-leaf-change` 且焦点不在 `rootEl` 内时补 `canvasEl.focus()`，属于「切回视图自动抢焦点」的行为变更，应先确认产品口径（`docs/02` 只写了「后台标签不抢焦点」）；③ WCAG 2.1.2「无键盘陷阱」是既有取舍：有选中时 Tab/Shift+Tab 已是结构命令，画布没有 Tab 出口（小地图也刻意不进 Tab 顺序），本轮未改。

### ↳ 同日追加：用户确认「已选中节点」后的重定位（同一症状，第二处修复）

**新事实（用户答问）**：① 出问题时**确实先选中了节点**；② 用鼠标点画布（节点或空白处）**不会**恢复，只能重启；③ 被缩进的笔记在**另一个标签页**（只有一个是可见的）。因此上面「空选中 → Tab 落到宿主焦点顺序」不是本次路径；真正的状态是：**焦点留在已切走标签页的笔记编辑器里**（该编辑器不再被绘制，却仍是 `document.activeElement`），Tab 由它消费并缩进；点画布也没能抢回焦点，于是「只有重启」。仓库对粘贴早就遇到过同一现象（`shouldCaptureDocumentPaste` 的注释原话：「Elements under display:none ancestors have no rects. They are the stale-focus case this document listener exists to recover from.」），Tab 一直没接这条规则 —— 这才是缺口。

**落点**：
- `src/ui/paste-routing.ts` → **重命名**为 `src/ui/document-event-routing.ts`（该模块现在管两类文档级事件归属，继续叫 paste 会误导）。保留 `shouldHandleMindTreePaste` 原样，新增 `StaleKeyTargetState` + `shouldHandleMindTreeStaleKey({ viewVisible, targetOutsideEditable, targetVisible, nativeSurfaceVisible })`：**只有「思维树自己已绘制 + 按键落在别的文本编辑面 + 那个编辑面没被绘制 + 没有可见弹窗/菜单」才接管**。
- `src/ui/components/canvas-shell.ts`：`CanvasShellActions` 新增 `documentKeyDown`，在 `ownerDocument` **捕获阶段**注册 `keydown`（与既有 document `paste` 同一处、同一生命周期）。
- `src/ui/mind-tree-view.ts`：新增 `onDocumentKeyDown` / `shouldRecoverStaleTab` / `isPainted`（优先 `Element.checkVisibility()`，回退 `getClientRects().length > 0`）；命中后调 `keyboardController.keyDownFromStaleFocus(event)`，并在焦点仍不在 `rootEl` 内时尝试 `canvasEl.focus()`，把后续按键交还画布。顺手把重复的内联选择器提成模块常量 `TEXT_SURFACE_SELECTOR` / `NATIVE_SURFACE_SELECTOR`，粘贴路由一并改用 `isPainted`。
- `src/ui/controllers/keyboard-controller.ts`：新增 `keyDownFromStaleFocus()`（**跳过 `isTextEditingTarget` 守卫**，因为事件目标正是那个看不见的编辑区），`keyDown` 与它共用私有 `dispatch(event, staleFocus)`。
- `test/paste-routing.test.ts` → `test/document-event-routing.test.ts`（原有 3 条粘贴断言一字未改，新增 4 条：绘制中的树接管未被绘制编辑区的 Tab、可见编辑器不吃、未绘制的树不抢、可见弹窗/非文本面不吃）；`test/keyboard-controller.test.ts` 增 1 条（残留焦点入口在 textarea 目标上仍处理 Tab，普通入口仍放手）。
- 文档：`docs/02` §6.3 Tab 条目写明「隐藏标签页残留的编辑器焦点不会吞掉 `Tab`（与粘贴同一条活动视图规则）」；`AGENTS.md` §10「改导入/粘贴」行改指新模块与新测试。

**风险边界（有意为之）**：可见的其他编辑器、弹窗、菜单、侧栏等非文本面**全部保留原生 Tab**；未绘制的思维树永远不抢别处按键。也就是说这不会把 Tab 从用户正在看的输入框里抢走。

**验证（2026-11-17 23:0x）**：`npm run check` 0 错误；全量 **1104 tests / 1097 pass / 7 fail**，7 条仍是既有 esbuild `spawn EPERM` 环境失败，无新增失败（替代运行器命令同上一条）。

**环境坑（本轮新增）**：`workspace-write` 沙箱下 `Remove-Item` 工作区文件被拒（「访问被拒绝」），删/改文件名要一次 `sandbox_permissions: danger-full-access`；本轮经用户批准删了 `src/ui/paste-routing.ts` 与 `test/paste-routing.test.ts` 两个文件。改文件名**不要**用「清空旧文件」绕过。

**仍未完成**：① 仍未在真实 Obsidian 内复现/验收；② 若用户重测后 Tab 仍缩进别的笔记，说明「未被绘制」判据没命中该宿主的隐藏方式（例如宿主用 `visibility:hidden` 之外的裁剪/离屏方案，或该宿主版本没有 `checkVisibility`），下一步改用「事件目标最近的 `.workspace-leaf` 是否为 `.mod-active`」或直接比较 `document.activeElement` 所在 leaf 与当前 leaf；③ WCAG 2.1.2 键盘出口那条既有取舍没变。

## 2026-11-19 · 节点编号（右键菜单「节点标记」下方）

**需求口径（用户确认）**：编号配置随节点保存，标题只在前端显示前缀；「从上层继续」接续祖先编号路径（父级 `3.` → 子级 `3.1`，祖先未编号时等同 restart）；编号要出现在画布、PNG/SVG/Canvas 导出与 Markdown 大纲。

**落点**：
- 领域纯函数 `src/domain/node-numbering.ts`：`NODE_NUMBERING_FORMATS`、`formatNodeNumberLabel`、`computeNodeNumbering`（按当前 `childIds` 派生标签，`owned` 标志区分“本级配置产生的路径”和“祖先路径”，保证 `descendants + restart` 仍是 `1.`→`1.1`→`1.1.1`，`continue` 只在配置起点接续祖先）、`clearNodeNumbering`、`numberedNodeTitle`。
- 类型与持久化：`types.ts` 新增 `NodeNumbering`（`format/scope/start`），`MindTreeNode.numbering`；`domain/runtime-node.ts` 归一化（非法值整条丢弃）；`format/document.ts` 的 `nodeToMachineData` 白名单补 `numbering`（**漏这里会表现为保存后重开编号丢失**）。
- 渲染：编号标签是派生值，不写标题。`render/layout.ts` 在 `layoutTree` 内 `computeNodeNumbering` 一次并参与标题测量；`ui/renderers/node-renderer.ts` 在 `render()` 里重算同一份 map（编辑态仍显示原始 `node.title`）；`services/export.ts`、`services/canvas-export.ts`、`format/outline.ts` 各自派生，因此画布/导出/大纲一致，且无需给 `layoutTree` 增加参数。
- 菜单：`ui/menus/node-numbering-menu.ts`（`addNodeNumberingMenu`，两级嵌套：动作 → 六种形式；无嵌套能力时平铺成「动作 · 形式」26 行；无子节点时四条编号行动作置灰），`node-context-menu.ts` 在标记行后调用并把 `supportsSubmenus` 探针提到 `show()` 顶部复用；`ui/mind-tree-view.ts` 新增 `numberChildren` / `clearNumbering` 两个 `commit` 命令（可撤销）。i18n 新增 `menu.numbering*` 与 `menu.numberingFormat.*` 双语文案。
- 测试：`test/node-numbering.test.ts`（14 条：六种形式、中文/罗马/字母转换、scope/start 组合、移除、归一化、文件往返、大纲前缀、布局宽度变化）、`test/node-numbering-menu.test.ts`（5 条，用 `loadModule` + obsidian `getLanguage` 桩，覆盖两级嵌套、20 条平铺、无子节点置灰）。

**验证**：`npm run check` 0 错误；替代运行器全量 **1251 tests / 1251 pass / 0 fail**（含新增 19 条）。

## 2026-11-21 · 打开资源按钮按资源类型显示图标（`feat`）

**需求口径（用户确认）**：关联了资源的节点，尾部「打开资源」图标改成该资源类型对应的图标——md 文档用笔记图标，URL 用网页/IE 图标，图片用图片图标等。

**落点**：
- 纯函数 `src/render/resource-badges.ts` 新增 `resolveResourceOpenIconKind()` / `resolveResourceOpenIcon()`：URL → `globe`；`isMindTreePath(pathHint)` → `git-fork`（`.mtn.md` 也算 markdown，必须先判）；`fileKind: "note"` → `file-text`；`fileKind: "image"` → `image`；附件按 `deriveFileBadgeExtension()`（会剥掉稳定资源 id、保留 `tar.gz` 这类复合后缀）映射 `music`/`video`/`archive`/`code`/`table`/`file-text`，未知后缀与无后缀回退 `file`。图标名只用 Obsidian 长期存在的 Lucide id——`setIcon` 遇到未注册名字只会渲染空按钮，不要凭后缀猜图标。
- `ui/renderers/node-renderer.ts` 的打开按钮改调 `setIcon(openButton, resolveResourceOpenIcon(node))`，并去掉遗留的 `fa-share-square-o` 类；`styles.css` 里该按钮的 `stroke-width` 由 `8px` 改回 `2px`（8px 是为 100 viewBox 的自制图标准备的，内置 Lucide 是 24 viewBox）。
- 删除已无引用的自制图标 `SHARE_SQUARE_ICON` / `SHARE_SQUARE_ICON_SVG`（`src/ui/icons.ts`）及其 `addIcon`/`removeIcon` 注册（`src/main.ts`）；「Obsidian 注册图标是 100×100 viewBox」的注释移到 `CHAIN_BROKEN_ICON_SVG` 上方。
- 测试：`test/resource-badges.test.ts` 新增 1 条（类型、后缀、复合后缀、资源 id 后缀、未知后缀）；`test/node-renderer.test.ts` 把笔记节点断言改为 `file-text` 并新增 5 种资源用例；`test/styles.test.ts` 的源码字符串断言改为正则匹配新 `setIcon(...)` 且 `doesNotMatch(SHARE_SQUARE_ICON)`。

**验证**：`npm run check` 0 错误；替代运行器（`.mtn-test-build/register.mjs` + `node --experimental-transform-types --import "file:///D:/Code/obsidian-mind-tree-natrue/.mtn-test-build/register.mjs" --test --test-isolation=none "test/*.test.ts"`）全量 **1253 tests / 1253 pass / 0 fail**。`npm run build` 仍报 esbuild `spawn EPERM`（沙箱环境限制，与本次改动无关），本轮未产出 `main.js`。

**待人工验收**：在真实 Obsidian 里逐类确认图标——尤其 `git-fork` / `archive` / `table` / `code` / `music` / `video` 在当前 Obsidian 版本的 Lucide 集中存在；任何一个不存在就是空按钮，只能从该版本图标表里换名。笔记内嵌分支视图与图片节点同样走这条映射，一并看。

## 2026-11-21 · 失效资源显示红色断开图标（`feat`）

**需求口径（用户）**：已失效的资源，原打开资源按钮的图标用红色断开链接图标替代，提示资源失效。

**判定口径**：URL 用既有 `isSafeHttpUrl`（非 `http`/`https` 即失效）；文件用资源索引解析。**关键门禁**：只有 `ResourceIndexService.isVerified()`（转 `catalog.isFullyVerified()`）之后才允许把“解析不到”判为失效，否则启动瞬间索引未建完会把正常文件标红。纯函数 `isResourceInvalid(resource, isFileResolved?)` 放在 `render/resource-badges.ts`，不拿 vault 引用，回调由调用方注入。

**落点**：
- `services/resource-index.ts` 新增 `isVerified()`；`render/resource-badges.ts` 新增 `isResourceInvalid()`（URL 恒判、文件仅在拿到回调时判）。
- `ui/renderers/node-render-model.ts`：`NodeVisualState.resourceInvalid` + `createNodeVisualState()` 第 6 参（默认 `false`，`ui-modules.test.ts` 的 3 参调用不受影响），并 `&& controls.hasOpenButton` 防止无按钮时置真。
- `ui/renderers/node-renderer.ts`：`NodeRenderState.invalidResourceNodeIds?: ReadonlySet<NodeId>`，打开按钮追加 `is-missing` 类，图标换 `CHAIN_BROKEN_ICON`（已有的自制断开链图标），`aria-label` 换 `node.resourceInvalid`；点击仍走 `openResource`（既有 `fileNotFound`/`invalidLink` 提示）。
- `ui/mind-tree-view.ts`：运行时字段 `invalidResourceNodeIds`、`handleResourceAvailabilityChanged()`、`refreshInvalidResourceNodeIds()`（集合相等才返回 false）、`collectInvalidResourceNodeIds()`；`render()` 在 `nodeRenderer.render()` 前重算并传入；`handleResourceMetadataChange()` 也重算（文件重建后图标能恢复）。
- `main.ts`：vault `delete` 处理器把原来的单行 `instanceof` 循环改成 `continue` 形式，并调用 `leaf.view.handleResourceAvailabilityChanged()`（先 `resources.removePath`）。
- `styles.css`：`.mtn-node-controls > .mtn-resource-open.is-missing` 三态 `color: var(--text-error)`（红色），正常态仍是 `--text-muted`。
- i18n 新增 `node.resourceInvalid`（EN/ZH）。
- 测试：`test/resource-badges.test.ts` +1（失效判定矩阵）、`test/node-renderer.test.ts` +1（图标/类/无障碍名，点击仍回调）、`test/styles.test.ts` 增加红色规则与条件 `setIcon` 断言、新建 `test/resource-validity-wiring.test.ts`（5 条：索引门禁、视图派生与传入、删除事件接线、渲染分支、红色 CSS）。`test/backlink-wiring.test.ts` 的原断言钉死“`backlinks` 后紧跟 `}, {`”，新字段插在 `backlinks` 之后，已放宽为只断言相邻两项。

**验证**：`npm run check` 0 错误；全量 **1260 tests / 1260 pass / 0 fail**。

**未完成 / 注意**：只读树预览（版本历史双栏、主题悬浮预览、笔记内嵌分支视图）没有资源索引能力，`ReadOnlyTreePreview` 未传 `invalidResourceNodeIds`，因此预览里失效资源仍显示类型图标；若要在内嵌视图也标红，需要给 `MindTreeReferenceEmbedPorts` 增加解析端口。`npm run build` 仍是沙箱 esbuild `spawn EPERM`。

## 2026-11-23 · 资源图标换成 Obsidian 内置图标（Canvas 用官方 `layout-dashboard`）（`fix`）

**结论（用户提问）**：Obsidian 自己的 Canvas 图标是 **`layout-dashboard`**。安装包里 bookmark 项与 `canvas:new-file` 命令都直接 `A(el,"lucide-layout-dashboard")`。`setIcon` 传无前缀 id 等价：包内 `o.startsWith("lucide-")` 分支会把 `lucide-x` 还原成 `x` 查表。

**关键坑（已存在的真缺陷）**：上一轮用的 `globe` / `music` / `archive` / `code` / `table` 在 Obsidian 内置图标表里**不存在**，`setIcon` 遇未注册 id 会静默渲染空按钮——表现是打开按钮位置只剩空白。核对办法：直接读安装包 `C:\Program Files\Obsidian\resources\obsidian.asar`，用 `node -e` 做 latin1 `includes(JSON.stringify(name))` 批量检查；**不要**用 `grep -a` 扫这个 24MB 单行包，会跑几分钟并被 150s 守卫杀掉。已确认存在于包内的 file-* 家族：`file-text`、`file-image`、`file-audio`、`file-video`、`file-archive`、`file-code`、`file-spreadsheet`、`file-json`、`file`；URL 官方用 `globe-2`（`globe` 不存在）；Canvas 用 `layout-dashboard`。另外 Obsidian 的**文件浏览器本身不给文件单独画类型图标**（文件项只显示扩展名 tag，`.md` 连 tag 都隐藏），类型图标来自各 view 类（pdf→`file-text`、image→`image`、audio→`file-audio`），所以「和官方一致」按 view 图标的 file-* 家族取。

**落点**：`render/resource-badges.ts` 的 `RESOURCE_OPEN_ICON_NAMES` 全量替换：url→`globe-2`、note→`file-text`、image→`image`、**canvas→`layout-dashboard`**、audio→`file-audio`、video→`file-video`、archive→`file-archive`、code→`file-code`、table→`file-spreadsheet`、mind-tree→`git-fork`、file→`file`。新增 `canvas` kind：`CODE_EXTENSIONS` 移除 `canvas`，扩展名判定在 video/archive/code 之前单独返回 `canvas`。docs/02 §5.5、docs/05 §9、README 双语同步；测试断言改为新 id（含 `Board.canvas` → `layout-dashboard`）。

**验证**：`npm run check` 0 错误；全量 **1260 tests / 1260 pass / 0 fail**。`npm run build` 仍受沙箱 esbuild `spawn EPERM` 限制。

**待人工验收**：真实 Obsidian 逐类看字形（`file-audio` / `file-video` / `file-archive` / `file-spreadsheet` / `layout-dashboard` / `globe-2`），确认失效红色断开图标仍正常，并顺手看 `.base`（Bases）是否也需要单独图标。

## 2026-11-23 · 右键菜单「从此创建」分组 + 创建新思维树（`feat`）

**结论（需求）**：文字节点右键菜单改为 ①关联已有文件 ②从此创建（子菜单：添加笔记 / 创建 TaskNote / 从模板添加文件 / 创建新思维树）③链接网页。节点已参与关联（有资源或 nodeLink）时，整个创建组与两条 link 行都隐藏。

**落点**：
- `ui/ui-contracts.ts`：新增 `CREATE_FROM_MENU_ORDER = ["add-note","create-task-note","add-file-template","create-tree"]`；`nodeResourceMenuItemOrder` 改返回 `NodeResourceMenuEntryId[]`（含组父行 `create-from`），`NodeMenuGroupId` 增加 `create-from`。
- `ui/menus/node-context-menu.ts`：资源段改为 `rowFor(id)` 行描述 + `addMenuGroup` 渲染 `create-from`（宿主无子菜单能力时由 `addMenuGroup` 平铺，顺序不变）。
- `services/tree-creation.ts` 新增纯函数 `createMindTreeSubfolderPath(base, title)`：`<base>/<清洗标题>`，标题清洗后为空则退回 base。
- `ui/view-ops/resource-ops.ts` 新增 `createMindTreeForNode`：捕获目标 → `createMindTree` 建树（`focus:false`）→ `resources.ensureStableReference` → `associateFileWithTarget`；文件已建但关联失效时保留并提示真实路径。
- `main.ts` 新增 `createMindTreeFile(title, folderPath)`，复用 `MindTreeCreationService`（与 Ribbon/命令/MCP 同源），新树不抢焦点。
- i18n：`menu.createFrom` / `menu.createMindTree` / `notice.createdMindTree` / `notice.createdMindTreeNotLinked`（双语）。

**坑**：`test/tasknotes.test.ts` 有一组源码字符串断言钉住旧的 `items.push("add-note", …, "link-web")` 与 `item.setTitle(...)` 写法，改菜单必须同步（已改为断言 `CREATE_FROM_MENU_ORDER`、`items.push("link-file","create-from","link-web")` 与 `{ title: t(...)`）。`edit` 偶发 `ReplaceFileW EIO (Win32 1175)`，原样重试即成功。

**验证**：`npm run check` 0 错误；全量（`.mtn-test-build/register.mjs` 替代运行器）**1262 / 1262 / 0 fail**，新增 2 条（菜单分组顺序、子路径构造）。`npm run build` 未跑，沙箱 esbuild `spawn EPERM` 预期仍在。

**待人工验收**：真实 Obsidian 里的子菜单悬停展开、移动端滑动子菜单、无子菜单宿主的平铺顺序，以及新树创建后节点徽标能打开新树。

**缺陷修复（2026-11-23，用户实测）**：点「创建新思维树」时文件夹与文件都没生成，提示 `ENOENT: no such file`。原因：`vault.create` **不创建父目录**，而本功能传入的是全新子目录 `<树目录>/<节点标题>/`；旧的建树调用方（Ribbon/命令/MCP）只会传已存在的目录，所以 `MindTreeCreationService` 从来没有目录创建步骤。修法：`MindTreeCreationPorts` 增加 `ensureFolder(directory)`，`create()` 在首写前调用（传入归一化后的目录，根目录为空串）；`main.ts` 的端口按路径逐段 `vault.createFolder`。测试：`test/tree-creation.test.ts` 新增「creation ensures the destination folder before the first write」（fixture 记录 `ensured`），全量 **1263 / 1263 / 0 fail**。**沙箱注意**：`npm run build` 的 esbuild Node API 会 `spawn EPERM`，直接用 `./node_modules/@esbuild/win32-x64/esbuild.exe src/main.ts --bundle --external:obsidian --external:electron --external:@codemirror/state --external:@codemirror/view --external:@lezer/common --external:@lezer/highlight --external:@lezer/lr --format=cjs --target=es2018 --tree-shaking=true --outfile=main.js` 可正常产出（未加 `--sourcemap`，与生产构建一致）。















