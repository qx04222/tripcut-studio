# 旅剪工作台 / TripCut Studio — 收敛方案 v3(Claude 主审,2026-08-31)

前情:五路调研(开源底座/AI栈/剪映交付/商业竞品/OpenClaw)→ 两个独立架构方案(产品闭环视角A、系统工程视角B)+ 一份对 Codex 原17节计划的对抗性审查C → 本文为主审收敛结果。

## 1. 定位与护城河

一句话:让「插卡」到「在剪映里能剪」之间的几个小时,变成一个有记忆、可信任、看得懂理由的助手过程。**不是剪辑器**。

护城河钉死在(竞品调研三条规律):**导入前、对整趟原始素材的本地理解+筛选+故事组织**——这是剪映结构上做不到也不会优先做的(它的AI投入在生成式与库素材);「自动生成」永远只做可撤销建议。Adobe Prelude 之死 = 做了主编辑器随时能补的功能;我们不重蹈。

**不做清单**:自动成片/自动排时间线;物理删除素材(只隐藏/降权,删除永远人手确认);ASR字幕成品/翻译/数字人(剪映已覆盖);独立「技术检查」监看层(D-Log示波/多声道仪表,达芬奇与剪映已有,Prelude 陷阱);多目的地备份(OffShoot 的活);协作/云/坐席;与剪映「项目内素材检索」撞车的功能(我们只做导入前、跨项目、原始素材)。

## 2. 技术栈与进程模型

- **Tauri 2 + React/TS 前端 + Rust 核心**。Electron 不解决视频问题只增体积;纯 SwiftUI 为 5% 播放器风险赔上 95% UI 迭代速度。
- **播放器绝不走 WebView `<video>`**(tauri#6375 大文件崩溃实锤)。Phase 0 spike 双方案对撞:
  - 首选:**独立 Swift helper 进程(AVFoundation + NSView child-window 叠加 WebView)**,JSON-RPC over stdio 控制;原生 VideoToolbox 解码、`step(byCount:)` 帧步进、HEVC/ProRes 全覆盖、零第三方依赖。
  - 备选:libmpv(libmpv2-rs,参考 IINA render API)。
  - 判据:4K HEVC 丝滑逐帧 step、多显示器/全屏/Mission Control 坐标同步不漂移、播放占用 <30% 单核。任一失败即退「独立播放器窗口」模式(牺牲一体感保功能)。
- 本地 axum loopback HTTP(Range 支持)只服务缩略图/波形/低码率代理,不服务主播放。
- 进程:Tauri 主进程(UI shell+任务调度+权限闸)/ Player helper(常驻1,崩溃3秒重启并恢复 timecode)/ Analysis worker 池(Rust,4-6 并行)/ ffmpeg 短命子进程(ffmpeg-sidecar 封装+videotoolbox)/ Python sidecar(仅懒加载可选功能)/ 订阅 CLI 路由(短命子进程)。
- 任务队列持久化于 SQLite(OpenClaw TaskFlow 模式:最小可恢复状态+blockedSummary;running 重启转 pending;payload_hash 幂等复用;指数退避3次后进「人工可见降级角落」)。

## 3. 存储(三层,Codex 原计划保留项)

- **原片只读层**:默认引用不复制(可选「复制并校验」:BLAKE3 + ASC MHL 兼容清单);永不写入原片目录。
- **缓存层**(可整体删除重建):代理、缩略图、波形(audiowaveform 生成+peaks.js 渲染)、CLIP 向量、转写中间产物;每条带 source_hash,原片变即弃。
- **项目层**(`project.db` SQLite,WAL + 定期 VACUUM INTO 快照):评级、标签、入出点、故事板、AI 建议采纳记录、交付审计。唯一不可丢层。
- **时间基:整数 tick + 分数帧率(OTIO RationalTime 思路),绝不存浮点秒**——入出点不漂移的根。VFR 素材导入时 ffprobe 检出并标记,切片时 `-fps_mode cfr`。
- 外置盘:volume UUID 首选 + 快速指纹(头4MB+尾4MB+size)次选做重关联;失败必显式提示人工指认,绝不静默改路径。
- 向量:sqlite-vec(与主库同一查询面,数万级规模甜点)。

## 4. AI 四层(与 Codex 原计划最大分叉:全离线 → 本地为主+订阅CLI增强)

- **L0 元数据**(EXIF/GPS/时间戳):导入即完成。
- **L1 经典CV**(纯CPU,可解释即数值):PySceneDetect 场景切分;光流→抖动+运镜分类(pan/tilt/zoom/handheld 自建启发式,现成模型不存在且 CC-NC 不可商用);Laplacian 失焦;直方图曝光;ffmpeg astats 爆音。
- **L2 小模型**:Chinese-CLIP(中文语义搜索主力,ONNX-CoreML vs PyTorch-MPS 由 spike 拍板;参考 MaterialSearch);whisper.cpp(Metal+CoreML;faster-whisper Mac 无 GPU 已排除);Apple Vision OCR 默认 + PaddleOCR 兜底(懒加载 sidecar);TransNetV2 转场精修(可选)。**转写与视频分析并行,不串行**。
- **L3 订阅 CLI 路由层**(claude -p / codex exec / kimi):只做高价值增量——镜头一句话描述、故事章节建议、自然语言问答。每项目几十~几百次调用量级。
  - 协议:强制 JSON Schema 输出,serde 严格解析,解析失败=调用失败,不从文本里猜。
  - 路由:显式 provider 锁定时失败即报错**不静默换模型**;未锁定才走 fallback 链(OpenClaw 实证设计)。
  - 预算:本地用量账本+用户自设上限+批量操作先估算确认+超限熔断降级为「仅结构化数据」,UI 明示。政策风险实锤(Anthropic Agent SDK 额度隔离,4个月变2次)→ **核心闭环零依赖 L3,整层可一键关闭**。
- **可解释性硬约束(代码级)**:排序/筛选函数签名只接受 L0-L2 结构化数值;VLM/LLM 文本仅作展示字段。「为什么推荐」角标点开显示数值证据链。

## 5. 筛片交互(竞品金标准合成)

三栏:左=批次/日期/智能集合树(Kyno Drilldown 拍平);中=胶片网格主区;右=信息面板(EXIF/评分/AI理由)。
- 悬停 skimming(FCP 式,与播放头解耦)——不点开就能看内容,效率核心杠杆。
- 单击进沉浸态:JKL / I O 入出点 / F 收藏 X 拒绝(二元初筛)/ 1-5 星 / ⌘1-9 中文关键词槽 / 0 清除。
- **中文输入法防护**:检测到 IME 激活时灰显单键快捷键+顶部指示灯提示,不让用户干撞。
- v2:Source Tape 连续拖动浏览(整日素材一条带子,F9 式不打断浏览);Audition 相似镜头容器(重复镜头收进一格,Tab 切换,非破坏);Smart Bins 式实时元数据查询(内建进筛片界面,不学 Resolve 割裂)。
- 帧级自我批注(Frame.io 单人版)随镜头表导出。

## 6. 交付剪映(单按钮三态降级,稳定包是一等公民)

用户只见一个「导出到剪映」:
1. 试原生草稿(pyJianYingDraft 思路/参考 capcut-mate):版本白名单(读剪映 Info.plist)→写前 probe→写后回读校验→通过则提示「已生成草稿(实验性)」。
2. 白名单外/自检失败:**不报错**,自动落「稳定交付包」= 粗剪 mp4(stream copy 关键帧吸附可接受)+ 精选片段(帧精确重编码,`-ss` 前置)+ 镜头表 CSV + SRT + 一屏图示「如何用这个包」。
3. 环境级失败:素材整理文件夹+镜头清单文档兜底。
层级是工程概念,用户永远只看到「尽力最省事,退而求其次也不两手空空」。
**前提实验(开工第0天)**:Mac 剪映 draft_content.json 是否明文——Windows 10.3+ 已确认加密,Mac 无一手信源;若加密,原生草稿整条砍掉,资源转投稳定包体验。

## 7. 阶段路线(每阶段一个可验收用户故事)

- **P0 Spike 周**(全部有时间盒+判据):①Mac 草稿加密实测(3天,决定第6节生死) ②AVFoundation 叠加 vs libmpv 对撞 ③Chinese-CLIP 推理路径拍板(100帧基准:延迟/内存/体积) ④500段真实素材 Stage1 并行实测(预算±50%内) ⑤whisper.cpp 25h 吞吐实测 ⑥capcut-mate 实跑评估。
- **P1 MVP 闭环**:「插卡→分钟级开始筛(缩略图+L0/L1 角标)→F/X+星级筛一遍→导出稳定交付包→拖进剪映能剪」。不含 CLIP/whisper/草稿/CLI。**这条闭环不依赖任何未验证技术,是产品活不活的判据。**
- **P2 理解增强**:中文语义搜索(CLIP)+对白搜索(whisper)+相似镜头容器+烂片角标全量。
- **P3 故事与交付深化**:故事章节/镜头槽位/Rough Cut 独立对象;帧精确切片+VFR/HEVC 规则;Source Tape。
- **P4 原生草稿+AI 增量**(视 P0-①结论):白名单草稿生成;L3 订阅 CLI(描述/建议/问答)+预算 UI。
- **P5 商业级**:签名公证 DMG、stable/beta channel+抖动灰度更新、doctor 式自检(带病拒运行)、崩溃恢复、完整中文帮助。
- 性能验收三段式:**开始筛=分钟级;全部结构化分析=1-2小时(whisper 长尾,异步不阻塞);L3=按需增量**。

## 8. 与 Codex 原计划对照(审查C结论)

保留:三层存储模型/交付三层降级/中文优先/先底座后智能的五阶段序/AI可解释原则/横竖版共享选择。
修正:「基线11.3.0」→开工实测真实版本(11.3.0 无信源,现实在 10.x);「AVFoundation播放器」含糊集成→P0 spike 双方案对撞;全离线模型栈→本地为主+订阅CLI增强层(用户明确要求+政策风险实锤);20界面模块→3核心界面(导入/筛片/交付),其余是筛片界面内模式;「技术检查」独立层→砍(Prelude 陷阱),判断性质量分保留进筛片面板;音乐自动切点→只做节拍标注不生成剪辑。
新增(原计划缺失):第0步实验清单;MVP 闭环定义;订阅CLI预算/熔断/降级;VFR/HEVC 处理规则;可解释性代码级硬约束;盘重关联失败兜底;SQLite 快照防损坏。

## 9. 多 agent 开发分工(Claude 主审+测试,Codex 实施)

- 仓库:`~/Projects/tripcut-studio`,新 git 仓+GitHub 私有远端。
- **Claude(本会话,Fable 主循环)**:架构主审、任务卡撰写(目标/边界/验收标准/禁改清单)、集成 owner(并行车道必须有接线人)、本地验收(build/test/真机 UI 探针)、剪映金丝雀测试执行。
- **Codex**:按任务卡实施。已知纪律:Codex 只写码不跑测试(测试归 Claude 本地);任务卡中途不改;沙箱 .git 受限时走直推 GitHub 路径。
- 沟通通道:Codex 官方联动 skill(codex-companion runtime)派工与回收;每张任务卡以 7 位 SHA 报交付。
- 门禁:`cargo test` + `tsc --noEmit` + `eslint` + `vitest` + `tauri build` 全绿才算绿;取真退出码不许管道吞;spike 各有独立判据。
- Kimi(可选):批量 UI 探针执行(kimi -p 纯参数调用)。
