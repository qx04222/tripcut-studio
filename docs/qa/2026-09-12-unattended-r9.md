# 无人值守 R9——界面成品化（0.3.0 预览） — 2026-09-12

## 1. 目标与工作项

业主看过 R8/0.3.0-preview 后的判词：「需要特大优化才能使用」。控制端复核 R8 的
`design-pass` 截图，同意诊断：主屏有结构没层级（12–13px 灰字压米色底、监视器空井、
文件名中段省略、瓦片下方大片空白）；三个抽屉/sheet 是旧页面原样塞进 700px 容器
（英文 kicker、01/02/03 水印数字、按钮样式混杂）；没有设计过的空状态、看不见分隔条、
没有 hover/拖动态、没有图标语言。R9 是
`docs/superpowers/specs/2026-09-12-r9-ui-productization-design.md` 与
`docs/superpowers/plans/2026-09-12-r9-ui-productization.md` 的执行轮：先做一套设计
令牌 + 一个组件套件，让全部新壳界面（主屏四栏 + 三个模态）只从这一套取样式；三个模态
用套件原生重写（推翻 R8「抽屉包装旧页面」的决定），旧页面只剩逻辑供体（hooks）。
**只改前端**：`src-tauri` 零改动、`src/api.ts` 一行不改、数据库 schema 不动；版本保持
0.3.0（本轮是 0.3.0 发布前的成品化，不另起版本）。

`git log --oneline 7f1e855..627661b --first-parent`（新到旧，`7f1e855` 是 Task 1 令牌+
套件合并点，`627661b` 是本轮最后一次合并）：

| 任务 | 内容 | 合并提交 | 车道分支 |
|---|---|---|---|
| Task 8a | 六车道集成收口（附属面板套件皮、镜头带栏高接模型、技术检查重名标题、⌘I、`workspace.css` 死规则清理、冒烟锚点核对） | `627661b` | `feat/r9-polish`（6 commits：`941fb79..3ae5df9`） |
| Task 7 | 设置 sheet 原生化（九分区） | `3d45367` | `feat/r9-settings`（3 commits：`69d87ef..cb9454d`） |
| 修复 | `drawers` 分块正则合并时被吃掉一个反斜杠 | `73a3683` | 直接提交在 main |
| Task 5 | 导入抽屉原生化（来源/任务/缺失素材三分页） | `0b62636` | `feat/r9-import`（2 commits + 1 次复审追加 = `049b52f..1207147`） |
| Task 4 | 镜头带 + 检查器 | `6b1e4a8` | `feat/r9-bandinsp`（2 commits：`4500809..d698210`） |
| Task 6 | 交付抽屉原生化 | `294d97f` | `feat/r9-deliver`（2 commits：`627d48d..e3cdeb3`） |
| Task 3 | 媒体池卡片 + 预览监视器 | `7f7fbc5` | `feat/r9-poolmon`（2 commits：`cd970e3..3fc5003`） |
| Task 2 | 主屏 chrome（顶栏/栏标题条/分隔条/状态条/空状态） | `b6404a0` | `feat/r9-chrome`（3 commits：`08cd230..9be1ffe`） |
| 环境修复 | 剪映 11.4.13189 记入待人眼验证名单；eslint 忽略 `.superpowers/`/`qa/`；许可清单补 `playwright-core` | `413814b` | 直接提交在 main（Task 1 合并之前） |
| Task 1 | 令牌 + 套件 + 图标 + 套件预览 | `7f1e855` | `feat/r9-kit`（4 commits：`10bb15f..16d4e0c`） |

调度顺序：`1 →（2,3,4 并行 ∥ 5,6,7 并行）→ 8`，每个任务收尾都跑 `preview:shots`、
由控制端 Read 截图后再合并。8 个任务全部走完；本文档对应 brief 里的 Task 8 收口
（8a 已单独合并，8b/8c/8d 是本文档 + 同批文档提交覆盖的范围）。

迁移号：无（本轮没有新增 Rust 命令、没有新增表，schema 与 R8 相同）。

## 2. 快照与测量

- **单元/集成**：`npx vitest run` 全量 79 个文件 753 条绿 + 3 条 `todo`（Task 8a 末次，
  较 Task 1 合并点 574 绿 +179 条，主要来自六条车道各自的组件/hook 直测 + `axNames`
  的冻结串核对用例）。
- **`workspace.css` 行数**：R9 起点（规格 §0）2382 行 → 六条车道叠加后 2405 行 →
  Task 8a 死规则清理后 **1667 行**（删除 101 条整条规则 + 4 条多选择器规则里剪掉死的
  部分；判据是 `grep -rn "<class>" src/ --include=*.tsx` 在非测试源码里为空）。
- **CSS 产物体积**：`dist/assets/index-*.css`（死规则清理前后，Task 8a 提交
  `2664172` 一次性量出）：269849 → **257897 B**。
- **JS chunk**（当前构建，`node scripts/qa/check-chunks.mjs` PASS，17 个 chunk 全部
  < 500 kB 预算）：

  | chunk | 大小 |
  |---|---|
  | `esm-*.js`（React 本体） | 289.8 kB |
  | `index-*.js` | 195.5 kB |
  | `settings-*.js` | 98.2 kB |
  | `drawers-*.js` | 81.5 kB |
  | `band-*.js` | 75.4 kB |
  | `vendor-dnd-*.js` | 50.1 kB |
  | `vendor-cmdk-*.js` | 48.2 kB |
  | `select-legacy-*.js` | 43.1 kB |
  | `vendor-panels-*.js` | 32.4 kB |
  | `workspace-*.js` | 28.3 kB |
  | `monitor-*.js` | 26.0 kB |
  | `pool-*.js` | 24.3 kB |
  | `inspector-*.js` | 23.9 kB |
  | `LegacyShell-*.js` | 13.4 kB |
  | `app-core-*.js` | 17.0 kB |
  | `ui-kit-*.js` | 19.9 kB |
  | `rolldown-runtime-*.js` | 0.7 kB |

  `drawers` 与 `settings` 全程只以 dynamic import 出现（由 `workspace-*.js` 拉取），
  每条车道合并前都单独核过这一条；`ui-kit` 是 R9 新增的独立 chunk（10.8 kB → 现
  19.9 kB，六条车道消费套件后自然增长）。
- **`SettingsPage.tsx` 行数**：**1636 → 1636（未改）**——按派工规则，旧壳文件本轮
  不许碰，`useSettingsForm` 等 hooks 是从它**复制**出来的，不是搬走；`SettingsPage.test`
  一行不改仍绿是 hooks 抽得对不对的判据。R10 删旧壳时这份文件本体才会消失。
- **套件组件 / 测试数**：`src/workspace/ui/` 16 个组件文件（每个 < 200 行）+ 14 份
  `*.test.tsx`（`Drawer`/`Sheet`/`ModalSurface` 共用一套模态断言，`ModalSurface`
  不对外导出、无独立测试文件）。
- **图标数**：**34**（规格 §2 按对写「33 = 24+9」，`IconName` 联合类型实际列出
  25 个基础图标 + 9 个 `settings-*` 分区图标 = 34，`volume`/`volume-off` 算两个名字；
  `ICON_NAMES.length === 34` 由 `icons.test.tsx` 钉住）。
- **视觉基准截图**：每个任务收尾一组，落在
  `.superpowers/sdd/r9-visual-audit/task-{1,2,3,4,5,6,7,8a}/`；集成后最接近发布态的
  一组是 `task-8a/`（`00-boot` … `09-gap-slot` 十张 + `aria.yml` + 六张附属带临时探针
  `x-*`），已由控制端 Read 逐张核对（详见 §4 与各车道报告的「看图核对」小节）。
  本轮未额外生成 `r9-visual-audit/final/` 汇总目录——brief 8d 的这一步不在本次收口
  任务范围内，留给下一次要打包发布前再补一轮 `--kit` 全量截图。

## 3. 门禁记录

`ls qa/runs/ | grep "2026-09-12.*fast-gates"`，逐条读 `gate.json.status`（主仓，
六条车道合并期间）：

| 运行目录 | status | 备注 |
|---|---|---|
| `2026-09-12T14-41-02Z-fast-gates` | FAIL | `eslint` 红（`.superpowers/`/`qa/` 尚未加入忽略名单）+ `cargo-test`/`cargo-audit` 环境项 |
| `2026-09-12T14-46-15Z-fast-gates` | PASS | `413814b`（eslint 忽略名单 + 剪映白名单记录）之后 |
| `2026-09-12T15-03-30Z-fast-gates` | PASS | |
| `2026-09-12T15-14-52Z-fast-gates` | PASS | |
| `2026-09-12T15-18-21Z-fast-gates` | PASS | `check-chunks.mjs` 三项 PASS：chunk 预算、`drawers`/`settings` 均只 dynamic import |
| `2026-09-12T16-05-59Z-fast-gates` | FAIL | 只剩 `cargo-test`/`cargo-audit` 两项环境失败，前端六项全绿 |

两条**已知环境项**（不是本轮引入、每条车道报告都记了同一因）：

1. **`cargo-test` 的 `jianying_canary_against_live_environment` 子用例**：本机剪映专业版
   版本 11.4.13189 不在门禁白名单里，`413814b` 已把它记入「待人眼验证」名单（不是放行，
   是承认门禁看不到这台机器上的真实剪映，需要人验证一次）。
2. **`cargo-audit`**：advisory-db 拉不到（网络环境），与代码无关。

`eslint` 那一次红是本轮唯一的真实回归：`.superpowers/sdd/` 与 `qa/runs/` 目录下的
Markdown/JSON 产物被 ESLint 当成源码扫描，`413814b` 把这两个目录加入忽略名单后
再没红过。

各车道自己的门禁（`typecheck`/`lint`/`vitest`/`build`+`check-chunks`）在合并前
逐条跑过，八份报告（`.superpowers/sdd/r9/task-{1..8a}-report.md`）里全部是 PASS，
唯二的例外是两次「全量跑里单个用例红、单独重跑与再跑全量都绿」的记录
（`CommandPalette.test` 与 `vitest run src/workspace src/SettingsPage.test.tsx`），
两处都判定为负载下的时序 flake，不是回归——这与 R8 报告 F-R8-INFRA 系列的态度一致：
不确定就如实记录，不隐藏，也不因为「重跑会绿」就当没发生过。

## 4. FINDINGS（按控制端 R8→R9 的三条诊断 (a)(b)(c) 对照）

### (a) 主屏「有结构没层级」—— 已解决

- 12–13px 灰字压米色底 → 顶栏/栏标题条/状态条换成 `--surface-panel`/`--surface-chrome`
  分层 + 发丝线 + `--shadow-card`，顶栏从米色壳底上抬起来（Task 2）。
- 监视器空井 → 16:9 深色 letterbox 井（`--well-bg`，全站唯一允许的深色）+ 内阴影，
  文件名 chip 深底白字（Task 3）。
- 文件名中段省略 → `fileNameLines` 按 `_` 就近断行，两段不省略，超出三行直接裁（不加
  省略号）；320px 三列宽、25 字以上文件名的第四行会被裁掉，**仍存在**，交业主看
  `task-3/crop-pool.png` 拍板（候选：四行 / 10px 等宽 / 允许尾部省略）。
- 瓦片下方大片空白 → 镜头带视口高改按内容定（`bandMinHeight`/`bandPanelMinHeight`），
  Task 8a 把 `WorkspaceShell` 接上模型后空白消失；**附属模式下默认高度仍偏矮**
  （1440×900 下约 100–130px，见下方「仍存在」）。

### (b) 三个模态「是旧页面塞进 700px 容器」—— 已解决

- 三个模态全部原生重写：`ImportDrawer`（Tabs 三分页）、`DeliverDrawer`（单表单 + 一行
  汇总 + 一个主按钮）、`SettingsSheet`（九分区左轨）。英文 kicker、01/02/03 水印数字
  全部消失（`axNames.test` 与每车道的 `SettingsSheet.test`/`DeliverDrawer.test` 各有
  一条「no English kicker / watermark」断言钉住）。
- 旧逻辑（api 调用、轮询、错误处理、`tripcut:*` 事件）全部搬进 hooks
  （`useImportSources`/`useImportJobs`/`useMissingMedia`/`useDeliverForm`/
  `useExportProgress`/`useSettingsForm`），旧组件（`ImportPage`/`ImportManagement`/
  `MissingMediaPanel`/`DeliverPage`/`SettingsPage`）**一行未改**、旧测试全绿，
  是 hooks 抽取对不对的唯一判据。

### (c) 「没有设计过的空状态、分隔条不可见、没有 hover/拖动态、没有图标语言」—— 已解决

- 四栏空状态换成 `EmptyState`（图标 + 标题 + 说明 + 动作，Task 2）；分隔条 6px 可见
  抓手，hover/拖动/键盘焦点变强调色；卡片 hover 上浮 1px + 边变 strong、选中双圈强调
  环；34 个图标统一线性风格（1.5px 描边、16px 视窗）。

### 逐张截图（`task-8a/`）核对

| 截图 | 已解决 | 仍存在 |
|---|---|---|
| `00-boot` | 首启浮层文案未动 | — |
| `01-workspace` / `02-selected` | 顶栏/栏标题条/分隔条/状态条分层；卡片 hover/选中态；井深色 letterbox | 附属带默认高度偏矮（见下） |
| `03-band-music` | 音乐刻度轨对齐 `BAND_SEGMENT_PITCH`；「音乐与节奏」无英文 kicker | 音乐面板 DOM 仍是旧组件本体（只换皮），R10 删旧壳时收 |
| `04-inspector-open` | 折叠段图标 + chevron 旋转；技术检查重名标题已修（`hideTitle`） | 折叠段 Card 圆角 6 与默认层 Card 圆角 10 不一致（A 稿两者都是 6） |
| `05-import-drawer` | 三分页 Tabs、关注文件夹卡、拖放区卡、「最近导入」卡 | 来源分页最下方仍有约 30% 留白（没有更多真实内容可放，未加装饰） |
| `06-deliver-drawer` | 单表单 + 一行汇总 + 主按钮，折叠说明段 | 进度卡/结果卡/剪映结果卡只有 jsdom 断言，没有截图（假后端的 `pick_export_folder` 走不到进行中态） |
| `07-settings-sheet` | 九分区左轨、无英文 kicker、危险动作靠底 | 左轨中段留白（约 180px，danger 靠底是设计结果）；许可清单 57 行要滚三屏 |
| `08-narrow-1280` | 窄窗下检查器折叠，顶栏/状态条不挤 | — |
| `09-gap-slot` | 空槽位虚线卡 + 「生成候选」/「忽略」 | — |

### 真机 / 环境实测项（brief 8d 要求必记的三条）

- **mpv 井 16:9 的真机 `playerSetViewport` 对齐**：**待实机**。假后端下
  `.player-native-slot` 是透明节点，`preview-shots` 截不到画面；嵌入态代码路径本身
  没改（viewport 仍取 `surfaceRef` 的 `getBoundingClientRect`，该节点在
  `.monitor-well--video` 内 `inset: 0`），井的圆角会裁 mpv 四角——这与 R8 报告
  F-R8-2 提到的「Task 3 mpv 嵌入 viewport 对齐要重新核一次」是同一个待办，R9 没有
  新增像素证据，仍然是环境权限问题（驱动进程缺少 macOS「屏幕录制」权限）。
- **「暂停 / 继续」导入队列**：**明确不做，已记档**。`api.ts` 只有
  `cancel_import_batch` 与关注文件夹的 `set_watched_folder_sync`，没有队列暂停命令；
  任务卡上的控制就是「停止本批」，关注文件夹的「自动同步」开关即事实上的
  「暂停/继续同步」。若业主坚持要真正的暂停/继续，需要新增 Rust 命令
  `pause_import_queue`（规格与计划都写明本轮不做）。
- **空池「导入素材」双按钮的取舍**：**保留两处，只在空池并存**。顶栏常驻一个
  「导入素材」，媒体池为空时额外渲染 `EmptyState` 的「导入素材」按钮，二者 AX 名
  相同但只在空池时两个都在树里（`WorkspaceShell.test` 与冒烟脚本按「顶栏第一个」
  取，不歧义）；非空池只有顶栏那一个。这是规格 §3.4 明确允许的例外，不是缺陷。

## 5. 被 revert 或冻结的项

无 revert。冻结/记档的项（都不是代码能替代的，或明确超出本轮范围）：

1. **附属带默认高度偏矮**（Task 8a 报告）：1440×900 下约 100–130px（`bandMinHeight`
   的附属档 284 = 视口 184 + 附属 100），音乐分析的图例与说明要在右栏里滚一下才全见。
   要更宽松需要改 `shotBandModel.BAND_ACCESSORY_MIN_HEIGHT`（会连带一条现有测试），
   或让用户拖分隔条——记决策项，交业主。
2. **「运行中 / 已完成」交付状态只有 jsdom 覆盖**（§4）：假后端截不到进行中/完成态的
   截图，真实视觉未经控制端过目；不影响逻辑正确性（hooks 从旧 `DeliverPage` 逐字复制），
   但发布前建议给 `devMock/fixture.ts` 加一条「立即完成」的导出路径手动核一次。
3. **真机 `playerSetViewport` 对齐**：待业主在真机 + 授权屏幕录制权限后确认（同 R8）。
4. **剪映 11.4.13189 人眼核对**：门禁已把它记入白名单待验名单，需要业主或有剪映环境的人
   实际打开一次剪映确认版本号识别正常。
5. **MiniMax 真实 e2e**：本轮 `useSettingsForm`/`useGenerationSettings` 的相关断言全部是
   mock 层面的（key 永不回显、预算夹紧），没有打过真实 MiniMax 请求。
6. **Screen Recording TCC 权限**：驱动进程缺少「屏幕录制」权限，六张真机截图（R8 起）与
   本轮的 mpv 对齐验证一直 SKIP，需要业主在系统设置里手动授权。
7. **16 GB 内存机器验收**：本轮的性能/内存测量沿用既有基线，未针对 R9 的新增
   `ui-kit`/`settings`/`drawers` chunk 重新做一轮低配机验收。
8. **构建产物体积干净重测**：本轮 CSS/JS 体积数字（§2）来自开发过程中多次增量构建后的
   `dist/`，建议下一轮发布前 `rm -rf dist && npm run build` 干净重测一次，排除增量构建
   残留的干扰。

## 6. 下一轮入口 —— R10

见 `docs/superpowers/plans/2026-09-12-r9-ui-productization.md` 末尾「R10 入口」一节
（本文档同批提交已把「业主对 0.3.0 预览签字之后才做」这条前提写明）：

1. **删旗 + 删旧壳**：删 `ui.workspace_v2` 旗；删 `LegacyShell`/`SidebarSearch`/
   `SelectPage` 容器/`ImportPage`/`DeliverPage`/`SettingsPage` 本体（`useImport*`/
   `useDeliverForm`/`useExportProgress`/`useSettingsForm`/`*Model.ts` 是新壳在用的
   hooks/纯函数，不能连它们一起删）；清 `styles.css` 里的旧页面规则；冒烟
   `workspace.single_screen` 从「旧导航名不在树里」改为断言构建产物没有
   `LegacyShell-*.js`。
2. **深色主题走查**：R9 只在令牌层保证深色可用，没有走查；R10 用
   `preview-shots --dark`（`html[data-theme="dark"]`）截一轮给控制端过目。
3. **「暂停 / 继续」导入队列**：若业主坚持要，需要新增 Rust 命令
   `pause_import_queue`（R9 明确不做）。
4. 顺带处理 §5 里的开放项（附属带默认高度、mpv 对齐、剪映人眼核对）。

**待业主（不是代码能替代的）：**

1. 看 `.superpowers/sdd/r9-visual-audit/task-8a/` 与各任务目录的截图，尤其
   `crop-pool.png`（文件名裁切）与 `03-band-music.png`（附属带高度），拍板 §4/§5 里
   列出的几个取舍。
2. 给 QA 驱动进程授「屏幕录制」权限，mpv 对齐与真机截图才能第一次有像素证据。
3. 剪映专业版 11.4.13189 的实机人眼核对（是否被正确识别为受支持版本）。
4. 明确 R10 的启动时机——是否已经看过 0.3.0 预览、是否同意删旧壳。

**发布边界**：本轮版本保持 0.3.0，未打 tag、未发布，仍是预览/未发布状态（QA 候选
不发布、不进更新源）。
