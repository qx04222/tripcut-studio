# 导演台工作区 —— 单屏三栏界面重做 · 设计规格（2026-09-11）

业主批准于 2026-09-11。本文是 R8 轮的唯一依据；执行计划另出。R8 **只改前端**，Rust 核心零改动。

## 0. 起点与目标

- 起点：`main` 已完成 R0–R7。前端约 17k 行，四页 hash 路由（`#/import` `#/review` `#/deliver` `#/settings`，`src/App.tsx:16-30`），左侧常驻侧栏（品牌 + `SidebarSearch` + `LibraryPanel` + `EpisodePanel` + 四步导航 `01 导入 INGEST` … `04 设置 SETTINGS`）。筛片页内部再分两个视图模式「胶片墙 SELECT / 故事板 ROUGH CUT」（`src/SelectPage.tsx:2013-2040`），故事板里又套「音乐与节奏 / 旅程时间线」标签。最重的三个文件：`SelectPage.tsx` 2451 行、`SettingsPage.tsx` 1628 行、`Storyboard.tsx` 1604 行。
- 目标：**每条 Vlog 少几次点击**。把"四页 + 页内两模式 + 模式内标签"这套三层导航压成**一屏三栏**：素材、监视器 + 镜头带、检查器。参照新开源的 MiniMax H3 Director 那类导演台布局（Premiere 式工位），但**不做逐帧 NLE**——精剪仍然在剪映里完成，本工具只负责"选哪条、排什么顺序、缺什么补什么"。
- 明确不做：
  - **不做逐帧修剪**。现有 I/O 打点 + `select_segments` 的粗剪粒度不变，不加帧步进、不加吸附、不加波纹编辑。
  - **不做多轨音频**。音乐带只显示节拍/段落刻度作为**建议**，不能拖、不混音、不导出音轨。
  - **不重写 Rust 核心**。`src-tauri` 本轮零改动；`src/api.ts` 的签名一行不动。
  - **不动数据库 schema**。不加迁移，不加表，不加列。新 UI 全部由既有命令 + `settings` 键支撑。
  - 不做多窗口、不做可自由浮动的面板系统（三栏固定，只能拖分隔条）。

## 1. 信息架构

```
┌─ 顶栏 ────────────────────────────────────────────────────────────────┐
│ 旅剪  [导入素材]   〈集切换 ▾ EP01 通用 · 同时〉   [生成交付包] [设置⚙] │
├──────────────┬──────────────────────────────────┬─────────────────────┤
│  媒体池       │          预览监视器               │   检查器             │
│  (左栏)       │  ┌────────────────────────────┐  │  评级与收藏          │
│  搜索框       │  │        mpv 画面             │  │  标签                │
│  筛选条       │  └────────────────────────────┘  │  所属章节/槽位        │
│  网格         │  传输控件 / 时间码 / I·O 打点     │  同镜头 Take 切换     │
│  (虚拟化)     ├──────────────────────────────────┤  ───────────────     │
│               │ 〈故事·音乐·旅程·地点卡·模板〉   │  ▸ 技术检查          │
│               │  ══ 镜头带（按章节分组） ══      │  ▸ 八维评分          │
│               │  [附属带：随分段控件切换]         │  ▸ AI 描述           │
│               │                                  │  ▸ 音轨与 LUT        │
│               │                                  │  ▸ 相似镜头          │
├──────────────┴──────────────────────────────────┴─────────────────────┤
│ 状态条：分析 12/500 · 转写 3 · 生成 1 排队 · 缺失素材 2          [详情] │
└───────────────────────────────────────────────────────────────────────┘
```

- **顶栏**（高 44px）：左起品牌字标、按钮「导入素材」；居中集切换 popover；右侧「生成交付包」「设置」。没有四步导航，没有英文 kicker。
- **三栏**：左媒体池、中监视器 + 镜头带（上下再分）、右检查器。
- **抽屉**：「导入素材」从左侧滑入（宽 min(720, 60vw)），「生成交付包」从右侧滑入。抽屉是模态的（遮罩 + `useFocusTrap`），Esc 关闭，不改 hash。
- **Sheet**：设置从顶部下沉为居中 sheet（宽 960 高 80vh），⌘, 打开，保留其左侧分区导航。
- **状态条**（高 28px）：常驻底部，汇总后台任务；整条可点，点开「导入抽屉 → 任务」分页。

### 1.1 旧 → 新映射

| 旧组件 / 页面 | 新归宿 | 备注 |
|---|---|---|
| `SelectPage` 胶片墙网格（含 `FilmGrid` 虚拟化，`SelectPage.tsx:623`） | **媒体池**（左栏） | 网格列数随栏宽自适应（2–4 列） |
| `SelectPage` 的 `semantic-searchbar` + `selection-filterbar` + 八维筛选 | 媒体池顶部**搜索 + 筛选条**（筛选条折叠成一行 chips + 「更多筛选」popover） | |
| `SelectPage` 的 `SelectionInspector` | **检查器**（右栏） | 拆成默认层 + 折叠层，见 §4 |
| `PlayerOverlay`（沉浸态全屏播放器） | **监视器**（中上） | 从"覆盖层"变成"常驻区域"；`playerSetViewport` 改为传中上区矩形；仍保留 ⌘⏎ 全屏沉浸态作为**可选**放大 |
| `Storyboard` 的章节/镜头序列 | **镜头带**（中下） | 保留 `@dnd-kit` 拖排、`setStoryOrder`/`undoStoryChange` |
| `MusicPanel` | 附属带模式「音乐」 | 节拍/段落刻度对齐在带上方，切点仅作建议 |
| `JourneyTimeline` | 附属带模式「旅程」 | 只读 |
| 目的地卡编辑（`Storyboard` 内 `DestinationCard`） | 附属带模式「地点卡」 | |
| `listStoryTemplates` 模板卡（「电影感」等） | 附属带模式「模板」 | |
| `GenerationDialog` | 由镜头带空槽位的「生成候选」按钮唤起 | 对话框本身不改 |
| `AnalysisPanel`（`AnalysisBadges`） | 媒体池卡片角标 + 检查器「八维评分」折叠段 | |
| `TechCheckPanel` | 检查器「技术检查」折叠段 | |
| `SimilarGroupsPanel` | 检查器「相似镜头」折叠段 | |
| `ImportPage` + `ImportManagement` + `MissingMediaPanel` | **导入抽屉**（三个分页：来源 / 任务 / 缺失素材） | |
| `DeliverPage` | **交付抽屉** | |
| `SettingsPage` | **设置 sheet**，保留 `settingsSections.ts` 的九个分区与侧栏导航 | |
| `EpisodePanel` | 顶栏**集切换 popover**（当前集 + 列表 + 重命名/封存） | |
| `LibraryPanel` | 并入集切换 popover 底部一行（库路径 + 切换） | |
| `SidebarSearch`（全库搜索） | 媒体池搜索框（同一输入）+ ⌘K 命令面板搜索结果 | 删除独立侧栏搜索 |
| `CommandPalette` ⌘K | 不变，命令集改为面向新 IA（打开抽屉/切换附属带/跳章节） | |
| `FirstRunGuide` / `SetupWizard` / `RecoveryPage` / `HelpOverlay` / `ErrorBoundary` | 保留，改为覆盖在工作区之上；`RecoveryPage` 仍占满整窗 | |
| `App.tsx` hash 路由 | 保留但只剩 `#/` 一条工作区路由 + `#/recovery`；旧四条 hash **重定向**到工作区并打开对应抽屉 | 兼容外部链接与旧 e2e |

## 2. 布局与尺寸

- 最小窗口 **1280×800**。`src-tauri/tauri.conf.json` 当前 `minWidth: 720, minHeight: 760`，本轮改为 1280×800（只改配置，不算 Rust 代码改动）；CSS 侧仍保留 `min-width` 兜底。
- 栏宽：媒体池 min 260 / 默认 320 / max 480；检查器 min 280 / 默认 340 / max 520；中栏 min 520（不可被挤到更窄）。
- 监视器与镜头带上下分隔：监视器 min 高 240，镜头带 min 高 160（附属带展开时 min 260）。
- 分隔条用已在用的 `react-resizable-panels`（`Group`/`Panel`/`Separator`，`SelectPage.tsx` 已引入）。四个尺寸持久化到设置键（§5）。
- **收缩顺序**（窗口变窄时）：① 检查器折叠为 44px 竖条（图标 + 「展开检查器」按钮）；② 媒体池折叠为同样的竖条；③ 中栏永不折叠。⌘1 / ⌘2 分别切换媒体池 / 检查器折叠。
- 栏内滚动各自独立；整窗不出现纵向滚动条。

## 3. 交互细节

### 3.1 选择模型
一个共享的 `selection` 概念，三栏都读它：
```ts
type Selection =
  | { kind: "clip"; clipId: number }              // 媒体池选中 / 镜头带选中真实素材
  | { kind: "slot"; chapterId: number; slot: string }  // 镜头带空槽位
  | null;
```
- 媒体池点卡片 → `clip` 选中 → 监视器 `playerOpen` 该 clip → 检查器换成该 clip。
- 镜头带点分段 → 同上；若该分段是**空槽位** → 监视器显示占位（章节标题 + 缺口 `reason`），检查器显示缺口信息 + 「生成候选」。
- 媒体池与镜头带互相**回显**：选中的 clip 若在镜头带里存在，对应分段高亮并 `scrollIntoView({block:"nearest"})`；反之亦然。
- 多选：媒体池支持 ⇧ 连选 / ⌘ 点选用于批量评级与批量 AI 描述（沿用现有批量入口），但监视器与检查器只跟**锚点项**（最后一次点击）。

### 3.2 焦点与键盘

| 键 | 作用 | 生效范围 |
|---|---|---|
| `F` / `X` / `1`–`5` / `0` | 收藏 / 拒绝 / 星级 / 清除评级 | 媒体池或镜头带有焦点 |
| `Enter` | 替换首选（把当前 Take 提为 hero） | 同上 |
| `L` / `R` | 锁定 / 排除（`setShotStackUserState`） | 同上 |
| `Tab` | 展开/收起当前 Stack 的 Take 列表 | 同上（**不**移动焦点——保持与现状一致，见 §9 风险） |
| `↑ ↓` | 切换候选 Take | Stack 展开时 |
| `← →` | 媒体池内左右移动 / 镜头带内前后移动分段 | 按栏 |
| `空格` | 监视器播放/暂停 | 全局（输入框除外） |
| `I` / `O` / `S` | 打点入/出、保存片段 | 监视器有焦点 |
| `⌘K` | 命令面板 | 全局 |
| `⌘,` | 设置 sheet | 全局 |
| `⌘1` / `⌘2` | 折叠媒体池 / 检查器 | 全局 |
| `⌘⏎` | 监视器全屏沉浸 | 全局 |
| `?` | 帮助覆盖层 | 全局 |
| `Esc` | 关抽屉 / 关 sheet / 退出沉浸 / 清除搜索（按此优先级） | 全局 |
- 中文输入法组合期间单键评级暂停的既有保护（`composing` 状态 + 「中文输入法组合中」提示条）原样搬到新壳的状态条右侧。
- 三栏各是一个 `role="region"` + `aria-label`，`F6` 在三栏之间轮转焦点。

### 3.3 镜头带
- 按章节分组：每章一个带头（章节序号 + 标题 + 章节时长 + 缺口数），下面一排分段。
- 每个分段 = 一个 Shot：真实素材（缩略图 + 文件名 + 时长 + 评级点 + Take 数角标）或生成候选（同样但带「AI 生成」徽章）。
- **空槽位**：虚线描边 + 槽位中文名（建立镜头/氛围/转场/细节）+ `reason` 一行 + 「生成候选」按钮 → 打开 `GenerationDialog`，参数预填不变。白名单外的槽位不产生空槽位（R7 规则不变）。
- **拖排**：`@dnd-kit` 沿用现有 `story_order` 写入与 `undoStoryChange`；跨章节拖动即改章节归属（沿用现有语义）；拖动中显示插入线，松手后 toast「已调整顺序 · 撤销」。
- **Take 切换**：分段选中后按 `Tab` 展开该 Stack 的成员条（横向），`↑↓` 在成员间移动，`Enter` 把当前成员提为首选。生成片排序永远在真实素材之后（R7 §6 的排序规则不变）。

### 3.4 附属带分段控件
`〈故事 · 音乐 · 旅程 · 地点卡 · 模板〉`，`role="tablist"`，选中项持久化：
- **故事**：不展开附属区，镜头带独占中下区（默认）。
- **音乐**：镜头带**上方**插一条 36px 刻度轨，画节拍点与段落分界，建议切点用空心三角标注并注明「建议」。刻度与镜头带共用同一时间/序号轴。点击刻度只做定位，不改任何数据。
- **旅程**：镜头带下方展开只读 `JourneyTimeline`。
- **地点卡**：展开当前章节的目的地卡编辑（含 R6 的字段状态与校验）。
- **模板**：展开模板卡选择（「电影感」等四选一）。

### 3.5 监视器
- 复用 `PlayerOverlay` 的 mpv 通道（`playerOpen`/`playerCommand`/`playerStatus`/`playerSetViewport`），**不新开播放器实例**；区域尺寸变化（拖分隔条、折叠栏、附属带展开）后 debounce 120ms 调一次 `playerSetViewport`。
- 控件条：播放/暂停、-1s/+1s、速度、音量、时间码（`formatTimecode` 不变）、I/O 打点与「保存片段」、右端「全屏沉浸 ⌘⏎」。
- 空选中时显示中性占位（品牌底纹 + 一句「从左侧媒体池选一条素材」）。

### 3.6 状态条
- 内容（按存在性依次显示，全部为中文短语）：`分析 12/500` · `转写 3` · `云端生成 1 排队` · `缺失素材 2` · 右端库状态点「本地项目」。
- 全部为 0 时显示单行「后台空闲」。
- 整条 `role="status"`，点击 = 打开导入抽屉的「任务」分页；「缺失素材 n」单独可点 → 直接落到「缺失素材」分页。

## 4. 检查器分层

**默认层**（永远展开，顺序固定）：
1. 评级与收藏（星级 + 收藏/拒绝，按钮与快捷键同义）
2. 标签（现有标签 chips + 添加）
3. 所属章节 / 槽位（可改章节；显示槽位判定）
4. 同镜头 Take 切换（Stack 成员横向列表，含 AI 生成候选，生成片排在后面并带徽章）

**折叠层**（`<details>` 语义，默认全收起，开合状态逐段记忆）：`技术检查` · `八维评分` · `AI 描述` · `音轨与 LUT` · `相似镜头`。

- 每段标题右侧给一个极简状态字（例：技术检查 `2 项提示`、AI 描述 `未生成`），收起时也能判断要不要展开。
- 选中的是空槽位时，默认层换成：缺口原因、目标槽位、「生成候选」「忽略此缺口」，折叠层全部隐藏。

## 5. 状态与数据流

- 新增 `src/workspace/WorkspaceStore.ts`：一个 `useSyncExternalStore` 的轻量 store（**不引状态库依赖**），持有 `selection`、`paneSizes`、`paneCollapsed`、`bandMode`、`openDrawer`、`inspectorSections`、`filter`/`query`、`focusedPane`。所有栏读同一份。
- `src/api.ts` **一行不改**。
- **轮询合并**：新增 `useClipsFeed()`，全应用唯一一个 `getClipsRevision` 轮询（2s），revision 变化才 `listClips` + `listShotStacks` + `getStoryboard`，结果广播给三栏。现有分散在 `SelectPage.tsx:1173`、`ImportPage.tsx:528`、`useSearchAugment.ts` 里的三处 revision 轮询合并到这一处（`useSearchAugment` 改为消费 feed）。`MusicPanel`、`DeliverPage`、`EpisodePanel`、`SetupWizard` 的轮询各自与 clips 无关，保留原样但在抽屉/面板关闭时停表。
- `PlayerOverlay` 的 80ms `playerStatus` 轮询保留（它是播放位置，不能降频），但只在监视器可见且播放中时跑。
- **持久化 UI 偏好**（走既有 `setSetting(key, value)` / `getSettings`，无 schema 改动）：

| 键 | 默认 | 含义 |
|---|---|---|
| `ui.workspace_v2` | `true` | 新界面开关 |
| `ui.pane.pool_width` | `320` | 媒体池宽 |
| `ui.pane.inspector_width` | `340` | 检查器宽 |
| `ui.pane.monitor_height` | `0.55` | 中栏上下比 |
| `ui.pane.pool_collapsed` / `ui.pane.inspector_collapsed` | `false` | 折叠态 |
| `ui.band.mode` | `story` | 附属带分段 |
| `ui.inspector.sections_open` | `[]` | 展开的折叠段 id 列表（JSON） |
| `ui.pool.filter` / `ui.pool.dimension` | `all` / `""` | 媒体池筛选 |
- 写入 debounce 400ms，沿用 `SettingsPage.tsx:670` 的串行保存队列模式，避免拖分隔条时刷爆设置表。
- `localStorage` 只继续承载 `tripcut.wizard.done` 这类"本机便利"位，不承载栏尺寸（栏尺寸要跟随项目库）。

## 6. 视觉

- **不改调色板**：沿用当前浅暖色 token，light/dark/system 机制与「浅色为默认」不变（`SettingsPage` 外观分区照旧）。
- 密度：正文 13px / 行高 1.45；元信息 12px；栏标题 12px 加粗 + 字距 0.04em。控件高 28px（顶栏按钮 30px）。
- 强调色只有一个（现有绿），用于：选中边框、主按钮、分段控件当前项。评级星、警告、错误各自沿用既有语义色，不新增强调色。
- **主屏不出现英文 kicker / eyebrow**：删掉 `01 INGEST`、`SELECT`、`ROUGH CUT`、`CHINESE-CLIP · LOCAL`、`LIBRARY`、`TRIPCUT / LOCAL-FIRST` 这类装饰性英文。品牌字标 `TRIPCUT STUDIO` 只保留在设置 sheet 的「关于」分区。
- 标签一律中文；缩写仅保留技术必需者（LUT、AI、EP01、⌘K）。
- `styles.css` 8069 行：本轮**不重写**，新增 `src/styles/workspace.css` 承载新壳样式，旧页面样式随 R9 删旗时一并清理。

## 7. 可访问性

- 顶栏按钮 AX 名称（冒烟脚本的锚点，**一字不差**）：`导入素材`、`生成交付包`、`设置`；集切换按钮名 `切换集`（其可见文本含当前集标题，AX 名用固定串以免随数据漂移）。
- 栏 landmark：`role="region" aria-label` 分别为 `媒体池`、`预览监视器`、`镜头带`、`检查器`、`后台状态`。
- 附属带分段控件：`role="tablist" aria-label="镜头带附属视图"`，五个 tab 名 `故事` `音乐` `旅程` `地点卡` `模板`。
- 镜头带分段：`aria-label="镜头 {n}：{file}"`（空槽位为 `aria-label="镜头 {n}：缺口 {槽位中文名}"`）。
- 媒体池卡片：`aria-label="{file} · {时长} · {评级}"`，网格 `role="grid"`，卡片 `role="gridcell"`。
- 检查器折叠段用原生 `<details>/<summary>`，`summary` 文本即段名。
- 抽屉 / sheet：`role="dialog" aria-modal="true"` + `useFocusTrap` + 关闭后焦点回到触发按钮。
- `eslint-plugin-jsx-a11y` 必须零告警（与现状一致）。

## 8. 迁移策略

- 特性开关 `ui.workspace_v2`，**默认 ON**。设置 → 外观分区加一行「界面」+ 按钮「切回旧界面」（写 `false` 后热切换，不需重启）。旧四页组件在开关关闭时仍可完整运行，保留**一个发行版**；R9 删旗并删除 `App.tsx` 旧壳、`SidebarSearch`、旧页面容器。
- 旧 hash（`#/import` 等）在新界面下重定向：`#/import` → 打开导入抽屉，`#/deliver` → 交付抽屉，`#/settings` → 设置 sheet，`#/review` → 工作区本体。
- **冒烟脚本改写**：`scripts/qa/smoke-gui.mjs` 的四步导航点击（`clickNav("01 导入 INGEST")` 等）全部作废，改为点顶栏三个按钮 + 直接在工作区断言。断言迁移表：

| 旧断言 id | 旧锚点 | 新断言 id | 新锚点 |
|---|---|---|---|
| `page.import.*` | `01 导入 INGEST` + kicker「素材入口」 | `drawer.import.*` | 点 `导入素材`，断言抽屉标题「导入素材」+ 三个分页名 |
| `page.select.*` | `02 筛片 SELECT` + kicker「故事选择」 | `workspace.panes.*` | 断言 `媒体池`/`预览监视器`/`镜头带`/`检查器` 四个 landmark 名同时在树里（一屏内，无需导航） |
| `page.deliver.*` | `03 交付 DELIVER` + kicker「成片出口」 | `drawer.deliver.*` | 点 `生成交付包`，断言抽屉内「本次交付平台」 |
| `page.settings.*` | `04 设置 SETTINGS` + kicker「工作台控制」 | `sheet.settings.*` | 点 `设置`，断言「隐私与诊断」 |
| `select.similar.content` | 需先 ↓ 选中再看「相似镜头」 | `inspector.similar.content` | 选中首条后展开折叠段「相似镜头」（`summary` 常驻，**不需展开即在树里**，硬断言升级） |
| `select.techcheck.content` | 同上 | `inspector.techcheck.content` | 同上，硬断言 |
| `select.storyboard.template`（WARN） | 点「故事板」tab 后找「电影感」 | `band.template.content`（**硬断言**） | 点分段 tab 「模板」→ 断言「电影感」；AX 路径由本轮自己定义，不再是未走查路径 |
| `select.storyboard.journey_timeline`（WARN） | 同上 | `band.journey.content`（硬断言） | 点 tab 「旅程」→「旅程时间线」 |
| `select.storyboard.music`（WARN） | 同上 | `band.music.content`（硬断言） | 点 tab 「音乐」→「音乐与节奏」 |
| `select.storyboard.gap_card`（WARN） | 「缺口」字样 | `band.gap.slot`（保持 WARN） | 依赖种子库有缺口，维持 WARN |
| `deliver.platform.content` | 交付页 | `drawer.deliver.platform` | 抽屉内，硬断言 |
| `deliver.contact.content` | 交付页「联系表」 | `drawer.deliver.contact` | 抽屉内，硬断言（接线未上时仍如实 FAIL） |
| `settings.privacy.content` | 设置页 | `sheet.settings.privacy` | sheet 内 |
| `settings.generation.content` | 「云端补镜」 | `sheet.settings.generation` | sheet 内 |
| `import.dropOverlay.hidden` | 「松开即导入」不可见 + kicker「素材入口」 | `drawer.import.dropOverlay.hidden` | 抽屉打开态下断言「松开即导入」不在树里 + 抽屉标题在 |
| `episode.renamePlatform.field`（WARN） | 侧栏 `CURRENT EPISODE` 抽屉 | `topbar.episode.rename`（**硬断言**） | 点固定 AX 名 `切换集` → popover → 「重命名本集」→「目标平台」 |
| `select.rate.f`（WARN） | 筛片页 ↓ + F | `pool.rate.f`（WARN 不变） | 媒体池获焦 ↓ + F，仍以 `ratings` 行数判定 |
| `db.integrity` / `db.clips` / `process.alive*` | — | 不变 | — |
- 新增断言：`statusbar.present`（断言 `后台状态` landmark 存在）、`workspace.single_screen`（断言旧导航名 `01 导入 INGEST` **不再**出现在 AX 树里 —— 这条是"旧壳确实下线"的负向证据）。
- 截图从"六页各一张"改为：01 工作区默认、02 导入抽屉、03 交付抽屉、04 设置 sheet、05 音乐附属带、06 检查器展开态。

## 9. 测试

- **vitest**：每个新单元一份测试，覆盖——`WorkspaceStore` 的选择/尺寸/折叠 reducer 与设置回写；`useClipsFeed` 的 revision 变化才重取、失败降级为全量取（迁移现有 `SelectPagePersistence.test.tsx` / `ImportPageRuntime.test.tsx` 里的同类断言）；`useSelection` 在媒体池↔镜头带间的回显；`useRatingHotkeys` 的 IME 保护与目标判定（沿用 `isFilmGridShortcutTarget` 语义）；`Inspector` 折叠段记忆；`ShotBand` 拖排回调与空槽位按钮；`StatusStrip` 文案与点击路由。
- 既有测试的处置：`SelectPage.test.tsx` / `SelectPagePersistence.test.tsx` 按上表拆到新组件测试，**断言内容逐条搬迁**，不允许净删断言；`Storyboard.test.tsx`、`MusicPanel.test.tsx`、`JourneyTimeline.test.tsx`、`TechCheckPanel.test.tsx`、`SimilarGroupsPanel.test.tsx`、`GenerationDialog.test.tsx`、`SettingsPage.test.tsx`、`DeliverPage.test.tsx` 组件本体不改则测试不改。`App.test.tsx` 增加"旗开/旗关渲染不同壳"两例。
- **a11y**：`npm run lint` 的 jsx-a11y 保持零告警。
- **chunk 预算**：每个 chunk < 500 kB。`vite.config.ts` 的 `codeSplitting.groups` 改为新分组：`workspace`（壳 + store）、`pool`、`monitor`、`band`（含 `@dnd-kit`）、`inspector`、`drawers`（导入 + 交付）、`settings`、`vendor-cmdk`。抽屉与设置 sheet 用 `React.lazy` 懒加载 —— 首屏只加载 workspace/pool/monitor/band/inspector。
- 六门禁其余项（typecheck、rust test、clippy 等）不受本轮影响。

## 10. 性能

- 媒体池 500 条：沿用现有行级虚拟化（`SelectPage.tsx:623` 的 `slice(startRow*columns, endRow*columns)`），搬进 `MediaPool` 并加 overscan 2 行；缩略图 `loading="lazy"` + `decoding="async"`。
- 监视器复用同一个 mpv 实例，切换素材走 `playerOpen`，**不销毁重建**；栏尺寸变化 debounce 后只发 `playerSetViewport`。
- 轮询总数：clips feed 1 个（2s）+ player status 1 个（80ms，仅播放时）+ 抽屉/面板内的既有轮询（仅在打开时）。相对现状净减少两个常驻 revision 轮询。
- 拖分隔条时用 CSS 变量驱动宽度，不触发三栏重渲染；松手才写设置。
- 镜头带分段数可能上千（500 素材 + 候选）：横向虚拟化同样必要，按章节分组懒渲染（视口外章节只渲染带头）。

## 11. 风险

**最大风险：`SelectPage.tsx` 2451 行里状态互相咬合**——搜索、筛选、评级、Stack 展开、选中、轮询、持久化、故事板切换共处一个组件，直接搬运必然带进隐性耦合。拆法如下，**每个文件 < 400 行**，且每拆一个先补测试再搬：

| 新文件 | 职责 | 大致行数 |
|---|---|---|
| `src/workspace/WorkspaceStore.ts` | 全局 UI 状态 + 设置回写 | ~220 |
| `src/workspace/useSelection.ts` | 选择模型、跨栏回显、多选锚点 | ~140 |
| `src/workspace/useClipsFeed.ts` | 唯一 revision 轮询 + 派发 | ~180 |
| `src/workspace/useRatingHotkeys.ts` | F/X/1–5/0/Enter/L/R + IME 保护 | ~200 |
| `src/workspace/TopBar.tsx` | 顶栏 + 集切换 popover | ~200 |
| `src/workspace/MediaPool.tsx` | 搜索 + 筛选 + 虚拟网格 | ~380 |
| `src/workspace/Monitor.tsx` | mpv 区域 + 传输控件 + 打点 | ~320 |
| `src/workspace/ShotBand.tsx` | 章节分组、拖排、Take、空槽位 | ~390 |
| `src/workspace/BandAccessory.tsx` | 五种附属带模式的容器 | ~120 |
| `src/workspace/Inspector.tsx` | 默认层 + 折叠段 | ~340 |
| `src/workspace/ImportDrawer.tsx` | 三分页壳（内容复用旧组件） | ~160 |
| `src/workspace/DeliverDrawer.tsx` | 壳（内容复用 `DeliverPage` 主体） | ~120 |
| `src/workspace/SettingsSheet.tsx` | 壳（内容复用 `SettingsPage` 主体） | ~120 |
| `src/workspace/StatusStrip.tsx` | 后台汇总 | ~140 |

其他风险：
- `PlayerOverlay` 从"全屏覆盖"改"嵌入区域"，mpv 子窗口的坐标/缩放在非全屏矩形下未实测；若 `playerSetViewport` 在小矩形下有偏移，退化方案是监视器区域保留占位图 + 点击进全屏沉浸态（功能不丢，体验打折）。**这是本轮最大的技术未知。**
- 镜头带横向虚拟化 + `@dnd-kit` 拖排同时存在：虚拟化会让拖动目标在视口外时消失。缓解：拖动期间关闭虚拟化（临时全渲染当前章节 + 相邻两章）。
- 设置表被当作 UI 偏好存储，写入频率上升；debounce + 串行队列必须真做，否则拖分隔条会刷出上百次写。
- 一屏信息密度上升，1280 宽下三栏都在最小值附近，实机手感需业主试用后微调（尺寸都是设置键，可调不改码）。
- **无需新增 Rust 命令**：已核对新界面所需数据全部有现成命令（`list_clips`、`get_clips_revision`、`list_shot_stacks`、`get_storyboard`、`list_story_gaps`、`list_generation_requests`、`set_story_order`、`undo_story_change`、`set_shot_stack_user_state`、`rate_clip`、`player_*`、`get_settings`/`set_setting`）。唯一的候选缺口是状态条要的"后台任务计数汇总"——当前靠 `ImportPage`/`Storyboard` 各自拉的列表推算。本轮先用既有列表在前端聚合；若实测发现聚合开销不可接受，R9 再补一个只读的 `get_job_summary`（本轮**不做**）。

## 12. 发布

- 本轮发布为 **0.3.0**（界面重做属破坏性交互变更，走 minor）。`package.json` / `tauri.conf.json` / `Cargo.toml` 版本三处同步。
- 0.2.1 的 DMG **只留本机给业主试用，不发布**、不打 tag、不进更新源；0.3.0 才是下一个公开版本。
- 发布说明第一句写清："界面改为单屏导演台；旧界面可在设置 → 外观 →「切回旧界面」临时恢复，下一版移除。"

## 13. 分解

按依赖顺序切成七个子项目，每个自带测试与可演示成果：

1. **工作区骨架**（`WorkspaceStore` + 顶栏 + 三栏 + 分隔条 + 状态条 + `ui.workspace_v2` 旗）。**最先做**，因为其余六项全部挂在这个壳和这份 store 上；本项完成时三栏里放占位块即可合并，旗默认关，风险最低。
2. **媒体池**。第二做，因为它提供 `selection` 的**产生端**——没有可选中的素材，监视器和检查器无从验证。它同时驱动 `useClipsFeed` 的首个真实消费者，把轮询合并这件事在一个栏里先验证掉。
3. **监视器 + 筛片操作**（mpv 嵌入、传输控件、`useRatingHotkeys`）。依赖 2 的选择产出；且 mpv 嵌入是最大技术未知，必须在做镜头带之前验掉——若退化方案生效，第 4 项的布局高度分配要跟着改。
4. **镜头带 + 附属带模式**。依赖 1 的中栏上下分割与 3 定下的高度，依赖 2 的 clips feed 拿 `getStoryboard`/`listShotStacks`。是本轮最大的一块（拖排 + 虚拟化 + Take + 空槽位），放在基础设施全部稳定之后。
5. **检查器分层**。依赖 2/4 两种选择类型（clip 与 slot）都已存在，否则空槽位分支无从实现；折叠段内容是既有组件搬运，工作量集中在分层与记忆。
6. **导入/交付抽屉 + 设置 sheet + 集切换**。依赖 1 的顶栏按钮与 `openDrawer` 状态；放在后面是因为内容全是既有页面主体的包装，风险最低，且设置 sheet 要能写全部 `ui.*` 键（这些键要等 1–5 全部定型）。本项完成即"旧四页全部有新家"，可以把旗默认打开。
7. **冒烟 / a11y / 文档 / 收尾 + 0.3.0**。依赖 1–6 的 AX 名称全部落地才能改写 `smoke-gui.mjs`；同时做 chunk 分组调整、`styles/workspace.css` 收口、README 与帮助内容更新、版本号与发布说明。

## 14. 局限

- 精剪仍在剪映：本工具给的是顺序与选择，时间线上任何帧级意图都传不过去（交付包语义不变）。
- 音乐带的切点只是建议，不写回任何数据；"按节拍排"的自动化留给后续轮次。
- 旧界面在 0.3.0 期间与新界面共存，两套样式同时打包，包体在这一个版本里偏大。
- 1280×800 是最小可用而非舒适尺寸；三栏在该尺寸下缩略图偏小，业主实机若不接受，可能要把媒体池改为可切"列表/网格"两种密度（本轮不做）。
