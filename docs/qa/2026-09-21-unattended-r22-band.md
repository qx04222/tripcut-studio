# 无人值守 R22-C · 镜头带精修 · 验证 + 真机手感验收(2026-09-21/22)

分支 `feat/r22-band`,基线 main `4c0c49e`(v0.11.1),本轮 16 次提交(Codex 交付按项拆 7 次 + 验证 agent 修复 / 决策 / 文档 9 次),末尾见 §1.3。未 push、未 merge。**本车道不碰** `player/mod.rs`、`MonitorSeekBar` / `MonitorControls`、`scrubber/*`、`playthrough/*`(与基线零 diff,验证过);镜头带栏标题条只在既有按钮之后追加。之后走 0.11.3(0.11.2 是 scrubber + playthrough 的接线车道)。
业主原话「镜头带功能进行精修和完善」,对照剪映时间线手感;任务书 `.superpowers/sdd/r21/codex-task-band.md` 11 项。

## 1. 做了什么

### 1.1 Codex 交付核对(任务书 11 项 + §0 决策)

| 项 | 处置 | 备注 |
|---|---|---|
| 1 选择与批量 | ✅ | ⇧ 连选 / ⌘ 点选 / 空白框选 / ⌘A;Delete 与 Backspace 都移出;「移到章」「批量评级」「移出所选」在标题条右侧;批量评级按源素材去重(同素材多段只评一次)。**验收改动**:「已选 0」不再常驻(F-05) |
| 2 拖拽手感 | ✅ | dnd 让位过渡 `--motion-fast`;自定义碰撞(段优先于章,折叠 / 空章整卡可落)+ 12 px 磁吸 modifier,⌥ 按住关;跨章、整章拖、多选整组、栏边缘自动滚动(dnd-kit autoScroll 12%)。**300 段拖动掉帧 46.5%** → 见 §3(F-01) |
| 3 修剪 | ✅ | 拖把手经 `useBandTimeline.preview → requestSeek`(既有 seek-ratio 桥)让监视器跟随;入 / 出时码气泡 + 越界「已到边界」抖一下;`[` / `]` 设到播放头;**原生新命令 `trim_band_segment` 原位改 in/out**(保留段 id / 评级 / AI 来源,按拖起时旧值校验拒绝过期覆盖)。⌥ 拖只动一边:现状本就如此(把手各自独立),写明 |
| 4 缩放与导航 | ✅ | 七档 35–300%;⌘+ / ⌘− / ⌘0;⌥滚轮以鼠标为锚(一次连击只提交一次);普通滚轮横移;按住空格拖动平移、轻按空格播放/暂停;最小档 49 px 只留色条 + 时长;刻度按像素间距抑制标签;按集记忆 `ui.band.view.<episode>`。**验收改动**:视图设置静默保存、不进 ⌘Z(F-03);最小档保留封面裁成的色条(F-05) |
| 5 章节 | ✅ | 双击改名(Enter / Esc)沿用;章头拖整章(`band-chapter:<id>` sortable);折叠记忆按集;段数 + 总时长;空章「拖段进来或删除」 |
| 6 缺口 | ✅ | 「从池里填」展开池、重置筛选、按缺口类型预填搜索;「忽略」进 ⌘Z 栈,标题条「···」可恢复;相邻缺口合成「缺 2 类:… / …」一张卡,各自保留操作。缺口**没有起止时间**,合卡不增加时长。没做「合并章节」 |
| 7 信息密度 | ✅ | 「···」开关角标(星 / ♥ / AI 理由一词,理由按需读 `list_select_segments`、最多 4 路);悬停 300 ms 提示原素材名 + in/out;`[data-playing="true"]` 样式钩子(由连播车道设属性)。**真机 P2**:提示层带了 `.shot-band` 类变成一块白板(F-07) |
| 8 撤销 | ✅ | `band/editHistory.registerBandUndo`:一次持久化操作一条 ⌘Z + 一条「已… · 撤销」toast,旧 toast 不越过较新操作(「请先撤销较新的操作」);章改名 / 并入 / 删除 / 这章够了 / 忽略缺口 / 修剪 / 排入 / 移动 / 移出全走它;文案统一「已撤销 · 移动 3 段」。⇧⌘Z 重做:栈不支持,**没做**(指南写明) |
| 9 空态 | ✅ | 「按 F 收藏几条,再点一键排入」+ secondary 按钮;带上有段时视觉文案「补充排入」、AX 名仍是冻结的「一键排入」;排入改为追加 storyboard 候选(精选段 + 收藏 / ≥3 星整条),`set_band_order` 一次写入 + 一条撤销。**mock 候选没对齐原生**(F-02) |
| 10 性能 | ⚠️→✅ | Codex 修好夹具(devMock 真产 300 段,此前只有 39 镜)但**没量出数字**(沙箱拒绝 CDP)。本轮量了:见 §3 |
| 11 截图 / 指南 | ✅ | preview-shots 四场景(框选 / 拖动中 / 最小缩放 / 章折叠)浅 / 深两套 0 失败;USER_GUIDE 键位表 |

约束核对:禁改文件全部零 diff;冻结 AX 名「一键排入 / 忽略 / 镜头带 / 镜头序列 / 拖动 …」不变;新控件 AX 名见 §5;`src/api.ts`、`src/devMock/fixture.ts` 只追加。文件行数:ShotBand 373 / BandSegment 249(拆出 BandGapSlot 180)/ MediaPool 393 / band 下新模块均 < 160。

### 1.2 先红后绿(落盘 diff 法,禁 stash)

- 25 个源文件 `checkout 4c0c49e` + `band/*` 与 `story/band.rs`、`band-r22.css` 移走,跑 25 个测试文件:**19 文件红 / 36 断言红**(多选 / ⌘A / Delete、章头拖、跨章归属、修剪 seek 桥 + `[`、300 夹具、撤销重试、刻度防重叠、缩放几何、四场景注册各一条真红;其余是模块缺失)。`git apply` 恢复后与落盘 patch **逐字节相同**(`cmp`)。
- 本轮新测试各自红过:`shotBandModel.test`「拖动期间按视口 ±1 屏 + 源章」(改前 300 段 5 章全渲染 → 红)、`band/dragWindow.test`、`band/preferences.test`(静默保存)、`interactions`「折叠 + 缩放后 peekUndo 为空」、`shotBandModel.test`「没滚动过、装得下视口不折前三章」(改前 [3] → 红)。
- Rust:`band.rs` 3 条原生测试跟 `story.rs` 改动一起交付,没单独红过(Codex 沙箱 13 条 VideoToolbox 红本机全绿)。

### 1.3 门禁(末尾树 `269da50`)

typecheck 0 错;lint 0 错 1 既有 warning(`showAllFeaturesR19.test.tsx:151`);vitest **250 文件 1732 通过 3 todo**;`vite build` + `check-chunks` PASS(15 chunk 最大 289.7 kB);`tokens.test` 40 通过;cargo build / clippy `-D warnings` 0 / **cargo test 1343 通过 0 失败**(lib 1292 + 集成;含 `story::band::tests` 3 条);`preview:shots --dpr 2` 浅 / 深两套 **0 失败**(Codex 交付原样跑是 2 失败:22-band-arranged / 26-timeline,见 F-02);单主按钮断言(preview `assertSinglePrimary` 每张 ×1)绿;`perf-band-r22` 见 §3;两个 QA 包 `audit`:ad-hoc 签名、`update check skipped: endpoint unreachable`、⌘Q 后无 `.unclean-exit`。

提交:Codex 交付 `29a5664`(原生)`2e0bb3e`(夹具)`8970af0`(1/2/8)`bdd741e`(3/4)`7b1dec4`(5/6/7/9)`af5503a`(接线 + 测试迁移)`100d2d8`(11);验证 agent `2430976` F-01、`e99c27d` F-02、`5e17bfb` F-03、`8fcf572` F-04、`7be38bc` F-05、`97b8f39` F-06、`4076956` F-07、`269da50` F-08、本文档。

## 2. 真机逐项

包:两个 QA 包(`97b8f39` → **`269da50` 最终**,SHA-256 `cf1537e6…`,`scripts/package-dmg.sh` qa 模式 ad-hoc,依赖根在 `~/Library/Caches/tripcut-build/native`),.app 拷到 scratch 直接起可执行文件。隔离:`TRIPCUT_APP_SUPPORT_DIR=<scratch>/profile1`、`TRIPCUT_EXPORT_DIR`、`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/`、`TRIPCUT_DISABLE_LLM_PROVIDERS=1`、`TRIPCUT_LOG=debug`;`AppleClamshellState = No`;激活只按 pid;导入靠 `watched_folders` 播一行 + AX「导入素材 → 立即扫描」。未碰 `~/Library/Application Support/TripCutStudio/`、`/Applications/旅剪工作台.app`。

素材:**27 条**(`band_00…26.mp4`,由 scrubber 车道的 iPhone X 4K HEVC 原片与烧时码 1080p H.264 母本 `-c copy` 切 8–20 s + lavfi 合成 1080p,`creation_time` 三天各 9 条、间隔 10 min → 4 章:第一版夹具间隔 1 h 被拆成 27 章,重打时间戳后重导)。「自动挑选精选段」6 段 + 手动 F 收藏 3 条 → 「补充排入」→ **4 章 · 9 镜**(6 段 + 3 整条)。

证据:scratch `r22band/evidence/`(截图 00–28、`trim-samples.csv`),探针 `r22band/tools/`(`axq` 通用 AX 查询、`cgscroll2` 带 ⌥ 滚轮,其余复用 scrubber 车道的 `axscrub / cgdrag / topwin / winid`;不入库)。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | 27 条导入 + 一键排入 / 补充排入 | ✅ 空态「按 F 收藏几条,再点一键排入」+ secondary;有段后按钮读「补充排入」(AX 仍「一键排入」);排入 3 条 → toast「已排入 3 段 · 撤销」;`internal.band.layout.1` 写入 9 条归属 | `02-empty-band` `04-arranged` |
| 2.2 | ⇧ 连选 / ⌘ 点选 | ✅ 点 9 → ⇧ 点 7 → 7/8/9「已选 3」;⌘ 点 2 → 「已选 4」(⌘ 必须分开发 keyDown / click / keyUp,cliclick 链式写法不带修饰键,是探针问题) | `06-shift-cmd-select` `11-shift-cmd` |
| 2.3 | 空白处框选 | ✅ 从 (300,945) 拖到 (760,850) → 2/3/4/5/6「已选 5」,框选矩形可见 | `12-rubber-band` |
| 2.4 | Delete 批量移出 → ⌘Z | ✅ Backspace「已移出 4 段」→ 9 → 5 行 → ⌘Z「已撤销 · 移出 4 段」→ 9;fwd-delete「已移出 1 段」→ ⌘Z 复原;「移出所选」按钮同路。**探针陷阱**:CGEvent 合成的 Return / Backspace / Delete / 方向键(cliclick `kp:` 与 osascript `key code`)没有字符载荷,WKWebView 报 `Unidentified`,一度把它误判成缺陷;AppleScript `keystroke return` / `(ASCII character 8/127)` 才是真按键(Chromium 与 Playwright-WebKit 里 `keyboard.press` 都正常) | `13-after-delete` `14-after-undo` `25-after-delete-undo` |
| 2.5 | 拖段跨章 | ✅ 第 1 章 band_04 拖到第 3 章 band_23 之后 → 顺序 1,10,13,22,21,23,**04**,25,26;`assignments.segment:80` 1 → 3;`clips.chapter_id` 仍是 1(源素材章节不动);toast「已移动 1 段」 | `15-cross-chapter-drag` |
| 2.6 | 拖动吸附 | ✅(观察)拖 band_13 到第 5/6 块之间按住 2.5 s:ghost 与邻块边界对齐、邻段让位 150 ms;12 px 磁吸与 ⌥ 关吸附由 `navigation.test` 覆盖,真机没有像素级测量 | `16-drag-snap-hold` |
| 2.7 | 拖边修剪 + 监视器跟随 | ✅ 拖 band_10 出点把手左移 35 px:`播放位置` 采样 5.0 → 7.0 → 6.9 … 6.0(跟着出点走);段 77 `out_ticks` 107520 → 92160(7.0 → 6.0 s),**id / `source=auto` 保留**;toast「已修剪 1 段 · 撤销」,⌘Z 复原 | `17-trim-drag-hold` `trim-samples.csv` |
| 2.8 | ⌘+ / ⌘− / ⌘0 | ✅ 140 → 105 → 70(0.75 / 0.5)→ ⌘0 140 → ⌘= 210 → ⌘⇧+ 280 → ⌘− 210;持久化 `{"zoom":…}`;**无 toast、不进 ⌘Z**(F-03) | `18-zoom-alt-wheel` |
| 2.9 | ⌥滚轮 / 普通滚轮 | ✅ ⌥ + 3 格 → 49 px(0.35)、反向 6 格 → 420 px(3);普通滚轮横移(cell 3 −444 ↔ 36)。方向:CGEvent `wheel1<0` 对应缩小,与系统「自然滚动」设置相关,不下结论 | `19-zoom-min` `21-alt-wheel-min` |
| 2.10 | 双击章名改名 | ✅ 双击 → `textbox "章节名"` 预填全选 → 输入「Dali」→ `keystroke return` → `chapters.title`=Dali,toast「已改名为「Dali」」;⌘Z 两次逐条回到「第 2 章 · 05:00-05:50」(story_history 两条 rename LIFO)。首次 ⌘Z 一次没响应(未复现) | `22-rename-editing` `23-renamed` |
| 2.11 | 章折叠记忆 | ✅ 「折叠第 3 章」→ 「5 镜 · 已收起」,`folded:["chapter:3"]`;展开后清空 | `27-fold` |
| 2.12 | 角标开关 | ✅ 「···」→「显示评级、收藏与 AI 理由角标」→ 每块 ♥ + 「AI · 清晰」,`badges:true` | `26-badges` |
| 2.13 | 悬停提示 | ✅(修后)`band_21.mp4 / 入 00:00:00.000 · 出 00:00:12.096` 紧凑气泡;修前是拖到窗底的白板(F-07) | `05-band-9`(修前)`13-after-delete`(修后) |
| 2.14 | 缺口「从池里填」 | ⚠️ 真机没覆盖:没有叙事编排就没有 `story_gaps`(要先在「附属 → 模板」编排一版,而「模板」在「显示全部功能」之后),时间盒内没做;mock 里 `preview` 22 场景与 `interactions.test`「gap pool action expands the pool …」覆盖 | — |
| 2.15 | 退出 | ✅ ⌘Q 即退,无 `.unclean-exit` | — |

## 3. 性能(第 10 项)

判据脚本 `scripts/qa/perf-band-r22.mjs`(与 `perf-scrubber-r22.mjs` 同一口径:mock 模式、CDP `Performance` + rAF 节拍算掉帧;自证:拖动中 `.band-drag-ghost` 出现、over 目标换过、缩放 `data-zoom` 真变,并记录拖动中真正渲染的镜块数)。`--band-segments 300` 与 `39` 各写 `qa/perf/r22-band-<N>.json`。

| 夹具 | 拖动 5 s 掉帧 | ⌥滚轮 ×20 掉帧 | 拖动中渲染镜块 |
|---|---|---|---|
| **Codex 交付原样** 300 段 | **46.5%**(313 / 673) | 4.9% | 300 + 章框 |
| 章级窗口放宽(±1 屏 + 源章) | 5.7% | 6.3% | ~120 |
| + items / draggingKeys memo | 4.8% | 6.7% | ~120 |
| + 段级窗口(拖动中) | **2.1%** | 6.7% | **20** |
| + ⌥缩放连击也套段级窗口(最终,串行 5 次) | 2.1 / 2.3 / 3.5 / 4.4 / 8.8%* | 0 / 0 / 1.1 / 3.7 / 4.5% | 20 |
| 39 段基线(最终代码,2 次) | 4.3 / 4.9% | 1.6 / 1.6% | 20 |

\* 那一次本机同时有别的车道的 ffmpeg(147%)与 node(151%)在跑;headless Chromium 的 rAF 节拍是 8.3 ms(120 Hz),一帧 17 ms 就算掉一帧,所以 39 段基线也有 4–5%,判据在 5% 附近对负载敏感。**结论:300 段与 39 段基线同一水平(拖动 2–4%,缩放 0–4%),≤5% 达标;Codex 原样的 46.5% 是「拖动期间关闭虚拟化、300 个 sortable 每次指针移动都重渲染」(R19 E-07 的旧数字 `idle-band300.json` 是滚动聚合指标且实际只有 39 镜,不是可比基线)。**

修法(`2430976`):`renderableChapterRange` 拖动时按真实 scrollLeft 取视口、前后各一屏、无条件保留源章(V14-02 的教训保留);`band/dragWindow.ts` 在拖动 / ⌥缩放连击中只渲染视口 ±1 屏内的段、其余合成占位(章宽 / 刻度不变),不拖不缩放时不启用(回显滚动照旧按 DOM 找镜块);SortableContext 的 items / draggingKeys 改 memo。CPU profile:剩余时间在 React 开发版(mock 是 dev 构建)对每张卡的重渲染,生产构建只会更快。

## 4. 缺陷与处置

| # | 级别 | 现象 | 处置 |
|---|---|---|---|
| F-R22C-01 | P1 | 300 段拖动掉帧 46.5%(Codex 未量、报告如实写「不能宣称 ≤5%」) | 修,`2430976`,见 §3 |
| F-R22C-02 | P1 | 「一键排入 / 补充排入」在 mock 排不出一个精选段镜块:前端改成追加 storyboard 候选,原生候选含精选段(`story.rs selected_items`),mock 只列整条 → preview 22 / 26 红 | 修 mock 对齐原生,`e99c27d`;preview 0 失败 |
| F-R22C-03 | P2(决策) | 每按一次 ⌘− / ⌥滚轮 / 折叠都弹「已缩放镜头带 · 撤销」并压一条 ⌘Z(截图里 toast 盖住镜块,连按三次三条;⌘Z 先撤缩放再撤移动) | 视图设置静默按集保存、不进 ⌘Z;失败仍回滚 + 提示。`5e17bfb` |
| F-R22C-04 | P2 | `useBandPlayhead.px` 被改成「播放的不是选中素材就不画」,连播切下一条、选择没跟上的一瞬播放头会闪没(跨车道风险) | 恢复 R13 / R17 语义,只有 `[` / `]` 用的 `positionSec` 按选中过滤。`8fcf572` |
| F-R22C-05 | P3 | 最小档把封面整个藏掉只剩淡底,一排白条分不出哪条是哪条;「已选 0」常驻标题条 | 封面按 cover 裁成色条;0 时不显示。`7be38bc` |
| F-R22C-06 | P2 | Codex 为凑 400 行删光 BandSegment / ShotBand / MediaPool 里的历史注释(Y-07 / Y-12 / R-08 / R10 U-30 / R12 §2 …)与所有空行 | 全部放回;缺口卡拆到 `BandGapSlot.tsx`、动作层拆到 `band/useBandCommands.ts`、视口拆到 `band/useBandViewport.ts`(导入路径不变)。`97b8f39` + `2430976` |
| F-R22C-07 | P2(真机) | 悬停提示 portal 到 body 时带了 `.shot-band`,吃到栏根 `workspace-pane` 布局,变成一块拖到窗底的白板 | 去掉类名,选择器改 `.band-tooltip-layer`。`4076956`;真机复验紧凑气泡 |
| F-R22C-08 | P2(基线即有,真机) | 没滚动过的带(9 镜装得下 1500 宽)点第 4 章一块,第 1–3 章立刻折成「n 个镜头」:`scrollLeft` 一直 null,退回「选中章偏移」当视口起点 | 起点按内容宽钳住(`contentWidth − viewportWidth`),真滚动过仍以 scrollLeft 为准。`269da50`;真机复验 9 块全渲染 |
| F-R22C-09 | P3(记录) | 只有 1 块的章,章头被压到 140 px:折叠箭头与序号不显示、标题「第 …」截断(基线即有) | 记,不改 |
| F-R22C-10 | P3(记录) | ⌥滚轮方向:CGEvent `deltaY<0` 是缩小;真机触控板「自然滚动」下手感与剪映是否一致没验证 | 记,业主试后再定 |
| F-R22C-11 | P3(记录) | 「···」菜单在 1500 宽窗口贴右缘时菜单右侧超出窗口一点(能点到) | 记 |

## 5. 新 AX 名(冻结名一个不改)

标题条:`button "缩小镜头带" / "重置镜头带缩放"(文案 N%) / "放大镜头带" / "镜头带更多"`(菜单 `"镜头带显示与缺口"`:「显示 / 隐藏评级、收藏与 AI 理由角标」「恢复缺口:…」);`"已选 N"`(aria-live)、`button "移到章" / "批量评级" / "移出所选"`(菜单 `"移到章"` / `"批量评级"`)。带内:`grid "镜头序列"` 加 `aria-multiselectable`、`data-segment-count`;镜块 DOM id 改为 `band-segment-<segmentId>`(整条仍 `band-clip-<clipId>`),`data-clip-id` 供回显兜底;缺口菜单新增 `menuitem "从池里填"`;空态 `button "一键排入"`(secondary);`tooltip`(悬停提示)。原生:`set_band_order`、`trim_band_segment`。

## 6. 决策(无人值守,按「业主日常最顺」拍板)

1. 视图设置(缩放 / 折叠 / 角标)不进 ⌘Z、不弹 toast(F-03);⌘Z 只撤数据编辑。
2. 一键排入改成「精选段 + 收藏 / ≥3 星整条」都排(Codex 决策,保留):空态引导写的就是「按 F 收藏几条」,旧原生 `arrange_selected_segments` 只排段、收藏整条排不进去会让这句话落空。旧命令保留没删。
3. 跨章只改段在带上的归属(`internal.band.layout.<episode>` 的 JSON,存 settings 不加迁移),源素材 `chapter_id` 与其它段不动;导出排序 / 章名读同一份布局;story_history 快照带上它。**风险**:这是一份和 `story_order` 并行的影子表,以后 `chapters` 表结构变了要一起想到;记为 0.11.3 的技术债候选(改成 `story_order.chapter_id` 列 + 迁移)。
4. 撤销失败保留条目可重试(Codex 改的语义,原来是失败即丢):换集后按 ⌘Z 会一直提示「请回到编辑时的集再撤销」直到回去,可接受。
5. 「已选 0」不显示;最小档保留封面色条。
6. 没做 ⇧⌘Z 重做(栈不支持)、没做合并章节、没做段级常驻虚拟化(只在拖动 / 缩放连击中)。

## 7. 剩余风险 / 下轮

- 缺口「从池里填」「忽略 / 恢复」「合卡」真机未覆盖(需先编排出缺口);⌥ 关吸附、12 px 磁吸真机只有观察没有测量。
- 拖动中段级窗口把视口外的镜块换成占位:自动滚动到远处时,新进入窗口的块是逐帧补渲染的(真机 9 镜看不出;300 段下滚到底时可能看到块「冒出来」),可接受但记下。
- `perf-band-r22` 在 5% 判据附近对本机负载敏感(39 段基线自己就 4–5%),跑它时别并发别的车道的 ffmpeg / QA 包。
- Delete / Backspace / Return / 方向键的真机探针必须用 AppleScript `keystroke` 常量,CGEvent 裸 keycode 打不进 WKWebView(已写进本文 2.4,建议进 memory)。
