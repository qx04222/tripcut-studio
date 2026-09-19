# 无人值守 R19 · 三步壳(shell · band · flow · deliver · bench)

规格:`docs/superpowers/specs/2026-09-18-r19-three-steps-shell-design.md`;头脑风暴、车道报告与合并接线报告在 `.superpowers/sdd/r19/`(不入库)。

## 1. Wave 1 合入(`r19/integrate`,未 push、未进 main)

五条车道按 shell → band → flow → deliver → bench 顺序 `--no-ff` 合入,每次合并后 `typecheck / lint / vitest` 三道绿再合下一条;合并后两个接线提交(镜块 148×112、preview-shots 06a 三卡检测器),验收前顶 `b6725ee`。

| 车道 | 合入 | 要点 |
|---|---|---|
| shell | `c22efbf` | V-01 一屏一颗实心主按钮(栏内 primary 全降 secondary,只留顶栏「下一步」;截图装置每张数一遍);V-02 顶部只有一行(提示条文案进「下一步」tooltip,工具链横幅降为状态条红点);V-04 检查器滑出层(选中即出、Esc / 点空白 / ⌘2 收、「钉住」落 `ui.inspector.pinned`;监视器让出层宽,60% 封顶);V-05 单检视器(井撑到栏边、传输条一行、热力画进 seek 轨道);V-11 单一断点 `--bp-compact: 1366px`;`WorkspaceShell.tsx` 446 → 365 行 |
| band | `cfe7ba2` | V-06 镜块三元素(封面 + 时长 + 一行名,动作条进 hover / 选中);V-07 工具条二级化(视图三芯片 → 「按章节 ⌄」,附属五标签 → 「附属:故事 ⌄」,选中即收);V-08 状态条静默化(真空闲只一句「后台空闲」+ 库名,「查看后台任务详情 / 全部暂停」不渲染)。语义冲突:工具链红点两份 → StatusStrip 消费 shell 的 `useToolchainStatus()`,红点只在状态条左端一处 |
| flow | `efc2195` | U-01 分析中不吃闭门羹(主按钮「先挑已分析的 x/N 条」,全 0 禁用 + eta);U-02 教学仲裁器(同一帧只出一个);U-03 零术语首页;U-05 库空时导入抽屉只一颗按钮;U-09 首次自动挑选零决定;P-05 「显示全部功能」开关(设置 › 关于,默认关) |
| deliver | `b7654e6` | U-06/P-04 导出首屏三张大卡「交给剪映 / 导出视频文件 / 整包交付」+「更多方式 ⌄」;J-04 素材包按章节子目录 + `顺序.txt` 标章节边界;J-05 素材包带同名 SRT 与本集音乐;J-07 完成 toast「打开剪映」直达目录;J-10 不可用时一行灰字 |
| bench | `a84377a` | E-03 `check-startup.mjs`(隔离 profile 起真包读 `rust_setup_ms`,空库 <400ms);E-11 `check-binary-size.mjs`(二进制 / DMG ≤ 基线 +10%);`fast-gates.mjs` 追加两条 |
| 接线 | `530260b` / `b6725ee` | 镜块 160×130(节距 168)→ 140×112(节距 148),刻度 / 播放头 / 音乐轨全从 `BAND_SEGMENT_PITCH` 派生,`bandTimeline.test` 一条未改即绿;preview-shots 新增 `06a-deliver-cards`(硬断言恰好三卡 + 「更多方式」、无四模式 chip) |

门禁(`b6725ee`):typecheck / lint 0 错;vitest 196 文件 / 1446 绿 + 3 todo;`fast-gates.mjs` 26 条全 PASS(perf-bench-100 total_ms 66.4%、rss_peak 103.6%);`preview:shots --dpr 2` 40 / 40 PASS、0 console error。AX 节点 −18%(未到 §6 的 30%,阈值不动)。

## 2. 真机验收(r19-qa-b6725ee 构建,隔离 profile,perf 夹具 27 条)

包:`TRIPCUT_PACKAGE_MODE=qa` ad-hoc,`旅剪工作台_0.9.1_r19-qa-b6725ee_qa_aarch64.dmg`(31.1 MB,二进制 25.2 MB);从 DMG 拷出的 .app 以 `TRIPCUT_APP_SUPPORT_DIR=<scratch>/r19-profile` 启动,只碰自己起的 pid。walk8 夹具已不在盘上(R18 用的是临时目录),改用 `scripts/qa/make-perf-fixtures.sh 27`(4K HEVC 切片 + lavfi 合成 1080p,1.1 GB)。AX 驱动:`.superpowers/sdd/r9/device-tools/`(axpress / axresize / wid)+ 本轮临时的 axdump / axmove / wid2;键盘走 `System Events`(**cliclick 的 `kp:esc` 打不进 WKWebView**,typing 能进但 Esc 不进,osascript `key code 53` 才行);截图 `screencapture -x -D 1` 全屏再裁到窗口——**`screencapture -l <windowid>` 抓不到 `.ui-guide` 气泡**(窗口层图像里没有,全屏图里有),窗口级截图不能当「用户看到的」用。

截图目录:`/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/0b1eb8a1-56bc-4f37-9f8f-c0573756a979/scratchpad/shots/`(`*-win.png` 为窗口裁切,同名无后缀为全屏原图)。

| 项 | 结果 |
|---|---|
| 首启零术语 | 首页 AX 树 grep 镜头带/章节/精选段/交付/模板/旅程 = **0**;一屏:四步上手卡 + 一句话 + 「新建一集」(唯一实心)+ 最近的集;顶栏「下一步:导入素材」此时是 secondary ✅ `01-first-run-home.png` |
| 「新建一集」→ 导入 27 条 | 点「新建一集」开导入抽屉(默认态只有「来源」一个分页、「选择文件夹」一颗按钮 ✅ `02-new-episode-import-drawer.png`);文件夹用 `open -a <app> <dir>`(「打开方式」路径,原生 NSOpenPanel 不走 AX)→ 「已发现 27 个视频,新增 27 项」;关抽屉后媒体池 27 卡已在(卡出现 <3 s,分析中角标)✅ `03-after-import.png`。**抽屉没有自动收**——U-04「导入即有地图 / 抽屉自动收」在规格里属 perf 车道(Wave 2),本波未做,不算缺陷 |
| 分析中点主按钮 | 文案「先挑已分析的 6/27 条」(唯一实心);点它 → 3 段进带、toast「…已按全部素材挑了 3 段 · 共 30 s · 还有 21 条在分析」,**0 报错、0 「画面分析还没跑完」** ✅ `04-pick-during-analysis.png`;27 条分析在 ~2 分钟内跑完(M5) |
| 教学同一帧一处 | 全程每帧只见一个「新手引导 n/8」气泡(1/8 流水线 → 3/8 连播 → 4/8 导出),首页四步卡与气泡不同帧 ✅ `04b-fullscreen-D1.png` |
| 壳 · 1440 | `region "镜头带"` 宽 **1440**(通栏);顶栏底到池标题条 **44 px**(AX:顶栏 y=120,池 y=164);顶部只一行 ✅ `06-selected-1440-win.png` |
| 检查器滑出层 | 选中即滑出(`region "检查器"` 1244..1584,压在监视器右侧 340 px);Esc 收(System Events)✅;收前后中栏 `预览监视器` 宽 **1131 / 1131** ✅;「钉住」→ 标「已钉住」,Esc 不收 ✅ `08-pinned-1440-win.png` |
| **滑出层 vs mpv 原生视图**(integrate 报告风险 #1) | **没被盖住**。播放中滑出:视频让出层宽(画面缩到 1244 处),层完整可见,时间码在走 ✅ `07-playing-inspector-1440-win.png` / `07b-…-t2-win.png`;播放中拖监视器/镜头带分栏(724 → 647)层与画面同步重排 ✅ `09-splitter-drag-playing-1440-win.png`;⌃⌘F 原生全屏(1800×1130)层仍在画面之上 ✅ `10-native-fullscreen-playing.png`,退全屏后播放继续、层仍在 ✅ `11-after-fullscreen-exit-playing-win.png`。1280 / 1920 下画面**不让位**(层直接盖在画面上,画面延到层底下),但层本身完整不透——原生视图并没有压在 WebView 之上,备选「回退为 Panel」不需要 |
| 四档宽度 | 1280(四步折「第 ④ 步 · 导出 ⌄」胶囊、池两列)`12-narrow-1280-win.png`;1440 `06-…`;1512 `13-standard-1512-win.png`;1920(外接屏 1×)`14-wide-1920-win.png`。四档同一套壳、检查器都是滑出层 ✅ |
| 单主按钮 | 首页 1(新建一集);导入抽屉 0 顶栏 + 1(选择文件夹);分析中 1(先挑已分析的);排列后 1(下一步:导出);导出首屏 0(三卡都是 secondary 大卡);设置 sheet 0 ✅。**例外:素材包导完后的详情页 2 颗**(页脚「导出素材包」+ 结果卡「打开剪映」)→ F-R19-03 |
| 镜块 148×112 | AX:镜块 cell **140×113**,相邻 x 差 **148**;文件名一行、时长角标不溢出;真机 Retina 观感可读(`06-selected-1440-win.png` 底部) |
| 工具条下拉 | 「按章节 ⌄」→ 按章节 / 按时间 / 仅缺口;「附属:故事 ⌄」→ 故事 / 音乐;真实点击:点选项即收并改标题(→「附属:音乐 ⌄」)、Esc 收、点外面收 ✅ `15-band-accessory-menu-off-win.png` / `16-band-view-menu-win.png` / `15b-accessory-menu-realclick-win.png`(**AXPress 打开的浮层 Esc / 点外面不收,两个能同时开**——AXPress 不发 pointerdown 也不给焦点,是探针假象,真实点击正常) |
| 状态条空闲 | 分析中:「查看后台任务详情 · 全部暂停 · 进度条 · 正在分析 6/27 · 正在生成预览小文件 6/27」;空闲:只剩「ⓘ 后台空闲」+ 右端「✓ 原有素材库」✅ `05-analysis-done-win.png` |
| 「显示全部功能」关 / 开 | 附属页签 **2 / 5**(故事 · 音乐 → + 旅程 · 地点卡 · 模板);检查器段 **6 / 7**(评级与收藏 · 标签 · 所属章节/槽位 · 精选段 · 同一镜头的多条 · AI 描述 → + 技术检查;「更多信息」1 项 → 3 项);设置组 **4 / 6**(项目与缓存 · 播放与导出 · 工具与模型 · 关于 → + 快捷键 · 性能;「隐私与诊断」直达两态都在)✅ `17-settings-off-win.png` / `18-settings-on-win.png` |
| 导出首屏 | 恰好三卡 + 「更多方式 ⌄」+ J-10 灰字「草稿(标记/字幕/配乐更完整)暂不可用于你的剪映版本,已改用素材包(顺序仍对)」(本机剪映 11.4 未核对)✅ `19-deliver-cards-win.png`;抽屉盖住监视器时 mpv 画面被正确遮住 ✅ |
| 「交给剪映」 | **b6725ee 上 ❌**:点卡只切到素材包详情页,还要再点「导出素材包…」;第一次导出弹原生「选择交付包保存位置」面板 `20-handoff-result-win.png` / `21-open-panel.png` → **F-R19-01(P1,已修 `c2107bf`,见 §3)**。素材包内容 ✅:`01_第 1 章 · 1400-1401/01_…_perf_0003.mp4`…`03_…`、`顺序.txt`(带「— 01_第 1 章 · 1400-1401 —」边界行)、`.tripcut-complete.json`;夹具无对白 → 无 SRT(「若有转写」,未验) |
| toast 直达目录 | 完成 toast「已导出 3 个片段 · 打开剪映」+ 结果卡三步;「在 Finder 中显示」→ Finder 打开所在目录并选中素材包 ✅ `22-reveal-finder.png`。「打开剪映」按钮本身**没点**(会在业主机器上拉起剪映,留业主) |
| 菜单栏审计 | `menu-audit.mjs --pid` **PASS(7 条顶级菜单)**;`native-audit/run.mjs --app --pid` 4 通过 / 0 缺陷 / 0 探针故障 ✅ |
| 退出 | ⌘Q 后台空闲时直接退出,profile 里 **无 `.unclean-exit`** ✅(两次:b6725ee 包与 c975147 包各一次) |
| bench · `check-binary-size` | PASS:binary 25,318,176 B vs 基线 29,360,464(**86.2%**);dmg 31,111,150 B vs 31,139,512(**99.9%**) |
| bench · `check-startup` | **b6725ee 上 PROBE**(5/5 轮 TIMEOUT)→ F-R19-02(bench 脚本,已修 `c975147`);修后对同一 QA 包 rounds=5:**621 / 353 / 348 / 325 / 354,median 353 ms**(空库阈值 400)PASS |

### 2.1 修后复验(r19-qa-c975147 包,同一 profile 升级启动)

同一 profile(记住的文件夹改指 scratch)起 c975147 包 → 「下一步:导出」→ 点「交给剪映」一次:**8.9 s 后 toast「已导出 3 个片段 · 打开剪映」+ 结果卡**,中间没有第二颗按钮、没有面板,素材包落在 `EP01_剪映素材包_2026-09-18-2/`(同名已存在自动 -2)✅ `23-fix-oneclick-handoff.png`。⌘Q 退出无 `.unclean-exit`。

### 2.2 前 5 分钟基线(U-12,bench2 车道,`scripts/qa/first-five-minutes.mjs`)

包:`v0.10.0-preview`(`TripCut-Studio_0.10.0_github-preview-v0.10.0-20260918T1937Z_preview_aarch64.dmg`,从 GitHub preview 缓存解包 + ad-hoc 重签)。夹具:`scripts/qa/make-perf-fixtures.sh 27`(与 §2 同一份配方)。跑法:隔离 profile 起真 .app → AX 驱动「新建一集 → 导入 27 条(`open -a` 旁路原生文件夹面板)→ Esc 关抽屉 → 冻结 AX 名「流水线下一步」按 `AXHelp` 判断走到哪步并点 → 交给剪映」,计点击、可见新词(§3.4 词表)、启动到导出文件的秒数;3 轮,`node scripts/qa/first-five-minutes.mjs --app <.app> --fixtures <dir> --rounds 3`。

两次各 3 轮(共 6 轮),`qa/runs/<ts>-first-five/` 与 `qa/perf/history.jsonl` 各留一条:

| 批次 | 轮 | 点击 | 新词 | 秒数 | 备注 |
|---|---|---|---|---|---|
| A | 0 | 5 | 7(集/镜头带/章节/精选段/缺口/素材包/交付) | 未量到 | 到达「交给剪映」;落地判据 90s 超时 |
| A | 1 | 5 | 7(同上) | 未量到 | 同上 |
| A | 2 | 3 | 6 | 未量到 | PROBE:第 4 步(自动挑选)90s 内没等到状态转换——本机同时段有别的车道在跑 `perf_driver`(4 worker)压测,资源争用 |
| B | 0 | 5 | 7(同上) | 未量到 | 到达「交给剪映」;落地判据 90s 超时 |
| B | 1 | 5 | 7(同上) | **125.7** | **真落地**:「交给剪映」→ 点「导出剪映素材包到上次文件夹」这次是 `enabled=true`,导出成功,文件迁回 scratch |
| B | 2 | 5 | 7(同上) | 未量到 | 到达「交给剪映」;落地判据 90s 超时 |

**中位数(批次 B,3/3 轮到达「交给剪映」,1/3 轮落地)**:点击 **5**、新词 **7**、秒数 **125.7 s**(仅 1 个样本,不是稳定中位数)。判据(点击 ≤6 / 新词 ≤6 / 秒数 ≤60):点击 PASS,新词 FAIL(超 1 个,超出的是「交付」——导出抽屉标题本身),秒数 FAIL(125.7 s > 60 s,且 5/6 轮完全没落地)。

**发现(F-R19-06,P2,记录)**:「交给剪映」详情页「导出剪映素材包到上次文件夹」按钮的 `enabled` 状态**跨轮不稳定**——6 轮里 5 轮进详情页后该按钮持续 `enabled=false`(同屏「更改文件夹」按钮始终 `enabled=true`),1 轮(批次 B 轮 1)是 `enabled=true` 并成功导出。这是 `useJianyingKit` 的 `canExport` 门(`selected_count>0 && planError===null && !hasMissing`)在 `plan`/`hasMissing` 上的一个时序竞态,不是「一次即出」F-R19-01 的回归(进入的是首屏三卡直接点击后落的详情页,不是二次点「更改文件夹」链路),产品侧根因本轮未继续深挖。**因此 §5 U-12 的「≤60s(含分析)」本轮只有一个真实秒数样本(125.7 s),且这一步本身就不稳定,不能当作可信中位数**——点击(5)/新词(7)两项样本稳定,可信。下一轮建议:先定位这个 `canExport` 竞态(F-R19-06),再重新测秒数。

## 3. 发现

- **F-R19-01(P1,已修 `c2107bf`)** 「交给剪映」一次即出没接上:`pickCard` 只 `setScreen("detail")`,素材包还要再点一次;规格 §6「点「交给剪映」一次即出…无选择对话框」。修法:`useJianyingKit(progress, { autoStart })`——卡片进来 + 记过文件夹 + 清单算好即 `exportNow()`(每次挂载只一次);没记过文件夹仍落详情页等一次点击(不替用户弹面板);「更多方式」/ chip / deep-link 进来的不自动导。`DeliverDrawerKit.test` 三条(一次即出先红后绿 / 没记过不弹面板 / chip 进来不自动导)。**第一次导出的原生文件夹面板仍在**——「无选择对话框」在全新机器上要么给默认目录(如 `~/Movies/旅剪工作台/`)要么接受一次面板,是产品拍板项,见 §4。
- **F-R19-02(bench 工具,已修 `c975147`)** `check-startup.mjs` 取 `MacOS/` 目录字母序第一个当主二进制,打包后的 .app 里第一个是 `ffmpeg`,五轮全 TIMEOUT 却只报 PROBE(不红)。改按 `Info.plist` 的 `CFBundleExecutable`。E-03 门禁此前在真包上从未量到过数。
- **F-R19-03(P2,记录)** 素材包导完后的详情页有两颗实心主按钮:页脚「导出素材包」仍是 primary,结果卡里「打开剪映」也是 primary;V-01 ≤1 的规则在这个态没守住(R14 遗留形态,preview-shots 没有「kit 导完」这张图)。建议导完后页脚降 secondary。
- **F-R19-04(P2,记录)** 1280 宽、检查器滑出时,监视器传输条右端「全屏」按钮被层盖住(1005 − 340 = 665 px 放不下整条传输条);Esc 收层或 ⌘⏎ 可达。shell 报告预告的「60% 封顶那段仍重叠」在真机上的实际形态就是这个——盖的是控件不是画面。
- **F-R19-05(P2,记录)** 媒体池三列(320 px 池)下卡内文件名两行断在 `perf_0026.mp` / `4`;真素材名(IMG_0003.mov)更短,可能不触发,但长名会。
- **观察** 首启到 27 条分析完 ~2 min(M5,4K HEVC 切片 + 1080p 合成);A18-01「首启无响应」本轮未复现。

## 4. 未验 / 留业主

- 「打开剪映」按钮(会拉起剪映)与 J-06 剪映 11.4 草稿三步验证:业主本机点。
- 第一次导出的文件夹面板:要不要给默认目录免掉面板(§6 「无选择对话框」的严格读法)——拍板项。
- 素材包同名 SRT:夹具无对白,J-05 的 SRT 分支只有单测,真素材未验。
- `first-five-minutes.mjs`(U-12,§6 前 5 分钟点击 ≤6 / 新词 ≤6 / ≤60 s)bench 车道推迟,本轮没有真机口径的 AX 节点计数与点击数。
- 真机 VoiceOver(工具链红点是 status 里一颗按钮)、深色主题、8 GB / M-Pro 机器:未走。
- 整窗拖放导入(鼠标从访达拖):AX 脚本不能模拟,本轮走的是「打开方式」路径。
- **一次环境事故(须知)**:验收期间业主机器上另有 `/Applications/旅剪工作台.app`(pid 79068,14:03 启动,默认 profile,库 0 条)在跑;15:00:55 默认 profile 的日志多了一次干净启动(0 条,无 `.unclean-exit`),随后该实例与我的实例都不在了。最可能是我用 `open -a <scratch .app>` 激活自己实例时 LaunchServices 按 bundle id 认到了另一份,⌘Q 落到了它。默认 profile 前后 census 都是 0 条、无异常退出标记,**没有数据影响**,但下次真机验收:激活自己的实例用 `System Events … set frontmost of (process whose unix id is <pid>)`,不要 `open -a`。

发布:v0.10.0(Wave 1,main `24d4cbe`)。

## 5. Wave 2 合入(`r19/integrate2`,顶 `115c290`,未 push、未进 main)

基于 main `35b4ae3`(v0.10.0),五条车道按 results → models → tokens → perf → bench2 顺序 `--no-ff` 合入,每合一条 `typecheck / lint / vitest` 三道绿再合下一条;5 个 merge + 24 个车道提交 + 5 个接线提交。合并接线报告(冲突逐处解法、接线债处置)在 `.superpowers/sdd/r19/integrate2-report.md`(不入库)。

| 车道 | 合入 | 要点 |
|---|---|---|
| results | `fc471b7` | P-03「为什么是这些」结果面板(迁移 0049 `auto_select_runs`;每段缩略图 / 时长 / 白话理由 / 兄弟段可展开;「不要这一段」「换一段」;整批 ⌘Z + 面板「全部撤销」);P-01 一句话挑片(本地规则解析中文 → `auto_select` 参数,LLM 可用时增强、不可用静默回落);P-09 三条预设句(旅行日记 / 电影感 / 快节奏)= 三句现成的 P-01,首页「让软件先挑一版」三卡 |
| models | `05c4b6e` | P-06 模型一键到位:可审计清单 `model_catalog.rs`(CLIP 4 文件钉 HF 提交 `36e679e…` ≈753 MB;whisper large-v3-turbo / small),后台下载 `model_download.rs`(边下边 SHA-256、可取消、失败可重试、临时文件不落半文件),设置 › 工具与模型 每模型一张三态卡,状态条一句进度,首启气泡「安装」同一入口;CLIP 目录成为侧车 `TRIPCUT_CLIP_MODEL_DIR` 默认值 |
| tokens | `5b7d5ba` | V-09 旧 `--font-*` 三文件清零;Q-3 主题收两套(`jianying-dark` 升格为唯一 `dark`,旧偏好自动映射);Q-4 浅色下监视器井 / 镜头带 / 状态条深底;V-12 深色全剧本走查 + @2x 基线入 git lfs + `preview-diff.mjs`(pixelmatch ≤0.5%) |
| perf | `ef5b55e` | E-01 whisper `-t` 实测收益 3.4% <15%,维持 `-t 4`;E-07 300 段镜头带量测无显著差异;P-10/U-04 导入即有地图(按日期 › 时段分组 chip 行 + 抽屉自动收 + 状态条「已导入 N 条 · 共 X 分钟」);E-06 A18-01 取证(排除 Rust 侧,间歇性首帧慢已复现);E-10 8 GB 注入回归表 |
| bench2 | `2c3e759` | U-12 `scripts/qa/first-five-minutes.mjs`(§2.2);`95adbcb` 追加 F-R19-06 取证(点前读按钮 enabled、原生面板按 every window 找、记延迟) |
| 接线 | `49be020` / `f0dcd3d` / `115c290` | 首次零决定:outcome 带 `run_id` 时 toast 不再带「撤销」(撤销只留面板「全部撤销」+ ⌘Z);假后端把 `models` 气泡预置为已看过(合并后 32-update 那步被气泡拦住)+ `guides.test` 静态对账;`ImportDrawer.test` 替身按真实 `SettingsStatus` 铺底(vitest 23 绿但 exit 1 那条) |

门禁(`115c290`):typecheck / lint 0 错;vitest **204 文件 / 1522 绿 + 3 todo**;cargo test lib 1118 绿 + 集成 5 文件;clippy `-D warnings` 绿;`fast-gates.mjs` **28 / 28 PASS**(perf-bench-100 total_ms 64.5%、rss_peak 93.8%;preview-diff-dark 45 / 45 0.000%);`preview-shots` 深 / 浅各 43 场景全 PASS、0 console error。

接线债(记录,不在本轮):「换一段」不进 ⌘Z 栈——`replace_auto_segment` 把旧段软删时 `batch_id = NULL`,`restore_select_segment` 不还 `batch_id`,撤完的旧段掉出这一批、「全部撤销」收不回;要做对需一条 Rust 命令 `undo_replace_auto_segment`(一个事务里还 batch_id + 软删新段),留决策。

## 6. Wave 2 真机验收(r19-qa2-115c290 构建,隔离 profile,perf 夹具 27 条)—— **中断:验收期间业主合上了笔记本盖**

包:`TRIPCUT_PACKAGE_MODE=qa` ad-hoc,`旅剪工作台_0.10.0_r19-qa2-115c290_qa_aarch64.dmg`(31,175,680 B,二进制 25,436,112 B;`src-tauri/target/release/bundle/dmg/`)。从 DMG 拷出的 .app 以 `TRIPCUT_APP_SUPPORT_DIR=<scratch>/r19w2-profile` 直接起可执行文件(不 `open -a`),只碰自己起的 pid;激活按 §4 的教训用 `System Events … set frontmost of (process whose unix id is <pid>)`。夹具复用 §2 的 `make-perf-fixtures.sh 27` 产物(1.1 GB,`<scratch>/fixtures27`)。AX 驱动:`.superpowers/sdd/r9/device-tools/` + §2 的 axdump / wid2 + 本轮 `ax.sh`(按名 AXPress / 读 enabled / 读值 / 设值)。

截图目录:`/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/0b1eb8a1-56bc-4f37-9f8f-c0573756a979/scratchpad/r19w2/shots/`(`*-win.png` 为窗口裁切)。

### 6.1 环境事故(须知,决定了本节能验到哪)

- 21:31 起包成功、起实例时屏幕已在锁屏(`CGSSessionScreenIsLocked=Yes`,锁于 21:31:10);锁屏下 WKWebView **没有 AX 窗口、不出首帧**(日志 `first paint first_paint_ms=3880429` —— 首帧出现在 22:36 解锁那一刻)。不去解锁,等到 22:36 业主解锁。
- 22:36–22:38 业主在机器前:我的实例被拉到 1512×945、设置页开在「关于」并按过「检查更新」,随后实例被 ⌘Q(干净退出,无 `.unclean-exit`;日志无异常)。22:37 重起一个新实例(pid 93330)继续。
- 22:38 之后 `AppleClamshellState = Yes`(**盖子合上**),Amphetamine 单次会话在防系统睡眠,但**内置屏没有 WindowServer 显示器**:`caffeinate -u` 能让屏幕短暂点亮 ~10 s(此时 AX 窗口存在、截图是真画面),随后灭屏、AX 树只剩窗口按钮;22:53 起连 `-u` 也叫不醒(进入密码锁)。在这 ~10 s 一格一格的窗口里做完了 6.2 的前半段;22:53 之后全部 AX/截图不可用。
- 没有虚拟显示器工具(BetterDisplay / displayplacer 都不在),没有 sudo;**合盖 + 无外接屏 = 真机验收不可能继续**。等到 23:30 盖子仍合着,本节按「做到哪写到哪」收笔,剩余项标「未验(合盖阻塞)」,QA 实例(pid 93330,profile `<scratch>/r19w2-profile`,27 条已导入、已分析完)留着不杀,开盖后可原地续。
- 为让屏幕点亮用过 `caffeinate -u/-d`(会话结束即停),没有改任何系统设置。

### 6.2 逐项

| 项 | 结果 |
|---|---|
| 菜单栏审计 | `menu-audit.mjs --pid` **PASS(7 条顶级菜单)**;`native-audit/run.mjs --pid` 3 通过 / 0 缺陷 / 1 探针故障(`app.window-on-screen`:锁屏下 AXWindows 首元素是 AXApplication —— 套件自己认出是锁屏,不当缺陷)✅ |
| bench · `check-binary-size` | PASS:binary 25,436,112 B vs 基线 29,360,464(**86.6%**);dmg 31,175,680 B vs 31,139,512(**100.1%**)✅ |
| bench · `check-startup` | rounds=5(锁屏下起,窗口建得起来、日志照写):**188 / 187 / 190 / 187 / 191,median 188 ms**(空库阈值 400)PASS ✅ —— 比 §2 的 353 ms 低,锁屏下没有首帧竞争,不能与 §2 直接比 |
| 导入即有地图(P-10) | 「新建一集」→ `open -a <app> <fixtures27>` → **抽屉自动收了**(没按 Esc,回到工作区时抽屉已不在)✅ `03-after-import-win.png`;媒体池 27 卡;**分组 chip 行没有出现**:27 条夹具同一天同一时段(`captured_at` 全是 09-18 下午),`MediaPool` 只有一组时按设计不渲染 —— 夹具覆盖不到这条,不是缺陷;要验需要把夹具 mtime 打散到两天以上(未做);「已导入 27 条 · 共 X 分钟」与占位卡出现秒数**没量到**(导入那一刻屏幕正好灭着,再看时分析已完、状态条已回「后台空闲」)→ **未验(合盖阻塞)** |
| 首次零决定(U-09 + 接线 (a)) | 新集第一次点「下一步:自动挑选」:**不弹面板**、直接挑了 3 段进带、结果面板同帧滑出;toast「你还没收藏或打星,已按全部素材挑了 3 段 · 共 30 s(本集平台:通用)· 覆盖 1 章 · 已排进镜头带」+「改范围 / 改时长」+ ×,**没有「撤销」**;撤销只在面板右上「全部撤销」✅ `04-first-autoselect-win.png` |
| 结果面板:行数 = 段数 | 「为什么是这些」头一行「3 段 · 共 24.0 s · 全部素材 · 按时间顺序 · 约 30 秒」,`不要这一段 · <名>` 按钮 **3 颗**(perf_0003 / 0007 / 0011)= 带上 3 镜;每行「8.0 s · 71 分」+ 理由「清晰 · 曝光正常 · 有声音」✅ |
| 「不要这一段」 | 点 perf_0003 那行 → 行消失、头行「2 段 · 共 16.0 s」、带「1 章 · 2 镜」、顶栏「挑选 2 段」✅ `05-drop-row-win.png` |
| 「换一段」 | 点 perf_0007 那行 → toast「已换成「perf_0007」· 清晰 · 曝光正常 · 有声音」(同一条素材的另一段),行与镜块都换了 ✅ `06-replace-row-win.png`;**但换来的段排到了带尾**(带序 0011 → 0007,原来是 0007 → 0011),「按时间顺序」的这批被打乱 → F-R19-08(P2) |
| 「全部撤销」回 0 | toast「已撤销这批挑选」,面板收起,带「1 章 · 0 镜 · 1 缺口」—— 换来的新段也一起收回(新段带着 batch_id)✅ `07-undo-all-win.png` |
| Esc 收面板 | **未验(合盖阻塞)**:面板第一次开着时没来得及按 Esc,之后屏幕不可用 |
| 面板压在监视器 / 镜头带上时 mpv 不遮它(播放中) | **未验(合盖阻塞)**。已看到:面板挂在镜头带栏右侧(`position:absolute` 滑出层,与检查器同机制),不与监视器重叠;§2 已证监视器播放时原生视图不压 WebView 滑出层,这条大概率同结论,但没跑 |
| 一句话挑片(输入句 / ⌘Z 回 0) | **未验(合盖阻塞)**:走到「自动挑选精选段」开面板这一步屏幕已不可用(AXPress 开的面板还没读到 `一句话挑片` 输入框) |
| 首页三张预设句卡 | 首页 AX 三颗按钮「旅行日记:挑 90 秒,按时间顺序,有人说话的留着」「电影感:挑 60 秒,少运动多稳定,风景为主」「快节奏:挑 30 秒,多运动,按分数」都在、可用 ✅(`01-first-home` 那一刻设置页盖着,截图只见卡的左缘);**各点一次看参数不同:未验(合盖阻塞)** |
| 模型三态卡 / CLIP 真源下载 / whisper 卡 | **未验(合盖阻塞)**。首启气泡 3/9「装上「画面理解」和转写模型…点「安装」后台下载…」带「安装」按钮已出现(`05-drop-row-win.png` 里)—— 与设置卡同一入口的那只气泡在;没点。**CLIP 没有装,profile `models/` 目录不存在、无半文件** |
| 主题(设置 › 外观三档 / 深色 Retina 截图) | **未验(合盖阻塞)**;浅色下井 / 镜头带 / 状态条深底在 `04`–`07` 四张截图里都能看到(Q-4 ✅,附带) |
| F-R19-06(`qa:first-five` 3 轮) | **未跑(合盖阻塞)**:脚本要 AX 窗口与 `open -a` 导入 |
| 退出无 `.unclean-exit` | 22:36 那次(业主 ⌘Q)无 `.unclean-exit` ✅;当前实例留着没退 |

### 6.3 发现

- **F-R19-07(P2,记录)** 首次自动挑选的 toast 说「共 30 s」,结果面板头行与带上实际是「共 24.0 s」(3 × 8.0 s)—— toast 报的是预算(`budget_secs`),面板报的是实际时长,同一屏两个数。建议 toast 用实际总时长(面板 `summaryText` 那个),预算另说「目标 30 秒」。
- **F-R19-08(P2,记录)** 「换一段」把换来的段追加到带尾而不是留在原槽位:「按时间顺序」挑的一批,换完 0007 → 0011 变成 0011 → 0007。`replace_auto_segment` 软删旧段、新段按新 id 排序进带;应继承旧段的 `position`。与 §5 接线债(「换一段」不进 ⌘Z 栈)是同一条命令,下轮一起做。
- **观察** 分析 27 条在锁屏 / 灭屏下照跑完(状态条回「后台空闲」),导入到分析完 <2 min 与 §2 一致。

### 6.4 续验(09-19 10:20–11:15,r19-qa2-**a9d1279** 包 = 571c8de + 两条 P2 修;新隔离 profile `<scratch>/r19w2-profile2`)

盖子已开,但**业主同时在这台机器上工作**(主屏 Chrome / Dell 外接屏 cmux):我的实例被业主最小化过一次、被挪到外接屏;后半程把它放在外接屏右侧空位(1434×917)。截图一律改 `screencapture -l <windowID>`(窗口级,不受前台遮挡;但 1×,只有标 Retina 的两张是搬回内置屏后抓的 2×)。§6.2 里 `01`–`08` 之外的 `18-preset-*` / `19-state` 曾抓到业主前台的浏览器,已删、按窗口级重抓。**键盘事件必须在自己实例前台时发**:两次 ⌘Z 与一次 Esc 在业主点回 Chrome 的 0.4 s 窗口里落进了 Chrome(00:5x,Chrome 里的撤销可能动了业主正在编辑的内容,须告知业主);之后 `key.sh` 改为「置前 → 核对 frontmost → 发键」,不是自己就拒发。`open -a` 只在本 bundle 无其它实例时用;业主默认 profile(`~/Library/Application Support/TripCutStudio/default`)最后活动 10:01,验收期间未被触碰。

夹具:`fixtures27b` = 同 27 条,mtime 打散到 09-16 上午 / 09-16 下午 / 09-17 傍晚各 9 条(P-10 分组要两天以上才渲染)。

| 项 | 结果 |
|---|---|
| 导入即有地图(P-10) | 「新建一集」→ `open -a` → 抽屉自动收 ✅;媒体池顶部分组 chip 行「09/17 夜间 9 · 09/16 傍晚 9 · 09/16 下午 9」在分析还没跑完时就在(截图里进度条还在走)✅;状态条「已导入 27 条 · 共 9 分钟」✅ `11-after-import-win.png`。**占位卡出现秒数没量到**(AX 树里 chip 列表没有可匹配的名字,轮询 20 s 没命中;截图是导入后 ~22 s 抓的,那时已在)。**观察**:分析进行中状态条只有「已导入 27 条 · 共 9 分钟」+ 进度条,**没有「· 正在分析 n/m」**(eta 估不出时整句不接)—— 与合并报告 §6 第一条同一件事,记 F-R19-12(P2) |
| 一句话挑片(P-01) | 「自动挑选精选段」面板顶部输入框 → 粘贴「挑 60 秒,风景为主,按时间顺序」+ Enter(AX 设值不触发 React,改剪贴板粘贴,粘贴前后备份 / 还原业主剪贴板)→ 12 s 后结果面板:**「7 段 · 共 56.0 s · 「挑 60 秒,风景为主,按时间顺序」」**,7 行理由都是「清晰 · 曝光正常 · 有声音」,带按时间序 0003 → 0005 → 0007 → 0011 → 0015 → 0019 → 0023 ✅ `14-prompt-select-win.png`(Retina);**⌘Z 回「3 章 · 0 镜 · 3 缺口」、面板同时收** ✅ |
| F-R19-07 修后 | 同一批 toast「…挑了 7 段 · 共 56 s · 覆盖 3 章 · 已排进镜头带」= 面板「共 56.0 s」= 实际 ✅(修前是预算 30 s) |
| F-R19-08 修后 | 「换一段 · perf_0007」(带里第 3 位)→ toast「已换成「perf_0007」· …」(同素材另一段),AX 按 x 排序带序仍是 0003 / 0005 / **0007** / 0011 / 0015 / 0019 / 0023,**位置没动** ✅ `15-replace-keeps-position-win.png` |
| 首页三张预设句卡 | 各点一次(AX 按钮名就是「旅行日记:挑 90 秒,按时间顺序,有人说话的留着」等):旅行日记 **11 段 · 88 s**;电影感 **7 段 · 56 s**;快节奏 **3 段 · 24 s**,面板头行回显各自原句(「挑 30 秒,多运动,按分数」)✅ `18b-preset-fastcut-panel-win.png`;每批 13–14 s |
| Esc 收面板 | 检查器 + 结果面板同开(`20-panel-and-inspector-win.png`)→ **一下 Esc 两层同时收** ✅ `21-after-esc-win.png`。(注:实例被最小化 / 不在可见 Space 时 Esc 送不进 WebView 而 ⌘Z 照样生效 —— ⌘Z 走菜单加速键,Esc 靠 key window;前两次「Esc 不收」是这个探针假象,不是缺陷) |
| 面板 vs mpv(播放中) | 选中 perf_0026 播放中点「自动挑选精选段 › 开始挑选」→ 面板滑出在镜头带栏右侧,画面在走(09.9 → 10.0 播完),面板完整、没被原生视图盖 ✅ `22-playing-panel-t1/t2-win.png`。**F-R19-09(P2)**:面板底色 `--surface-panel` = `--bg-elevated` 是 96–97% 透明度,镜头带镜块从面板行里透出来(浅 / 深两主题都能看见,1× 屏更明显)—— 滑出层该用不透明底(V-25 给 `--ring` 换 `--bg-solid` 的同一条理由) |
| 模型三态卡 | 设置 › 工具与模型:「画面理解模型 · 未安装(≈753 MB)· 推荐 · 安装」/「转写模型(默认质量)· 未安装(≈1.6 GB)· 安装」+「转写模型文件 · 未安装」+ 模型位置输入框 ✅ `23-settings-models-win.png`;下载中「下载中 67% + 进度条 + 取消」✅ `24-clip-downloading-win.png`;装完「已安装 + 目录路径」✅ `25-clip-installed-win.png` |
| **CLIP 真源下载** | 10:49:06 点「安装 画面理解模型」→ **~40 s** 装完(HF 钉 `36e679e…`,本机网速 ~20–120 MB/s);`models/chinese-clip-vit-b-16/` 四文件 **SHA-256 全部与清单一致**(pytorch_model.bin `7b7b583c…` 753,177,983 B;config / preprocessor / vocab 各对上);下载中只有 `.pytorch_model.bin.download` 临时名,装完无半文件。为看状态条又删目录重下两次:状态条「正在下载画面理解模型 7% → 25%」✅ `28-strip-clip-dl-t3/t9-win.png`;日志「画面理解模型已就位,补排 CLIP 向量任务 requeued=27」✅。**provider 没有 blocked → ready**:「画面识别组件 · 未安装」+「画面识别的运行环境还没就位(等带签名的组件包);模型可以先装好,组件到位后自动启用」—— QA 包不带 Python 运行环境(models 报告已点名的拍板项),所以「搜索「海边」」在这个包上验不了,不是缺陷 |
| whisper 模型卡 | 点「安装 转写模型(默认质量)」→ 1.6 GB **~60 s**,SHA `1fc70f77…` 一致;状态条「正在下载转写模型(默认质量) 0%」✅ `26-strip-downloading-win.png`;装完转写模型行的 pill 翻「模型已安装」、卡「已安装」✅ `27-whisper-installed-win.png`。档位下拉用 AX 设值 / AXShowMenu 都换不到 small,low-mem 卡未验 |
| 主题(Q-3) | 设置 › 播放与导出 › 主题只有 **跟随系统 / 浅色 / 深色** 三个,没有「剪映风格深色」✅ `29-appearance-three-themes-win.png`;点「深色」即生效 |
| 深色 Retina | `30-dark-02-selected-win.png`(2868×1834):唯一实心主按钮「下一步:导出」(青绿)、检查器滑出层、140×112 镜块、下井深灰、状态条一行 ✅;选中镜块的 `--ring-selected` 在深底上确实弱(与 tokens 报告说的 1.51:1 一致,肉眼要找)。`31-dark-results-panel-win.png`:深色结果面板 ✅(同样能看到镜块透出,F-R19-09) |
| 浅色深底(Q-4) | `21` / `22` 浅色下监视器井、镜头带、状态条深底 ✅ |
| ⌘Q | 设置改回「跟随系统」后 ⌘Q:进程退出,profile 无 `.unclean-exit` ✅ |
| **F-R19-06 判定** | 先退自己的实例再跑 `first-five-minutes.mjs --rounds 3`(脚本自起实例、临时 profile)。第一遍 **3/3 PROBE**:脚本等「已发现 N 个视频」30 s —— P-10 之后抽屉一入库就自动收,这句闪不到一秒;修 `2c3976f`(认「已导入」/「已发现」任一,抽屉已收就不按 Esc、不计点击)。第二遍 3 轮:**点击 4 / 4 / 4,新词 7,到达「交给剪映」3/3,`exportButtonEnabledBefore` = true / true / true,原生面板延迟 15.3 s / 12.9 s / 9.9 s,落地 0/3**(面板出来后脚本点「打开」没点中,90 s 超时)。**结论:F-R19-06 不是产品缺陷** —— 按钮进详情页时就是 enabled,点下去面板确实弹;之前「5/6 轮 enabled=false」是点了之后 busy 期间读到的。留两条:① 原生 `pick_folder` 面板 10–15 s 才出现(本机同时有业主在用 + 两次模型下载,负载不干净;整点再量一次);② 脚本对面板「打开」的 AXPress 不落地,秒数判据仍量不到 —— 记 F-R19-10(bench2 探针,P2)。点击数 4 ≤ 6 ✅、新词 7 > 6(多出的还是「交付」)|

### 6.5 发现(续)

- **F-R19-09(P2,记录)** 结果面板底色 96–97% 透明,镜头带镜块透出(浅 / 深都是);建议 `.results-layer` 用不透明的 `--bg-solid`。
- **F-R19-10(P2,bench2 探针,记录)** `first-five-minutes.mjs` 在原生「选择交付包保存位置」面板上点「打开」不生效,落地秒数一直量不到;需要换成真实点击(cliclick 面板按钮坐标)或给导出记一个默认目录绕过面板。
- **F-R19-11(P2,记录)** 「自动挑选精选段」弹层开着时同屏两颗实心主按钮:顶栏「下一步:自动挑选」+ 弹层里「开始挑选」(`BandAutoSelect.tsx:321` `variant="primary"`),V-01 在这个态没守住;preview-shots 没有这一帧。
- **F-R19-12(P2,记录)** 分析进行中、eta 估不出时状态条只剩「已导入 N 条 · 共 X 分钟」+ 进度条,看不到「正在分析 n/m」(合并报告 §6 已提;真机证实)。
- **探针教训(进 §4 那一类)**:① 实例被最小化 / 挪到不可见 Space 时 WKWebView 的 rAF 停,靠 rAF 加 `.is-open` 的滑出层永远停在 translateX(100%) —— 看到「面板在窗口右边界外」先查 `AXMinimized` / `CGWindowListCopyWindowInfo(.optionOnScreenOnly)`;② 键盘事件前必须核对 frontmost 是自己,否则会落进业主正在用的应用;③ 状态条的模型进度按钮 AX 名时有时无,判据看窗口级截图不看 `entire contents`。

### 6.6 结论

**可发(0.10.1)**:Wave 2 六件事真机都跑通 —— 结果面板四动作、一句话挑片 + ⌘Z、三条预设句、首次零决定、CLIP / whisper 真源下载 + SHA + 状态条进度、主题三档 + 深浅两套、导入即有地图;两条 P2 修复(F-R19-07 / 08)真机复验通过;bench 三项与菜单审计绿;退出干净。**0 P0 / 0 P1**;P2 四条(F-R19-09 / 10 / 11 / 12)与两条拍板项(CLIP 运行环境不随包分发 → 装了模型也 blocked;「换一段」不进 ⌘Z 栈)记录待下轮。

发布:v0.10.1(Wave 2,main `fc48b61`)。
