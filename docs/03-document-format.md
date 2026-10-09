# 03 文档格式

> 定义 `.mtn.md` 的文件头、可读大纲、压缩 JSON 数据区、数据模型、保存与备份规则。
> [返回文档导航](requirements.md)

## 7. 文件格式设计

### 7.1 总体原则

- `.mtn.md` 必须始终是合法 UTF-8 Markdown。
- `.mtn.md` 扩展名、有效的顶层 `schemaVersion` 与完整压缩数据区共同识别导图文档；YAML Frontmatter 还保存布局、递归扫描、文件收集策略、主题、连线样式与节点形状六项本树独立设置。`documentId` 是可选的资源链接身份，不再是格式识别前提。
- Frontmatter 不保存节点、视口或压缩 JSON；只使用顶层整数 `schemaVersion` 标识文件结构版本，不使用 `format`、`version`、`revision` 等并行版本字段。
- 正文前半部分是可读、可检索、可供 AI 分析的 Markdown 无序列表大纲。
- 完整、无损的机器数据放在大纲之后：先用 Markdown 分割线分隔，再写明“这段话之后的内容是压缩json，无需读取和分析。”，最后保存 gzip + Base64 数据块。
- 每次正常保存必须从同一个已校验领域对象同时生成大纲和压缩数据，避免两者不同步。
- 写文件采用“生成完整内容 → 临时文件 → 原子替换”的策略；失败时保留原文件。

### 7.2 文件示例

````md
---
schemaVersion: 2
layoutMode: balanced
recursiveScan: false
collectionMode: ask
theme: vibrant
connectionStyle: theme
nodeShape: rounded
---

# 项目导图

<!-- mtn:outline:start -->
- 项目导图
  - [[notes/需求分析|需求分析]]
  - [参考资料](https://example.com)
<!-- mtn:outline:end -->

---

这段话之后的内容是压缩json，无需读取和分析。

<!-- mtn:data:start -->
```mtn-data-gzip
H4sIAAAAAAAA...按固定宽度换行的Base64数据...
```
<!-- mtn:data:end -->
````

约束：

- 新建且未被其他导图关联的文件不写 `documentId`。首次作为资源被另一棵树关联时，插件才生成随机 UUID 并将其写为 Frontmatter 顶层属性；已有 ID 保持不变。
- 复制带 ID 的导图可能产生重复身份：不再根据历史缓存自动修复或重分配 ID，而是拒绝新的关联及文件改写并列出冲突路径。已有引用只有路径与实际 ID 同时匹配时允许只读打开。明确从模板创建新副本仍生成独立 UUID；索引重建不修改身份。
- `schemaVersion` 是统一迁移工厂的唯一版本入口；当前写入版本为 v2，最早支持版本为 v1（引入版本字段前的当前基线格式）。
- `layoutMode`、`recursiveScan`、`collectionMode`、`theme`、`connectionStyle` 和 `nodeShape` 分别保存为 Frontmatter 顶层属性，不使用设置字典。全局设置中的布局、文件收集策略、主题、连线样式与节点形状只作为新建导图及缺失属性回填的默认值；主题笔记、扫描忽略规则、操作与导出偏好仍是插件全局设置。
- Frontmatter 中不得出现 `mind-tree-nature.payload`、节点映射或其他机器数据载荷；允许保留用户添加的无关 YAML 属性。
- `<!-- mtn:outline:start -->` 与 `<!-- mtn:outline:end -->` 标记可读大纲边界。
- 大纲结束后使用独占一行的 `---` 分割线，将可读内容与机器数据提示分开。
- 提示文字必须原样写为：`这段话之后的内容是压缩json，无需读取和分析。`
- `<!-- mtn:data:start -->`、`<!-- mtn:data:end -->` 和 `mtn-data-gzip` 代码块标记机器数据边界与编码方式。
- 代码块中只保存 gzip 压缩结果的 Base64 表示，永不写入 `documentId`；可选 ID 只存在于文件头，并仅用于跨文件资源关联。
- 大纲区与机器数据区之外允许用户写普通 Markdown 说明；插件保存时不得删除这些内容。
- 新建文件自动生成的单独一级标题属于导图标题投影；`.mtn.md` 重命名后随文件名和根节点同步更新。一级标题前后存在其他用户说明时视为用户内容，不自动覆盖。
- 解析器只接受本节定义的结构及统一迁移工厂明确登记的版本。早于 v1、晚于当前版本、迁移链断裂或仍使用更早废弃结构的文件直接报错，不在解析器其他位置增加临时兼容分支。

### 7.3 版本迁移

- 只有影响思维树识别或核心机器数据解码、导致旧文件无法读取的结构修改，才提升 `schemaVersion`，并在统一 `MindTreeMigrationFactory` 中登记一个从旧版本到下一整数版本的迁移。
- 新增布局、外观、扫描或操作类 YAML 属性不提升版本，也不进入迁移工厂；属性缺失统一交给文档设置规范化层处理，避免迁移代码随设置数量膨胀。
- 迁移严格逐级执行，不允许从任意旧版本直接跳到最新版本，也不允许在领域模型、视图或序列化器中散落版本判断。
- v1 是引入迁移机制前最后一版无版本号格式。缺少 `schemaVersion` 只在结构满足该基线时解释为 v1；迁移到 v2 时补充显式版本标记，不在工厂中写入节点形状、文件收集策略等可缺省设置。
- 当前及未来树设置缺失时，解析器统一采用对应全局默认值（无全局项时采用代码默认值）作为运行时回退；缺失或无效值本身不标记待保存、不自动补写属性。仅新建树写入初始设置，或用户在树菜单主动设置时写入对应字段。
- 迁移先在内存副本中执行，再进行当前结构的完整校验。成功打开后按正常保存流程写回最新版本；任何迁移或校验失败都不得覆盖源文件。
- 新建文件始终直接写当前版本，不生成中间版本文件。

### 7.4 压缩、序列化与校验

保存流程固定为：

1. 将领域对象转换为稳定字段顺序的机器数据对象，并移除 `documentId`、`settings` 与 `schemaVersion`；版本只存在于 Frontmatter。
2. 将对象序列化为无额外空白的 UTF-8 JSON。
3. 使用 gzip 压缩 JSON，再编码为 Base64，并按固定宽度换行写入 `mtn-data-gzip` 数据块。
4. 根据同一个领域对象生成 Markdown 无序列表大纲。
5. 写入顶层 `schemaVersion`、`layoutMode`、`recursiveScan`、`collectionMode`、`theme`、`connectionStyle` 和 `nodeShape`；仅当领域对象已有 `documentId` 时才保留该顶层属性，同时保留无关用户属性，再组合普通说明、大纲、分割线、AI 忽略提示和机器数据区。
6. 重新解析生成结果并执行可选文档 ID、根节点、节点引用、循环与可达性校验后，再原子替换文件。

读取流程固定为：

1. 从 Frontmatter 读取必需的 `schemaVersion` 与可选的 `documentId`，定位 `mtn:data` 边界并完成 Base64、gzip 与 JSON 解码。
2. 交给统一迁移工厂逐级升级到当前版本，再按“缺失属性使用对应默认值”的统一规则规范化顶层 `layoutMode`、`recursiveScan`、`collectionMode`、`theme`、`connectionStyle` 与 `nodeShape`。
3. 文件头存在 `documentId` 时将其与规范化后的设置注入领域对象，并执行完整结构校验；只有实际版本迁移等需要落盘的修正才标记待保存，设置回退不触发保存。
4. 打开画布时不解析大纲区，也不把大纲差异导入机器数据；发生迁移时标记文档待保存。

解码器必须限制压缩数据、解压后 JSON、节点数量和嵌套深度；默认压缩数据上限为 20 MB，解压后 JSON 上限为 50 MB。解析失败时不得执行其中任何 URL 或 HTML 内容。

### 7.5 文档数据模型

解压后的 JSON 对应以下领域模型；会话内保存序号、撤销栈等运行时状态不写入文件：

```ts
type NodeId = string;
type ResourceId = string;

interface MindTreeDocumentData {
  title: string;
  rootId: NodeId;
  nodes: Record<NodeId, MindTreeNode>;
  createdAt: string;
  updatedAt: string;
}

interface MindTreeNode {
  title: string;
  childIds: NodeId[];
  resource?: ResourceRef;
  markers?: NodeMarker[];
  collapsed?: boolean;
  titleSync?: 'off' | 'bidirectional';
  style?: NodeStyle;
  createdAt: string;
  updatedAt: string;
}

interface NodeStyle {
  /** 图片节点的独立显示尺寸；必须成对出现。 */
  imageWidth?: number;
  imageHeight?: number;
}

type NodeMarker =
  | { type: 'progress'; value: 'todo' | 'inprogress' | 'done' | 'cancelled' }
  | { type: 'priority'; value: 'red' | 'yellow' | 'blue' }
  | {
      type: 'highlight';
      value: '#75ACA6' | '#85A695' | '#C39E96' | '#F37B6A' | '#6B565D'
        | '#403721' | '#BF4830' | '#BF6730' | '#99723C' | '#E0CA9D';
    };

type ResourceRef =
  | {
      type: 'file';
      resourceId: ResourceId;
      pathHint: string;
      fileKind: 'note' | 'image' | 'attachment';
      fileSubtype?: 'excalidraw';
    }
  | {
      type: 'url';
      url: string;
    };
```

`documentId`、`schemaVersion` 与 `settings` 均不进入压缩 JSON；文档设置由文件头的 `layoutMode`、`recursiveScan`、`collectionMode`、`theme`、`connectionStyle` 和 `nodeShape` 提供。节点 ID 由 `nodes` 映射的键表达，不在节点对象中重复保存。模型不存 `parentId` 和浮点排序值：唯一根节点由 `rootId` 指定，其余父子关系与顺序统一由 `childIds` 表达。画布平移与缩放属于视图会话状态，不属于文档数据，也不进入压缩 JSON。

图片节点继续使用 `fileKind: 'image'`，不增加独立节点类型。`NodeStyle.imageWidth/imageHeight` 只记录该引用在导图中的显示尺寸并写入压缩 JSON，必须作为有效正数成对出现；它们不改变源图片，也不进入 YAML 或 Markdown 大纲。同一图片被多个节点引用时，各节点可保存不同显示尺寸。

`fileSubtype: 'excalidraw'` 是关联文件 Frontmatter 的派生缓存，仅当 `excalidraw-plugin` 为 `raw` 或 `parsed` 时存在；文件名和扩展名不参与判断。关联文件可解析时以当前 Frontmatter 校正该缓存，文件暂时无法解析时保留最后状态。该字段不改变 Markdown 文件的 `fileKind: 'note'`。普通非 Markdown 文件的扩展名显示标签由 `pathHint` 与全局插件设置在运行时派生，不属于节点字段，也不进入本格式。

加载时必须校验：

- 文件头存在 `documentId` 时，其值必须能被解析；缺少 ID 的 v2 文件仍是合法导图。
- 所有节点 ID 唯一且能被解析。
- `rootId` 必须指向一个存在的节点，且根节点不能作为其他节点的子节点。
- 根节点以外的每个节点只能出现一次，且不存在循环引用。
- 无法从根节点到达的节点移入压缩数据中的恢复区，而不是直接丢弃。
- 未知资源类型显示为不可用资源，并保留原始字段。

### 7.6 大纲、AI 分析与外部编辑

大纲表达标题、层级、可读资源链接以及节点标记。标记以稳定的可读后缀输出，例如 `〔progress:done〕`、`〔priority:red〕` 和 `〔highlight:#75ACA6〕`；关联 `.mtn.md` 的节点还会根据资源路径派生 `〔mind-tree〕` 后缀。大纲仍不承载折叠、其他样式或视口状态。它用于 Markdown 阅读、搜索和 AI 分析，不是编辑导图的输入渠道。

- AI 工具读取文件时，应分析从文件开头到提示文字之前的内容；看到“这段话之后的内容是压缩json，无需读取和分析。”后停止读取和分析后续数据。
- 打开导图时根据 `.mtn.md` 扩展名、文件头 `schemaVersion` 与底部压缩数据区识别并恢复导图；`documentId` 按可选资源身份读取，不解析大纲，也不比较大纲差异。
- 用户手动修改或删除大纲不会改变画布内容。
- 每次保存都根据当前机器数据完整重建大纲，覆盖大纲区内的手动修改。
- 文件名是文档标题与根节点标题的权威来源；打开或收到文件重命名事件时先同步标题，再生成大纲和压缩数据。
- 只有大纲而没有有效 `schemaVersion` 和压缩数据区的文件不视为有效导图，也不会自动导入；缺少 `documentId` 不影响打开。
- 只有有效压缩数据而缺少大纲时，导图仍可打开，并在下一次保存时补全大纲。
- 大纲区和数据区之外的普通 Markdown 说明不参与树结构解析，保存时必须保留。

### 7.6 保存与未决版本暂存

- 结构或内容变化后延迟 500 ms 自动保存；连续输入会重新计时。
- 视口平移、缩放和复位不改变文档状态，不触发自动保存，也不改变保存按钮状态。
- 同一规范路径优先复用已有标签。共享会话仍作为并发防线：同一路径只有一份文档、100 步线性撤销历史、基线、冲突状态及写入队列。选择、平移与缩放属于视图；未决会话不会因最后一个标签关闭而丢弃。
- 标题输入框中的原始草稿属于共享会话内的本地工作。`Ctrl/Cmd+S`、文件切换、正常关闭及首次写入资源身份前必须先提交草稿，再等待文件级保存；`Escape` 仍取消草稿。插件不写持久化草稿日志，因此应用被强制终止时尚未确认的输入不在保证范围内。
- 保存前在 `Vault.process()` 内重新读取磁盘文件，并按“磁盘基线 / 当前内存 / 最新磁盘”比较受管理的逻辑数据。冲突主体是解压并规范化后的 JSON；gzip/Base64 重压缩或换行差异不构成冲突。
- 版本选择只比较规范化 JSON。六项树设置按字段接收最新 YAML；保存只提交明确修改的字段，同一字段已在磁盘修改或删除时磁盘优先，用户随后主动设置可再次写入。属性存在性和待写字段仅作为运行时状态，不进入压缩 JSON。
- `documentId` 仍独立保护：正常首次赋值可接纳，已建立身份删除或替换时显示安全提示而非版本选择。用户可恢复已验证基线中的原 ID；必须先排除重复身份，再在 `Vault.process()` 中比较期望现值，只补改该属性并读回校验，不改节点数据。没有可信原 ID 时不猜测。身份恢复后重新判断 JSON 是否真的需要选择。
- 自动一级标题、大纲、普通 Markdown 正文及未知 Frontmatter 不参与冲突判断。非冲突保存以最新磁盘文本为底稿，因此这些外部内容会被保留，而标题与大纲仍按当前树重新生成。
- `schemaVersion` 只用于兼容性校验；无效或未来版本、缺失或损坏的压缩数据会阻止自动覆盖，但普通版本规范化不被视为内容冲突。
- 进入预览时冻结当前逻辑数据并纳入原始草稿，独立暂存于插件目录 `pending-conflicts/<本机标识>/`，不混入 `data.json`，也不创建仓库恢复副本。暂存写入与读回校验失败时不可选择版本。外部版本不累积快照，始终重读原文件。
- 选择时比较点击时展示的外部逻辑指纹，并在 `Vault.process()` 内再次比较。写入及读回一致后才能清理暂存；准备/验证提交回执可识别写入成功但清理前中断的情况。重开恢复未决预览，改名更新定位；源文件已删除或路径改由另一份已建立身份的文档占用时清理记录并释放冲突锁（只提示一次被清理的路径），按唯一 `documentId` 找到唯一移动目标时改绑定位，无法唯一判定时保留记录并报错而不猜测。
- 写入成功后必须重新读取磁盘并核对受管理逻辑快照；只有验证通过才更新基线和绿色保存状态。写入期间产生的新修改会保留为未保存并进入下一轮串行写入。
- 视图打开期间源文件被删除属于文档的正常结束，不是保存失败：不创建版本预览或冲突记录，不写回已删除路径（也不因此重建文件），共享会话同步释放冲突锁并停止报告未保存状态，关闭标签页不产生错误提示。文件被恢复后仍按普通外部修改流程重新读取。
- `.mtn.md` 是唯一权威导图数据；共享会话是可丢弃的运行时缓存，资源索引是可重建的路径映射，二者都不能替代原文件。
