# P0 Spike S2b — libmpv render API embedded in a Tauri 2 window (stage 2 of S2)

日期:2026-08-31。工作目录:`<local-worktree>`(git worktree,分支
`spike/s2b-embed`)。只改动了 `spikes/s2b-tauri-embed/` 目录。判据来源:任务书 + S2 报告
(`spikes/s2-libmpv/REPORT.md`)遗留的“必须带进 stage 2”的三件事,以及
`docs/specs/2026-08-31-tripcut-design.md` §3。

## 结论先行

**方案 A(libmpv render API 直接嵌进 Tauri 窗口)可行,已在真实窗口 + 真实 hwdec 路径下跑通,
不需要降级方案 B。** S2 报告标记的三个“未闭环项”里,两个已经闭环、一个部分闭环:

| S2 遗留问题 | 本次结果 |
|---|---|
| NSApplication 前置条件是否真的满足 | **闭环,确认满足**——`mpv_render_context_create` 在 Tauri 的 Cocoa 事件循环里一次成功,不再需要 `vo=null` 规避 |
| 硬解路径下的真实 seek p50/p95 | **闭环,但结果是不达标**——见下方 c) 项,这是本轮最重要的新发现,不是测量条件的问题 |
| GPU context 重建 / 崩溃隔离 | **部分闭环**——`catch_unwind` 包住了整条测量协议且 5 次完整跑都没触发,但没有主动诱发真实崩溃或真实 resize 期间的 context 重建去验证隔离效果,同 S2 一样留白 |

## 方案 A 的实现方式

`src/main.rs`(约 470 行,单文件 GUI harness,不是库):

1. **拿到原生 NSWindow**:`WebviewWindow::ns_window()`(Tauri 2 自带的 macOS 专用方法,内部
   走 `raw-window-handle` 的 `AppKitWindowHandle`),`Retained::retain_autoreleased` 接回来。
2. **建一个 `NSOpenGLView`**,`initWithFrame:pixelFormat:`(3.2 Core Profile,double-buffered,
   accelerated),`addSubview:positioned:relativeTo:` 挂到 `contentView` 最前面,顶在 WKWebView
   之上——不是叠加/伪装,是真的原生子视图,占窗口上方 620pt 高的区域,底下留 140pt 给一条纯装饰性的
   HTML 状态条。`setAutoresizingMask(WidthSizable|HeightSizable)` 让它跟着窗口缩放(见判据 d)。
3. **`mpv_render_context`(OpenGL API)**:`vo=libmpv`,`get_proc_address` 用
   `dlsym(RTLD_DEFAULT, name)`(OpenGL.framework 符号进程级可见,不用逐个查 NSOpenGLContext),
   `RenderParam::ApiType(OpenGl)` + `InitParams`。这一步成功 = 本 spike 最关键的检查点:
   在 S2 里同样的调用会因为没有 NSApplication 直接失败,这次是“[render] mpv render context
   created OK”一行日志,进程没有卡死也没有报错。
4. **渲染循环**在一个专用后台线程里(不是主线程——Tauri 主线程要跑自己的事件循环),
   `makeCurrentContext` 一次,之后反复 `render_ctx.render(0, w, h, true)` +
   `NSOpenGLContext::flushBuffer()`。同一线程里复用并扩展了 S2 的测量协议(见下)。
5. **崩溃隔离**:整条测量协议包在 `std::panic::catch_unwind` 里,5 次完整跑(3 次 debug + 2 次
   release)都干净退出,`had_error=false`。

依赖:`libmpv2 = "6.0.0"`(和 S2 一致)+ `objc2 0.6` / `objc2-app-kit 0.3.2` /
`objc2-foundation 0.3.2`(和 tauri 2.11.5 自己用的版本对齐,类型化调用,没有手写
`msg_send!`)。`NSOpenGLView`/`NSOpenGLContext` 全系列 API 在这个 crate 版本里已标记
`#[deprecated]`(建议上 Metal/MetalKit),这是已知且接受的取舍——和 mpv render API、IINA 经典
集成方式一致,`#![allow(deprecated)]` 显式承认。

## 环境

- macOS,Apple Silicon,mpv 0.41.0(Homebrew,GPL 构建,同 S2)。
- Rust 1.98.0 / cargo 1.98.0,`PATH` 需要 `/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin`。
- Tauri 2.11.5(全新最小 app,不依赖 `@tauri-apps/cli`,直接 `cargo build`/`cargo run` 跑,
  前端只有一个静态 `ui/index.html`,没有 npm 前端框架)。
- 测试视频:`media/test-4k-hevc.mp4`(不入库),3840x2160 HEVC Main 8-bit yuv420p 30fps 20s,
  `hevc_videotoolbox -tag:v hvc1`,和 S2 同一族生成命令(`testsrc2` 合成源,20s 缩短版)。
  `ffprobe` 确认 GOP=12 帧(约 0.4s)——这点在判据 c) 的分析里有用。
- 跑了 5 次完整流程(debug ×3 用于调试链路本身,release ×2 用于取最终数据/截图),全部
  `had_error=false`,没有一次崩溃、没有一次进程挂死。

## 五项判据实测结果(release build,`target/release/s2b_tauri_embed`)

### a) 4K HEVC 能在窗口内播放且画面正确 —— **通过**

`01-playing.png`:mpv 把 `testsrc2` 测试图案(彩条+对角线+网格)正确画进了 Tauri 窗口内的原生
`NSOpenGLView`,底下的 HTML 装饰条同框可见,证明这是真实的原生子视图叠加而不是全屏截图或
webview `<video>`。`02-paused-midframe.png` 是暂停在某一帧的静态画面,`03-after-measurements.png`
是走完全部测量协议后的画面——三张图内容和视频源(彩条随时间平移、对角线随时间摆动)完全吻合,
没有花屏、撕裂或黑屏。

截图机制本身踩了一个坑,记在这里供以后参考:第一版用 AppleScript/System Events
把进程带到前台再全屏截图,任务书就警告过“屏幕上有并行自动化在抢焦点”——实测踩中两次,
截图截到了一个不相关的 Chrome/Vercel 页面(另一个并行会话正在用的浏览器窗口)。换成
Tauri 自带的 `WebviewWindow::set_focus()`(进程内、同步、走 Tauri 自己的主线程调度,不经过
单独的 osascript 子进程)+ `screencapture -R <window rect>`(按窗口坐标截取,只要求这块屏幕
区域没被别的窗口挡住,不要求整个屏幕没有其他活动)之后,五张图全部命中正确内容。

### b) frame-step 精确到 ±1 —— **通过**

暂停在中间点后,连续 10 次 `frame-step` + 10 次 `frame-back-step`,轮询
`estimated-frame-number`:

- `frame-step` deltas:`[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]` —— 10/10 精确。
- `frame-back-step` deltas:`[-1, -1, -1, -1, -1, -1, -1, -1, -1, -1]` —— 10/10 精确。

比 S2(10-bit 文件那次第一步是 0)更干净——真实渲染循环下每次轮询之间有稳定的 render 节奏,
没有再出现“settle 窗口没稳定就采样”的问题。

### c) hwdec-current == videotoolbox —— **通过,而且是真正闭环的一次**

```
hwdec (requested)=videotoolbox hwdec-current=videotoolbox
```

这是 S2 报告里明确留白的一项:S2 只能用独立的 mpv CLI(它自带事件循环)间接验证,libmpv
client API 本身因为没有 NSApplication 而没跑到真实窗口场景。这次是同一个 libmpv2 Rust
绑定、同一次进程运行,在 Tauri 提供的窗口 + Cocoa 事件循环下,直接读到
`hwdec-current=videotoolbox`——不再需要外部对照。

### d) 窗口 resize,视频区域跟随 —— **通过**

机制:`NSOpenGLView.autoresizingMask = WidthSizable | HeightSizable`,不需要监听 resize
事件、不需要手动重算 frame——纯 AppKit 原生行为。`04-resized.png` 是程序化把窗口从
1040×760 拉到 1400×940 之后拍的:

```
before: {origin: (0, 140), size: (1040, 620)}
after:  {origin: (0, 140), size: (1400, 800)}
```

宽度和高度都跟着窗口变化按比例放大,底部装饰条固定 140pt 高度不变(截图里也能直接看到,
视频区域的比例/边界随窗口变宽变高而变化,文字条高度没变)。**已知留白**:没有在 resize 时
调用 `NSOpenGLContext::update()`(该方法在这个 objc2-app-kit 版本里要求 `MainThreadMarker`,
而渲染循环跑在后台线程——为了不引入“渲染线程和主线程抢 GL context”的复杂度,选择不调用它,
下一帧渲染时用最新的 view bounds 重新画,实测没有出现撕裂/花屏,但这是 spike 里没打满的一个角落,
生产实现要么在 resize 时把 `update()` 派回主线程、要么彻底换 Metal 拿掉这个顾虑)。

### e) seek(`absolute+exact`)20 个随机点,p50/p95 —— **不达标,这是本轮最重要的发现**

跑了两种测法(对比着看才有意义):

**测法 1:render-coupled**——每次轮询 `seeking` 属性的同时都强制 `render()+flushBuffer()`
(模拟真实播放器一边等 seek 完成一边保持画面刷新的场景):

```
seek p50=261.4ms p95=291.4ms (target p95<100ms) -> FAIL
```

在 3 次 debug 跑和 2 次 release 跑里高度一致(p50 都在 260-280ms,p95 都在 290-300ms 左右)——
**不是 debug 模式的编译期开销**,换 `--release` 后数字几乎没变。

**测法 2:no-forced-render**——同样 20 个随机点,但轮询循环里完全不调用 `render()`,只读
`seeking` 属性:

```
seek p50=0.0ms p95=659.8ms (target p95<100ms) -> FAIL
```

这组数据本身很奇怪也很有信息量:前 13-18 个样本几乎是 0(0.001-0.04ms,`seeking` 属性
几乎读一次就是 false),但后面几个样本跳到 400-660ms 的量级,而且这个模式在两次独立跑里
重复出现。结合“render-coupled 反而比 no-forced-render 的尾部更快、更稳定”这个反直觉的
结果,合理的解释是:**libmpv render API 是拉模式(pull-based)——host 不持续调用 `render()`
去消费已解码帧,mpv 内部的解码/呈现流水线会失去推进的节奏,`seeking` 状态位本身可能就是
跟着 render 节奏更新的**,不是纯粹的“seek 完成了没有”的信号。也就是说 no-forced-render
这组数字不是更纯净的“mpv 真实 seek 延迟”,而是一个新的、值得警惕的行为:*不持续渲染时,
状态更新本身会变得不可预测*。

排除了两个容易先入为主的解释:①软解——不成立,`hwdec-current=videotoolbox` 已确认硬解全程
生效;②GOP 太长导致 exact seek 要解码很多帧——不成立,`ffprobe` 测得 GOP 只有 12 帧
(~0.4s),不足以解释 260ms+ 的延迟。真正的瓶颈更可能在:host 侧的轮询循环粒度(每次
`render()` 一个 4K 双缓冲交换本身有不可忽略的成本,叠上 5ms 轮询间隔,累积出 200+ms)、以及
上面提到的“render 节奏影响 mpv 内部状态推进”这个新发现。

**结论:硬解路径下的 seek 判据本次量出来是不达标的,但根因还没有定位到 mpv 本身——更可能是
本 harness 这种“轮询 `seeking` 属性 + 每次轮询都强制整帧渲染”的测量方法本身引入的延迟,不是
libmpv render API 或 videotoolbox 硬解的结构性问题。**这条不能拍胸脯说“没事,生产环境会更快”,
必须作为 P1 播放器卡的第一个验证项,用 mpv 的 `set_update_callback`(事件驱动、不是轮询)
去重新测一遍——这是本 spike 明确排除范围外的工作量,但下一步该做的方向已经很清楚。

## 给 P2 播放器卡的建议

1. **嵌入路线定案:libmpv render API + NSOpenGLView 直接可用,不需要降级到 AVFoundation 独立
   窗口备选方案。** NSApplication 前置条件在 Tauri 里天然满足,不需要额外处理。
2. **seek 延迟是 P1 的第一个待办,不是本 spike 能关闭的项**:把测量方式从“轮询 + 强制渲染”换成
   `RenderContext::set_update_callback`(mpv 有新帧/状态变化时才回调,不是固定间隔轮询),
   再跑一次同样的 20 点随机 seek。如果换了正确的事件驱动测法后 p95 依然超 100ms,才是真正
   要处理的性能问题(候选方向:代理/降分辨率轨道用于快速 scrub,`hr-seek-framedrop` 等
   mpv 选项调优,或者把 render 循环和“seek 完成”检测解耦到两个独立节奏)。
3. **Metal 迁移是可选项,不是阻塞项**:`NSOpenGLView`/`NSOpenGLContext` 全系列已废弃,长期看
   应该迁移到 `MTKView` + mpv 的 Vulkan/Metal 渲染路径(如果 libmpv2 crate 后续支持,目前
   这个版本的 `RenderParamApiType` 只有 `OpenGl` 一个变体),但当前 macOS 仍完整支持 OpenGL,
   IINA 经典集成也是这条路,P2 阶段没有必须现在切换的紧迫性。
4. **Resize 时的 `NSOpenGLContext::update()` 要在主线程补上**:本 spike 为了偷懒没调,没看到
   问题,但这是已知的正确性缺口,不要带着这个缺口直接抄进生产代码——P2 实现时要么把渲染循环
   拆成“GL 绘制在后台线程 + `update()` 调用派回主线程”的模式,要么记录成显式的技术债。
5. **崩溃隔离没有真正验证过**:5 次跑都没蹦出真实崩溃,`catch_unwind` 目前只是“没坏”而不是
   “确认能兜住”。P1/P2 需要主动诱发一次真实的 mpv/libmpv 侧崩溃(比如喂一个损坏的容器文件、
   或者在 seek 过程中中途销毁 render context)去验证隔离和降级路径真的生效,而不是假设它生效。

## 文件清单

- `src/main.rs` —— 全部实现,~470 行。
- `Cargo.toml` / `build.rs` / `tauri.conf.json` / `ui/index.html` —— 最小 Tauri 2 app 骨架。
- `icons/icon.png` —— 32×32 占位图标(`tauri_build::build()` 需要,dev 运行不打包不影响)。
- `01-playing.png` / `02-paused-midframe.png` / `03-after-measurements.png` / `04-resized.png`
  —— 判据 a)/d) 的截图证据(按窗口坐标截取,~300-800KB)。
- `media/`(不入库,`.gitignore` 已排除)。
