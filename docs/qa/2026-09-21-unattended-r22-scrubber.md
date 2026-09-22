# 无人值守 R22-A · 剪映级监视器进度条 · 验证 + 真机手感验收(2026-09-21)

分支 `feat/r22-scrubber`,基线 main `4c0c49e`(v0.11.1),本轮 16 次提交(Codex 交付 3 次按编号项拆分 + 验证 agent 修复 / 撤回 / 诊断 / 文档 13 次),末尾见 §1。未 push、未 merge。
业主原话「视频剪辑截取出的片段播放的时候,进度条/轨道条不是很好用,需要类似剪映级别的进度条设置」是本轮判据;任务书 `.superpowers/sdd/r21/codex-task-scrubber.md` 9 项。

## 1. 做了什么

### 1.1 Codex 交付核对(任务书 9 项)

| 项 | 处置 | 备注 |
|---|---|---|
| 1 自绘轨道 | ✅ | `Scrubber.tsx` 替换 `<input type=range>`;刻度 1/2/5/10/30/60 s 自适应、播放头 + 把手、已播填充、波形、热力(`MonitorHeatStrip` 原数据)、入出区间;`role=slider` + `aria-label="播放位置"` + `aria-valuenow/min/max` |
| 2 帧级拖动 | ✅(exact) | pointerdown 即 seek,1/fps 量化,rAF 合并,串行只留最后一个待发目标;拖动前暂停、松手恢复。关键帧粗定位**做了又撤了**,见 §3 |
| 3 悬停预览 | ✅ | 后端新命令 `frame_at`(ffmpeg 抽 160×90,硬解失败转软解,原子写入,每素材 200 张 mtime-LRU,媒体服务器只对 `scrub-<hash>-<ms>.jpg` 签短期 URL);前端 150 ms 合并 + 去重缓存。真机两处修(F-R22-02 / F-R22-06) |
| 4 入出点把手 | ✅ | `slider "入点" / "出点"` 与原按钮共存;拖过对方钳到 1 帧间隔;区间时长气泡 |
| 5 精选段放大 | ✅ | in−10%…out+10%,`button "切换进度条范围"`,`localStorage tripcut.scrubber.range` 记住;段外灰化 |
| 6 时码可编辑 | ✅ | `textbox "输入时间码"`,`mm:ss.ff` / `ss.ff`,Enter 跳、Esc 取消、非法标红 |
| 7 键盘 / 滚轮 | ✅ | ←/→ 一帧、⇧ 十帧、Home/End 到入/出点;滚轮 non-passive。⇧+滚轮真机不动 → F-R22-07 修 |
| 8 主题 / 截图 | ✅ | `scrubber-r22.css` 全令牌,`@import` 在 `workspace.css` 头部;三场景进 `preview-shots`(Codex 沙箱起不来浏览器,本机跑通,深浅两套都看了图) |
| 9 性能 | ✅ | `perf-scrubber-r22.mjs` 5 s 拖动 CDP:掉帧 1/606(0.17%)≤ 5%。**Codex 版对着被盖住的轨道空转也报 0 掉帧** → 加「拖动中 aria-valuenow 取过 ≥3 个值」自证 |

约束核对:`src-tauri/src/player/mod.rs` 与 `4c0c49e` **零 diff**(§3 的关键帧命令加了又整体撤回);冻结 AX 名「播放位置 / 入点 / 出点 / 保存片段 / 全屏沉浸」全在(`MonitorControls.test` V-05 循环断言 + 真机 AX 树);`Monitor.test` 23 / `MonitorControls.test` 13 / `MonitorR17Playfix.test` 5 / `MonitorSeekBarR17.test` 1 / `axNames.test` 13 的 `it` 计数与基线一致,无删断言,迁到 `aria-valuenow` / pointer 事件。

### 1.2 先红后绿(落盘 diff 法,禁 stash)

- 前端:7 个源文件 `checkout 4c0c49e` + 8 个 scrubber 新源文件移走,跑迁移过的 6 个测试文件 + tokens:**16 红 / 3 文件编译红**;`git apply` 恢复后 `diff` 与落盘 patch 逐字节相同。
- Rust:`media_server.rs` 回基线 → `scrubber_frames::tests::rejects_invalid_seconds_and_names_are_strict` **红**(签名拒绝 scrub 文件名);恢复后 4/4 绿。
- 本轮新测试各自红过一次(F-R22-03 `useStageFitR22.test`、F-R22-02 / 04 / 06 `ScrubberPreviewR22.test`、F-R22-05 / 07 `ScrubberReleaseR22.test`),红的截图在 §2 每行注明。

### 1.3 门禁(末尾树 `cbf898b`)

typecheck 0 错;lint 0 错 1 既有 warning(`showAllFeaturesR19.test.tsx:151`);vitest **242 文件 1730 通过 3 todo**;`vite build` + `check-chunks` PASS(15 chunk 最大 289.7 kB);`tokens.test` 40 通过;cargo build / clippy `-D warnings` 0 / **cargo test 1344 通过 0 失败**(lib 1293 + 集成;Codex 沙箱报的 13 条 VideoToolbox 红本机全绿);`preview:shots` 浅 / 深两套 **0 失败**(`16-heat-strip` 剧本改了两处,见 §4);`perf-scrubber-r22` PASS(掉帧 0.17%);`audit-dmg` 13/13 PASS(adhoc);`menu-audit` 7 条 PASS;`native-audit` 4 通过 / 0 缺陷。

## 2. 真机逐项

包:七个 QA 包(`aa2c7fb` Codex 原样 → `a32702a` → `9138bb5` → `d57313a` → `16635e3` → `9f24d9b` → **`6c4db3d` 最终**,SHA-256 `6966a9a2…78f89`,`src-tauri/target/release/bundle/dmg/`),.app 拷到 scratch 直接起可执行文件。隔离:`TRIPCUT_APP_SUPPORT_DIR=<scratch>/profileN`、`TRIPCUT_EXPORT_DIR`、`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/`(日志 `update check skipped: endpoint unreachable`)、`TRIPCUT_DISABLE_LLM_PROVIDERS=1`、`TRIPCUT_LOG=debug`;开始前 `AppleClamshellState = No`;激活只按 pid,导入靠 `watched_folders` 播一行 + AX「立即扫描」;窗口搬到第二屏(3200,100)并用 `CGWindowList` 逐点确认最上层是本 pid,再发 CGEvent。未碰 `~/Library/Application Support/TripCutStudio/`、`/Applications/旅剪工作台.app`。

素材(`<scratch>/fixtures`):**真 iPhone X 4K HEVC** `iphone-hevc-4k.mov`(`mdfind` 命中 `~/百度网盘/手机视频备份/763109451776335778.MOV`,只读复制,3840×2160 30p Main,30.49 s,关键帧 1 s;前后 SHA-256 `ca84c6b5…` 相同)+ `make-perf-fixtures.sh` 同命令的 1080p H.264 `perf_0003.mp4`(20 s,GOP 8.3 s)+ 两条烧入大号计时数字的 `timer-h264-1080p.mp4` / `timer-hevc-4k.mov`(1 s GOP,用来肉眼比对画面时码)。

证据:`qa/runs/2026-09-21T23-00-00Z-r22-scrubber-native/`(截图、`*-samples.csv`、`*-seeks.log`、`*-clicks.log`、`lag-*/montage`、探针源码 `tools/`,`SHA256SUMS.txt`;不入库)。探针:`axscrub`(只读 AX,20 ms 采样 `播放位置.AXValue` 与 `当前时间码.AXHelp`)、`cgdrag`(60 Hz 匀速 CGEvent 拖动)、`cgscroll`、`axhit`、`imgdiff`。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | **拖动跟手**(3 s 匀速 60 Hz,4K HEVC 经代理) | ✅ 拖动中 status.pos 落后播放头 0.13–1.4 s 画面时间,追上播放头的墙钟 **中位 74 ms**(45–191);松手后 25 ms 内到位。见 §3 表 | `p7-hevc-fast-samples.csv`、`lag-hevc4k/m1s.png`(计时数字逐帧连续) |
| 2.2 | 每次 seek 落地耗时(player 自量 命令→PlaybackRestart) | ✅ 4K HEVC 代理 **中位 24 ms**(p90 41);1080p H.264 中位 69 ms(p90 101,GOP 8.3 s 所致);4K HEVC **原片**(代理关)中位 101 ms(p90 172)| `p7-*-clicks.log`、`landed.py` |
| 2.3 | 点击跳转 | ✅ 点 x=4108 → 期望 15.26 s,落 15.07 s(1 帧量化 + 把手宽) | `f-02-hevc-full.png` |
| 2.4 | 悬停缩略图 150 ms 出、移出即隐 | ✅ 修后:缓存命中 103–184 ms 出图;未缓存 ~380 ms(4K 抽帧)—— 修 F-R22-06 后 150 ms 先出时码气泡再补图;移到走带行 / 画面井都立即隐 | `f-03-hover.png`、`f-12-dark-hover.png` |
| 2.5 | 入/出点把手拖动与互斥 | ✅ 入点把手从 19.5 拖过出点 27.5 → 钳在 27.467(1 帧);拖回 21.4;区间气泡「00:00.1」 | `f-07-handle-drag.png` |
| 2.6 | I / O 键 | ✅ 点轨道 8.83 s 按 I → 入点 8.831;点 18.10 按 O → 出点 18.096 | AX 值 |
| 2.7 | ←/→ 一帧、⇧ 十帧、Home/End | ✅ 18.096 → → 18.129(+1/30)→ ⇧→ 18.463(+10/30)→ Home 8.831(入点)→ End 18.096(出点);每次一条 `SeekAbs` | 命令日志 |
| 2.8 | 滚轮 | ✅ 一格一帧;⇧+滚轮 macOS 发成 deltaX → **F-R22-07** 修后 vitest 覆盖(真机 ⇧+滚轮走 `cgscroll shift`,修前不动) | `ScrubberReleaseR22.test` |
| 2.9 | 精选段放大 / 全片切换 | ✅ 「片段」入点把手 x=3683 出点 4519(占满);「全片」3887 / 4199;记住上次(重选素材保持) | `f-10-zoom-segment.png` |
| 2.10 | 时码输入 | ✅ 输入 `00:12.15` Enter → 12.499;`03.07` Esc → 不动;`99.99` Enter → 标红留在框里,Esc 取消。**注**:System Events `keystroke` 一次性发整串会乱序(`0012:15.`),逐字发才对,是探针问题 | `f-08-timecode-invalid.png` |
| 2.11 | 拖动中暂停、松手恢复 | ✅ 播放中按下 → `Pause` → 65 条 `SeekAbs` → 松手 `Play`,按钮从「暂停」→「播放」→「暂停」 | 命令日志 |
| 2.12 | 5 s 拖动 CDP 掉帧 | ✅ 1 / 606 帧(0.17%)≤ 5%;LayoutCount +302 / RecalcStyle +584 | `qa/perf/r22-scrubber.json` |
| 2.13 | 视频壳与 0.11.1 截图 diff(传输条除外) | ✅ 同一夹具、同 profile 副本、同状态(选中 iPhone 片、检查器开):顶栏 0 / 媒体池 0 / 检查器 0 / 镜头带 + 状态条 0 像素差;差只在监视器井(井高从 590 → 480,画面按 16:9 缩)与传输条(设计变化) | `diff-base.png` / `diff-r22.png`、`imgdiff` |
| 2.14 | 深色主题 | ✅ 全部走令牌,轨道 / 气泡 / 把手在深色下正常;`preview:shots --theme dark` 三场景 PASS | `f-11-dark.png`、`f-12-dark-hover.png`、`dark/r22-*.png` |
| 2.15 | 菜单审计 / 原生审计 / 退出 | ✅ 菜单 7 条 PASS;原生 4/4;每个包 ⌘Q(菜单项「退出旅剪工作台」)后 `.unclean-exit` 不存在(7 次) | `menu-audit-p7.json`、`native-audit-p7.json` |

## 3. 延迟数字表与「关键帧 seek」的处置

**结论:没加 `seek_abs_keyframes`。** 加过(`47b0057`)、真机 A/B 量过、撤回(`9f24d9b`);`player/mod.rs` 回到零改动。

### 3.1 exact seek 落地耗时(player 线程自量,`TRIPCUT_LOG=debug` 的 `seek landed` 行;点击 20 次取「落地 pos = 目标」的样本)

| 素材 | 路径 | n | p50 | p90 | min–max |
|---|---|---|---|---|---|
| iPhone X 4K HEVC 30p | **代理 960×540 H.264(默认开)** | 20 | **24 ms** | 41 | 16–73 |
| iPhone X 4K HEVC 30p | 原片(代理关) | 16 | **101 ms** | 172 | 45–206 |
| 1080p H.264 `perf_0003`(GOP 8.3 s) | 原片(≤1080p 不产代理) | 20 | **69 ms** | 101 | 45–127 |
| 1080p H.264 `timer`(GOP 1 s) | 原片 | 12 | 56 ms | 81 | 49–187 |

### 3.2 拖动跟手(3 s 匀速 60 Hz,每 ~360 ms 取一个采样;「墙钟滞后」= status.pos 追上该时刻播放头值所需时间)

| 素材 / 模式 | 画面时间落后播放头(s) | 墙钟滞后 ms | 拖动中落地 seek 数 |
|---|---|---|---|
| 4K HEVC 代理,exact(最终) | 0.13–1.40,中位 0.63 | **45–191,中位 74** | 52 / 3 s |
| 4K HEVC 原片,exact(`a32702a` 包) | 0.80–1.43,中位 0.93 | **44–286,中位 93** | 1 / 3 s(后续 seek 冒领了 PlaybackRestart) |
| 4K HEVC 原片,**keyframes 拖动 + exact 松手**(`d57313a` 包) | 2.37–3.63,中位 2.7 | **239–461,中位 ~360** | 0(不计入) |
| 1080p H.264 GOP 8.3 s,exact | 0.30–1.27,中位 0.43 | 46–293,中位 92 | 26 / 3 s |

撤回原因:`absolute+keyframes` 每次 `mpv_command` 都要等前一条 seek 处理完(命令日志两条命令间隔稳定 ~210 ms,exact 模式为 ~42 ms),4K HEVC 上关键帧定位并不比 exact 便宜 —— 反而更卡。真机 p50 也不到 80 ms(代理 24 ms),任务书的「>80 ms 才切」条件在默认路径不成立。Codex 报告里 decoder-only 的 58 ms 中位是 `--vo=null` 的独立 mpv,不是渲染路径,不能外推,已如实标注。

## 4. 发现

| 编号 | 级别 | 发现 | 处置 |
|---|---|---|---|
| F-R22-01 | P1 | 框住的走带条定高 36 px,56 px 轨道下半截压到监视器底边之外被「调整监视器高度」把手盖住,**拖不到**;Codex 的 perf 脚本对着盖住的轨道空转还报 0 掉帧 | **已修** `ac44b4a`;perf 脚本加「拖动中 aria-valuenow 取过 ≥3 个值」自证 |
| F-R22-02 | P1 | 真机悬停预览是一枚碎图:媒体服务器只给带 `Origin` 的请求发文件,`<img>` 没带 | **已修** `eb44bbf`(`crossOrigin="anonymous"`,与 `CoverImage` 同) |
| F-R22-03 | P1 | 传输条长高后井被栏高钉死,检查器收起时井只平移不变大,原生 GL 视图停在旧位置(画面留左、右侧露出封面底图);0.11.1 里井会变大所以从未暴露 | **已修** `9e8f096`(`useStageFit` 也观察舞台,井的屏幕矩形位置变了就广播) |
| F-R22-04 | P2 | 波形按绝对幅度画,安静素材(±0.03)是空轨 | **已修** `eb44bbf`(按素材最大峰值归一化) |
| F-R22-05 | P1 | WKWebView 偶发 `pointerup` 没送到被捕获的轨道:拖动态卡住、松手的 exact 不发,下一次按下才补发一条陈旧 seek(真机三次拖动两次中) | **已修** `16635e3`(松手 / 取消在 `window` 上也听一份) |
| F-R22-06 | P2 | 悬停气泡要等缩略帧取到才出现,「正在取帧…」是死分支;未缓存位置 4K 要 ~380 ms 才出 | **已修** `17e5b0d`(150 ms 先出时码 + 正在取帧,帧到再补) |
| F-R22-07 | P2 | ⇧ + 滚轮真机不动(macOS 转成 deltaX) | **已修** `6c4db3d` |
| F-R22-08 | P3 | 精选段放大时热力层按全片时间铺,左移出轨道是设计;`preview-shots 16-heat-strip` 的旧断言按轨道左缘量 → 先切「全片」再量;点卡片后检查器 300 ms 滑出,按钮在动画里平移,真鼠标 down/up 落两处不切换 → 派发 click | 剧本改 `9138bb5` / `cbf898b` |
| F-R22-09 | P3 | Codex 的 `r22-hevc-decoder.json` 是独立 mpv `--vo=null` 数据,与渲染路径无关;`r22-scrubber.json` 沙箱内 blocked | 本机重跑覆盖 `r22-scrubber.json`;decoder JSON 留档但不作依据 |
| — | 注 | 4K HEVC 拖动的"卡"主要来自代理 H.264 GOP 0.4 s 的 exact 解码 + 80 ms 状态轮询,不是 seek 本身;进一步顺滑要在 player 侧做(渲染线程直读 time-pos),超出本车道 | 留业主 |

## 5. 留业主

1. **可发性**:P1 四条(F-R22-01/02/03/05)已修并在最终包真机复验;六门禁全绿;`player/mod.rs` 零改动;`feat/r22-scrubber` 可进 main。建议版本 0.11.2 说明里写「进度条重做」。
2. **关键帧 seek 不上**:真机 A/B 证明 4K HEVC 上 `absolute+keyframes` 比 exact 慢一倍以上(§3.2),且默认代理路径 exact 中位 24 ms 本就低于阈值。要更顺滑得改 player(渲染线程直读 `time-pos` 替代 80 ms 轮询),是另一条车道。
3. 两条诊断日志(`a32702a` `seek landed`、`d57313a` `player command`)只在 `TRIPCUT_LOG=debug` 出,INFO 零成本;要不要留作长期排障口,业主定。
4. 「时码输入」在真机用 System Events 整串 `keystroke` 会乱序,是探针限制;人手键盘正常。
5. 探针工具(`tools/axscrub.swift` 等 7 个)放在 `qa/runs/...`,下一轮真机手感验收可直接复用。
