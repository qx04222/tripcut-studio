# 旅剪工作台 TripCut Studio — 设计规格 v4(定稿)

日期:2026-08-31。主审:Claude(Fable 5)。实施:Codex。业主已批准(建仓+全部并行铺开)。
演进链:Codex 初版 17 节计划 → 五路调研(`docs/research/2026-08-31-research-digest.md`)→ 两个独立架构方案 + 对初版的对抗审查 → 收敛 v3(`docs/reviews/2026-08-31-plan-v3-pre-codex-review.md`)→ Codex 实施者审阅(`docs/reviews/2026-08-31-codex-review-of-v3.md`)→ 本文。

## 0. 本机实测事实(2026-08-31)

- 剪映专业版已安装:`/Applications/VideoFusion-macOS.app`,版本 **11.3.0**。(初版计划的"基线 11.3.0"与本机一致,审查 C 判其"无信源"有误——特此更正。)
- 草稿根:`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`。
- **实验 E0 已完成(2026-08-31,见 `spikes/s1-e0-draft-encryption/REPORT.md`)**:11.3.0 时间线文件改名 `draft_info.json` 且落盘加密;但 `template.tmp` 暴露明文经典 schema,且**读取端接受明文草稿**(明文探针草稿被剪映正常打开,零报错)。**判决:P4 原生草稿路线保留**——单向写明文交付可行;适配层按 11.x 文件名与 template.tmp 金样对齐;剪映每次升级重跑明文探针金丝雀。留白:含真实素材轨道的明文草稿、保存回写行为,P4 首卡验证。

## 1. 定位与护城河

一句话:让「插卡」到「在剪映里能剪」之间的几个小时,变成一个有记忆、可信任、看得懂理由的助手过程。**不是剪辑器。**

护城河(竞品调研三条规律推导):**导入前、对整趟原始素材的本地理解 + 筛选 + 故事组织**——剪映结构上做不到也不会优先做(其 AI 投入在生成式与库素材);「自动」永远只做可撤销建议(用户对"理解与记录"层交口称赞,对"自动生成"层普遍不信任);Adobe Prelude 之死 = 只做主编辑器随时能补的功能,不重蹈。

**不做清单**:自动成片/自动排时间线;物理删除素材(只隐藏/降权,删除永远人手确认);ASR 字幕成品/翻译/数字人(剪映已覆盖);独立「技术检查」监看层(D-Log 示波/多声道仪表——Prelude 陷阱;判断性质量分保留进筛片面板);多目的地备份(OffShoot 的活);协作/云/坐席;与剪映「项目内素材检索」撞车(我们只做导入前、跨项目、原始素材)。

## 2. 支持矩阵(Codex 审阅补)

- 目标机型:Apple Silicon(M1 起),**基准机 = 业主 32GB M 系列**;不支持 Intel(节省 universal 打包与测试矩阵,做出取舍并在文案写明)。
- 最低 macOS:14(Sonoma)。磁盘:缓存层需预留原片体积的 ~15%(代理+缩略图+波形),导入前预测并提示。
- 媒体兼容矩阵(P0 建夹具,P1 起金样回归):H.264/HEVC 8-bit 与 10-bit 4:2:0(必须);HEVC 4:2:2、ProRes、D-Log/HLG(必须正确预览,见 §6 色彩);VFR(手机/Pocket 常态,必须);多音轨/四声道(P3);损坏尾帧文件(必须检出并标记,不崩溃);旋转元数据(必须尊重)。矩阵外格式:明确报"不支持"而非错误渲染。

## 3. 技术栈与进程模型

- **Tauri 2 + React/TS 前端 + Rust 核心**。Electron 不解决视频问题只增体积;纯 SwiftUI 为 5% 播放器风险赔上 95% UI 迭代速度。
- **播放器主路线 = libmpv render API 进程内集成**(Codex 审阅裁决采纳:跨进程 NSView 无法挂进 Tauri 的 NSWindow,伪叠加是结构性脆弱)。参考 IINA;绑定用 libmpv2-rs(维护度设门槛:P0 spike 验收含 C ABI 生命周期与 GPU context 重建)。**备选 = AVFoundation 独立播放器窗口**(牺牲一体感保功能)。WebView `<video>` 禁用于主播放(tauri#6375 实锤)。
  - 许可证硬约束:mpv 用 `-Dgpl=false` LGPL 构建 + 动态链接;FFmpeg 同理 LGPL 配置;进 SBOM(§12)。
  - 硬解不假设:spike 必须实测 hwdec=videotoolbox 在夹具矩阵上的生效率与 CPU 占用。
- axum loopback HTTP(随机端口 + 每会话随机令牌,拒绝无令牌请求,禁路径穿越)只服务缩略图/波形/低码率代理,不服务主播放。
- 进程:Tauri 主进程(UI shell + 任务调度 + 权限闸)/ libmpv(进程内 render surface;若崩溃拖垮主进程超过阈值,降级切独立窗口备选路线)/ Analysis worker 池(Rust,4-6 并行)/ ffmpeg 短命子进程(ffmpeg-sidecar 封装)/ Python sidecar(仅懒加载可选功能:PaddleOCR、allin1)/ 订阅 CLI 路由(短命子进程)。
- 任务队列持久化于 SQLite,OpenClaw TaskFlow 模式:最小可恢复状态 + 结构化 blockedSummary;running 重启转 pending;**幂等协议(Codex 审阅补)**:每次执行带 attempt ID,产物先写临时路径,完成后原子 rename + 落完成标记,重复执行以完成标记为准;外部副作用(导出/CLI 调用)按 attempt 记账。失败指数退避 3 次后进"人工可见降级角落"。

## 4. 存储(三层)

- **原片只读层**:默认引用不复制(可选「复制并校验」:BLAKE3 + ASC MHL 兼容清单);永不写入原片目录。
- **缓存层**(可整体删除重建):代理、缩略图、波形(audiowaveform+peaks.js)、CLIP 向量、转写中间产物。每条带 source_hash,原片变即弃。**治理(Codex 补)**:总容量上限可配,LRU + 项目优先级清理,正在使用文件保护,清理后可重建验证。
- **项目层** `project.db`(SQLite,WAL):评级、标签、入出点、故事板、AI 建议采纳记录、交付审计。唯一不可丢层。**保护(Codex 补)**:定期 VACUUM INTO 快照(本地,防进程级损坏)+ 每次交付时自动导出项目决策包到用户可见目录(异盘可选,防盘丢失)+ 恢复流程在测试里演练(§13 故障注入)。
- **schema 演进(Codex 补)**:`schema_version` 表;迁移前自动快照;迁移失败回滚到快照并拒绝带病运行(OpenClaw doctor 模式);旧版本应用打开新版 db:拒绝并提示升级,不静默降级写入。
- **时间基(Codex 审阅修正后)**:每素材保存源流 time_base 与容器/流级时长;入出点存 **源 time_base 下的整数 tick + 冗余的帧索引(经 PTS 映射)**;VFR 素材额外落 PTS 采样表(关键点映射,非全量)。`-fps_mode cfr` 仅作为**导出策略**(稳定包/粗剪),绝不在导入或批注链路"修复"。浮点秒禁止入库。
- 外置盘:volume UUID 首选 + 快速指纹(头尾 4MB+size)只做**候选缩小**,自动确认需完整哈希或多段采样一致;任何歧义人工确认,绝不静默改路径。
- 向量:sqlite-vec(与主库同一查询面)。
- **并发所有权(Codex 补)**:project.db 单实例独占(启动持文件锁,第二实例只读打开并明示);导出目标目录写锁互斥。

## 5. AI 四层

- **L0 元数据**:EXIF/GPS/时间戳,导入即完成。
- **L1 经典 CV**(纯 CPU,可解释即数值):PySceneDetect 场景切分;光流→抖动+运镜启发式(pan/tilt/zoom/handheld;现成模型不存在且 CC-NC 不可商用;**工作量按 Codex 校准:标注集+阈值校准+误判回归是实现的 3-5 倍,P2 排期按此**);Laplacian 失焦;直方图曝光;ffmpeg astats 爆音。
- **L2 小模型**:Chinese-CLIP(中文语义搜索主力,ONNX-CoreML vs PyTorch-MPS 由 spike S3 拍板;参考 MaterialSearch);whisper.cpp(Metal+CoreML;faster-whisper Mac 无 GPU 已排除);Apple Vision OCR 默认(横排中文)+ PaddleOCR 兜底(懒加载 sidecar);TransNetV2 转场精修(可选)。转写与视频分析并行。
- **L3 订阅 CLI 路由**(claude -p / codex exec / kimi -p):只做高价值增量——镜头一句话描述、故事章节建议、自然语言问答。每项目几十~几百次调用量级。
  - 协议:强制 JSON Schema 输出,serde 严格解析,解析失败=失败,不从文本里猜。
  - 路由:显式锁定 provider 时失败即报错**不静默换模型**;未锁定才走 fallback 链(OpenClaw 实证)。
  - 预算:本地用量账本 + 用户自设上限 + 批量操作先估算确认 + 超限熔断降级为"仅结构化数据",UI 明示。政策风险实锤(Anthropic Agent SDK 额度隔离、不结转、4 个月变 2 次)→ **核心闭环零依赖 L3,整层一键可关**。
  - 出境数据清单(Codex 补):设置页明列 L3 会发送什么(代表帧 JPEG、转写片段、镜头结构化摘要),GPS 默认脱敏为城市级,可全关。
  - 工作量按 Codex 校准:三家认证/版本漂移/限流差异,路由层排期按单 provider 的 2-3 倍。
- **可解释性硬约束(代码级)**:排序/筛选函数签名只接受 L0-L2 结构化数值;LLM 文本仅作展示字段。"为什么推荐"角标点开显示数值证据链。
- **模型可追溯(Codex 补)**:每条分析结果落模型名+版本+阈值+预处理参数;模型升级触发按夹具集的金样回归,排序变化可解释。

## 6. 色彩正确性(Codex 审阅补,原则:可以不专业,不许错误)

- 识别并记录色彩空间/传递函数(BT.709/BT.2020、HLG/PQ、D-Log);预览链路显式声明转换(mpv 侧配置目标 SDR),UI 标注"显示用转换,非调色"。
- D-Log 素材:预览可套显示 LUT(明示仅显示);代理记录色彩空间;交付包附色彩说明文档。
- 10-bit/HDR 在 SDR 屏上的 tone-map 行为进夹具金样;full/video range 错标检测(常见相机 bug)标记提醒。

## 7. 筛片交互(竞品金标准合成)

三栏:左=批次/日期/智能集合树(Kyno Drilldown 拍平);中=胶片网格(虚拟化列表,500 段流畅);右=信息面板(EXIF/评分/AI 理由)。
**主题(业主要求 2026-08-31)**:深浅色自适应——跟随 macOS 系统外观(`prefers-color-scheme` + Tauri 窗口主题),全部颜色走设计 token(CSS variables),浅色深色各定义完整一套;设置页留「跟随系统/浅色/深色」三档覆盖项。任何组件不许硬编码颜色值。
- 悬停 skimming(FCP 式,与播放头解耦,走低码率代理)。
- 沉浸态:JKL / I O 入出点 / F 收藏 X 拒绝 / 1-5 星 / 0 清除 / ⌘1-9 中文关键词槽。
- **中文输入法防护**:检测 IME 激活→灰显单键快捷键+顶部指示灯,不让用户干撞。
- v2:Source Tape 连续拖动浏览(整日素材一条带子);Audition 相似镜头容器(重复镜头收进一格,Tab 切换,非破坏);Smart Bins 式实时元数据查询(内建进筛片界面,不学 Resolve 割裂)。
- 帧级自我批注(Frame.io 单人版)随镜头表导出。
- 界面总数=3 个核心(导入/筛片/交付),其余全部是筛片界面内的模式,不做 20 模块铺开。

## 8. 交付剪映(单按钮三态,降级显式)

用户只见一个「导出到剪映」:
1. 试原生草稿(pyJianYingDraft 思路,参考 capcut-mate):版本白名单(读 VideoFusion Info.plist)→写前 probe→写后回读校验。
2. 白名单外/自检失败:自动落「稳定交付包」= 粗剪 mp4 + 精选片段 + 镜头表 CSV + SRT + 一屏图示。**降级必须显式(Codex 裁决)**:不中断流程,但明示降级原因、拿到了什么、缺了什么("当前剪映 11.3.0 未通过草稿验证,已改为交付包;差异:需手动拖素材上时间线")。
3. 环境级失败:素材整理文件夹+镜头清单文档兜底。
- **帧精确协议(Codex 修正)**:精选片段重编码切片后**回读首尾 PTS 与期望比对**,超差即报;粗剪 mp4 用 stream copy 时**显示实际边界偏移**,超阈值(默认 0.5s)自动转码该段。
- VFR:导出时 `-fps_mode cfr` 并记录目标帧率;HEVC 不做 smart-cut,整段重编码。
- 交付审计:每次导出落 exports 表(层级/清单/剪映版本/校验结果)。
- 稳定包是一等公民并永久维护;原生草稿是"锦上添花",E0 实验若判加密即整条撤下。

## 9. 阶段路线(P0 按 Codex 校准为 2-3 周)

- **P0 Spike(2-3 周,六项各有判据与时间盒)**:
  - S1 剪映草稿加密实测(E0,阻塞在业主建一份草稿,判定后半天出结论)
  - S2 libmpv render API 进 Tauri(判据:4K HEVC 10-bit 逐帧 step、hwdec 生效、seek<100ms p95、GPU context 重建、崩溃不拖垮主进程;8-12 工程日预算;失败→AVFoundation 独立窗口)
  - S3 Chinese-CLIP 推理路径拍板(100 帧基准:延迟/内存/体积,ONNX-CoreML vs PyTorch-MPS)
  - S4 真实素材 Stage1 并行实测(含人工真值样本、冷暖缓存、失败分类;预算±50% 内)
  - S5 whisper.cpp 长音频吞吐实测
  - S6 capcut-mate 实跑评估(对 11.3.0)
- **P1 MVP 闭环**:插卡→分钟级开始筛(缩略图+L0/L1 角标)→F/X+星级→稳定交付包→剪映能剪。依赖 S2/S4 结论(不再宣称"零依赖未验证技术",Codex 纠正)。**签名公证 CI 流水线在 P1 就建**(Codex:不许拖到末期)。
- **P2 理解增强**:中文语义搜索+对白搜索+相似镜头容器+运镜启发式校准(3-5 倍工时预算)。
- **P3 故事与交付深化**:故事章节/镜头槽位/Rough Cut 对象;Source Tape;多音轨;帧精确全协议。
- **P4 原生草稿+AI 增量**(视 E0):白名单草稿生成;L3 路由+预算 UI。
- **P5 商业级**:DMG 分发、stable/beta channel+抖动灰度、doctor 自检、崩溃恢复演练、中文帮助。
- 性能验收三段式(2026-08-31 实测对账,M5/32GB):
  - **实装 Rust+ffmpeg 管线单条成本**:缩略图 3.2s、波形 0.5s、代理 3.4s、L1 分析 3-8s(4K 10bit 实测 7.7s 墙钟)→ 500 条串行约 100 分钟;"开始筛"由缩略图先行,单 runner 500 条约 27 分钟 → **P2 必做 worker 池并行**(4 并发即进 10 分钟级)。
  - S4 报告(spikes/s4-stage1-bench)的 2.4-2.8 小时/500 条是 **Python 原型+Farneback 光流**的成本,只约束 P2 运镜分类(光流占 47% 是大头,须降采样+Rust 化或重估方案);其两个管线 bug(PySceneDetect start_in_scene、astats 日志级别)已在 Rust 实现中天然规避。
  - whisper 全量转写 25h→约 1 小时(S5);L3=按需增量。

## 10. macOS 权限与安全(Codex 补)

security-scoped bookmarks 持久化用户授权目录(含可移动盘重连);hardened runtime + 全部 sidecar 二进制签名进 bundle;首启引导授权流;loopback 令牌(§3);诊断日志默认脱敏。

## 11. 测试策略分层(Codex 补)

单元(Rust/TS)→ 属性测试(时间基换算往返)→ 金样(媒体夹具矩阵:每格式一真实短样本,分析结果与切片 PTS 快照比对)→ 故障注入(写入边界 kill -9、拔盘、磁盘满、重复执行,验证 db 与产物一致)→ 真实素材端到端(S4 夹具集)→ 剪映跨版本金丝雀(每次剪映升级人工跑一遍最小草稿)。门禁:`cargo test` + `tsc --noEmit` + `eslint` + `vitest` + `tauri build`,真退出码,不许管道吞。

## 12. 依赖与许可证(Codex 补,P0 内完成首版 SBOM)

关键项:mpv/FFmpeg(LGPL 构建配置逐项核)、Chinese-CLIP 权重(核商用条款)、PaddleOCR(Apache-2.0)、PySceneDetect(BSD)、whisper.cpp(MIT)、audiowaveform(GPL——**注意:需评估以 CLI 子进程隔离使用是否可接受,否则换自研波形**)、模型权重来源与再分发权。锁版本,进 SBOM 文件。

## 13. 多 agent 开发分工

- 仓库:`~/Projects/tripcut-studio`(本仓),GitHub 私有远端(待建)。
- **Claude(Fable,主循环)**:架构主审、任务卡撰写、集成 owner(并行车道的接线人)、全量门禁与真机验收、剪映金丝雀执行、E0 类实机实验。
- **Codex**:按任务卡实施 + **聚焦快检**(cargo check/tsc/单文件测试,作者最小回归;全量测试归 Claude)。通道:codex-companion(已验证,线程可 resume)。
- 任务卡模板:采用 Codex 提出的 16 项(ID/依赖与前置结论/可观察目标/范围与非目标/承重假设与杀停条件/接口契约/数据不变量/状态机/测试夹具/量化验收/验证责任/失败注入/依赖约束/回滚/交付证据/变更记录)。**冻结目标与验收,实现约束可带变更记录修订。**
- Kimi(可选):批量 UI 探针(kimi -p)。

## 附录 A:对 Codex 审阅的主审裁决

全盘接受:播放器翻转 libmpv、VFR 时间模型、PTS 回读验证、stream-copy 边界显示、降级显式化、幂等 attempt 协议、project.db 异盘导出、P0 工作量 2-3 倍校准、§2/§6/§10/§11/§12 全部新增章节、任务卡 16 项模板。
修正后接受:实施者跑聚焦快检(全量门禁仍归主审);任务卡冻结目标非冻结文字。
更正审查 C:剪映 11.3.0 基线并非杜撰,与业主本机实装一致(§0)。
驳回:无。

## 附录 B:旅行 Vlog 素材八维分类法(业主提供,2026-09-01,产品正式标签体系)

| 维度 | 分类 | 解决什么问题 |
|---|---|---|
| ①镜头运动 | Static/Pan/Tilt/Push-Pull-Zoom/Handheld-Follow | 镜头怎么动 |
| ②景别 | 超广角/广角/中景/近景/特写 | 观众离主体多远 |
| ③主体 | 人/风景/建筑/食物/交通/商品/动物/细节 | 拍什么 |
| ④视角 | 平视/俯拍/仰拍/POV/Over-shoulder/航拍 | 从哪里看 |
| ⑤功能 | Establishing/Transition/Action/Detail/Reaction/Atmosphere | 这个镜头剪辑时干什么 |
| ⑥人物状态 | 对镜头说话/行走/互动/操作/吃喝/观察/自然反应 | 人在干什么 |
| ⑦时间阶段 | 出发/路上/到达/探索/吃饭/活动/日落夜景/返回 | 故事发生在哪一段 |
| ⑧声音 | Talking/环境声/动作声/音乐素材/Voice-over素材 | 声音怎么支撑故事 |

实施:①=C6 块匹配(+follow 细分);②③④⑤⑥=Chinese-CLIP zero-shot 中文原型分类;⑦=章节+时段+标签规则合成;⑧=转写密度+astats 规则。任务卡 P2-C8。置信度不足标"不确定",不硬贴;全部分数落库可解释。

## 附录 C:叙事结构 v2——长期旅行/房车 Storyboard(业主定义,2026-09-01)

**核心原则:时间断档、GPS 位移、日期变化只是事件边界信号,不能独立决定分章。** 系统先识别本集核心目的地、旅行主题与关键事件,围绕其组织故事。(D2 的时间/GPS 聚类自此降级为信号层。)

- **三级结构:Episode → Chapter → Beat**。Chapter 按本集素材动态生成,不要求每集覆盖相同流程。
- **叙事单元分类**:目的地/景点介绍/在途旅程/体验活动/房车生活/人物互动/意外事件/信息知识/氛围B-roll/过渡。
- **降级规则**:连续驾驶、早餐、扎营、做饭等重复性房车生活默认降为 Beat/Montage/Transition;仅当具有新故事价值时升级为 Chapter。
- **Destination Card(重要叙事节点)**:识别到国家公园/城市/历史建筑/自然景观/特色道路/营地/文化地点时,主动聚合相关素材,结合 GPS+画面识别+现场口播+可验证外部资料,生成:地点名称/地理背景/历史·文化·自然特点/为什么值得来/个人体验/相关 B-roll。**服务于故事,不做百科罗列**;外部资料须标注来源与"待核实"态,防幻觉。
- 实施:任务卡 P3-D3(依赖 C8 八维标签、C3 转写、E2 LLM 路由)。

## 附录 D:Shot Stack 与叙事编导系统(业主定义,2026-09-01;末节"Storyboard视觉显示"原文截断,已按意图补全)

**边界裁决(主审)**:数字人由本工具**规划**(槽位/模式/脚本/节奏记忆),**生成**交给剪映数字人/即梦——"不做清单"的"不做数字人"改写为"不生成数字人,但规划数字人叙事层"。

### D.1 镜头五类(折叠语义不同)
重复镜头(可折叠择优)/互补镜头(同主体但景别·视角·运动·功能不同,必须保留)/信息镜头(路牌·地图·菜单·价格,不因画质低被淘汰)/人物镜头(叙事价值优先于画质)/数字人镜头(不参与实拍去重,独立 Narrative Layer)。

### D.2 Scene Cluster
GPS/时间/视觉语义/ASR/地标/环境变化聚合成 Scene;**理解地点的故事角色**(150km Icefields Parkway=一个 Journey Scene,Lookout 为 Sub-scene/Beat),不采用 GPS>2km 机械切分。

### D.3 Shot Function 八功能(取代附录B维度⑤的六分类)
Establishing/Orientation(路牌·GPS·地图)/Experience/Detail/Human-Reaction/Information(说明牌·门票·海拔·规则)/Atmosphere/Transition。每条素材至少一个主功能。

### D.4 Shot Stack 折叠规则
同 Scene+同主体+同 Function+接近景别构图运动 → 同一 Stack;默认只显示 AI 首选;交互:Tab 展开候选/↑↓切换/Enter 替换/Lock 锁定人选/Reject 永久排除/Compare 并排/Promote 升 Hero Shot。**人工选择反哺后续推荐**。

### D.5 AI Best Take 六轴评分
Technical(对焦·曝光·稳定·果冻·噪点·污染·遮挡)/Composition(主体位置·地平线·景深·前中后景·平衡)/Motion(起止稳·速度·Handle 余量)/Human(表情·自然度·真实反应·尴尬停顿)/Audio(风噪·清晰度·独特 Natural Sound)/Narrative(推动故事·新信息·目的地特点·情绪·空间关系)。选的不是画质最高,是**当前故事位置最合适**。

### D.6 Destination Coverage 覆盖检测
每张 Destination Card 附 13 项清单(Establishing/到达入口/地理位置/Hero Shot/Wide/Medium/Detail/Human Scale/Experience/Natural Sound/Information Source/Personal Reaction/Exit-Transition);判据是**"素材是否足以把这个地方讲清楚"**而非全勾。缺口→补救建议:缺真人介绍→建议 DH;缺信息→地图/Graphic/DH;缺 Establishing→找 Drone/Wide;全是 Wide→提示缺 Detail/Human/Experience。

### D.7 数字人五模式(规划输出,不生成)
A 开题式(DH 提问→CUT 实景回答)/B 夹心式(实景→DH 短解→实景,知识补充)/C Overlay(小尺寸半身叠加地图·Drone·B-roll)/D DH+地图(路线动画→CUT 真实出发,房车高优)/E Reality First(熊·极光·陷车·真实反应等强事件**禁止 DH 抢占**,事后补充)。
角色分工:真人=Experience/Emotion/Authenticity;数字人=Context/Knowledge/Narrative Compression。**真实发生的由真人和实拍讲;无必要现场讲的信息交给数字人。**

### D.8 跨集视觉记忆(Long-term Visual Memory)
频道级 Used Shot Memory:地点/镜头/次数/集数/功能/构图/运动/是否Hero/最近使用。重复模式(如 RV Drone Follow 连用四集)→Routine Visual 默认压缩;新语境(Dempster Highway+暴雪)→Novelty↑ 恢复 Hero 候选。

### D.9 Routine Stack(房车重复行为库)
起床/咖啡/收营/发动/驾驶/加油/Grocery/倒车/Leveling/接水/接电/Awning/做饭/篝火/睡觉…首次出现→可完整解释;重复→Montage/Transition(默认2秒级);**发生变化(冬季水管冻结)→升级 Main Story Event**。

### D.10 数字人重复记忆
记录 DH 最近出现/连续时长/本集累计/机位/背景/风格/讲解类型;禁止 DH↔B-roll 机械循环;连续知识点合并为 DH开题→Map/Archive/B-roll→Reality→真人体验 一条链。

### D.11 Storyboard 槽位视图
故事板显示叙事槽位流而非缩略图堆:[DH INTRO]→[MAP]→[REAL/ESTABLISHING ★+N候选]→[REAL/EXPERIENCE]→[REAL/DETAIL]→[DH OVERLAY]→[REAL/HUMAN]→[ATMOSPHERE]→[TRANSITION];编辑者看到的是"这个故事还缺哪部分",不是"一堆素材"。

实施映射:D.1-D.5→任务卡 P3-D4(Shot Stack v2,升级C4);D.2/D.6/D.7/D.11→P3-D3(叙事v2,已扩);D.8-D.10→P4-E3(跨集记忆)。

## 附录 E:三条产品级原则(业主定义,2026-09-01)——Asset Safety / Temporal Integrity / Travel-native Benchmark

### E.1 Asset Safety(系统级不可绕过)
**AI decides what to use, not what to keep.** 质量判断与删除决定彻底分离;疑似废片/低质/重复/低叙事价值→只允许降权·折叠·隐藏·标记,永不自动删除;黑屏/镜头盖/误录也只标 Likely Unusable。
- 质量角标非破坏,红=AI 默认优先级低,≠删除;**禁止单一总分判废**——Image/Motion/Audio/Narrative 四维分别记录(现有 L1+C6+八维已分维,守此纪律)。
- **Narrative Override Technical Quality**:熊出现/陷车/爆胎/极端天气/真实第一反应/偶遇/故障/边检/意外发现——技术 31 分+叙事 98 分=保留并主动推荐(Best Take 六轴的 Narrative 轴有一票否决式加权)。
- **Rescue Candidate**:技术差+叙事高→标记而非标红;允许推荐可用子区间(如 14s 抖动素材只推 07.2-09.8s,原文件完整保留);后续抢救手段(稳定/降噪/裁切/变速/定帧/VO 覆盖)作为建议清单。

### E.2 Temporal Integrity
**Preserve source time, normalize only when necessary.**(现有:源 time_base tick/禁浮点秒/导出才 CFR——守住。)增量:
- 导入记录扩展:PTS/DTS/timebase/audio drift/rotation/HDR/色彩空间/时区推断/proxy 映射关系。
- **Proxy↔Source 时间映射**:代理即使转 CFR 也必须可精确反查原始时间戳;一切导出回到原素材正确位置。
- **Canonical Journey Time(多设备钟漂校正)**:Drone 14:32/iPhone 14:34/GoPro 停留上个时区 13:31——结合 GPS/EXIF/创建时间/音频相关性/视觉事件匹配/日出日落推断设备钟偏移,跨设备素材进同一真实旅行时间轴。

### E.3 Travel-native Benchmark
**Test against real travel chaos, not clean demo footage.** 现有 97 条=Seed Dataset,不作长期 Benchmark 全部。
- 场景覆盖七组:A 景点/B 公路(含雨雪夜砾石)/C 房车生活(重点 Routine 降权与升级)/D 真人(口播·对话·反应·打断)/E 数字人节奏(过度出现检测)/F 技术边角(全帧率矩阵·HDR·竖屏·旋转·损坏尾·外置音轨·长录制·时区错·钟错)/G **"坏素材但重要"专组**(抖动的熊/欠曝陷车/竖拍冰雹/失焦反应/噪点夜间故障/风噪唯一口播)。
- 回归指标:Clustering(Scene 边界 P/R、Stack P、去重)/Selection(Best Take 一致率、Hero 召回、重要事件召回)/**Safety(Unique Event 误拒率、叙事关键素材压制率、原始删除=0)**/Timeline(VFR 同步误差、音漂、Proxy 映射误差、多机对齐)/Long-term(Routine 重复率、跨集视觉重复、Coverage、DH 频率)。
- **Critical Recall ≈100%**:Golden Moments 专组,宁可 FP 不可 FN;漏一条不可重拍时刻=该版本严重失败,是发布门禁。

最终优化目标:**在不丢失不可重拍旅行记忆的前提下,从长期、混乱、多设备的真实旅行素材中,稳定构建真人+实景+数字人结合的连续旅行故事。**
实施映射:E.1→P3-D5;E.2 增量→P4-E4;E.3→P5-F4(大验收即以此为骨架)。
