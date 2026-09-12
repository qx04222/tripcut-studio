# R9 界面成品化 —— 设计系统、原生抽屉、主屏层级 · 设计规格（2026-09-12）

业主对 R8 成果的判词是「需要特大优化才能使用」。本文是 R9 轮的唯一依据；执行计划另出。R9 **只改前端**：`src-tauri` 零改动、`src/api.ts` 一行不改、数据库 schema 不动。

## 0. 起点与目标

- 起点：`main` @ `e8e2de9`（R8 合并后 + 设计遍历）。新壳在 `src/workspace/`（52 个文件，最大 `ShotBand.tsx` 394 行），样式在 `src/styles/workspace.css`（2382 行，10 个分节），无头截图装置 `scripts/qa/preview-shots.mjs`（`vite --mode mock` + Playwright，9 张图 + AX 树）。旧四页（`ImportPage` 858 行、`DeliverPage` 610 行、`SettingsPage` 1636 行）仍被 `LegacyShell` 使用，R10 删除。
- 控制端对 R8 截图（`.superpowers/sdd/r8-visual-audit/design-pass/*.png`）的诊断（**固定输入，不再讨论**）：
  - (a) 主屏有结构没层级：12–13px 灰字压在米色底上，只有发丝线；监视器是一块空米色矩形；镜头带瓦片下方大片空白；媒体池卡片文件名中段省略成 `202… 01.MP4`（无法分辨）；检查器默认层是占位文案。
  - (b) 三个抽屉 / sheet 是旧页面（`ImportPage` / `DeliverPage` / `SettingsPage`）原样塞进 700px 容器：英文 kicker（`SOURCE / WATCHED / DELIVERY ITEMS / ESTIMATED DURATION / STABLE PACKAGE / NATIVE DRAFT / SETTINGS / 01 APPEARANCE / MUSIC`）、三栏统计头被挤扁、`01/02/03` 巨型水印数字、按钮样式混杂。**R8 规格 §1.1「抽屉包装旧页面主体、内容不改」这一决定是错的，R9 予以推翻。**
  - (c) 没有设计过的空状态、分隔条不可见、没有 hover / 拖动态、没有图标语言。
- 目标：**一套设计系统 + 一个组件套件，全部新壳界面（主屏四栏 + 三个模态）只从这一套取样式**，把 R8 的线框升到成品；抽屉与 sheet 用套件原生重写，旧页面只剩逻辑供体（hooks）与旧壳宿主。
- 明确不做：
  - 不重做深色主题（令牌层保证深色能用即可，不做深色视觉走查）。
  - 不加功能、不加 Rust 命令、不加 schema、不改 `api.ts`。
  - 不给旧壳（`LegacyShell` + 旧四页）重新做样式——它们在 R10 被删。
  - 除 150ms 以内的 transition 之外不做动画。
  - 不加 npm 依赖（图标自绘，套件自写）。

## 1. 设计系统 `src/styles/tokens.css`

唯一的令牌文件，在 `src/main.tsx` 里**先于** `styles.css` 引入（令牌只定义变量，不含规则，顺序只影响可读性）。旧 `styles.css:4-60` 的调色板变量（`--bg`、`--bg-elevated`、`--accent`、`--warning`、`--danger`…）**保留**并作为色源，`tokens.css` 里的表面 / 语义色**引用它们**，深色主题因此自动跟随（`prefers-color-scheme` 与 `html[data-theme]` 两条既有机制都不动）。

| 组 | 令牌 | 值（浅色） | 说明 |
|---|---|---|---|
| 字号 | `--text-11` `--text-12` `--text-13` `--text-15` `--text-20` | 11/12/13/15/20 px | 五级，主屏正文 13、元信息 12、角标 11、标题 15、抽屉标题 20 |
| 行高 | `--lh-11` `--lh-12` `--lh-13` `--lh-15` `--lh-20` | 14/16/18/20/26 px | 与字号一一配对 |
| 间距 | `--space-1`…`--space-6` | 4/8/12/16/24/32 px | 只允许这六档；不许写 `padding: 10px` |
| 表面 | `--surface-ground` `--surface-panel` `--surface-card` `--surface-raised` | `var(--bg)` / `var(--bg-elevated)` / `#fff` / `#fff` | 四级：壳底 → 栏面板 → 卡片 → 浮层（抽屉 / popover） |
| 阴影 | `--shadow-card` `--shadow-raised` `--shadow-inset-well` | `0 1px 2px rgb(29 30 26/6%), 0 1px 0 rgb(29 30 26/4%)` / `0 8px 24px rgb(29 30 26/16%), 0 1px 3px rgb(29 30 26/8%)` / `inset 0 2px 8px rgb(0 0 0/45%)` | 三级；深色下 card 阴影换成 `0 0 0 1px var(--border)` |
| 圆角 | `--radius-6` `--radius-10` | 6 / 10 px | 控件 6，卡片 / 井 / 抽屉 10 |
| 边框 | `--border-hair` `--border-strong` `--border-focus` | `var(--border)` / `var(--border-strong)` / `var(--accent)` | |
| 强调 | `--accent` `--accent-ink` `--accent-tint` | 沿用 `styles.css` | 只有一个强调色 |
| 语义 | `--ok` `--ok-tint` `--warn` `--warn-tint` `--danger` `--danger-tint` `--info` `--info-tint` | ok = accent；warn/danger 沿用；info = `var(--text-secondary)` | |
| 焦点 | `--ring` | `0 0 0 2px var(--surface-panel), 0 0 0 4px var(--focus-ring)` | 双圈，`:focus-visible` 专用 |
| 动效 | `--motion-fast` | `150ms cubic-bezier(.2,.7,.2,1)` | 唯一允许的 transition 时长 |
| 控件 | `--control-sm` `--control-md` | 24 / 28 px | 控件高度两档；顶栏主按钮 30 |

规则：
- `src/workspace/**` 与 `src/styles/workspace.css` 里**禁止**出现颜色字面量、`px` 字号、非六档间距（Task 1 加一条 vitest 扫描 `workspace.css`：`#[0-9a-f]{3,6}`、`font-size:\s*\d+px`、`padding|margin|gap:\s*(1|2|3|5|6|7|9|10|11|13|14|15)px` 一律红）。
- 深色：`tokens.css` 末尾一段 `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` 与 `html[data-theme="dark"]` 覆盖 `--surface-card`（`var(--bg-elevated)`）、`--shadow-*`、`--shadow-inset-well`。只保证不刺眼、不反色，不做走查。

## 2. 组件套件 `src/workspace/ui/`

每个组件一个文件（< 200 行）+ 一份 vitest + 在 `KitPreview.tsx` 里一个示例块。全部用 tokens，`className` 可透传，`ref` 用 React 19 的 props ref。

| 组件 | 文件 | API 摘要 | 视觉 |
|---|---|---|---|
| `Button` | `Button.tsx` | `variant: "primary"\|"secondary"\|"ghost"\|"icon"`，`size: "sm"\|"md"`，`icon?: IconName`，`busy?`，其余透传 `<button>` | primary = 强调底白字；secondary = 卡面 + 发丝边；ghost = 透明，hover 出底；icon = 28×28 方形 |
| `Chip` | `Chip.tsx` | `selected?`, `count?`, `onClick?`, `tone?: "neutral"\|"accent"\|"warn"\|"danger"` | 24px 高胶囊，selected = 强调 tint + 强调边 |
| `Badge` | `Badge.tsx` | `tone`, `icon?`, children | 11px 角标，用于「AI 生成」「2 条候选」「缺口 1」 |
| `Card` | `Card.tsx` | `level: "card"\|"raised"`, `interactive?`, `selected?`, `padding?: 3\|4` | 圆角 10 + card 阴影；interactive hover 上浮 1px + 边变 strong；selected 双圈强调环 |
| `SectionHeader` | `SectionHeader.tsx` | `title`, `meta?`, `actions?`, `size: "pane"\|"section"` | pane = 13px 半粗 + meta 12 灰；section = 15px |
| `Field` / `Label` / `Help` | `Field.tsx` | `Field{label, help?, htmlFor, inline?}` 三件套 | 行式：左标签 13 + 右控件；help 12 灰在下 |
| `Toggle` | `Toggle.tsx` | `checked, onChange, label(AX 名), disabled?` | 32×18 滑块，`role="switch"` |
| `Select` | `Select.tsx` | 原生 `<select>` 外套 chevron-down 图标 | 高 28，卡面 + 发丝边 |
| `Tabs` | `Tabs.tsx` | `items:{id,label,count?}[]`, `value`, `onChange`, `ariaLabel` | `role="tablist"`；下划线式；R8 的 `BandTabs` 与导入分页都换成它 |
| `Drawer` | `Drawer.tsx` | `open, title, side: "left"\|"right", width, onClose, children, actions?` | 迁自现有 `workspace/Drawer.tsx`：模态栈、`useFocusTrap`、Esc 只在栈顶响应、mousedown 遮罩关闭、**可见「关闭」按钮**——四条行为一条不丢；标题栏 52px：20px 标题 + 右侧 actions + 关闭 |
| `Sheet` | `Sheet.tsx` | 同上，居中，`width`, `height="80vh"` | 与 Drawer 共用 `ModalSurface`（内部） |
| `EmptyState` | `EmptyState.tsx` | `icon, title, body?, action?: ReactNode, size: "pane"\|"inline"` | 图标 32px 淡色 + 15 标题 + 13 灰说明；pane 版竖直居中 |
| `Toolbar` | `Toolbar.tsx` | `children`, `ariaLabel?`, `dense?` | 28px 一行，子项 4px 间距，`Toolbar.Divider` |
| `Kbd` | `Kbd.tsx` | children | 11px 等宽，卡面底 + 发丝边 |
| `icons` | `icons.tsx` | `Icon name=… size=16`；`IconName` 联合类型 | 16px 视窗、1.5px 描边、`currentColor`、`aria-hidden` |

图标集（24 个，命名冻结）：`import deliver settings search play pause prev next volume volume-off fullscreen mark-in mark-out save star heart x check chevron-down chevron-right grip plus close info warning`。

套件预览：`src/devMock/KitPreview.tsx` 是一张 kitchen-sink 页（每个组件所有 variant × 状态，含 hover 模拟态 `data-hover`、focus 态、禁用态、深色一栏用 `data-theme="dark"` 包一块），由仓库根新增的 `kit.html` + `src/devMock/kitMain.tsx` 挂载。`kit.html` 只在 `vite --mode mock` 下访问（Vite 生产 build 只打 `index.html`，`kit.html` 不进产物——Task 1d 加断言）。`scripts/qa/preview-shots.mjs --kit` 多截一张 `10-kit.png`。

## 3. 主屏

### 3.1 顶栏（44px）
- 品牌：字标「旅剪工作台」13px 半粗，前置 16px 品牌记号；不再画三根线。
- 「导入素材」= `Button variant="secondary" icon="import"`；「生成交付包」= `primary icon="deliver"`；「设置」= `icon` 变体（AX 名 `设置` 不变，`title="设置 ⌘,"`）。集切换胶囊改 `secondary` + `chevron-down`，AX 名 `切换集` 不变。
- 顶栏底：`--surface-panel` + 1px `--border-hair` + 下方 `--shadow-card`（把顶栏从米色壳底上抬起来）。

### 3.2 栏标题条（`PaneHead` → 用 `SectionHeader size="pane"`）
- 高 36px，标题 13px 半粗，meta 12px `--text-secondary`，右侧 actions 槽。底部 1px 发丝线，背景 `--surface-panel`。
- 栏本体：`--surface-panel`，四栏之间的分隔条 6px 可见（`--surface-ground` 底 + 居中 2×16px 圆角抓手 `--border-strong`），hover / 拖动中抓手变强调色，`cursor: col-resize / row-resize`。

### 3.3 状态条（28px）
- 左：`Icon info` + 「查看后台任务详情」（AX 名不变）；短语前各带图标：分析 → `play`（进度中）/ `check`（完成）、缺失素材 → `warning`（tone warn）；右端库名前绿点换成 `Icon check` 小圆 tint。IME 提示槽不变。

### 3.4 空状态（`EmptyState`）
| 位置 | 图标 | 标题 | 说明 | 动作 |
|---|---|---|---|---|
| 媒体池（无素材） | `import` | 还没有素材 | 导入一批素材后，卡片会按拍摄时间出现在这里。 | `Button secondary` 「导入素材」（打开导入抽屉；AX 名与顶栏同名，`WorkspaceShell.test` 的 `getByRole("button",{name:"导入素材"})` 要改成 `getAllByRole` 取第一个——**只在空池时出现**，非空池不渲染，避免主屏出现两个同名按钮） |
| 媒体池（筛选无命中） | `search` | 没有匹配的素材 | 换个筛选条件或清空搜索。 | `ghost` 「清空筛选」 |
| 监视器（未选择） | `play` | 从左侧媒体池选一条素材 | 选中后在这里预览，I / O 打点。 | 无 |
| 镜头带（无章节） | `grip` | 还没有章节 | 导入完成后会按拍摄时间自动生成章节。 | 无 |
| 检查器（未选择） | `info` | 选一条素材查看详情 | 评级、标签与技术检查都在这里。 | 无 |

「从左侧媒体池选一条素材」这句文案 R8 的 `Monitor.test` 已断言，保留原句。

### 3.5 媒体池
- 卡片 = `Card interactive selected`：缩略图 16:9 圆角 6，时长角标右下（`Badge` 深底），候选数 / AI 生成角标左上。
- 文件名两行：`fileNameLines(name)` 在最接近中点的 `_` 处断行（无 `_` 则按中点断），第二行末尾永远含扩展名；CSS `overflow-wrap: anywhere` + 两行 clamp；**不再有中段省略**（`splitFileName` 删除，其测试迁移到 `fileNameLines`）。
- 元信息行：日期 12 灰 · 评级（收藏 = `Badge tone=accent icon=heart`，拒绝 = `danger icon=x`，星 = 实心 `star` ×n，未评 = 灰字）。
- hover：上浮 1px + 边变 strong（`--motion-fast`）；选中：2px 强调环（`--ring` 变体 `--ring-selected`）+ 缩略图外框强调。
- 筛选条：`Chip` 一行（全部 / 收藏 / 未评 / 拒绝 各带 count）+ 「更多筛选」`ghost` 按钮带 `chevron-down`。搜索框 = 28px，`Icon search` 前缀，`Button secondary size=sm` 「搜索」。

### 3.6 监视器
- 舞台：中上区 padding 16，井 = `aspect-ratio: 16/9`、`max-height: 100%`、居中、圆角 10、背景 `#121311`（仅此一处允许的深色，定义为 `--well-bg` 令牌）+ `--shadow-inset-well`。播放器矩形只在井内（`playerSetViewport` 继续拿井的 rect）。
- 文件名 `Chip tone=neutral` 深底白字，左上角 12px 内缩，`aria-hidden`。
- 控件条 = `Toolbar`：`icon` 按钮 `play/pause`、`prev`(−1s)、`next`(+1s)、速度 `×1`（仍禁用）、`volume/volume-off`；时间码等宽；`Toolbar.Divider`；`mark-in`/`mark-out`（带值时显示 `Kbd I` + 时间码）、「保存片段」`primary size=sm`；右端 `fullscreen`。所有 AX 名与 R8 一致（播放 / 暂停 / 后退一秒 / 前进一秒 / 播放速度 / 静音 / 取消静音 / 入点 / 出点 / 保存片段 / 全屏沉浸）。
- 空槽位占位：井内 `EmptyState size=inline` 深底变体（标题 = 章节 · 槽位名，说明 = reason）。

### 3.7 镜头带
- 栏高**按内容定**：`band-viewport` 高 = 章节头 28 + 瓦片 130 + 滚动条 10 + padding；多余高度让给附属带（`BandAccessory`）或留白**在栏外**（中栏纵向分割的下限改为「镜头带内容高」，`Panel minSize` 由 `bandMinHeight(bandMode)` 算：story 184，其它 284）。**不再出现瓦片下方的白色空区。**
- 章节头 = `Toolbar dense`：序号 `Badge neutral` + 标题 13 半粗 + 时长 12 灰 + `n 镜` + 缺口 `Badge warn icon=warning`。
- 瓦片 = `Card interactive selected` 160×130：缩略图 + 序号角标 + 时长角标 + 候选 / AI 角标 + 文件名单行（同 `fileNameLines` 第一行 + 省略）；`grip` 图标做拖柄（AX 名 `拖动 …` 不变），hover 时显示。
- 横向滚动条常显（`scrollbar-gutter: stable; overflow-x: scroll`，10px 细条）。
- 拖动：`DragOverlay` 里的 `band-drag-preview` 改为 160×130 瓦片缩略图半透明 ghost（`opacity .85` + `--shadow-raised` + 2° 倾斜），拖动源瓦片 `opacity .35`，插入位置画 2px 强调竖线（`useBandDrag` 已有 over 索引，只补 DOM）。
- 空槽位卡 = 虚线 `Card` + 槽位名 + reason + 「生成候选」`secondary size=sm` / 「忽略」`ghost size=sm`。

### 3.8 检查器
- 默认层**只渲染有内容的段**：评级与收藏永远在；标签段只在 `tags.length > 0` 时渲染（禁用的「添加」跟随出现——`api.ts` 无手动打标签接口，这一决定不变）；所属章节 / 槽位只在 `placement !== null` **或**有可改章节时渲染；Take 段只在 `stack !== null` 时渲染。**不再出现「暂无标签…」「不属于任何 Take Stack。」这类占位句。**
- 评级段：收藏 / 拒绝 / 清除 = `Button secondary size=sm` 分段（带 `Kbd F/X/0`），五星 = `icon` 按钮 `star`（实心 = 强调色）。
- Take 条：横向缩略图卡 96×54，当前项强调环，AI 生成带 `Badge`。
- 折叠段：`<details>/<summary>` 保留（冒烟锚点），`summary` 排版 = 行 36px：`chevron-right`（open 时旋转 90°，`--motion-fast`）+ 段名 13 半粗 + 右侧状态字 12 灰。段内容 `padding: 0 var(--space-4) var(--space-4)`。
- 空槽位分支：`GapInspector` 用 `Card` + `SectionHeader` + 两个按钮，文案不变。

## 4. 三个模态的原生重写

共同点：标题栏（20px 标题 + 关闭）由 `Drawer`/`Sheet` 画；主体滚动区 padding `--space-5`；节标题 `SectionHeader size="section"`；卡 = `Card`；**无任何英文 kicker**；旧组件的 api 调用 / 轮询 / 错误处理 / 事件（`tripcut:action`、`tripcut:episode-changed`、`tripcut:deliver-availability`、`tripcut:library-changed`）**全部**搬进 hooks，UI 只是新皮。

### 4.1 导入抽屉 `ImportDrawer`（左，宽 min(720, 60vw)）
- `Tabs` 三分页：来源 / 任务 / 缺失素材（AX 名不变；tablist AX 名 `导入分页` 不变）。
- **来源**（`ImportSourcesTab.tsx`，用 `useImportSources`）：
  - 顶部行：说明「只建立索引，不复制或改写原片」+ 右侧 `Button primary icon=plus` 「添加素材文件夹」（`pickImportFolder` → `startImport`；扫描中显示「正在扫描…」busy）。
  - 已关注文件夹列表（`Card`，每行：路径 13 半粗 单行省略 + 上次同步 12 灰 + `Toggle` 「自动同步」 + `ghost icon=x` 「移除」）；列表头右侧 `secondary size=sm` 「立即扫描」；扫描结果 notice 行（文案逐字沿用）。
  - 无关注文件夹时 `EmptyState inline icon=import` 「还没有关注的文件夹」+ 「添加素材文件夹」。
  - 工具链缺失警告 = `Card` warn tint + `Icon warning`（文案逐字沿用，「去设置」改为按钮，打开设置 sheet 而不是改 hash）。
  - 拖放：`getCurrentWebview().onDragDropEvent` 逻辑进 hook，`dragActive` 时抽屉主体覆盖「松开即导入」层（`role="status"`，文案不变——冒烟 `drawer.import.dropOverlay.hidden` 断言它平时不在树里）。
  - 素材清单（`VirtualClipList`）**不进抽屉**——素材在主屏媒体池里，抽屉只管来源与任务。
- **任务**（`ImportJobsTab.tsx`，用 `useImportJobs`）：
  - 进度卡（`Card`）：标题「索引进度」+ 大数字 `已处理 59 / 60` 20px + 进度条（`role=progressbar` 属性沿用）+ 三行阶段：`索引`（done/failed/running/waiting）、`画质分析`、`运镜分析`（数据 = `analysisProgress(readyClips, kind)`，函数从 `ImportPage` 移到 hook 文件并保留原导出转发）；`PermitWaitingHint` 文案沿用。
  - 批次列表：每批一张 `Card`：来源末段 13 半粗 + 状态 `Badge`（等待处理 / 正在扫描 / 索引完成 / 已停止 / 扫描未完成，可重试）+ 「新增 · 重复 · 失败」12 灰 + 右侧 `secondary size=sm` 「停止本批」/ `ghost size=sm` 「撤销本批…」。
  - 批量操作行：「移除选中」（新壳下始终 0 选中 → 不渲染此按钮）、「清空当前集素材…」`ghost danger`、「清理重复/失败提示」`ghost`。
  - 确认框：`role="alertdialog" aria-label="确认移除素材"` 文案逐字沿用（`ImportManagement.test` 断言「原视频不会删除」）。
  - **「暂停 / 继续」**：`api.ts` 没有导入队列的暂停命令（只有 `cancel_import_batch` 与关注文件夹的 `set_watched_folder_sync`），本轮**不做**假按钮；任务卡上的控制就是「停止本批」，关注文件夹的 `Toggle 自动同步` 即「暂停 / 继续同步」。这是任务书与 `api.ts` 的出入，在此记档。
- **缺失素材**（`ImportMissingTab.tsx`，用 `useMissingMedia`）：按卷分组的 `Card`：卷标 + `n 个文件缺失` `Badge warn`，文件名列表 12 等宽，`Button secondary icon=search` 「重新定位」（AX 名改为 `重新定位`；`MissingMediaPanel` 旧版仍叫「选择新位置」——旧组件不改），结果行文案逐字沿用（「已重绑 n…」）。无缺失时 `EmptyState inline icon=check` 「所有素材都在原位」。

### 4.2 交付抽屉 `DeliverDrawer`（右，宽 min(720, 60vw)）
一张表单 + 一行汇总 + 一个主按钮，顺序固定：
1. `SectionHeader` 「本次交付」→ `Field` 行：`本次交付平台`（`Select`，选项文案沿用 `PLATFORM_LABELS`，「通用(本集设置)」这类当前文案沿用）、`参考粗剪时长`（`Select`：完整 / 30 秒 / 60 秒 / 3 分钟）、`联系表.pdf`（`Toggle`，AX 名 `联系表.pdf`，冒烟 `drawer.deliver.contact` 找「联系表」）、`剪映草稿`（`Toggle` + 状态字：「已检测到剪映专业版 11.4」/ reason；`supported=false` 时 Toggle 禁用）。
2. 交付项汇总一行 12 灰：「12 项 · 1 段精选片段 · 11 条整条收藏 · 预计 5:00」。
3. `Button primary size=md icon=deliver` 「生成交付包」（AX 名与顶栏同名——抽屉是 `aria-modal`，顶栏在树外，冒烟不歧义；`DeliverDrawer.test` 用 `within(dialog)`）。剪映 Toggle 打开时点它走 `generateNative`（失败自动降级逻辑不变）。
4. 进行中：进度卡 `Card`：阶段名（`STAGE_LABELS` 沿用）+ 进度条 + 每项列表（文件名 + 状态 `Badge`，失败红）+ `ghost` 「取消」。
5. 完成：结果卡 `Card` ok tint：`Icon check` + 「交付完成」+ 输出路径 12 等宽 + `Button secondary` 「打开文件夹」（`revealExport`）；失败 = danger tint + error；`nativeResult` = 「剪映草稿已生成」+ `draft_name` + message（不声称已打开剪映）。
6. 「交付包里有什么」四条说明改为 `<details>` 折叠段（默认收起，文案沿用），**删除 01/02/03/04 水印数字**。

### 4.3 设置 sheet `SettingsSheet`（居中 960×80vh）
- 标题栏：「设置」+ 右侧「关闭」；标题栏下**一行内联 notice**（`role=status aria-live=polite`，`Icon info/check/warning` 按内容切换：「正在读取本地设置…」「已保存」「保存失败：…」）。
- 左 nav 200px：九个分区（`SETTINGS_SECTIONS` 的 `label` + `description`，**不渲染 `eyebrow`**），图标沿用 `SettingsIcon` 路径但改成 16px 描边（迁入 `icons.tsx` 为 `settings-*` 九个附加图标，图标总数 33）；「缓存与重建」用 danger 色，靠底。
- 右内容：每分区 `SectionHeader size=section`（中文标题 + 一句说明）+ `Field` 行（左：标题 13 + help 12；右：控件）。所有分区内容与控件从 `SettingsPage` 逐段搬来，**文案逐字沿用**（`SettingsPage.test` 里断言的串——「隐私与诊断」「云端补镜」「检查更新」「已配置」等——在 sheet 里必须同样存在，Task 7 把这些断言复制到 `SettingsSheet.test`）。
- 分区文件：`src/workspace/settings/` 下 `SettingsNav.tsx`、`AppearanceSection.tsx`、`PerformanceSection.tsx`、`TimelineSection.tsx`、`ToolsSection.tsx`、`AnalysisSection.tsx`、`GenerationSection.tsx`、`PrivacySection.tsx`、`AboutSection.tsx`、`CacheSection.tsx`，每个 < 400 行，全部只消费 `useSettingsForm()`。
- 「界面 / 切回旧界面」那一行**保留**（R10 删旗），文案不变。

## 5. 逻辑供体：hooks

| hook | 文件 | 从哪里抽 | 返回 |
|---|---|---|---|
| `useImportSources` | `src/workspace/import/useImportSources.ts` | `ImportPage` 的 watched / chooseFolder / rescan / toggle / remove / drop / toolchainMissing | `{ watched, notice, error, choosing, dragActive, toolchainMissing, chooseFolder, rescan, setAutoSync, remove, refreshWatched }` |
| `useImportJobs` | `src/workspace/import/useImportJobs.ts` | `ImportPage` 的 progress + clips 轮询（1.5s、revision 门、visibility 停表、请求序号防回写）+ `ImportManagement` 的批次轮询与操作 | `{ progress, readyClips, quality, motion, refreshError, batches, busy, notice, confirmation, arm, confirm, dismiss, cancelBatch, dismissNotices, clearAll }` |
| `useMissingMedia` | `src/workspace/import/useMissingMedia.ts` | `MissingMediaPanel` | `{ groups, busy, results, notice, relink, refresh }` |
| `useDeliverForm` | `src/workspace/deliver/useDeliverForm.ts` | `DeliverPage` 的平台 / 时长 / 联系表 / 剪映可用性 / generate / generateNative / cancel / reveal / episode-changed / tripcut:action / deliver-availability | `{ episodePlatform, overridePlatform, setOverridePlatform, targetSeconds, setTargetSeconds, includeContactSheet, setIncludeContactSheet, jianying, nativeBusy, nativeResult, nativeNotice, busy, error, generate, generateNative, cancel, reveal }` |
| `useExportProgress` | `src/workspace/deliver/useExportProgress.ts` | `DeliverPage` 的 `getExportStatus` 轮询（750 / 2000ms 自适应）+ episode reset | `{ status, jobId, setJobId, setStatus, refresh }` |
| `useSettingsForm` | `src/workspace/settings/useSettingsForm.ts` | `SettingsPage` 的全部 state、载入、`save`（版本号 + 串行队列 + 失败回滚）、`savePath`、updater 三步、minimax key、device clocks、cache、self-check、logs | 见计划 Task 7a 接口 |

**行为对等由测试钉住**：旧组件（`ImportPage` / `ImportManagement` / `MissingMediaPanel` / `DeliverPage` / `SettingsPage`）改为调用这些 hooks 后，它们的既有测试**一行不改**必须仍绿（这是 hooks 抽得对不对的判据）；同时 hooks 各自有直接测试（`renderHook`），断言从旧测试里**复制**一份（不是搬走）。

## 6. 可访问性与冻结串

- 冻结 AX 名（R8 §7，一字不差）：按钮 `导入素材` `生成交付包` `设置` `切换集`；landmark `媒体池` `预览监视器` `镜头带` `检查器` `后台状态`；tablist `镜头带附属视图` + `故事 音乐 旅程 地点卡 模板`。
- 抽屉内冻结串（冒烟 / preview-shots 锚点）：导入抽屉标题 `导入素材` + 分页 `来源 任务 缺失素材` + `松开即导入`（平时不在树里）；交付抽屉 `本次交付平台` `联系表`；设置 sheet `隐私与诊断` `云端补镜`；集切换 `重命名本集` `目标平台`。
- `EmptyState` 的标题用 `<p>` 不用 heading（栏 landmark 已有名字）。
- `Toggle` 是 `role="switch" aria-checked`；`Tabs` 是 `role="tablist"/"tab" aria-selected`；`Drawer`/`Sheet` 是 `role="dialog" aria-modal aria-label`。
- `eslint-plugin-jsx-a11y` 零告警。

## 7. 测试与门禁

- 每个套件组件一份 vitest（渲染 + variant class + AX 角色 + 禁用态）；`tokens.css` 一份扫描测试；`fileNameLines` / `bandMinHeight` / `visibleInspectorSections` 等纯函数各一份。
- 既有断言**迁移不删除**：`PoolCard` 的 `splitFileName` 用例 → `fileNameLines`；`Inspector.test` 的「默认层四段顺序固定」→ 「有内容时四段顺序固定；空段不渲染」；`ImportDrawer.test` / `DeliverDrawer.test` / `SettingsSheet.test` 全部保留并加原生内容断言；`ImportManagement.test` / `MissingMediaPanel.test` / `DeliverPage.test` / `SettingsPage.test` / `ImportPageRuntime.test` 不改。
- 每个任务收尾必跑 `npm run preview:shots`，实施者**用 Read 工具看 PNG**，在任务报告里列出「仍存在的缺陷」；控制端合并前看图。
- `node scripts/qa/fast-gates.mjs` → `gate.json.status === "PASS"`；`npm run build && node scripts/qa/check-chunks.mjs`（每 chunk < 500 kB；`drawers` / `settings` 只以动态 import 出现；新增 `ui-kit` 组）。
- 文件 < 400 行。

## 8. 分解（8 个任务，可构建顺序）

1. 令牌 + 套件 + 图标 + 套件预览（其余全部依赖它；独占车道）。
2. 主屏 chrome：顶栏、栏标题条、分隔条、状态条、空状态。
3. 媒体池 + 监视器。
4. 镜头带 + 检查器。
5. 导入抽屉原生（hooks 抽取 + 三分页）。
6. 交付抽屉原生。
7. 设置 sheet 原生。
8. 收口：冒烟 AX 核对、文档、报告、`workspace.css` 死规则清理、版本保持 0.3.0。

并行：1 先行；2/3/4 依赖 1，两两可并行（各改不同文件，`workspace.css` 各自分节）；5/6/7 依赖 1，互相独立可并行；8 最后。

## 9. 风险

- **套件先行但没有消费者时容易设计过头**：Task 1 只做上表列出的 API，不加没人用的 prop；Task 2–7 需要新 prop 时回到 `ui/` 加并补测试，不许在消费者里 override 样式。
- **`SettingsPage` 1636 行的 hook 抽取**是本轮最大的一块：`save` 的版本号 / 串行队列 / 失败回滚 / `applyAppearanceSettings` 副作用要一次抽干净；判据是 `SettingsPage.test` 一行不改仍绿。
- **`workspace.css` 分节合并冲突**（R8 出过六处括号被冲掉的事故）：每个任务只碰自己的分节；Task 8 跑 `axNames.test` 的括号配平用例。
- **mpv 井的矩形**变了（16:9 letterbox），真机 `playerSetViewport` 要重新核一次；假后端截不到画面，Task 3 报告要写明。
- **两个同名按钮「导入素材」**（顶栏 + 空池空状态）只在空池时并存；`WorkspaceShell.test` 与冒烟按「顶栏第一个」取。
- 深色主题只保证令牌层可用，不走查；业主若切深色看到问题属 R11。

## 10. 发布
- 版本**保持 0.3.0**（本轮是 0.3.0 发布前的成品化，不另起版本）。
- `docs/qa/2026-09-12-unattended-r9.md` 六节报告 + `.superpowers/sdd/r9-visual-audit/` 留全部 PNG。
```

---

## 11. 视觉基准（控制端 2026-09-12 拍板）

三条设计探索样稿在 `.superpowers/sdd/r9-design-explore/{A-editing-desk,B-editorial,C-tool}/workspace.png`（含 `deliver-drawer.png` 与可再渲染的 HTML）。**以 A「编辑台密度」为基准**：面板 32 px 铬条 + 6 px 带握把分隔条、三列密集素材池（文件名按 `_` 断行不省略）、按章节的镜头带（章节行带序号/时长/镜数/缺口警示，瓦片带槽位标签与 Take/AI 徽章，缺口虚线瓦片自带「生成候选」）、检查器带图标的卡片与折叠行、监视器 I/O 轨道。**融入 C**：单一分组传输条（含 tabular 时码与入/出/保存/全屏）、`kbd` 芯片作为全局引导（/ F X 1–5 0 [ ] ⌘K ?）、检查器头部缩略图 + 上一条/下一条、镜头带「按章节 / 按时间 / 仅缺口」切换。**融入 B**：监视器作为全屏唯一的深色锚点（深阴影）、抽屉表单语法（分段平台选择、带说明的开关、一行摘要 + 一个主按钮、进度卡、静默的内容清单）。**不采用**：B 的两列素材池（500 条太稀）、C 自创的检查器分区（字幕与旁白/地点与时间/使用记录/备注）。Task 1 的令牌与套件以 A 的 HTML 里的实际数值为起点抽取（颜色、字号、间距、圆角、阴影）。
