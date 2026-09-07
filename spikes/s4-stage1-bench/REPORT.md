# S4 Spike — 真实素材 Stage1(经典 CV)吞吐实测

日期:2026-08-31 · 机器:Apple M5 / 32GB(实测 `machdep.cpu.brand_string` = Apple M5,10 核 = 4P+6E)/ macOS 27.0
Python 3.14.7,venv:`opencv-python-headless` 5.0.0、`scenedetect` 0.7.1、numpy、psutil
时间盒:两个错误各触发一次即修复继续(见"过程中发现的两个 bug"),未出现"同一错误卡 3 次"的情况。

## 结论(拍板)

**spec §9 "开始筛=分钟级" 对 L1 角标不成立——Python 原型下,500 条素材的 Stage1 全跑需要 ~2.4-2.8 小时,不是分钟级,也超出"全部结构化分析 1-2 小时"预算本身(超 20-40%)。P1 若要兑现"插卡→分钟级开始筛(缩略图+L0/L1角标)",必须让缩略图先出、L1 角标异步补上,不能等 L1 跑完才解锁浏览——或者把 L1 做成 Rust 且做算法层减负(见下方修正值与建议)。**

- 单条素材 Stage1 全五项(CPU 单线程串行)均值 **81.1s/条**,中位数 58.5s/条,4K 素材均值 **157s/条**(是 1080p 素材 36.4s/条的 4.3 倍)——这条曲线几乎完全由分辨率主导,不是编解码器主导(H.264/HEVC 8bit/10bit 三者耗时无系统性差异,见下表)。
- 4→6→8 worker 并行扩展性差:8 worker 相对 4 worker 只快 1.15 倍(理想应为 2 倍),**扩展效率 57%**——10 核机器上 4 worker 就已经把 CPU 打到 100%,加 worker 只是让每个 worker 分到更少的核,OpenCV/x264 内部线程池与 multiprocessing worker 数在互相抢核。**建议:worker 数按性能核数(此机 4P)定,而不是"越多越好"。**
- 光流(motion,Farneback)是全流程最贵的一项:均值 23.2s,4K 最坏 144.4s/条,占单条总耗时的 ~29%;scene_detect(PySceneDetect ContentDetector 全帧解码)第二贵,均值 16.5s。focus/exposure 因为只 1fps 采样,相对便宜。
- **VFR(5 条)与损坏尾帧(2 条)都按预期处理,没有崩管线**:VFR 素材正常跑完全部五项,分类器仍能给出 handheld/static/tilt 等合理判断;2 条被截断到 70% 字节数的 mp4(moov atom 在文件尾部,被截断后直接找不到)在 scene_detect 阶段就以 `VideoOpenFailure` 报错,后续 motion/focus/exposure 因为同一个 `cv2.VideoCapture` 打不开而依次报 `RuntimeError`,audio 阶段 ffmpeg 单独尝试解码也失败但同样不抛异常——worker 进程全程存活,`analyze_clip` 从不 raise,pool continue 到下一条。**失败分类是对的,但"损坏"目前只有"完全打不开"一种真值——因为 mp4 默认 moov 在尾部,截断即整体不可读;要测试规格里说的"损坏尾帧"(前面能读、尾部才坏)需要给 mp4 加 `-movflags +faststart` 再截断,这个 spike 没做,记在下面的"未覆盖"里。**

## 修正值(vs spec §9)

| 项 | spec §9 原述 | S4 实测(Python 下限) | 差距 |
|---|---|---|---|
| 500 条 / ~1TB 全量 Stage1(4 worker) | "开始筛=分钟级" 隐含 L1 角标很快可用 | **168 分钟(2.8 小时)** | ~5-15× |
| 500 条 / ~1TB 全量 Stage1(8 worker,本机最优) | 全部结构化分析预算 1-2 小时 | **147 分钟(2.4 小时)** | 超预算 20-40% |
| 单条素材(1080p) | — | 36.4s | — |
| 单条素材(4K) | — | 157.1s | — |

推算方法:97 条素材(95 条有效,2 条故意损坏)在 8 worker 下墙钟 1707.7s,吞吐 3.41 条/分钟;500 条按同一吞吐线性外推 = 500/3.41 ≈ 146.6 分钟。这批 fixture 的分辨率分布(35 条 4K / 40 条 1080p / 其余 720p-1440p,详见 MANIFEST.csv)已经比典型旅拍相册偏"重"(无人机+步行街拍 4K 视频占多数),如果真实相册以手机 1080p/竖版为主,实测成本会更接近 36s/条那一档,500 条 ≈ 300 分钟单核估算——按 4-worker 有效吞吐折算约 80-100 分钟,同样够不上"分钟级"。

**建议的修正路线(按性价比排序,不是同时做全部):**
1. **P1 不要用"L1 跑完"做开始筛的门槛。** 缩略图 + L0(EXIF/GPS/时间戳)秒级可得,先解锁浏览;L1 角标异步补,UI 上给"分析中"占位,这本身就是 spec §9 P1 路线写的"分钟级开始筛"唯一站得住脚的实现方式——不需要等这个 spike 才发现,但这个 spike 把"等 L1 跑完"这个隐含假设的代价量化到了小时级,值得在 P1 设计评审时明确排除。
2. **motion(光流)先降采样、scene_detect 用 scenedetect 自带的 downscale 参数**——motion 目前 3 对/秒×25% 缩放,scene_detect 是全分辨率全帧跑 ContentDetector;把两者都压到更粗的采样率(例如 motion 2 对/秒、scene_detect downscale=2)预计能把这两项(占总耗时约 47%)砍掉 30-50%,不需要换语言。
3. **worker 数按性能核数设置**,该机 4 个足够,6/8 只多烧内存(peak RSS 8 worker 时 7.96GB vs 4 worker 5.08GB)不多出多少吞吐。
4. **Rust 移植的性能余量判断:中等,不是"重写就能到分钟级"。** Python 在这条链路上的"纯解释器开销"占比不大——真正的时间大头是 OpenCV/x265/PySceneDetect 内部的 C/C++ 计算(帧解码、Farneback 光流、DCT/运动估计),Rust 版本调用同样的 OpenCV/ffmpeg 绑定或用 `image`+`imageproc`/自写光流,预计能省下的主要是:(a)Python 逐帧 for 循环里 numpy↔cv2 之间的胶水开销,(b)PySceneDetect 库本身在 Python 层做的额外簿记,(c)减少 subprocess 启动开销(audio 分析当前每条起一次 ffmpeg 进程)。综合判断 **3-6× 是合理预期上限,不是 10×+**;500 条要真正落到 10-30 分钟,光靠 Rust 重写不够,还得配合第 2 条的降采样/降分辨率策略一起做。P2 排期应该按"3-6× + 算法减负"两件事共同兑现,不能只按 Rust 单独兑现。

## 素材库(MANIFEST.csv)

15 条真实 CC 授权源视频(Wikimedia Commons,通过 HTTP Range 请求只拉取片头 150-260MB 再用 `ffmpeg -c copy` 截取,不下载完整原片——原片普遍数 GB 到数十 GB),覆盖:
- **无人机自然航拍** ×5(瀑布/沙滩,北卡/田纳西)
- **城市步行 vlog / 街景** ×7(曼谷/迪拜/德黑兰/西安/卡塞尔/托莱多/米科诺斯,4K 60fps 手持为主,含雨天、夜景)
- **人群/市集事件** ×1(卢布尔雅那圣诞市集)、**手机随手拍** ×1(新德里公园,仅 5.7s,时长不足但保留作"极短素材"边界样本)、**街拍** ×1(马德里,Theora/720p,格式最旧)、**延时** ×1(内罗毕)

许可证均为 CC BY 3.0/4.0 或 CC BY-SA 3.0/4.0,来源标题、直链、许可证逐条记在 `fixtures/MANIFEST.csv`(不入库,见下方路径)。

用 `scripts/generate_fixtures.py` 扩增出 **97 条**测试 fixture,4 worker 并行编码,矩阵:

| 维度 | 覆盖 |
|---|---|
| 编码 | H.264 8bit ×52、HEVC 8bit ×15、HEVC 10bit ×30 |
| 分辨率 | 1080p ×39、4K(2160p/2026p 竖裁)×40、1440p ×9、720p ×6、其余 3 |
| 帧率 | 24/25/30/50/60fps 混合(取各源片原生帧率+部分强制转换) |
| VFR | 5 条(`setpts=PTS+random(1)*0.02` 抖动时间戳,`-fps_mode vfr` 重新封装) |
| 损坏尾帧 | 2 条(编码后截断到 70% 字节数,moov 在尾部因此整条不可读) |

总大小(原始下载 + 生成)**3.3GB**,在 10GB 预算内。

**路径(均不入库,scratchpad 临时区):**
- 素材根目录:`/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/38c230ca-c578-49ef-b07a-e3b6d17d80b4/scratchpad/s4/fixtures/`
- `raw/`(15 条源片段,770MB)、`generated/`(97 条 fixture,2.5GB)、`MANIFEST.csv`(97 行,来源/许可证/编码/分辨率/帧率/VFR/损坏标记齐全)

## Stage1 原型管线(`scripts/stage1_pipeline.py`)

对每条素材独立跑五项分析,全部落 JSON,单条素材从不因某一项失败而整体崩溃(`analyze_clip` 包住每一步,失败记 `error_type` 继续下一项):

1. **scene_detect** — PySceneDetect `ContentDetector(threshold=27)`,输出场景切点时间戳
2. **motion** — OpenCV Farneback 光流,25% 降采样、~3 对帧/秒,启发式分类 pan/tilt/zoom/handheld/static + jitter 抖动分(P2 校准阈值前的占位分类器,spec §5 已标注这部分工作量是实现的 3-5 倍)
3. **focus** — Laplacian 方差,1fps 采样,softframe 比例
4. **exposure** — 灰度直方图,过曝(≥250)/欠曝(≤5)像素占比
5. **audio** — ffmpeg `astats`,峰值 dB、削波判定

## 单项耗时表(95 条有效素材,4 worker 档,与 worker 数无关——单条耗时是串行数字)

| 分析项 | 均值 | p50 | p95 | 最大值 |
|---|---|---|---|---|
| scene_detect | 16.46s | 10.96s | 53.84s | 83.02s |
| motion(光流) | 23.19s | 17.30s | 62.69s | 144.36s |
| focus | 15.32s | 10.06s | 51.31s | 97.99s |
| exposure | 14.70s | 9.71s | 47.89s | 80.25s |
| audio | 修复前统计因 bug 计时未受影响(仅解析结果错),修复后单独重跑:65/97 条检出真实音轨,0 条判定削波,峰值范围 -26.25dB ~ -6.32dB |
| **总计/条** | **81.11s** | **58.50s** | **266.75s** | **471.43s** |

按分辨率分层(总耗时/条):

| 分辨率 | 条数 | 均值耗时 |
|---|---|---|
| 720p | 6 | 7.57s |
| 1080p | 39 | 36.43s |
| 1440p | 9 | 43.40s |
| 4K(2160p 及竖裁变体) | 40 | ~155-157s |

**每秒素材的分析成本**:均值 2.99×(即 1 秒视频平均要花 3 秒 CPU 时间分析),p50 2.14×,p95 7.41×(4K 长尾)。

## 并行扩展性(4/6/8 worker,全部 97 条,含 2 条故意损坏)

| worker 数 | 墙钟 | 吞吐 | 相对 4-worker 加速 | 理想加速 | 扩展效率 | 峰值总 RSS | 峰值 CPU |
|---|---|---|---|---|---|---|---|
| 4 | 1958.96s | 2.97 条/分钟 | 1.00× | 1.00× | 100% | 5075MB | 100% |
| 6 | 1743.73s | 3.34 条/分钟 | 1.12× | 1.50× | 75% | 6211MB | 100% |
| 8 | 1707.67s | 3.41 条/分钟 | 1.15× | 2.00× | 57% | 7962MB | 100% |

CPU 早在 4 worker 就跑满 100%(10 核机器),再加 worker 边际收益递减明显——本机(4性能核+6能效核)上 **4-6 worker 是甜点区**,8 worker 只多吃内存(+2.9GB)换 3% 吞吐提升,不划算。单 worker 峰值 RSS 均值 955MB / 最大 1136MB(HEVC 10bit 4K 一条独立跑时);多 worker 并发下峰值总 RSS 随 worker 数近线性增长(每 worker 约多 1GB),32GB 机器上到 8-10 worker 都不会 OOM,瓶颈是 CPU 不是内存。

## VFR 处理结果(5 条)

| 素材 | 分类结果 | jitter_score | scene_count | 全五项是否成功 |
|---|---|---|---|---|
| dubai_walk (60fps VFR) | handheld | 5.16 | 1 | ✅ |
| madrid_calle_preciados (24fps VFR) | handheld | 3.57 | 1 | ✅ |
| mykonos_walk (30fps VFR) | static | 1.02 | 2 | ✅ |
| newdelhi_park_phone (30fps VFR,仅5s) | tilt | 1.58 | 1 | ✅ |
| tehran_walk_pocket3 (60fps VFR) | handheld | 5.32 | 7 | ✅ |

`cv2.VideoCapture` 对这批 VFR mp4 的 `CAP_PROP_FPS`/`CAP_PROP_FRAME_COUNT` 读数在实测里没有出现明显偏差(帧对采样数与素材时长基本吻合),说明 OpenCV 后端(此环境用的是 FFmpeg backend)按封装的平均帧率处理是稳的;但这只验证了"不崩、能出数",没有验证"VFR 下的时间戳精度"——如果后续要用这些分析结果做时间轴对齐(比如场景切点要精确落到帧),VFR 素材的 PTS 漂移风险仍在,没有专项测过。

## 损坏尾帧处理结果(2 条)

`kassel_walk_clip__h264_8bit_native_60fps_cfr_058.mp4`、`toledo_walk_rain_clip__h264_8bit_native_60fps_cfr_065.mp4` 均截断到编码后字节数的 70%:

- `scene_detect`:`ffmpeg`/`OpenCV` 均报 `moov atom not found`,PySceneDetect 抛 `VideoOpenFailure`,被 `analyze_clip` 捕获记录,**不传播、不崩 worker**
- `motion`/`focus`/`exposure`:各自独立 `cv2.VideoCapture(path)` 打不开,抛 `RuntimeError: cannot open for ...`,同样被捕获
- `audio`:ffmpeg 单独尝试解码同一文件也失败,`analyze_audio` 内部已做兜底,返回 `has_audio_stream=False` 而不是抛异常
- `analyze_clip` 顶层:`ok=False`,`fail_class="VideoOpenFailure"`,**这条素材在批处理里被跳过继续下一条,总耗时里两条加起来只占约 4-5 秒(远低于均值 81s),因为一开始就打不开、没有真正的解码工作**

**局限**:因为测试用的 mp4 默认 `moov` 在文件尾部,截断即整条不可读,验证到的是"完全损坏/播不了的文件不崩管线"这一档;spec §2 真正想测的"损坏尾帧"(前面正常、只有结尾坏帧)需要 `-movflags +faststart` 让 moov 前置,再截断尾部,这样管线应该能读到大部分帧、只在末尾解码报错——这个更精细的场景本次 spike 没覆盖,留给 P1 实现阶段或下一轮 spike 补测。

## 过程中发现的两个 bug(均已修复并在最终数据里生效)

1. **PySceneDetect 0.7.1:`get_scene_list()` 不传 `start_in_scene=True` 时,一条没有场景切换的素材会返回空列表(`scene_count=0`)而不是"一整段=1个场景"**——用合成测试片(`testsrc`)复现后确认,已在 `stage1_pipeline.py` 里加上该参数。
2. **ffmpeg `astats` 的 summary 输出(Peak level dB / Flat factor 等)是 `AV_LOG_INFO` 级别,不是 `AV_LOG_ERROR`**——`analyze_audio` 最初沿用了本模块其它函数的 `-v error`(为了保持 stderr 干净),导致这些行被日志级别过滤掉,**97 条素材全部误报 `has_audio_stream=False`**(实际上 65/97 条真的有人声/环境音)。改成 `-v info -nostats` 后重跑修复,详细数字见上文 audio 行与 `audio_corrected.json`。这个 bug 提醒:P1 正式实现里任何依赖 ffmpeg filter 日志输出的分析(不只是 astats)都要单独确认该 filter 的日志级别,不能默认 `-v error` 安全。

## 文件清单

- `scripts/generate_fixtures.py` — 素材扩增(15 源→97 fixture),写 `MANIFEST.csv`
- `scripts/stage1_pipeline.py` — 五项 Stage1 分析,`analyze_clip(path)` 可独立调用
- `scripts/bench_stage1.py` — 4/6/8 worker 吞吐 harness,读 MANIFEST 联表
- `scripts/rerun_audio.py` — audio bug 修复后的单项重跑脚本(保留作复现记录)
- `results.json` — 三档 worker 的完整逐条结果(97×3 条记录,含每项 elapsed/分类/错误类型)
- `audio_corrected.json` — 修复后的 audio 分析结果(97 条)
