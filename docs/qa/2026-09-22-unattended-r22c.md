# 无人值守 R22-C · 镜头带精修 接线 / 合入 / 真机验收(2026-09-22)

分支 `r22/integrate2`(worktree `~/Projects/tripcut-wt-r22-integrate2`),基线 main `bd0d426`(v0.11.2,已含 scrubber + playthrough)。合入 `feat/r22-band`(17 提交到 `9470df9`,基线 `4c0c49e`;车道报告 `.superpowers/sdd/r21/lane-band-report.md`,车道 QA `docs/qa/2026-09-21-unattended-r22-band.md`)。判据 = 任务书 `codex-task-band.md` 11 项 + 接线债两条 + 0.11.2 的 `data-playing` / `seekTo(source)` 契约。无人值守,歧义按「业主日常最顺」定并记录在 §6。

## 1. 合入

| 步 | 提交 | 说明 |
|---|---|---|
| merge | `eb6c771` | `--no-ff feat/r22-band`。冲突 3 处手工合:`src/api.ts`(scrubber 的 `frameAt` 与 band 的 `setBandOrder` / `trimBandSegment` 都留);`src/devMock/fixture.ts`(scrubber 的 `frame_at` / 波形 mock 与 band 的 300 段 / `set_band_order` / `trim_band_segment` mock 都留);`src/workspace/ShotBand.tsx`(以 band 重构版为底 —— 它拆出了 `band/useBandCommands` / `useBandViewport` 并改了 `useBandTimeline` 签名 —— 接回 playthrough 的 `PlaythroughButton`(栏标题条动作组第一颗,band 的缩放 / 「···」/ 已选工具在其后)与 `useBandPlaythrough(allChapters, …, timeline, setView)`)。`useBandArrange.ts` / `workspace.css`(头部 @import:scrubber-r22 / playthrough-r22 / tokens-r19 / band-r22 …)/ `useBandPlayhead.ts` / `lib.rs` / `preview-shots.mjs` 自动合并,逐个看过 |
| `data-playing` | 同上 | 0.11.2 用 `selectedKey={playthroughKey ?? activeSegment?.key}` 高亮当前段;band 侧改成 `selectedKeys` 集合后这条对镜块**失效**(集合分支不看 `selectedKey`)。改为 `ShotBand → BandChapterSection.playingKey → SegmentCard.playing → data-playing="true"`,样式只在 `band-r22.css` 一处(band 车道预留的钩子);`Scrubber` 自己的 `data-playing` 是另一元素,不重复 |
| 零 diff 核对 | — | `src-tauri/src/player/mod.rs`、`src/workspace/scrubber/*`、`src/workspace/playthrough/*` 与 `bd0d426` 零 diff(接线提交前) |

## 2. 接线债(`4d8098c`,先红后绿 8 条)

红:`band/playthroughWiring.test.tsx` 3 条、`playthrough/usePlaythrough.test.tsx` 3 条、`playthrough/integration.test.tsx` 1 条、`Monitor.test.tsx` 1 条,改前全红、改后全绿。

| 债 | 做法 |
|---|---|
| 连播中多选 / 框选 / 拖动段 → 停连播 | `playthrough/store.ts` 加 `releasePlaythrough()`(事件 `tripcut:playthrough-release`):`usePlaythrough` 收到后 `stop(null, keepPlaying=true)` —— 连播停、**素材继续播**(与「拖进度条停连播」同语义,不暂停)。触发点:`useBandSelection.select` 带 ⇧ / ⌘ / Ctrl 时、框选真的拉开(> 3 px,只点一下空白不算)、`useBandCommands.onDragStart`(段 / 章拖动)。单选 / 点镜块照旧由选中变化 / 人工 seek 处理 |
| 连播中修剪当前段 out → 连播用新 out | 两半:(a) `useMonitorTransport.seekTo` 的 `source` 扩到 `"band-trim"`:不广播 `manual-seek`,改广播 `tripcut:trim-seek`;`Monitor` 的 `seek-ratio` 监听把 `detail.source` 原样递给走带;`useBandPlayhead.requestSeek(clipId, ratio, { source })`(pending 也带);`useBandTimeline.trim.preview` 用它。(b) `usePlaythrough`:`deps.segments` 变了按 key 换成新入出点(当前段没了就停);`trim-seek` 到来 → phase `paused` + 暂停素材(挂起,叠层还在),段列表落地后自动回 `playing`(位置已过新 out 就接下一段);取消修剪则停在 paused,空格继续 |
| 文档 | USER_GUIDE 镜头带键位表加「连播中编辑」一行 |

## 3. 门禁 / preview / 性能(树 `102c90a`)

- `node scripts/qa/fast-gates.mjs`(共享 `CARGO_TARGET_DIR`,perf 夹具符号链接到主仓,F-R22-13):**29/29 PASS** —— typecheck 0 / lint 0 错 1 既有 warning / **vitest 262 文件 1791 通过 3 todo** / vite build + check-chunks / cargo build / **cargo test 全绿** / jianying-canary / clippy `-D warnings` / cargo-audit / npm-audit / perf-bench-100 / preview-diff-dark。
- preview:shots 浅 / 深 `--dpr 2` 各 58 场景 **0 失败、0 console 错误**。深色基线:56 张里 41 张过 0.1%,**差全部落在镜头带栏**(每张的包围盒起于带顶:2880 宽在 y≥1302 / 检查器开或音乐 y≥1006 / 130% 缩放 y≥990 / 1280 宽 y≥806),分区 imgdiff 顶栏 **0** / 媒体池 + 监视器 + 检查器 **0** / 状态条 **0**(22 / 26 两张状态条区 315 px 是 toast 阴影压边);内容 = 标题条新增缩放 / 「···」/ 已选工具、「补充排入」、mock 候选对齐原生后段数 40 → 60 镜。重拍 41 张 + 4 张 band 新场景(框选 / 拖动中 / 最小缩放 / 章折叠)与 `playthrough-playing`(当前段 `data-playing` 高亮 + 「停止连播」)共存;其余 15 张 ≤0.05% 保留。重拍后 `preview-diff --dir` **60/60 0 超阈**(`102c90a`)。
- `perf-band-r22 --band-segments 300` 合入树串行 2 次:拖动掉帧 **2.4% / 2.1%**,⌥滚轮 **1.1% / 1.6%**,拖动中渲染镜块 20(≤5% 达标;车道数字 2–4%)。

## 4. 真机

QA 包:`旅剪工作台_0.11.2_r22c-qa-102c90a_qa_aarch64.dmg`(SHA-256 `f54d1eb4ed4d173794fba07be87bedcec8a943559157066c1f10605027244269`,`audit-dmg --expect-signature adhoc` **14 PASS / 0 FAIL**;打包用 `~/Library/Caches/tripcut-build/native` 依赖根,worktree `src-tauri/target` 符号链接到主仓共享 target)。隔离 profile1(`TRIPCUT_APP_SUPPORT_DIR` / `TRIPCUT_EXPORT_DIR` / `TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/` / `TRIPCUT_DISABLE_LLM_PROVIDERS=1` / `TRIPCUT_LOG=debug`),27 条夹具(band 车道同批)经 `watched_folders` 入库 **27 / 27 分析完成**。0.11.2 正式包(Release DMG `f0e538a9…`)已解到 scratch 作壳对照。

真机分两段:09-22 00:45–08:26 EDT 会话被锁屏(`CGSSessionScreenIsLocked=1`,AX 只剩菜单栏、`screencapture -l` 拿不到图),两次 20 分钟轮询无果;08:44 真解锁后跑完下表。期间另一会话的 headful Playwright 反复抢焦点,所有合成输入前都先断言「未锁屏 + 目标 pid 在前台」(F-R22C-14),抢焦点时中止而不是打到别人窗口。逐项:

| # | 项 | 结果 |
|---|---|---|
| 4.1 | 27 条 + 自动挑选 + 排入 | ✅ 27 条入库分析完,旅行日记预设挑 89 段、排入 **4 章 · 14 镜** |
| 4.2 | ⇧ / ⌘ / 框选 + Backspace 移出 + ⌘Z | ✅ 单选「已选 1」→ ⇧ 点「已选 3」→ ⌘ 点「已选 4」;空白清选;框选「已选 6」;Backspace toast「已移出 6 段」14 → 8 镜;⌘Z「已撤销 · 移出 6 段」回 14 镜 |
| 4.3 | 跨章拖 + 吸附 | ✅ 拖 band_01 的抓手从第 1 章落到第 2 章:toast「已移动 1 段」,`story_order` 位置 1 → 5,`internal.band.layout` 里 `segment:76` 归属 1 → 2,源素材 `clips.chapter_id` **不动**;落点贴在邻块边界(吸附,像素级未量) |
| 4.4 | 拖边修剪 + 监视器跟随 | ✅ 拖出点把手左移:监视器 `播放位置` 连续跟着走 **11.50 → 11.30 → … → 9.80**,toast「已修剪 1 段」,段 85 `out_ticks` 220800 → 188160(id 与来源保留) |
| 4.5 | ⌘+/−/0、⌥滚轮 | ✅ 镜块宽 140 → 105 → 70 → 105 → 140;⌥滚轮到最小档 **49 px** 再回;`ui.band.view.<集>` = `{"zoom":1,"folded":[],"badges":false}` 静默保存;**无 toast、⌘Z 不撤视图**(F-R22C-03 决策) |
| 4.6 | 双击章改名 | ⚠️ 双击进编辑态、⌘A 选中全文都对(截图),但键盘输入被并发的 Playwright 浏览器抢焦点吃掉,未完成提交;Esc / 失焦后章名完好。**车道真机 2.10 已验过**(`docs/qa/2026-09-21-unattended-r22-band.md`),本轮记 P2 |
| 4.7 | 连播中框选 → 停连播、素材继续播 | ✅ 连播第 3/14 段时框选「已选 6」:叠层立即消失(连播停),**日志里没有 Pause 命令**,位置继续走到 8.067 = 该素材 EOF(clip 5 时长 8.067 s)—— 素材一直播到自己结束 |
| 4.8 | 连播中修剪当前段 out | ❌→ 已修待复验:真机发现连播运行时**任何段的修剪把手都按不动**(时码气泡不出、不落盘;停止连播后同一手势立即生效,探针有正控)。根因 = 连播每 80 ms 发一次进度,镜头带整栏跟着重渲染,10 px 把手拿不到指针 → **F-R22C-16 已修**(带只订阅「正在播哪一段」);另修 F-R22C-15(刷新途中空段列表掐断连播)。两条都有先红后绿单测,**真机复验留下轮** |
| 4.9 | 300 段 mock 掉帧 ≤5% | ✅ 2.4% / 2.1%(拖动)、1.1% / 1.6%(⌥缩放),见 §3 |
| 4.10 | 进度条 / 连播回归 | ⚠️ 只覆盖到连播起停、段计数、叠层与打断(4.7);进度条三项未重跑(0.11.2 已验),记 P2 |
| 4.11 | 壳 vs 0.11.2 0 diff | ✅ preview 侧 56 张分区 imgdiff:顶栏 / 媒体池 / 监视器 / 检查器 / 状态条 **0 像素**,差全在镜头带栏(§3);真机同状态截图对照未做,记 P2 |
| 4.12 | 菜单 / 原生审计 | ⚠️ 未重跑(0.11.2 已验),记 P2 |
| 4.13 | 退出无 sentinel | ✅ 四个实例退出后 `.unclean-exit` 均不存在 |

band 车道自己的真机(同一套代码、`269da50` 包,15 项 14 ✅)见 `docs/qa/2026-09-21-unattended-r22-band.md` §2。

### 4.14 探针校准(三次「假缺陷」都是探针的错,记下来)
1. 合成点击必须带 `CGEventFlags`:用 System Events 按住 ⇧/⌘ 再发 CGEvent 点击不带修饰键,⇧ 连选看起来「没实现」。
2. 合成拖动必须写 `mouseEventPressure`:不写时 WKWebView 收不到 pointerdown,修剪把手「拖不动」。
3. 接近把手的时长有个窗口:40 ms 太短(按下按的是上一次 hover 命中),≥300 ms 会弹出镜块悬停提示并吃掉按下;松手前还要留 ≥1 s 让最后一次 move 落地。
每条都先在「停止连播」状态下做正控(同一把手同一手势能修剪成功)再下结论。

## 5. 发现

| 编号 | 级别 | 发现 | 处置 |
|---|---|---|---|
| F-R22C-12 | P2(合并) | 0.11.2 的连播当前段高亮走 `selectedKey`,band 的 `selectedKeys` 集合让它对镜块失效 | 已修(`eb6c771`,`playingKey` → `data-playing`) |
| F-R22C-13 | P3(基建) | `package-dmg.sh` 写死 `$ROOT/src-tauri/target`,不认 `CARGO_TARGET_DIR`(RELEASE.md 说会认);worktree 打包要么冷编译要么把 `src-tauri/target` 符号链接到主仓 | 记录;本轮用符号链接 |
| F-R22C-14 | P3(基建) | 锁屏后真机探针全部失明且不报错(AX 树只剩菜单栏、AXPress 静默失败)—— 开跑前要断言 `CGSSessionScreenIsLocked = 0`,与查合盖并列;并发会话抢焦点时也要中止 | **已做**:`assert_ready` = 未锁屏 + 目标 pid 在前台,每次合成输入前跑 |
| F-R22C-15 | **P1**(真机) | 连播中拖边修剪 / 排入触发的刷新会掐掉连播:`refreshClipsFeed` 途中故事板短暂为空,本轮新加的「段列表变了」effect 把空列表当成「当前段被移出」就 `stop()` | **已修** `bb8fe2b`(空列表忽略,等下一拍真列表);先红后绿一条单测;**真机复验留下轮** |
| F-R22C-16 | **P1**(真机) | 连播运行时镜头带**任何段的修剪把手都按不动**(时码气泡不出、不落盘;停止连播后同一手势立即生效,探针有正控)—— 连播每 80 ms 发一次进度,整栏跟着重渲染,10 px 把手拿不到指针 | **已修** `5ab1c7e`(`usePlaythroughKey()` 只在段变化时唤醒镜头带);先红后绿一条(重渲染计数);**真机复验留下轮** |
| F-R22C-17 | P2(真机未覆盖) | 4.6 章改名、4.10 进度条三项、4.11 真机壳对照、4.12 菜单 / 原生审计本轮未跑(业主要求尽快发版收敛);4.6 键盘输入被并发 Playwright 抢焦点吃掉,车道真机 2.10 已验过 | 记录,下轮补 |

## 6. 决策(无人值守)

1. 连播中 ⇧ / ⌘ 多选、框选、拖动 = 「开始编辑」→ 连播停、素材继续播(与拖进度条一致);只点一下空白不停。
2. 连播中拖当前段把手 = 连播挂起(暂停,叠层还在),松手落地后自动继续、按新入出点算(位置已过新 out 就接下一段);取消修剪就停在暂停,用户按空格继续。理由:修剪时监视器要跟把手走,不能一边放一边跳。
3. 基线重拍阈 0.1%(不是门禁的 0.5%):差全在带栏且是设计变更,不留一堆 0.3–0.4% 的「合法差」给下轮当噪声。

## 7. 留业主

1. **下轮先补的真机**:F-R22C-15 / F-R22C-16 两条 P1 的真机复验(都已单测覆盖但没在真机上再验一遍)、4.6 章改名、4.10 进度条回归、4.11 真机壳对照、4.12 菜单 / 原生审计。
2. 决策 1 / 2 的语义要不要改(尤其「修剪挂起后自动继续」)。
3. F-R22C-13:`package-dmg.sh` 是否改成认 `CARGO_TARGET_DIR`。
