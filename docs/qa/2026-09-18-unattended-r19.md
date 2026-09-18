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
