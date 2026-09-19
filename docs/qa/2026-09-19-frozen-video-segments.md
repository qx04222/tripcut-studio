# 2026-09-19 · 「挑选好的片段只有音频动、画面不动」排障

业主报告(v0.10.1,本机 M5):监视器预览精选段、以及导出的片段文件,都是声音在走、画面不动。
基线 main `5792f22`;工作分支 `fix/frozen-video`(worktree `~/Projects/tripcut-wt-fix-frozen`)。
所有取证产物在会话 scratchpad `…/0b1eb8a1-…/scratchpad/`(下文简写 `$S`);业主的
`~/Library/Application Support/TripCutStudio/default/` 只拷到 `$S/evidence/` 读,没有写、没有用它起应用。

## 1. 现象与结论(先说结果)

| 侧 | 结论 | 根因 |
|---|---|---|
| 应用内监视器 | **复现并定根因,已修(三处)** | ① 任一「新手引导」气泡(1/9 … 9/9)在屏时,`Guide` 无条件向播放器登记遮挡 → Rust `player_set_occluded(true)` → 原生 mpv `NSView.setHidden(true)`;监视器露出的是井底封面 `cover.jpg`,mpv 本身照常播放(时间码、音频都在走)。业主装的是新库,九条引导一条没看过,挑完段一进监视器就有气泡,画面就「不动」。② 检查器「复播精选段」自 R17 起对换过的素材整个哑掉(闭包里的 clipId 是首次挂载那条,后端按归属拒)。③ 复播绕过监视器,停表中的监视器不知道已经在放,时间码 / 播放键停在旧值 |
| 导出的片段文件 | **没有复现**——真包在同一批真实 iPhone 素材(HEVC 10-bit HLG 杜比视界 / HEVC 8-bit / H.264,30/60 fps,带 AAC)上导出的 6 段,ffprobe、AVFoundation(QuickTime 同一解码栈)、QuickTime Player 实播三者都是逐帧不同、画面在动 | 未定。一个可解释「两边都不动」的候选:业主在应用里看导出结果(应用是 mp4/mov 的 Alternate 打开方式;在应用内看=还是同一个被遮挡的监视器)。另抓到一条副产物:每段 60 fps 带音轨的导出都被打了假黄标(见 §5.4),会让人以为文件坏了 |

**两边不是同一根因**:预览侧是界面遮挡,不是解码 / 渲染 / 关键帧问题;导出侧的文件本身在我能跑到的所有路径上都是好的。

## 2. 取证

### 2.1 业主 profile(只读拷贝)

- `project.db`(schema 49):`clips` 0 条、`segments` 0 条、`cache_artifacts` 0 条;唯一一条 `exports`/`export_package` 是 09-02 指向旧 scratchpad 的测试导出。`settings` 里 `onboarding.*` 有、**`guide.*.viewed` 一条都没有**(九条引导全未看过)。
- 五个 pre-migration 快照(v26/v41/v43/v44/v48)与 `dev/` profile 同样没有 `kind='select'` 的段。
- `logs/tripcut.log.2026-09-19`:四次启动(13:21 装 0.10.1 迁到 v48→49),`census clips: 0`;除 channel-memory 的重复 WARN 外,没有 player / export / mpv 的 error。
- 所以业主「挑过的段」的数据本身已不在库里(09-14 清过库,`removed_clip_high_water=12`);无法按段复现,改用本机真实 iPhone 素材做同形状复现。

### 2.2 复现素材

`~/百度网盘/手机视频备份/` 里 70 条真机片,挑 7 条拷到 `$S/real-fixtures/`:

| 文件 | 编码 | 备注 |
|---|---|---|
| IMG_6186.MOV / IMG_5034.MOV | hevc Main 10, yuv420p10le, arib-std-b67(HLG), **DOVI configuration record**(profile 8), 59.94 fps, B 帧 2, tb 1/600 | iPhone 杜比视界默认档 |
| 12853_raw.MP4 | 同上,3840×2160 | |
| IMG_3650.MOV / IMG_3745.MOV | hevc Main 8-bit bt709 30 fps | |
| IMG_2309.MOV / IMG_1232.MOV | h264 High bt709 30 fps | |

## 3. 复现:导出侧(文件是好的)

### 3.1 ffmpeg 层(包内 `/Applications/旅剪工作台.app/Contents/MacOS/ffmpeg` 7.1.5)

`$S/repro/cut.sh` 按 `deliver.rs::select_segment_copy_args`(`-ss` 前置 + `-c copy -tag:v hvc1 -fps_mode passthrough -avoid_negative_ts make_zero`)和 `select_segment_ffmpeg_args`(`-ss … -accurate_seek` + `h264_videotoolbox -allow_sw 1`)各生成一份,源 IMG_6182.MOV(杜比视界 HLG),入点取关键帧 1.001667 s:

```
copy : hevc hvc1 Main10 yuv420p10le, nb_frames=242, DOVI record 被丢(只剩 ambient viewing)
       first 8 frames pts/dts: 902/870 I, 1222/1190 B, … 全部可解
       AVFoundation: frames decoded 243, identical_consecutive 0, distinct 243
x264 : h264 avc1 yuv420p, nb_frames=180, AVFoundation 181 帧全不同
```

AVFoundation 读帧器 `$S/tools/avreader.swift`(AVAssetReader + 逐帧像素哈希)就是 QuickTime 的解码栈。

### 3.2 真包导出(v0.10.1,隔离 profile,交给剪映)

profile `$S/ab/prof-export`(本轮自己导入的 7 条 + 手工插的 5 条精选段,含关键帧入点 3002/600 与非关键帧入点 3300/600),`ui.export.last_dir` 预先指到 `$S/export-out` 绕开原生保存面板;job 80 `done`,「已导出 6 个片段」:

| 输出 | 探测 | AVFoundation |
|---|---|---|
| 01_…IMG_3745.mp4(整段 0–3820) | hevc hvc1 30 fps 191 帧 | 192 帧 distinct 192 |
| 02_…IMG_2309.mp4 | h264 29.97 fps 90 帧 | 91 / 91 |
| 03_…IMG_5034.mp4 | h264 arib-std-b67 59.94 fps 300 帧 | 301 / 301 |
| 04_/05_…IMG_6186.mp4(关键帧入点 / 非关键帧入点) | 同上 300 帧 | 301 / 301 |
| 06_…12853_raw.mp4 | h264 59.94 fps 179 帧 | 180 / 180 |

QuickTime Player 实播 04_…IMG_6186.mp4(`osascript play` + 每秒 `screencapture -l`):相邻两秒画面差 319,946 / 320,000 像素——在动。整条 remux(`remux_clip` 形状,杜比视界源 `-c copy -tag:v hvc1`)AVFoundation 2721 帧全不同。

结论:关键帧判定(`best_effort_timestamp == in_ticks`、`key_frame` 缺省当 1)、`-ss` 前置 + `make_zero` + B 帧、`hvc1` 标签、10-bit/HLG/杜比视界源,在这批素材上都**没有**产出冻结文件。没覆盖到的见 §7。

## 4. 复现:预览侧(界面遮挡)

### 4.1 判据装置

真包 `/Applications/旅剪工作台.app`(0.10.1)以 `TRIPCUT_APP_SUPPORT_DIR=$S/…` 隔离 profile 启动(只杀自己起的 pid);AX 点击走 `System Events`(`$S/tools/ax.sh`);每秒 `screencapture -x -l <windowid>`;`$S/tools/cropcmp`(Swift,CoreGraphics)比监视器井区域(1690×1050 像素)相邻两张差多少像素。**动 = 百万级像素差;不动 = 0–416(416 是井底的 seek 轨道在动)。**

### 4.2 观测

| 场景 | 相邻秒像素差 | 时间码 |
|---|---|---|
| IMG_6186(HLG)按「播放」 | 416 / 416 / 416 / 416 | 06.5 → 37.6 在走 |
| IMG_3650(SDR)按「播放」 | 239 / 224 / 278 | 05.7 → 33.9 |
| 同上,暂停、前进/后退一秒 ×11 | 0 / 362 / 370 | 33.9 → 22.9(**seek 也不刷画面**) |
| 冻住的画面 vs `cache/2/cover.jpg` | 同一张(构图、人物位置一致) | — |
| **新手引导 1/9 在屏**,IMG_3650 播放(`$S/bins/prof-guide`,清掉 `guide.*`) | 239 / 224 / 278 | 走 |
| 「知道了」点掉九条引导后再播 | **1,132,684 / 1,092,494 / 1,353,415** | 06.1 |
| 合成夹具 perf_0004(无音轨)+ 1/9 在屏 | 416 / 416 | 走 |

冻住时看到的图 = 井底封面(`Monitor.tsx` 第 316 行注释里写明:被 `player_set_occluded` 遮挡时露出来的是封面);去掉气泡的**唯一**变量差异就让画面回来。

排除项(每项都跑过):A/B 三个构建(v0.9.1、v0.10.0 DMG,fresh `cargo build --release`,debug 构建 + homebrew libmpv,debug 构建 + 包内 LGPL libmpv)、`$S/tools/mpvprobe.c`(包内 libmpv + `vo=libmpv` + `hwdec=videotoolbox` 离屏 render API 装置:带音轨 5 s 内 148 帧渲染、`vo_drops=2`、`ao=avfoundation`)、代理有无音轨——起初「去掉音轨就动」是**混淆变量**(那份 profile 当时已经把引导点完了),§4.2 的对照实验才是定论。

### 4.3 代码路径

`src/workspace/ui/Guide.tsx:65` `useOccludesPlayer(target !== null)`(注释:「画出来的时候让视频让位,比算几何简单」)→ `modalStack.pushOccluder` → `usePlayerOcclusion` → `player_set_occluded(true)` → `player/mod.rs::set_surface_hidden` → `NSView.setHidden(true)`。九条引导(`guides.ts`)锚点:导航条、状态条 ×2、精彩度条、自动挑选按钮、镜块、缺口卡、导出抽屉、连播开关——只有精彩度条 / 连播开关两条真会压到画面。

## 5. 修复(四条,一条一个提交;都没动 `src-tauri/src/player/`)

### 5.1 引导气泡不再无脑藏画面(`src/workspace/ui/Guide.tsx`)

- 遮挡按几何判:气泡矩形与 `.player-native-slot`(mpv 画面节点)矩形相交才登记;没有画面节点或 0 尺寸时不登记。
- `placeBubble(rect, side, viewport, bubble, avoid?)`:首选侧压到画面而另一侧躲得开就换侧(精彩度条 / 连播开关那两条会从画面下沿换到下方);不给 `avoid` 时行为与以前完全一样。
- 两侧都躲不开(`nav` 那条挂在导航条下、正压在画面上沿)而画面正在放:气泡**让位**(`hidden`,不登记遮挡),播放一停原地出现——`guides.ts` 新信号 `playing` 由 `notePlayerStatus` 报(Monitor 每次状态回写都会调),`GuideHost` 透传 `yieldWhilePlaying`。Y-02 的底线不破:气泡在屏时原生层永远不会盖住它。
- 测试 `Guide.test.tsx` +8、`guides.test.ts` +1,先红后绿;原 Y-02 断言迁移为「压到画面时遮挡」,未删。

### 5.2 检查器「复播精选段」整个哑掉(`src/workspace/InspectorSegments.tsx`)——取证时撞出的第二个真缺陷

`replay` 的 `useCallback` 依赖是 `[]`,闭包里的 `clipId` 永远是首次挂载那条;R17(`1272fa3`)起 `player_command` 按素材归属拒命令,换过素材后按「复播」后端回「命令属于已换掉的素材」,界面上什么都不发生。用带 `tracing` 的 debug 包抓到:`SeekAbs { seconds: 10.008 } clip_id=Some(2) result=Err("命令属于已换掉的素材")`(当时监视器开的是 7)。改 `[clipId]`;测试:换素材后复播必须带新 id、不带旧 id(先红后绿)。**这条就是业主「预览精选段」的入口**——修 5.1 之前它就已经不播,修了 5.1 之后才暴露出来。

### 5.3 复播后监视器的表要重新走(`src/PlayerOverlay.tsx`、`InspectorSegments.tsx`)

监视器暂停时停表(80 ms 轮询只在播放中跑),检查器绕过监视器直发 seek + play 后,时间码 / 播放键 / `signals.playing` 全停在旧值——画面在动但界面像没反应,5.1 的让位也拿不到「在放」。新增 `PLAYER_STATUS_REFRESH_EVENT`:检查器发完命令广播一次,`PlayerOverlay` 收到补读一次状态。测试 `PlayerOverlay.test.tsx` +1、`InspectorSegmentsR16.test.tsx` +1,先红后绿。

### 5.4 导出黄标误报(`src-tauri/src/core/deliver.rs::pts_boundary_warning`)

真包导出的 6 段里 5 段被打「⚠ 黄标:PTS 边界偏差超过 1 帧(首帧 0.023000s …,1 帧 0.016685s)」:0.023 s 正是 AAC 编码器延迟(1024/44100)被 `make_zero` 整体前推的封装偏移,`validate_output_pts_bounds` 早已按 `MUX_SHIFT_ALLOWANCE_SECONDS` 放过,给用户看的黄标却按 1 帧硬判,60 fps 带音轨必中。改成同一把尺:首帧容 1 帧 + 封装偏移,段长(尾 − 首)仍只容 1 帧。三条单测先红(1 条)后绿,原 `pts_difference_over_one_frame_becomes_yellow_warning` 仍绿。

## 6. 门禁与证明

门禁(worktree,`5792f22` + 本分支):`npm run typecheck` 0 错;`npm run lint` 0 错 + 1 条 main 上就有的 warning(`showAllFeaturesR19.test.tsx:151` 未用的 eslint-disable);`npm run build` 通过;`check-chunks.mjs` 2/2 PASS;`cargo build` / `cargo test`(lib 1122 绿 + 4 ignored,集成全绿)/ `cargo clippy --all-targets -- -D warnings` 全绿。vitest:改动前后各一次整套 **204 文件 / 1529–1534 绿 + 3 todo**;之后两次整套跑在机器忙时各红 11 / 2 条(全是抽屉 / 设置 sheet 懒加载 chunk 的 5 s 超时),7 个红文件单独跑 **120 / 120 绿**,把改动 stash 掉在 `5792f22` 上整套跑同样红 14 条——是本机负载下的既有抖动,不是回归(CLAUDE.md 的「红文件是嫌疑名单,单跑决定」)。

证明(`$S/bins/fixed.app` = 装机包换入本分支 release 二进制;`$S/tools/replayrun.sh`、`guiderun.sh`;每秒窗口截图比井区像素):

| 场景(九条引导全未看过,1/9 在屏) | 装机 0.10.1 | 本分支 |
|---|---|---|
| IMG_3650 按「播放」,相邻秒像素差 | 239 / 224 / 278(不动) | **1,193,505 / 1,243,815 / 1,296,184**(动),气泡让位,播完气泡回来 |
| IMG_6186(杜比视界 HLG)按「复播精选段 1」 | 0 / 0,时间码停 06.5、按钮仍「播放」,气泡 1/9 | **1,510,519 / 1,021,986**,时间码 10.2、按钮「暂停」、气泡让位;按「暂停」后气泡 1/9 回来 |

## 7. 未覆盖 / 待业主

- 业主真实那几段的源文件与导出文件都不在了,导出侧只能按同形状素材证明「没复现」。若业主手里还有一份「画面不动」的导出文件,请连同同目录 `.tripcut-complete.json` 一起给我:`ffprobe -show_frames -select_streams v` + AVFoundation 读帧两分钟就能定。
- 没测:ProRes / Log、4K 60 HEVC 杜比视界 profile 8.4 以外的档、竖拍 rotation、VFR 真机片(本批 iPhone 片 `is_vfr=0`)。
- `first-five-minutes.mjs` 真机装置在导出一步仍卡在原生保存面板(F-R19 已知),本轮用 `ui.export.last_dir` 预置绕过;装置本身没改。
- 气泡真压到画面、**且播放器没在放**时,仍是「藏画面露封面」(暂停态本来就不动,没有感知差);要不要干脆把 `nav` 那条锚到别处,业主看了再定。
- `first-five-minutes.mjs` 一类装置的 `screencapture -l` 抓得到 `.ui-guide` 气泡(本轮每张都抓到了),与 R19 报告里「窗口级截图抓不到气泡」的记录相反;没查原因。
- v0.10.2 发布前跑 `preview-diff.mjs` 三次,`29-entity-menus`/`34-move-to-episode` 轮流随机报 ~2% 超阈值,但把同一张截图与基线逐像素重放完全一致(diffPixels=0)——是报告级噪声,疑似截图时序,不是本次改动引入的视觉差异,基线未动,留给 W2 tokens 收尾排查根因。

发布:v0.10.2(main d7be122)
