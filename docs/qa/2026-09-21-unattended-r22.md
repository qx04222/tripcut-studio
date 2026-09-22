# 无人值守 R22 · 剪映级进度条 + 镜头带连播 · 接线 / 合入 / 真机验收(2026-09-21 → 22)

分支 `r22/integrate`,基线 main `4c0c49e`(v0.11.1)。合入 `feat/r22-scrubber`(17 提交,车道报告 `.superpowers/sdd/r21/lane-scrubber-report.md`,真机 `docs/qa/2026-09-21-unattended-r22-scrubber.md`)与 `feat/r22-playthrough`(2 提交,`lane-playthrough-report.md`);`feat/r22-band` 还在写,**不合**。判据 = 两份任务书 + 业主原话(「进度条不好用,要剪映级」「镜头带还需要连播」)。无人值守,歧义按「业主日常最顺」定并记录在 §5。

## 1. 合入

| 步 | 提交 | 说明 |
|---|---|---|
| merge A | `3d1a76b` | `--no-ff feat/r22-scrubber`,无冲突 |
| merge B | `2d6b55b` | `--no-ff feat/r22-playthrough`。冲突 2 处手工合:`src/styles/workspace.css` 头部两条 `@import`(scrubber-r22 / playthrough-r22)都留;`useMonitorTransport.seekTo` 取 playthrough 侧签名 `(seconds, options?: { source: "playthrough" }) => Promise<boolean>`(scrubber 只 `await` 不用返回值)。`Monitor.tsx` / `useStageFit.ts` / `preview-shots.mjs` 自动合并后逐个看过:`useStageFit(active, layoutKey)` 同时保留 F-R22-03 的舞台观察与连播的 `layoutKey`;`guides.ts`「连播」文案只有 playthrough 侧改,直接进 |
| 接线 | `385046f` | **先红后绿**(`ScrubberPlaythroughR22.test.tsx` 3 条先 3 红):`Scrubber` / `MonitorControls` 增 `playthrough?: PlaythroughRange` 原样透传;连播中轨道上画当前段 in→out 高亮条(`.scrubber-r22-playthrough[data-playing]`,`--playhead` 令牌)+ 轨道右侧「第 n/m 段」;用户按下 / 拖动仍是无 `source` 的 `onSeek` → 走带广播 `tripcut:manual-seek` → 连播停止、素材继续播。`MonitorPlaythrough.test` 的「人工滑杆打断」原来 `fireEvent.change` 打在 `div[role=slider]` 上(旧 `<input type=range>` 的写法,merge 后抛「no value setter」),改成 pointer 事件驱动自绘轨道并断言段带 / 标签出现与消失。`onSeek` 返回类型放宽 `Promise<unknown>`(tsc 红) |
| 测试 | `74651fe` | `MonitorPlaythrough.test` 两处 `getByRole('button',{name:'暂停'})` 改 `findByRole`:假 mpv 的 paused 翻了、界面要等下一次 80 ms 轮询才翻按钮,抢着查随机红(全量 vitest 里红过一次,单跑 12 连跑 0 红) |
| 基线 | `b14e74d` | 深色 @2x 基线:18 张过阈全部落在监视器井 / 传输条重做 + 镜头带标题条新增「连播」按钮;4 张新场景(r22-scrubber ×3、playthrough-playing);34 张 <0.1% 保留原基线(LFS 指针经 `git add` 重算,`git status` 干净) |

`src-tauri/src/player/mod.rs` 与 `4c0c49e` 零 diff。合入后 `qa/preview-baseline` 区域 diff(imgdiff,@2x):顶栏 0 / 媒体池 0 / 检查器 0 / 镜块 0–12 px / 状态条 0;差只在监视器井 + 传输条(设计)与镜头带标题条(新按钮,3798 px)。

### 1.1 门禁(`node scripts/qa/fast-gates.mjs`,树 `74651fe`+基线)

**29/29 PASS**:typecheck 0 / lint 0 错 1 既有 warning / **vitest 247 文件 1754 通过 3 todo** / vite build + check-chunks / cargo build / **cargo test 1293+1 通过 0 失败** / jianying-canary / clippy `-D warnings` / cargo-audit / npm-audit / perf-bench-100 / preview-diff-dark。第一轮两条红:`vitest`(上面那条 flaky,已修)与 `perf-bench-100`(worktree 里没有 `spikes/s2-libmpv/media` 与 `bench/fixtures/cache`——都是 gitignore 的夹具,从主仓符号链接后绿;不是回归)。`preview:shots` 浅 / 深各 54 场景 0 失败、0 console 错误。

## 2. 真机逐项

包:`旅剪工作台_0.11.1_r22-qa-b14e74d_qa_aarch64.dmg`(SHA-256 `e6f7d42b…3aae9`,`audit-dmg` **14 PASS / 0 FAIL**,adhoc)。.app 拷到 scratch 直接起可执行文件;隔离 `TRIPCUT_APP_SUPPORT_DIR=<scratch>/profileN` + `TRIPCUT_EXPORT_DIR` + `TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/` + `TRIPCUT_DISABLE_LLM_PROVIDERS=1` + `TRIPCUT_LOG=debug`;开始前 `AppleClamshellState = No`;窗口搬到第二屏 (3200,100),激活只按 pid,导入靠 `watched_folders` 播一行 + AX「立即扫描」;未碰 `~/Library/Application Support/TripCutStudio/`、`/Applications/旅剪工作台.app`。

夹具:profile1 = **27 条**(`scripts/qa/make-perf-fixtures.sh` 同批 `fixtures27`,4K HEVC 10/30/120 s + 1080p H.264 20 s);profile2 = 真 iPhone X 4K HEVC 原片 + `perf_0003` + 两条烧入计时数字的 `timer-h264-1080p` / `timer-hevc-4k`。段由真实生命周期产生:「自动挑选精选段 → 旅行日记」预设(profile1:38 段生成、**11 段排入镜头带、跨 11 条 clip、每段 8 s**;profile2:4 段 / 4 clip)。

探针(`qa/runs/2026-09-22T03-00-00Z-r22-integrate-native/tools/`,不入库):`axtext`(60–100 ms 走一遍 AX 树,抓 `播放位置` 值 / 时码 / 叠层文案 / 状态条 / 播放按钮)、`wellluma`(ScreenCaptureKit 30 fps 抓窗口,算井内 650×360 矩形平均亮度与暗像素占比,可落帧)、`pxclass`(逐帧角点色分类)、复用 scrubber 车道的 `axscrub` / `cgdrag` / `winid` / `raise` / `imgdiff` / `montage`;命令序列来自 `TRIPCUT_LOG=debug` 的 `player command` 行(Pause / SeekAbs / Play 带 clip_id)。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | 连播全程:每段 in 起 out 止 | ✅ 11 段各播 **8.02–8.19 s**(Play→Pause,run3),命令序列每段 `Pause(A) → Pause(B) → SeekAbs(B,in) → Play(B)`;AX 采样每段 pos 上限 8.33 / 11.40 / 20.87…= out 附近(采样 ~130 ms 一次);末段停在 **11.467 = out − 1/30**,按钮翻「播放」 | `run1/ax.tsv`、`run3/app.log`、`run1/end.png` |
| 2.2 | **跨 clip 切换黑屏 ms** | ✅ **0 ms**(阈 = 采样步 34 ms):run3 全程 117 s / 3444 帧 30 fps 无一帧 >90% 暗像素,run1/run3 共 20 次切换;run5(计时数字夹具)逐帧看:上一段末帧 → 封面静帧 ~70 ms → 新 clip **头两帧(000.0 / 000.1)~130 ms** → in 点帧(009.0)停 ~100 ms → 起播。**不黑,但有 ~200 ms 看得见的「错帧」**(F-R22-10,P2)。日志 Pause(A)→Play(B) 10 次中位 **272 ms**(231–365;run1 318,259–495) | `run3/luma.csv`、`run5/sw24d.png`、`run5/sw24e.png`、`run5/px.txt` |
| 2.3 | 叠层计数 | ✅ 「连播 · 第 n/11 段 · 章 1」11/11 段都出现;状态条「连播 n/11 · mm:ss / 01:28」88 个不同样本;上一段 / 下一段 / 停止 / 循环四键 AX 可达 | `run1/ax.tsv` |
| 2.4 | 结束停最后一帧 | ✅ `done` 后 pos 11.467(out − 1 帧),画面停在末段,不接媒体池「连播」 | `run1/end.png` |
| 2.5 | ⌘⇧P | ✅ 第一次:叠层出现、按钮变「停止连播」、素材在播;第二次:叠层消失、按钮回「镜头带连播」、播放停在原地(停止 = 暂停,见 §5) | AX 文本 |
| 2.6 | 拖进度条停止连播 | ✅ 连播第 1 段 4 s 时 cgdrag 3800→4100 px 1.5 s:叠层立即消失、「第 n/m 段」消失、位置落到 16.47、按钮仍「暂停」= **素材继续播不留暂停** | `drag-stop/during.png` |
| 2.7 | 连播中进度条显示段区间 | ✅ 轨道上红色段带 0.5→8.5 s + 右侧「第 1/11 段」+ I/O 把手(检查器把段的入出点带给监视器)| `drag-stop/during.png` |
| 2.8 | 拖动跟手(3 s 匀速 60 Hz,iPhone 4K HEVC 经代理,全片范围) | ✅ 落地 seek **n=43 p50 28.8 ms p90 44.6**(车道 24 / 41);status 追上播放头的墙钟滞后 **52–113 ms,中位 ~75**(车道 74);松手 24 ms 到位 | `int-hevc-drag3-samples.csv`、`-seeks.log` |
| 2.9 | 悬停预览 | ✅ 真鼠标轨迹(`cgmove` 60 Hz)从镜头带滑上轨道 → 500 ms 内 `img "悬停位置预览"` 出现在指针位;滑进画面井 → 隐;再上轨道 → 出;滑到镜头带 → 隐。**注**:`cliclick m:` 一步跳点在 WKWebView 里不产生 pointermove/leave,会看到「气泡不消失」的假象 | AX 帧 |
| 2.10 | I/O 把手 | ✅ 入点 19.5 拖过出点 27.5 → 钳 **27.4667**(1 帧);再从重叠处拖回时按到的是上层的出点把手 → 出点钳在入点 + 1 帧不动(互斥双向都对) | AX 值 |
| 2.11 | 片段放大 | ✅ 「全片」→「片段」:入点把手 4491 → 3683、出点 4504 → 4519(占满轨道),再切回原位 | AX 帧 |
| 2.12 | 时码输入 | ⚠ 探针没打通:AXPress「当前时间码」出框、System Events 逐字有时进有时丢字、Return 三种发法都没触发(cliclick 的 Esc/Return 打不进 WKWebView 是既知坑,scrubber 车道 2.10 同样备注);本轮以 `Scrubber.test`/`ScrubberPlaythroughR22` 单测 + 车道真机 2.10 为准,**人手键盘未复验** | — |
| 2.13 | 视频壳与 0.11.1 diff | ✅ 0.11.1 正式包(scratch 副本)与本包同夹具(iPhone + perf_0003,保留 mtime)、同流程(导入 → 点 iPhone 卡 → 检查器开 → 引导全部「知道了」)、同窗口 1512×945@(3200,100):顶栏 **0** / 媒体池 **0** / 检查器 **0** / 镜块区 **0** / 状态条 **0**;差只在监视器井 + 传输条(设计)与镜头带标题条(新「连播」按钮,禁用态,0 段) | `shell-base.png` / `shell-new.png`、`band-mid.png` |
| 2.14 | 菜单审计 / 原生审计 | ✅ 菜单 7 条 PASS;原生 4 通过 / 0 缺陷 / 0 探针故障 | `menu-audit.json`、`native-audit.json` |
| 2.15 | 退出 | ✅ 4 个实例(profile1 / profile2 / base / new)都经菜单「退出旅剪工作台」,`.unclean-exit` 均不存在;`update check` 走死端口 | — |

## 3. 数字

- 连播段时长(11 段,run3):8.02 / 8.15 / 8.02 / 8.12 / 8.02 / 8.12 / 8.14 / 8.02 / 8.19 / 8.05 / 8.13 s(段长 8.0)。
- 跨 clip 切换 Pause(A)→Play(B):run3 245 / 318 / 272 / 242 / 307 / 365 / 354 / 300 / 260 / 248 / 231,**中位 272 ms**;run1 中位 318。
- 黑屏:0 帧(run3 3444 帧 @30 fps;run5 994 帧)。首次开 4K HEVC 原片(冷实例、无代理)有一次 410 ms 黑(run4 `t=1189..1566`),是「首次打开素材」而非切段,0.11.1 同路径。
- 切换可见错帧(run5 计时数字):封面静帧 ~70 ms + 新 clip 头帧 ~130 ms ≈ **200 ms**;从上一段末帧到 in 点静帧 ~240 ms,到重新动起来 ~370 ms。
- 拖动:落地 seek p50 28.8 / p90 44.6 / max 252 ms;墙钟滞后中位 ~75 ms。

## 4. 发现

| 编号 | 级别 | 发现 | 处置 |
|---|---|---|---|
| F-R22-10 | **P2** | 跨 clip 切段时先看到新 clip 的封面静帧再看到它的开头两帧(000.0 / 000.1),~200 ms 后才跳到 in 点:`player_open` 是「载入即播从 0 起」,连播只能在 ready 后 Pause → SeekAbs(in) → Play。检查器「复播精选段」(`InspectorSegments.tsx:75`)是同一条路,0.11.1 已有 | **记录,不在本轮修**:根治要给 player 加「按位置暂停打开」(`loadfile … start=<in>,pause=yes`,动 `player/mod.rs`),另开车道;修完可把 2.2 的错帧从 ~200 ms 压到 0 |
| F-R22-11 | P3 | 进度条「全片 / 片段」记忆在 `localStorage`,而 WKWebView 的数据目录不在 `TRIPCUT_APP_SUPPORT_DIR` 下 —— 隔离 profile 之间共享(profile1 首次就是「全片」,是 scrubber 车道上一轮切的) | 记录。若业主要「按项目库记」应改进 settings;探针文档已注明 |
| F-R22-12 | P3(测试) | `MonitorPlaythrough.test` 两处抢在状态轮询前 `getByRole('暂停')` 随机红;merge 后「人工滑杆打断」用 `change` 事件打在 div 上直接抛错 | **已修** `385046f` / `74651fe` |
| F-R22-13 | P3(基建) | worktree 跑 fast-gates 的 `perf-bench-100` 红:`spikes/s2-libmpv/media`、`bench/fixtures/cache` 是 gitignore 夹具,新 worktree 没有 | 符号链接到主仓后绿;下轮任务书写进去 |
| — | 注 | 同一次「停止连播」(⌘⇧P 第二次 / 「停止」键)= 暂停在当前位置;拖进度条打断 = 继续播。两种打断语义不同但都符合各自直觉 | 见 §5 |

## 5. 留业主

1. **可发**:`r22/integrate` 六门禁全绿、真机 2.1–2.15 除 2.12(探针限制)全 ✅,P0/P1 为 0;`player/mod.rs` 零改动。建议发 **0.11.2**。
2. F-R22-10(切段 ~200 ms 错帧)要不要单开一条 player 车道做「按位置暂停打开」——顺带能把首次打开 4K 原片的 410 ms 黑也压掉。
3. 「停止连播」= 暂停、「拖进度条」= 停连播但继续播:这是本轮按「业主日常最顺」定的,要统一成一种就说一声。
4. 进度条范围偏好放 `localStorage`(跨项目库共享)还是进设置,业主定。
5. 时码输入真机没用键盘复验(探针打不进 WKWebView 的 Return);人手按一遍 30 秒的事。

发布:v0.11.2(main 合并 c41bfb4)
