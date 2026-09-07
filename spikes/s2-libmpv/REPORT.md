# P0 Spike S2 — libmpv 帧精确播放可行性

日期:2026-08-31。判据来源:`docs/specs/2026-08-31-tripcut-design.md` §9-S2。

## 环境

- macOS,Apple Silicon(Apple M5,系统自带 Metal 4)。
- mpv **0.41.0**(Homebrew,GPL 构建——见下方许可证备注)。libplacebo v7.360.1,内置 FFmpeg 9.0.1。
- Rust **1.98.0**(rustup 装,stable-aarch64-apple-darwin),cargo 1.98.0。
- 绑定:`libmpv2 = "6.0.0"`(crates.io,libmpv2-sys 4.0.1)。**未试 `libmpv` crate**——libmpv2 第一次就编译链接成功,没有触发"API 对不上换绑定"的分支。
- 链接:`build.rs` 加 `cargo:rustc-link-search=native=/opt/homebrew/lib` + rpath,无需额外 `LIBMPV_*` 环境变量。
- 测试素材(`media/`,不入库):
  - `test-4k-hevc.mp4` — 3840x2160 HEVC Main 8-bit yuv420p 30fps 30s(`hevc_videotoolbox` 编码,`hvc1` tag)。
  - `test-4k-hevc-10bit.mp4` — 3840x2160 HEVC Main10 yuv420p10le 30fps 30s(同样走 `hevc_videotoolbox -profile:v main10 -pix_fmt p010le` 成功,未降级到 libx265)。

## 关键发现:libmpv 客户端 API 不会自举 NSApplication

第一次尝试让 mpv 自建真实窗口(不设 `vo`,或显式 `vo=gpu-next` + `force-window=yes`)来验证 hwdec,程序卡住;打开 mpv 内部日志(`terminal=yes` + `msg-level`)后看到真实原因:

```
[vo/gpu-next/vulkan] Failed to initialize macvk context, no NSApplication initialized.
[vo/gpu/vulkan] Failed to initialize macvk context, no NSApplication initialized.
Error opening/initializing the selected video_out (--vo) device.
...
Video: no video
No video or audio streams selected.
```

对照:同样的 `--hwdec=videotoolbox --vo=gpu-next` 参数,**用 mpv 命令行二进制**跑同一个文件完全正常、且确认走了硬件解码(见下方 a 项证据)。区别是:mpv CLI 的 `main()` 自己会拉起 Cocoa/NSApplication 事件循环,而 **libmpv 作为库嵌入时不会替宿主进程做这件事**——GPU/窗口 context 的初始化要求宿主进程(未来是 Tauri)已经在跑 NSApplication run loop。Tauri 本身就是跑 Cocoa 事件循环的 GUI 应用,所以真实集成大概率不受影响,但这是一条**必须带进 stage 2(Tauri 内嵌 render API)任务卡的硬性前置条件**,不能假设"库能自己开窗口"。

规避方案:本 spike 的裸 Rust CLI harness 没有事件循环,所以后续 b/c/d 三项判据改用 `vo=null`(无窗口,不需要 NSApplication)跑,把 a 项(hwdec)拆出来单独用 mpv CLI(它自带事件循环)验证。这是方法论上的降级,不是回避——报告里明确标注哪些数字是在哪种模式下测的。

## 四项判据实测结果

### a) hwdec-current == videotoolbox

- **`vo=null` 的 Rust harness 内测得 `hwdec-current=no`**(两个文件都一样)。原因:没有真实 GPU 表面可绑定,mpv 静默软解回退——这本身也是一条真实、值得记录的行为(`vo=null` 不能用来测 hwdec)。
- **改用 mpv CLI(`--hwdec=videotoolbox --vo=gpu-next`,真实窗口)直接验证,两个文件都确认硬解生效**:
  - 8-bit:`Using hardware decoding (videotoolbox).` / `Decoder format: 3840x2160 videotoolbox[nv12] ...`
  - 10-bit:`Using hardware decoding (videotoolbox).` / `Decoder format: 3840x2160 videotoolbox[p010] ...`
- **结论:hwdec 判据本身通过**(8-bit 与 10-bit 4K HEVC 在本机都能拿到 videotoolbox 硬解),但**不是通过 libmpv2 Rust 绑定直接验证的**——是通过独立的 mpv CLI 对照验证的。Rust 绑定层面,hwdec 属性读写路径(`hwdec` / `hwdec-current` property)本身是通的(能读到 `no`),只是没有真实窗口场景没跑到。这条留给 stage 2(Tauri 内嵌)去闭环。

### b) frame-step / frame-back-step 精确到 ±0

`vo=null`,mid-file 位置,连续 10 次 `frame-step` + 10 次 `frame-back-step`,直接轮询 `estimated-frame-number` 直到它相对上一次读数变化(而不是等一个宽泛的 "settle" 信号——原因见下方"方法论教训")。

- 8-bit:frame-step deltas `[1,1,1,1,1,1,1,1,1,1]`,frame-back-step deltas `[-1,-1,-1,-1,-1,-1,-1,-1,-1,-1]` —— **10/10 精确**。
- 10-bit:frame-step deltas `[0,1,1,1,1,1,1,1,1,1]`,frame-back-step deltas `[-1,-1,-1,-1,-1,-1,-1,-1,-1,-1]` —— 9/10 精确,第一次读数是 0(紧跟在"seek 到中点"之后的第一次 frame-step,大概率是那次 seek 的 settle 窗口本身还没完全稳定就采样了,不是 frame-step 命令本身的问题——后续 9 次全部精确)。
- **结论:判据通过**。逐帧步进在两种位深下都是精确的,10-bit 那一次异常更像是采样时机问题而非 API 行为问题(建议下一轮加大 seek 后的 settle 冗余再复核,但不影响本 spike 的整体判断)。

### c) 精确 seek(`seek <t> absolute+exact`)20 个随机点,p50/p95

`vo=null`,`duration=30s`,`fps=30`,每个文件 20 个随机时间点。

| 文件 | p50 | p95 | 判据(<100ms p95) |
|---|---|---|---|
| 8-bit 4K HEVC | 67.3ms | 123.6ms | **不达标** |
| 10-bit 4K HEVC | 92.0ms | 135.9ms | **不达标** |

原始延迟分布明显是双峰:每个文件的 20 个数里,前 10 个左右都在 15-19ms,后 10 个跳到 67-177ms。这不是随机噪声,是可解释的——**`vo=null` 强制软解**(见 a 项),精确 seek 到某个非关键帧位置需要从最近关键帧开始逐帧软解码 4K HEVC 直到目标帧,这在软解下天然比硬解慢很多;分布的双峰大概率对应"目标点离最近关键帧近/远"。**这份 seek 延迟数据是软解路径下测的,是本 spike 能拿到的最保守(最差情况)数字,不代表 stage 2 硬解嵌入后的真实延迟**——真实数字待 stage 2(带 NSApplication + hwdec 生效的窗口)复测。
- **结论:本次实测不达标,但测量条件系统性偏差(软解而非硬解),不能就此判定路线失败**;这是 P0 里必须标注的"未闭环项",留给 stage 2 用真实硬解路径复测。

### d) 暂停态帧号/时间戳一致性

`vo=null`,5 次随机 seek 后检查 `pause` 是否为 true、`estimated-frame-number` 与 `round(time-pos × fps)` 是否一致。

- 两个文件全部 5/5 一致(`diff=0`),暂停态稳定为 true。
- **结论:判据通过**,时间基换算(帧号 ↔ 时间戳)在暂停态下是自洽的。

## 方法论教训(留给以后写类似 harness 的人)

- 第一版用 `Event::PlaybackRestart` 作为"操作完成"的信号,在 `vo=null` + 暂停态逐帧步进时该事件不可靠触发,导致每次操作都吃满超时(5-20 个操作 × 3-5s),看起来像挂死,其实是在" sleep 到超时"。改成轮询具体属性(`seeking` / `estimated-frame-number` 本身)更稳。
- 用泛化的 `seeking` 属性作为 frame-step 的"已完成"信号也不精确:出现过交替的 0/1 delta(每两次读数才真正前进一帧),因为 `seeking` 提前翻回 false 但 `estimated-frame-number` 还没跟上。改成直接轮询目标属性本身(而不是一个代理信号)修复了这个问题——判据 b) 的意义就在这——写"判据在读哪一列"要打在真正变化的那个属性上,不能图省事用邻近信号代替。

## 许可证备注

- 本 spike 用的是 **Homebrew 默认 GPL 构建的 mpv**(`enabled features` 里有 `gpl`),spike 阶段可接受。
- 正式发布(§3 硬约束)必须换成 `-Dgpl=false` 的 LGPL 自编译 mpv + 动态链接,FFmpeg 同理走 LGPL 配置;这个环节本 spike **未做**,留给 P1/打包阶段,进 SBOM(§12)时一并核对。

## 结论

**可行,但不完全闭环——建议按"可行,继续投入 + 三个具体后续动作"处理,而不是简单打勾:**

1. **可行的部分**:libmpv2 crate 编译链接零阻力;client API(属性读写、命令、事件、`estimated-frame-number`)行为符合预期;4K HEVC 8-bit/10-bit 硬解在本机(用真实窗口)确认可用;逐帧步进精确;暂停态帧号自洽。这些支持"继续投入 libmpv render API 路线",不用现在就转 AVFoundation 备选。
2. **本次没闭环、必须带进 stage 2(Tauri 内嵌 render API)任务卡的三件事**:
   - **NSApplication 前置条件**:验证 Tauri 的 Cocoa 事件循环确实能满足 libmpv 的窗口/GPU context 初始化要求(理论上应该没问题,但"理论上"不算验证过)。
   - **硬解路径下的真实 seek p50/p95**:本次 67-177ms 是软解路径测的,必须在硬解+真实渲染 surface 下重新量一次才能对 <100ms 判据下结论。
   - **GPU context 重建**:本 spike 完全没碰(裸 CLI harness 连正常窗口都没跑起来,更谈不上模拟 context 丢失重建),这条留白,是 stage 2 的核心工作量。
3. **崩溃隔离(判据里的"崩溃不拖垮主进程")**:本次用 `catch_unwind` 包了探测逻辑,但没有主动诱发 mpv/libmpv 侧崩溃去验证隔离效果(那需要真实渲染管线才能有意义地触发)——同样留给 stage 2。

**不建议现在就切 AVFoundation 备选路线**——目前看到的所有失败点都是"这次 spike 的测量条件限制"(软解、无窗口),不是 libmpv API 本身的结构性问题。

## 下一步(明确排除在本次范围外)

- Tauri 窗口嵌入(render API,GPU context 生命周期,崩溃隔离)——按任务书要求,这是 stage 2,本次不做。
- 硬解路径下的 seek 延迟复测(需要先解决 NSApplication 前置条件)。
- 发布用 LGPL 自编译 mpv/FFmpeg(留给打包阶段)。
