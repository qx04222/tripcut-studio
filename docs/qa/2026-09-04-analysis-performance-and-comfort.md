# TripCut 高清分析、桌面舒适度与稳定性优化

日期：2026-09-04。仓库：`/Users/xin/Projects/tripcut-studio`。状态：本轮代码优化与针对性验收完成；不是发布验收。

## 决策与范围

按当前源码、可复现故障和实际窗口操作收敛，使用三个只读 agent 分别审查性能、UI、稳定性，主 agent 统一写入。完成初审、反向评审与修正后的再审。未提交、推送、发布、改动正式用户数据库或安装模型。

本轮将“新模型”理解为使用当前 Codex 模型协作审查；应用内现有 Chinese-CLIP / Whisper 模型保持不变。没有目标电脑的配置、真实素材规模和性能证据，因此不更改默认 worker 数，不给另一台电脑的整批处理时间承诺。

执行顺序及验收：

1. 建立源码与测试基线 → 前端 90 项通过、Rust 运镜 22 项通过。
2. 优化无损计算与修复稳定性 → 等价输出、短读/截断/超时、数据库取消/重试回归。
3. 修复桌面交互 → 原生 Tauri 窗口操作和二次视觉检查。
4. 完成必要门禁 → 类型、lint、前端测试/build、Rust 测试/clippy、最终 diff。

## 已落实的改动

| 问题与证据 | 改动 | 验收与影响范围 |
| --- | --- | --- |
| 运镜先把整片 2fps 灰帧 `read_to_end`，再复制成逐帧 Vec；时长越长占用越大 | `motion.rs:278` 起改为双帧流式处理，只保留紧凑 PairMotion。缓存位移搜索顺序；SAD 精确为零时提前退出 | 原采样率、尺寸、分类算法和统计顺序保持；静止/横摇/俯仰/缩放/抖动输出对照相等。无需数据迁移或重算已有有效结果 |
| 进程已退出后 reader 仍可能等待后代持有的管道，原 timeout 不再生效 | `motion.rs:771` 起用独立进程组、结果 channel 和统一截止时间；超时/取消终止整组并回收直接子进程 | 正常、短读、截断、慢 reader、后台 wrapper 管道均有回归；仅修改运镜模块内的执行器 |
| 纯色无边缘帧的 blurdetect 返回 NaN，SQLite 把 NaN 绑定为 NULL，导致 `NOT NULL constraint failed: clip_analysis.blur_mean` | `analysis.rs:487` 起计算均值时排除非有限样本，保留原数组的逐帧对齐；记录有效模糊度样本数，全部无效时 UI 显示“—”。采样元数据从错误的 1fps 改为实际 2fps | 先取得失败测试，再修复；真实 FFmpeg 4K 纯白视频可分析并写库。纯白仍判过曝，不被误标为虚焦 |
| 旧 attempt 失败后可能改写已重新认领的新 attempt | `jobs.rs:319,512` 失败/重试携带 attempt；主失败路径在一个事务内判取消、决定重试或封锁并更新 | 先复现旧 attempt 污染新 attempt，再验证新 attempt/owner 不变。未修改 schema |
| 转写取消后，提交路径仍可能写字幕并设为 done | `transcribe.rs:441` 起在提交事务资格查询与完成 UPDATE 中增加取消守卫，完成时清除租约 | 先复现取消后仍成功提交，再验证取消发生在提交前时没有最终产物/字幕行 |
| 导入与筛片固定间隔发起全量查询，慢请求重叠；旧响应覆盖新结果 | 两页改为上次请求完成后再调度，提交状态前校验请求代次；隐藏页停止定时，回前台立即刷新。导入详情的产物刷新也串行化 | fake timers + deferred promises 覆盖慢请求、旧响应、前后台切换与卸载。仍为全量 API；本轮没有实现后端增量订阅 |
| 导入操作失败被下一次成功轮询清除；索引完成被叫成全部处理完成 | 分开操作错误与刷新错误；显示画质/运镜各自完成、运行、等待、失败计数；关注文件夹操作增加 rejection 处理 | 错误提示持久性及计数测试；原生窗口观察到索引 3/3、画质 3/3、运镜 3/3 |
| 表头在横向滚动时与行不同步、质量标签挤占列宽 | 表头与虚拟行共用滚动容器、表头 sticky；紧凑标签优先显示关键风险，完整名称保留于辅助说明与详情；表格文字增大 | 原生窗口查看 4K/10-bit 行及详情；1200 条素材静态虚拟化回归仍通过 |
| Stack 候选在胶片墙下沿展开被裁切，按钮为 7px/22px | 实机复现后改为可变高度虚拟行，候选区占用真实布局空间并可滚动；按完整网格宽度展开，添加收起按钮；文字最小 12px、操作高度 32px，主镜头按钮中文化 | 实机完整显示三条候选的选择/锁定/排除/主镜头按钮，选择 4K 候选后可进入播放；行偏移/详情边界有回归。未声称测试所有 Stack 数量/窗口尺寸 |

## 性能测量的实际含义

设备：Apple M5，32 GiB，arm64。编译：rustc 1.98.0，`-O`。工具：[benchmark-motion.py](../../scripts/qa/benchmark-motion.py) 直接从优化前后源码提取实际纯计算函数，生成独立基准程序，各运行三次并校验完整结果摘要。

| 输入 | 优化前峰值 RSS 中位数 | 优化后峰值 RSS 中位数 | 输出 |
| --- | ---: | ---: | --- |
| 等效 1 小时：7200 张 160×160 静止灰帧，184.32 MB 输入 | 394.92 MB | 3.03 MB | 完全一致 |
| 从 30 秒 3840×2160 HEVC 10-bit 测试片提取的 60 张灰帧 | 5.44 MB | 2.13 MB | 完全一致 |

上述是**运镜纯计算进程**的 RSS，不是 App 加 FFmpeg 的整体 RSS，也不是“一小时 4K 视频几秒分析完”。原始日志包含 wall time，但存在启动、缓存和其他本机负载干扰，且短片计时很小，本轮不据此声称整链路提速倍数。PairMotion 和聚合统计仍随时长增长；双帧原始像素缓存固定，并非所有内存均为常量。

可重放证据：

- [一小时灰帧结果](2026-09-04-optimization-evidence/motion-static-1h.json)
- [HEVC 10-bit 采样结果](2026-09-04-optimization-evidence/motion-hevc10bit-30s.json)
- [原生窗口与数据库观察](2026-09-04-optimization-evidence/native-observations.json)

基准重跑示例（先保存需要比较的旧 `motion.rs`，输入为专用测试素材）：

```sh
python3 scripts/qa/benchmark-motion.py \
  --baseline src-tauri/target/optimization-qa/motion-before.rs \
  --raw src-tauri/target/optimization-qa/static-1h.gray \
  --out src-tauri/target/optimization-qa/replay
```

## 原生验收与限制

使用隔离的 `TRIPCUT_APP_SUPPORT_DIR`、独立 bundle ID、最新 debug 可执行文件与 Vite 前端，没有打开正式项目数据库。此候选链接本机媒体库，不能作为独立分发安装包。

Computer Use 实际操作：选择受控目录 → 导入三条素材（两条 30 秒 4K HEVC 8/10-bit、一条 2 秒 H.264）→ 展开 10-bit 胶片条/波形/分析详情 → Escape 收起 → 筛片墙 → 展开候选组 → 选中 10-bit 候选 → 播放/暂停/返回 → 正常退出 → 最新二进制重新启动，三条素材仍在。

播放器可能按现有逻辑读取代理，因此这段观察只证明“4K 素材的播放工作流可用”，不证明全分辨率原片播放性能。发送了逐帧键但未单独测量其前后帧号，不能算逐帧精度验收。没有执行评级/精选段/交付写入或模型调用。

只读数据库交叉核验：import_probe、thumbnail、waveform、full_hash、proxy、analyze_l1、analyze_motion 各 3 项 done。`clip_embed` 三项因未提供已核验的本地 Chinese-CLIP 模型而 blocked；`transcribe` 一项因缺少 Whisper 模型而 blocked。它们没有被算作完成。

额外纯白片的第二次文件选择器自动化未能确认路径；这条桌面导入用例未完成。替代证据是核心层真实 FFmpeg 生成/分析/持久化 4K 纯白素材的回归，不能替代该桌面用例。2026-09-04 本机未发现新增 `tripcut-studio*.ips`，不等于长期浸泡稳定性结论。

## 下一轮按收益排序

| 优先级 | 可执行改动 | 必须取得的证据 |
| --- | --- | --- |
| P1 | 按视频解码、磁盘读取、Whisper、CLIP 分资源限制并发；保留可选 worker 数 | 目标电脑同素材 workers 1/2/4，记录可开始筛片时间、每阶段耗时、总 RSS/swap、前台 seek p95；不先盲目加到 8 |
| P1 | CLIP 的全局互斥等待与响应等待增加共同截止时间、取消后重启子进程 | 假 sidecar 卡死/取消回归，加真实模型装载、重复调用与恢复测试；当前源码 `sidecar.rs:355` 单次响应可等 600 秒 |
| P1 | 全量 `list_clips` 改为可修订号/增量更新，产物请求按 clip 合并并限制并发 | 500/1000 条素材持续滚动/切页，统计 API 并发、SQLite p95、Webview long tasks；已有签名 URL 过期/刷新行为必须保留 |
| P2 | 代理按需生成与缓存配额、闲时预热 | 原片直读/代理切换、VFR 映射、导出引用保护、缓存回收/重启；不能只删缓存或关闭全部代理 |
| P2 | 视频分析模型 A/B：比较本地推理后端与模型大小 | 相同人工标注素材的质量、召回、峰值内存、耗时和模型许可；版本化 embedding，保留回退，禁止直接覆盖旧向量 |
| 发布前 | 独立 DMG 和目标电脑验收 | bundled 工具、签名/依赖/许可证、干净安装、模型可选路径、全按钮矩阵与长时间浸泡。本轮未发布 |

模型选择依据：当前核心瓶颈有明确 I/O、灰帧缓存和状态机原因，更大模型不能修复它们。Whisper.cpp 官方说明提供 Apple Silicon 的 NEON、Accelerate、Metal 和 Core ML 路径，可作为后续后端 A/B 的依据；是否更换模型仍需上述项目数据。[Whisper.cpp 官方说明](https://github.com/ggml-org/whisper.cpp)；视频采样/滤镜行为参考 [FFmpeg 官方滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)。

## 门禁

- 前端：typecheck、lint、15 个测试文件 / 99 项测试、生产 build 均通过，无未处理 Promise rejection。build 有约 512 kB 单个 JS chunk 的体积提示，未伪装成无警告。
- Rust：完整测试 404 项通过（392 单元测试、7 产物集成测试、5 素材集成测试），1 项目标设备性能测试按原配置 ignored；`cargo clippy --all-targets -- -D warnings` 通过。原始日志保留于 `src-tauri/target/optimization-qa/cargo-test-final.log` 和 `clippy.log`。
- 源码：`git diff --check` 通过；原有工作区起初干净，未提交任何改动。
- 原生：完成上文逐项操作，限制逐项记录；不构成全功能、全机型或商用发布通过。
