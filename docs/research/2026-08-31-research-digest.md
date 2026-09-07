# TripCut 调研摘要(第一轮五路调研合并,2026-08-31)

产品:macOS 本地「旅行 vlog 素材筛选工作台」。定位=剪映之前的"素材副导演":安全导入→理解素材→筛选→组织故事→交付剪映专业版。用户环境:Apple Silicon 32GB+,中文用户,单人使用。用户明确要求:AI 走"已订阅大模型 CLI"(Claude Code/Codex/Kimi 等)辅助;参考 OpenClaw(2026.8.1) 作为开源范本;功能完整不简化,但要真正好用。

## A. 媒体底座(已验证事实)
- Tauri WebView `<video>` + asset:// 对大文件有实锤崩溃/seek 问题(tauri#6375, #4133)。解法:本地回环 axum HTTP server 提供 Range 流;帧精确播放必须走 libmpv(libmpv2-rs 62★ 在维护,参考 IINA 46k★ 的 render API 集成)——这是全项目技术风险最高点,必须先做 spike。
- ffmpeg 封装:ffmpeg-sidecar(Rust, 536★, 活跃) + `-hwaccel videotoolbox`。
- 波形:bbc/audiowaveform(2.1k★) 生成 + peaks.js(3.4k★) 前端渲染,黄金组合。
- 校验:无成熟开源 DIT 轮子;自研 xxHash/BLAKE3 状态机,输出 ASC MHL 兼容清单(行业标准,ascmitc/mhl)。
- 时间线数据模型:OTIO(.otio 本质是 JSON, 1.9k★, ASWF);Rust 绑定荒废→自研 OTIO JSON 读写子集。
- MAM 思路:immich(113k★)可借架构(sidecar 索引不侵入原文件、ML 独立进程、异步任务队列),但它是服务器模型不能照搬。

## B. AI 层(已验证事实)
- 分层原则:能用经典 CV/小模型解决的绝不上 VLM/LLM。
  - 第0层:EXIF/GPS/时间戳,零成本。
  - 第1层经典CV(纯CPU秒级):PySceneDetect 场景切分;光流(Farneback)→抖动+运镜分类(pan/tilt/zoom/handheld,自建启发式,天然可解释);Laplacian 失焦;直方图曝光;ffmpeg astats 音频爆音。
  - 第2层小模型:Chinese-CLIP(5.7k★,中文语义搜索主力;现成参考 MaterialSearch 整套方案);whisper.cpp(Metal+CoreML,faster-whisper 在 Mac 仅CPU不可用);OCR 用 Apple Vision(.accurate,横排中文OK,竖排不行)+PaddleOCR 兜底;TransNetV2(ONNX)渐变转场精修;NIMA 美学弱信号;librosa 节拍(allin1 可选段落结构)。
  - 第3层 VLM/订阅CLI:仅对每镜头1-3代表帧;吞吐是"分钟-小时级批处理"不是实时。
- 运镜/景别分类没有生产级现成模型(shot-type-classifier 是 CC BY-NC 非商用),自建光流+人脸框占比启发式。
- 向量检索:sqlite-vec(与主 SQLite 同一查询面,数万级规模甜点);LanceDB 备选。
- 所有中文模型无官方 mlx/CoreML 移植→需要 Python sidecar(打包成本)或 ONNX 转换,需拍板。
- 可解释性:排序依据必须是第0-2层结构化数值(CLIP 相似度、光流参数、Laplacian 值),VLM 文本只做人类可读理由,绝不做唯一依据。

## C. 剪映交付(已验证事实+关键未知)
- pyJianYingDraft(4.2k★活跃,支持 5.9~10.8):Mac 上只能"生成草稿",自动导出不可行(v7+ UI 变更)。
- Windows 10.3.0~10.6.5 草稿已确认加密(jianying_draft_encrypt_v2);**Mac 端是否加密全网无一手信源——开工第0步必须实测**。
- SRT/LRC/ASS 字幕导入已验证可靠;FCPXML 只是字幕级交换不可靠;EDL/CSV 剪映不支持。
- capcut-mate(1.6k★,今天还在更新,有 macOS DMG+沙盒指南,面向 LLM/API 集成)值得实跑评估,可能已踩平当前版本兼容坑。
- 交付层三层降级:①原生草稿生成(版本白名单+写前自检回读+金丝雀测试制度化)→②稳定交付包(粗剪mp4 stream copy+精选片段+镜头表CSV+SRT,永不失效,一等公民)→③纯素材+镜头表文档兜底。
- ffmpeg 切片:`-ss` 在 `-i` 前+重编码=帧精确;`-c copy` 关键帧吸附只配粗剪;VFR(手机素材常见)必须 ffprobe 检测并 `-fps_mode cfr`;HEVC smart-cut 不可靠优先整段重编码。

## D. OpenClaw 可抄模块(已验证)
- 模型路由:显式 provider/model;用户锁定时失败即报错不静默降级;未锁定走 fallback 链。→映射到"分析任务分发给 Claude/Codex/Kimi CLI"。
- TaskFlow 长任务:owner session+最小可恢复状态+结构化 blockedSummary/waitJson。→视频批处理断点续作。
- 安全:三层权限闸、文件路径 scope 在工具层强制、TOCTOU 文件绑定(审批后文件变了拒绝执行)。
- 工程:doctor 拒绝带病运行、config schema 单一真相源、stable/beta channel+抖动灰度更新。
- imageModel 与对话模型分离(便宜模型日常,视觉任务才切贵的)。
- **重大风险**:Anthropic 已把 `claude -p` 程序化用量隔离为独立 Agent SDK 额度(不结转,用完另付费),政策4个月变两次。→订阅 CLI 只能做"高价值增量"(镜头描述/故事建议/自然语言问答),全量基础分析必须本地模型,且要有用量预算/预警/降级路径。Codex/Kimi 条款未核实。

## E. 商业软件借鉴矩阵(要点)
吸收:Kyno Drilldown 拍平文件夹+数字键评级(1-5,M标记,I/O入出点);FCP 悬停 skimming(与播放头解耦)+F收藏/X拒绝二元初筛+Ctrl+1-9关键词槽+**Audition 容器**(近似重复镜头收进一个可切换容器,非破坏);Resolve **Source Tape**(整箱素材拼一条带子连续拖动浏览,F9 smart insert 不打断浏览)+双时间线+Smart Bins(实时元数据查询,但要内建进筛片界面别学它割裂);Prelude 三阶段心智模型(导入→打日志→Rough Cut 独立对象)+可移植元数据;Jumper 三路搜索(自然语言/对白/人脸)+Match Similar+悬停操作条+全本地索引;iconik 导入即自动打标;Frame.io 帧级批注单人版;Recut 多轨同步感知;买断/固定价,绝不按量计费。
不做:校验拷贝多目的地备份(OffShoot 的活,假设已导入或轻量做);静音/填充词自动剔除(越界抢剪映);ASR字幕成品/翻译/数字人/自动成片(剪映已覆盖);协作/坐席/云。
三条规律:①护城河在"理解与记录",自动生成只做可撤销建议;②前置工具必须做主编辑器结构上做不到的事(Prelude 之死),我们钉死"导入前对原始素材的本地AI理解+故事组织";③买断/固定价是对这个人群的定位表态。
- 剪映自身已有"本地素材智能检索"(项目内),我们必须区隔:作用于导入前、整趟原始素材、跨项目。

## F. 原 Codex 计划(对照用,17节要点)
名称"旅剪工作台/TripCut Studio"。三层界面(极速筛片/导演工作台/技术检查);中文优先;三层存储(原片只读/缓存可重建/项目决策永久);AI 可解释;剪映适配可回退(稳定包+实验草稿,基线 11.3.0);完整用户旅程(建项目→安全导入(哈希/断点/损坏检测)→自动理解(质量+内容+B-roll镜头语言)→筛片工作台(胶片/沉浸JKL/相似对比)→中文四路搜索→故事章节+模板+镜头槽位→粗剪与节奏(音乐节拍建议切点/智能时长/帧准入出点)→D-Log/多声道专项→交付包目录结构→项目管理/全局素材库/外置盘身份(卷UUID+哈希重关联)→AI嵌入工作流(主动建议+导演问答)→20个界面模块→macOS 原生体验(签名公证DMG)→技术架构(Tauri2+React+Rust+SQLite+FFmpeg+AVFoundation播放器+本地AI栈+JianyingAdapter五件套)→隐私默认离线→验收标准(500段流畅/缩略图快出/入出点不漂移/中文路径/失败有恢复)→五阶段路线(底座→旅行智能→导演台→剪映深适配→商业级)。
已知它的问题:假设全离线本地模型栈(与用户"订阅CLI辅助"要求冲突);假设剪映 11.3.0 为基线(实际版本号存疑,调研见 10.x);未意识到 Mac 草稿加密未知这一前提实验;未提 libmpv/WebView 视频坑;AVFoundation 播放器与 Tauri 集成方式含糊;无明确 MVP 最小闭环定义。
