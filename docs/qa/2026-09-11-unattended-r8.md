# 无人值守 R8——单屏导演台工作区（0.3.0） — 2026-09-11

## 1. 目标与工作项

本轮（R8）是 `docs/superpowers/specs/2026-09-11-r8-director-workspace-design.md` 与
`docs/superpowers/plans/2026-09-11-r8-director-workspace.md` 的执行轮：把「左侧四步导航 +
四个页面」重做成一屏三栏的导演台（媒体池 / 预览监视器 + 镜头带 / 检查器），导入与交付改抽屉、
设置改 sheet、集切换改顶栏 popover；旧壳保留一个发行版，由 `ui.workspace_v2` 旗控制。版本
0.3.0。

`git log --oneline --merges` 命中的本轮合并提交（新到旧；Task 8 在 `feat/r8-closeout` 上，
未合并、未推送）：

| 任务 | 内容 | 合并提交 |
|---|---|---|
| Task 7 | 全局键盘 / 焦点 / a11y / 视觉收口（`feat/r8-polish`） | `386135d` |
| Task 4 | 镜头带与附属带（`feat/r8-band`） | `352a921` |
| 修复 | 媒体池 AX 树补 `role=row`（`fix/r8-pool-empty`） | `45440ca` |
| Task 5 | 检查器分层（`feat/r8-inspector`） | `91d5b6b` |
| Task 6 | 导入 / 交付抽屉、设置 sheet、集切换、旗默认开（`feat/r8-drawers`） | `d53aabf` |
| Task 2 | 媒体池——单一轮询、按集过滤、漫游焦点（`feat/r8-pool`） | `f2b9002` |
| Task 3 | 预览监视器与单键评级（`feat/r8-monitor`） | `c25d439` |
| Task 1 | 工作区骨架——store / 顶栏 / 三栏 / 状态条 / 旗（`feat/r8-shell`） | `45efbea` |
| 合并后 | 去重 api mock 重复键 | `850b257` |

Task 8（本文档所在分支 `feat/r8-closeout`，基于 `850b257`）的提交：

| 提交 | 内容 |
|---|---|
| `c5cb496` | fix(pool)：行不再用 `display:contents`（真机疑点 b 的第一刀，见 §4 F-R8-3） |
| `1958eb3` | refactor(workspace)：**修复 workspace.css 六处未闭合规则**、分节重排；`testApiMock.ts`；拆 Inspector/ShotBand |
| `d6e8e06` | build(vite)：八组 chunk 分组 + `scripts/qa/check-chunks.mjs` |
| `bea7e46` | test(qa)：`smoke-gui.mjs` 改写为单屏工作区 |
| `b993875` | fix(drawer)：抽屉与 sheet 补可见「关闭」按钮与可点遮罩 |
| `ede9723` | docs(r8)：三份手册 + 帮助浮层改写 |
| `fdffd36` | release(0.3.0)：版本号四处同步 |
| `ba0a50e` | test(qa)：landmark 断言改按精确 AX 名判（校准跑抓出的空断言，F-R8-INFRA-4） |
| （本文档） | release(0.3.0)：发布说明、QA 报告、R9 入口 |

迁移号：无（本轮没有新增 Rust 命令、没有新增表；schema 与 0.2.1 相同）。

## 2. 快照与测量

- 单元 / 集成：`npx vitest run` **49 个文件 498 条全绿**（Task 8 新增：MediaPool 行结构 1、
  axNames 3（嵌套 tablist、CSS 花括号配平、重复选择器）、DeliverDrawer 3（Esc、关闭按钮、遮罩）、
  HelpOverlay 改 1）。
- 构建：`npm run build` 193 模块；`node scripts/qa/check-chunks.mjs` → 16 个 chunk 全部
  < 500 kB（最大 `esm-*.js` 289.8 kB，React 本体）；`drawers` / `settings` 只以 dynamic import
  出现（由 `workspace-*.js` 拉取）。八个规格 §9 分组的实际尺寸：pool 22.8 / monitor 23.5 /
  inspector 19.5 / band 70.2 / workspace 25.8 / drawers 53.0 / settings 58.7 / select-legacy 44.1 kB。
- 文件行数上限（规格 §11 的 < 400）：`Inspector.tsx` 414 → 273（`InspectorSections.tsx` 156），
  `ShotBand.tsx` 442 → 392（`BandChapters.tsx` 118）。
- **真机冒烟**（最终一次：`qa/runs/20260911T-r8-closeout-3-smoke/gate.json`，QA 候选
  `旅剪工作台_0.3.0_r8-closeout`，种子库 500 条）：**PASS**，43 条断言——33 PASS / 4 WARN /
  6 SKIP / 0 FAIL。之前一次（`…-closeout-2-smoke`，landmark 断言还是字符串包含）同样 PASS，
  中间的校准跑（`…-calib2-smoke`，故意改坏 `镜头带` 的 AX 名）如期 **FAIL 5 条**。逐条如下：

| 断言 | 结果 | detail |
|---|---|---|
| process.alive | PASS | pgrep |
| onboarding.dismiss.first-run-guide | WARN | gave up after 8 attempts（第一次运行时是 PASS；本次浮层未出现，见下） |
| onboarding.dismiss.setup-wizard | WARN | gave up after 8 attempts |
| onboarding.cleared | PASS | 两层首启浮层均已关闭 |
| workspace.panes.媒体池 / 预览监视器 / 镜头带 / 检查器 | PASS ×4 | landmark 在树里 |
| statusbar.present | PASS | 后台状态 landmark |
| workspace.single_screen | PASS | 旧导航名 `01 导入 INGEST` 不在树里；镜头带 landmark 仍在 |
| topbar.buttons.present | PASS | 四个按钮 AX 角色全部是 **pop up button** |
| shot.workspace-default | SKIP | screen recording permission missing |
| band.template.content | PASS | tab 点中=true 电影感=true |
| band.journey.content | PASS | 旅程时间线=true |
| band.music.content | PASS | 音乐与节奏=true |
| shot.band-music | SKIP | screen recording permission missing |
| band.gap.slot | WARN | 缺口=false（种子库没有缺口，数据条件） |
| topbar.episode.rename | PASS | 切换集点中=true 重命名本集=true 目标平台=true |
| drawer.import.open | PASS | 点中=true |
| drawer.import.tab.来源 / 任务 / 缺失素材 | PASS ×3 | |
| drawer.import.dropOverlay.hidden | PASS | 松开即导入 不在树里；抽屉标题在 |
| shot.drawer-import | SKIP | screen recording permission missing |
| modal.import.close | PASS | 关闭按钮点中=true 回到工作区=true |
| drawer.deliver.open | PASS | |
| drawer.deliver.platform | PASS | 本次交付平台 |
| drawer.deliver.contact | PASS | 联系表 |
| shot.drawer-deliver | SKIP | screen recording permission missing |
| modal.deliver.close | PASS | |
| sheet.settings.open | PASS | |
| sheet.settings.privacy | PASS | 隐私与诊断 |
| sheet.settings.generation | PASS | 云端补镜 |
| shot.sheet-settings | SKIP | screen recording permission missing |
| modal.settings.close | PASS | |
| pool.select.first | PASS | 文件名=perf_0000.mp4 |
| inspector.similar.content | PASS | 相似镜头 |
| inspector.techcheck.content | PASS | 技术检查 |
| shot.inspector-expanded | SKIP | screen recording permission missing |
| pool.rate.f | WARN | 0->0（按 F 没写进 ratings；与 R7 之前同一形态的 WARN） |
| db.integrity | PASS | ok |
| db.clips | PASS | 500 |
| process.alive.end | PASS | |

同一脚本的**第一次**真机运行（`qa/runs/20260911T-r8-closeout-smoke/`，改动前的候选）是
**FAIL**：`sheet.settings.open/privacy/generation`、`pool.select.first`、
`inspector.similar/techcheck.content` 六条 FAIL——前三条是 F-R8-2（抽屉 Esc 关不掉），
后三条是探针自己的错（F-R8-INFRA-2）。两次运行的差异就是 `b993875` 那一个提交。

**规格 §13 要求本文档必须记录的四条实测**（如实：三条没量到）：

- **Task 3 mpv 嵌入 viewport 对齐**：**没有像素证据**。三轮真机检查（`r8-monitor-realcheck-report.md`、
  `r8-realcheck3-report.md`、本轮）截图全部 SKIP——驱动进程没有 macOS「屏幕录制」权限，
  `CGWindowListCopyWindowInfo` 返回空；全屏截图兜底已被证实不安全（拍到的是别的 app 的窗口，
  一次是业主的邮箱）。AX 层面能确认的只有：点媒体池卡片后监视器空态文案消失、出现文件名
  与「暂停」标签（realcheck3 §5），即"载入并开播"这条链路通了；画面有没有画在栏的矩形里、
  有没有偏移，**没看到**。走的是规格 §11 的主路径（嵌入 + `playerSetViewport`），退化方案未启用。
- **1280×800 三栏密度手感**：没量。自动化只能读 AX 树，量不到"手感"。规格 §11 本来就把这条
  留给业主试用；R8 做的是把尺寸全部变成设置键（可调不改码）+ 窄窗自动折叠（<1280 折检查器，
  <1040 连媒体池一起折）。
- **镜头带上千分段的横向虚拟化帧率**：没量。种子库 500 条素材未编排成章节（`band.gap.slot`
  WARN 的同一原因），镜头带在真机上是空的。单测覆盖了"视口外章节只渲染带头"的逻辑，帧率无数据。
- **设置表写入频率（拖分隔条 10 秒内落几次 `set_setting`）**：没量。真机探针没有拖拽能力
  （AXPress 点得了按钮，拖不了分隔条）。代码路径：拖动中只写 CSS 变量、`onLayoutChanged`
  才 dispatch、store 里 400 ms debounce + 串行队列——`WorkspaceStore.test.tsx` 覆盖了这条，
  但"真机 10 秒几次"这个数没有。

## 3. 门禁记录

`ls qa/runs/ | grep -i "2026-09-11.*fast-gates"`，逐条读 `gate.json` 的 `status`：

主仓（各车道合并期间）：

| 运行目录 | status |
|---|---|
| `2026-09-11T15-16-16Z-fast-gates` | PASS |
| `2026-09-11T16-57-01Z-fast-gates` | PASS |
| `2026-09-11T17-26-37Z-fast-gates` | PASS |
| `2026-09-11T17-31-11Z-fast-gates` | PASS |
| `2026-09-11T18-01-32Z-fast-gates` | FAIL（如实列出，未追查根因） |
| `2026-09-11T18-07-49Z-fast-gates` | FAIL（如实列出） |
| `2026-09-11T18-15-10Z-fast-gates` | PASS |
| `2026-09-11T18-21-50Z-fast-gates` | PASS |
| `2026-09-11T18-24-20Z-fast-gates` | FAIL（如实列出） |
| `2026-09-11T18-27-35Z-fast-gates` | PASS |
| `2026-09-11T19-09-58Z-fast-gates` | FAIL（如实列出） |
| `2026-09-11T19-13-10Z-fast-gates` | PASS |

Task 8 worktree（`feat/r8-closeout`）：

| 运行目录 | status |
|---|---|
| `2026-09-11T19-53-12Z-fast-gates` | PASS（23 项全绿：zsh 语法 ×12、npm-deps、license-manifest、typescript、eslint、vite-build、vitest、cargo-test、jianying-canary、cargo-clippy、cargo-audit、npm-audit） |

今日主仓 12 次，8 PASS、4 FAIL，每次 FAIL 之后的下一次均为 PASS；Task 8 分支 1 次 PASS。
本轮另外的门禁：`node --check scripts/qa/smoke-gui.mjs` 通过；`node scripts/qa/check-chunks.mjs`
通过；QA 候选打包（`TRIPCUT_PACKAGE_MODE=qa TRIPCUT_ALLOW_ADHOC=1 TRIPCUT_BUILD_STAMP=r8-closeout`）
四次成功（初版、加关闭按钮后、校准用的坏候选、改回后的最终版），最终 DMG SHA-256
`97992c44ad3fc5189fc64c04afd96541334d2c0699646b672f2f545d6e08f3db`（QA 候选，不发布）。

## 4. FINDINGS

### F-R8-1：AX 树修剪——WebKit 对 ARIA grid / `display:contents` / `aria-modal` 的三种剪法

（本轮把三个"AX 树里东西不见了"的现象放一起，因为处置思路相同：**AX 树不是 DOM，jsdom
看不见这些**。）

- **(1) `gridcell` 没有 `row` 祖先 → 整棵 AXTable 后代被剪空**（`45440ca` 已修，主仓）。
- **(2) `display:contents` 的 `role=row` 被剪掉**：`.pool-grid-row { display: contents }` 这层
  在渲染树里不存在，WebKit 的 AX 映射跟着丢。`c5cb496` 改成真实 grid 盒子（列模板搬到行上，
  像素排布逐像素一致）。**但真机复测仍然只暴露 1 AXRow / 1 AXCell**（见 F-R8-3），说明这一刀
  是必要的卫生修复，不是根因。
- **(3) `aria-modal="true"` 让其余 DOM 从 AX 树消失**：抽屉一开，窗口 `entire contents` 从
  118 KB 缩到 11 KB，顶栏四个按钮连名字都不在树里。这是 WebKit 的正确行为（规格 §7 要的就是
  aria-modal），但它意味着**抽屉里出不去 = 探针也出不去**（引出 F-R8-2）。

### F-R8-2（P1，已修）：抽屉 / sheet 没有任何可见的关闭控件，Esc 在真机上关不掉交付抽屉

真机复现两次（第一次冒烟 + fresh candidate 专项探针）：点「生成交付包」→ 抽屉打开 →
`key code 53`（Esc）→ 抽屉仍在，再按一次仍在。同一台机器同一次运行里导入抽屉的 Esc 是有效的。
`AXFocusedUIElement` 当时是 `missing value`——窗口里没有任何元素持有键盘焦点。
`DeliverDrawer.test.tsx` 里新加的 Esc 用例在 jsdom **是绿的**，即代码逻辑（document 级
keydown + 模态栈顶判定）没问题，问题在真机的焦点归属——**根因没查到**（线索留在 R9 入口）。
处置：`b993875` 给共用外壳 `Drawer` 加 `aria-label="关闭"` 按钮 + 遮罩 `onMouseDown` 关闭，
三个模态一次覆盖；冒烟改走「关闭」按钮，新增 `modal.*.close` 三条断言。先红后绿。

### F-R8-3（开放）：500 条素材的媒体池，AX 只暴露 1 AXRow / 1 AXCell

本轮在 fresh candidate、未做任何选中之前，用递归 `UI elements` 直接数 `AXTable "媒体池"`：
`pool AXRows: 1  AXCells in rows: 1`。此时 DOM 里至少有 4 行 × 2 列（`visibleRows =
ceil(h/150)+4`，`columns ≥ 2`），单测断言了这一点。所以 WebKit 在 ARIA grid 的行展开上还有
一道剪法没找到。已排除：`display:contents`（已改）、`role=row` 缺失（已修）。**下一步线索**
（R9）：① 去掉 `aria-rowcount` / `aria-rowindex` 再数一次（WebKit 的 `AccessibilityARIAGrid`
对带 rowcount 的虚拟网格有特殊路径）；② 把 `<button role="gridcell">` 换成 `<div role="gridcell">`
里包按钮（button 的 AX 角色可能压过 gridcell）；③ 用 Safari 的无障碍检查器直接看，不用
AppleScript 猜。

### F-R8-4（探针侧，已解）：附属带 tablist"8 个 tab"是探针数错了

realcheck3 报 `AXTabGroup 镜头带附属视图` 下有 8 个 AXRadioButton（故事/音乐/旅程/地点卡/模板 +
来源/任务/缺失素材）。本轮 fresh candidate 用 `UI elements of <该 tab group>` 只数直接子节点：
**恰好 5 个**，名字与冻结串一致。8 = 5 + 3，后三个是导入抽屉的分页名——上一轮的探针把整窗的
radio button 数进去了。DOM 层面另加 `axNames.test.tsx` 用例：导入抽屉开着时附属带 tablist
仍恰好五个 tab，两张 tablist 互不为后代。**不是产品缺陷。**

### F-R8-5（P1，已修）：`workspace.css` 六条规则的 `}` 被合并冲掉，整张表后半段在真机上失效

六条车道合并后，`.monitor`、`.monitor-placeholder-title`、`.monitor-button`、
`.monitor-button.primary`、`.monitor-duration/.monitor-marked`、`.visually-hidden` 六条规则
的闭合括号连同尾部声明一起丢了。WebKit 支持 CSS 嵌套，于是 `.monitor {` 之后的**整张表**
（媒体池、抽屉、镜头带、检查器）都被当作 `.monitor .xxx`——一条都不生效。jsdom 不跑 CSS，
49 个测试文件全绿也看不见。丢掉的声明从来源提交（`feat/r8-monitor`、`86ae848`）逐字恢复，
不是凭记忆重写。探测器：`axNames.test.tsx` 新增花括号配平 + 重复选择器两条断言，前者对改前
文件跑列出恰好这六条。（这也可能是三轮真机检查里"三栏密度手感"迟迟无法判断的原因之一——
之前真机上看到的样式本来就不是设计的样式。）

### F-R8-6（构建，已修）：rolldown 分组顺序有实义

按规格 §9 的书写顺序把 `workspace` 组放在 pool/monitor/band/inspector 之前，rolldown 把那四组
全部并进 `workspace` 一个 161 kB 的 chunk，四条 group 一条都没 materialize，构建日志只是少了
四行、不报错。壳本体挪到四组之后，八个 chunk 才各自成块。`check-chunks.mjs` 校准过：把
`SettingsSheet` 改回静态 import 再构建，脚本立刻红（那一组连独立 chunk 都没有了）。

### F-R8-INFRA-1（环境）：驱动进程缺少「屏幕录制」权限，六张截图全部 SKIP

`CGWindowListCopyWindowInfo` 从每一个候选进程（cmux 起的 zsh、Terminal.app）都返回空；这个
权限不能由程序申请。全屏兜底不可用（会拍到别的 app 的窗口，realcheck3 实测拍到了业主的邮箱，
已删）。冒烟脚本改为：拿不到窗口 id 就记 `SKIP: screen recording permission missing`，
**绝不全屏**。

### F-R8-INFRA-2（探针侧，已修）：`SELECT file_name FROM clips` 查了一个不存在的列

`clips` 表没有 `file_name`（那是 Rust 侧从 `rel_path` 取的 basename），sqlite3 报 parse error、
stdout 为空，被报成"库里没有素材"，而同一次运行的 `db.clips` 数到 500。改查 `rel_path` 取
basename。教训：查列名，别照抄前端类型定义。

### F-R8-INFRA-4（探针侧，已修）：landmark 断言用字符串包含判,校准跑证明它永远绿

按 brief 的校准要求把 `aria-label="镜头带"` 改成 `镜头带2` 重新打包冒烟,
`workspace.panes.镜头带` **仍然 PASS**——`entireContents().includes("镜头带")` 对着 `镜头带2`
和 `镜头带附属视图` 照样为真。改成一次遍历取全部**精确** AX 名(`exactNames()`),再跑同一个
坏候选:`workspace.panes.镜头带`、`workspace.single_screen`、`modal.*.close` 三条(它们靠
"镜头带 landmark 回来"判回到工作区)全部如期变红(`qa/runs/20260911T-r8-calib2-smoke/`);
改回后重新打包再跑,全部转绿(`qa/runs/20260911T-r8-closeout-3-smoke/`)。
不做这一步,这轮的六条 landmark 绿就没有一条是可信的。

### F-R8-INFRA-3（环境，开放）：反复读 `entire contents` 之后，WKWebView 的 AX 子树会整个变空

本轮两次观察到：连续几次全树遍历（其中一次被 kill 掉中途的 osascript）之后，`window 1` 的
`entire contents` 从 600+ 元素变成 **0**，窗口直接子节点里的 `AXGroup`（webview）
`children=0`，activate 也不恢复，只能重启候选。realcheck3 报的"树大了之后遍历 >200 s 未完成"
可能是同一件事的前半段。对探针的含义：**每个候选实例的全树读取次数是有限预算**，读取密集的
步骤要排前面、合并成一次读；点击密集的步骤排在"选中素材"之前（选中后树从 ~15 KB 涨到 ~274 KB）。

### 各任务 review 抓到的问题（合并前修，摘自各 task 报告）

- Task 2：P1 按集裁剪缺失、P1 切集不重取、P2 网格键盘焦点（`task-2-report.md`）。
- Task 3：审查三条整改，`a1c094f`（`task-3-report.md` §审查）。
- Task 6：终审十条（M1 `React.lazy` 是空头支票——`App.tsx` 静态 import 把三个 lazy 目标全提升进
  首屏；L4 设置未读回时的中性骨架；L5 旧 hash 转接后收回 `#/`；L6 历史集只读查看事件无人接；
  L9 抽屉与命令面板的 Esc 互相打架 → 模态栈；等），`948c9db`。
- Task 7：P2 `HelpOverlay` 未挂模态栈、P3 `GenerationDialog` 完全没挂模态栈、P4 焦点环 token，
  `6a980df`。
- 合并后：`DeliverDrawer.test.tsx` / `ImportDrawer.test.tsx` 的 api mock 重复键（`850b257`）——
  这正是 Task 8 用 `testApiMock.ts` 从 `src/api.ts` 真实导出表生成替身、不再手抄名单的原因。

## 5. 被 revert 或冻结的项

无 revert。冻结一项：规格 §11 的 `get_job_summary` 只读命令**不补**——本轮没有测出前端聚合
（`getImportProgress` / `listMissingClips` / `listGenerationRequests`）的开销不可接受，规格说的
是"量到再补"。

## 6. 下一轮入口 / 待业主

**待业主（三件，都不是代码能替代的）：**

1. **给 QA 驱动进程授「屏幕录制」权限**（系统设置 → 隐私与安全性 → 屏幕录制，勾上跑
   `osascript` / `screencapture` 的那个 app）。授了之后 `smoke-gui.mjs` 的六张截图自动从 SKIP
   变成 PASS/FAIL，mpv 嵌入对齐这条才第一次有像素证据。
2. **指针拖排的真机手感**：镜头带拖排、三条分隔条拖动、设置表落盘次数——自动化探针拖不了，
   要人上手。拖分隔条 10 秒，看日志里 `set_setting` 落了几次；规格预期是个位数。
3. **1280×800 的三栏手感**：所有尺寸都是设置键。不接受的话下一版给媒体池加「列表 / 网格」
   两档密度（§14 已预留）。

**下一轮入口（技术）**：见 `docs/superpowers/plans/2026-09-11-r8-director-workspace.md`
末尾「R9 入口」——删 `ui.workspace_v2` 旗、删 `LegacyShell` / `SidebarSearch` / `SelectPage`
页面容器（纯函数留在 `poolModel.ts` / `shotBandModel.ts`）、清 `styles.css` 旧页面样式与
`select-legacy` 分组；外加本轮两条开放项：F-R8-3（媒体池 AX 只有 1 行）与 F-R8-2 的根因
（真机上抽屉内无焦点）。

**发布边界**：0.2.1 的 DMG 只留本机给业主试用，不发布、不打 tag、不进更新源；0.3.0 才是下一个
公开版本。本轮打的 `旅剪工作台_0.3.0_r8-closeout_qa_aarch64.dmg` 是 QA 候选（ad-hoc、未公证），
同样不发布。
