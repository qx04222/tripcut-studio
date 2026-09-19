# R20 / R21 「视频 + 照片」:无风险升级视频线,把照片做进同一工作台(0.11.x)

业主方向(2026-09-19):① 借片刻(Pianke)的优点无风险升级 TripCut;② 照片不做成第二个软件,**做进 TripCut,分视频、照片两部分**;③ 调研与施工可以和 Codex 协作、多 agent 并行;④ 自用为主,开源附带。
依据:两份独立调研(不互看)——Claude `.superpowers/sdd/r21/brainstorm-photo-landscape.md`(30+ 项目全景、本机实测、PH-01…12)与 Codex gpt-6-astra `.superpowers/sdd/r21/codex-brainstorm-photo.md`(解码路线、数据模型影响面、归档协议审计、PH-01…10);R19 规格与 QA 台账;片刻两版源码阅读。
既有原则继续有效:原片只读、不上传、一条流水线、AI 可解释可撤销、参考不抄资源。

## 0. 两份调研的收敛与我的裁定

| 议题 | Claude | Codex | 裁定 |
|---|---|---|---|
| 照片的主身份 | `clips.kind='photo'` 直接加列 | `clips.kind='photo'` + 一对一 `photo_meta` 子表 | **子表**:`clips` 不长照片专属列;所有按 clip_id 挂的表(评级/标签/顺序/相似组/向量/结果批次)零改动 |
| 解码 | macOS ImageIO(objc2-image-io),实测 HEIC 0.12 s/张、ARW 内嵌预览 0.11 s | ImageIO 首选,`image` crate 做 JPG/PNG 后备 | ImageIO 主、`image` 后备;**不引 libheif / rawler**(LGPL + 维护风险) |
| RAW | 首期取内嵌预览 | 首期只 JPG/PNG/HEIC,RAW 第三期白名单 | 首期 **JPG/PNG/HEIC(+ 有伴随 JPG 的 RAW 按 JPG 显示)**,纯 RAW 内嵌预览第二期 |
| 照片展示时长 | 5 s | 3 s,计入自动挑选预算,只是展示/交接说明 | **3 s,计入预算**;存 `photo_meta.hold_ms`,不伪造源时长 |
| 片刻代码 | 两版都不借 | Rust 版标 MIT 但权属链未核清,先自实现 | **不借代码**,借阈值表(pHash .40/dHash .30、连拍 ≤1.2 s、汉明 ≤18、30 min 硬切)与「计划/执行/提交」归档结构 |
| A/B 擂台 | 新建,视频段 + 照片共用,迁移 `duel_*` | 新建,共享决策器,单播放器 | 新建、共用、单播放器(不做双 mpv) |
| 归档 | copy,move 不做 | 首期只 copy;move 需业主改「原片只读」原则 | **只 copy**(R19 原则不变) |
| 不做 | 人脸/闭眼/ORB/HSV/水印/进剪映草稿 | 同 + 完整 RAW 显影、Live Photo 绑定、Windows | 合并两份不做清单(§5) |

## 1. 本轮取舍

- 视频线(R20)全部是**无风险项**:不动数据模型(除擂台新表)、不动播放器、不加依赖、每条可独立回退。
- 照片线(R21)按「进得来 → 看得见 → 挑得快 → 出得去」四步,每步单独可发;**第一步就把 kind 分派修到所有视频专用入口**(probe/seek/trim/motion/导出),分派没修完不让照片进旧路径。
- 迁移:0050 `clips.kind` + `photo_meta`;0051 `clip_companions`(伴随文件);0052 `duel_sessions`/`duel_verdicts`(擂台);0053 归档日志(第二期)。
- 施工分工:**Codex(gpt-6-astra / high)写代码**,每条车道独立 worktree + 任务书;**Claude 本地 agent 跑六门禁 + 真机验证 + 合并**;文件域不重叠的车道并行。Codex 不跑测试、不 commit(沙箱写不了 .git),改动由验证 agent 提交。
- 版本:Wave 1 → 0.11.0;Wave 2 → 0.11.1;Wave 3 → 0.11.2。

## 2. 视频部分(R20)

| # | 项 | 做法 | 难度 | 判据 |
|---|---|---|---|---|
| **V-FIX** 画面冻结 | 「挑好的片段只有音频动、画面不动」(应用内预览 + 导出文件两边都有):独立排查车道正在做(`fix/frozen-video`);根因与修复先于一切,发 0.10.2 | — | 业主的那几段重新导出后 ffprobe 帧数正常、QuickTime/mpv 画面动;单测覆盖关键帧误判分支 |
| R20-1 可修理由 | `reason_json` 加 `fixable[]`(曝光偏亮/轻微手抖/路人/色偏);判定顺序先「骨架」(失焦/抖/时机/大光比 → 不选)再「皮肤」(可修 → 选但标注);结果面板每行多一句「可修:…」;`clip_brief` 同步 | S | 夹具 10 段:骨架问题的段不出现在结果;皮肤问题的段 reason 含「可修」;文案无内部 key |
| R20-2 「换一段」进 ⌘Z | 新 `undo_replace_auto_segment` 命令(还回 batch_id + 旧段快照),`useBandArrange` 撤销栈压一条 | S | 换一段 → ⌘Z → 旧段回原位、run 段数不变 |
| R20-3 画质三指标 | 地平线倾斜角(Hough)、九宫格曝光最差格、显著区锐度;Rust 自算;**先进 `qa/ai-eval` 真值,权重默认 0**,标定后再开 | M | ai-eval 三指标各有 ≥18 条真值;开权重前后「最佳窗 IoU」不降 |
| R20-4 P2 三条 | F-R19-09 结果面板透出镜块;F-R19-12 eta 估不出时显示「正在分析 n/m」;F-R19-10 first-five 点原生面板 | S | 各一测试 |
| R20-5 依赖 | 公开仓 6 个 dependabot(vite 8、vitest 5.0.1、uuid、sha2、tracing-subscriber、pinyin-pro)与 R19 同法收拢 | S | fast-gates 全绿 |

A/B 擂台见 §3 PH-05(视频照片共用,归照片 Wave 2)。

## 3. 照片部分(R21)

### Wave 1「进得来、看得见」(→ 0.11.0)

| # | 项 | 做法 | 难度 | 判据 |
|---|---|---|---|---|
| PH-01 入库 | `import.rs` 加 `PHOTO_EXTENSIONS`(jpg/jpeg/png/heic/heif/webp/tiff;RAW 扩展名先只作伴随识别),`scan_media_files` 返回 kind;新 `photo_probe` 任务(ImageIO:尺寸/方向/EXIF 时间/GPS/机身镜头)代替 ffprobe;迁移 0050(`clips.kind` 默认 'video'、`photo_meta`:width/height/orientation/taken_at/gps/camera/lens/hold_ms/color_space/has_alpha);**所有视频专用入口按 kind 分派**(probe/proxy/audio/motion/transcribe/analyze_l1 对照片跳过或改走照片路径) | M | 0049 库迁 0050 后视频数/评级/顺序不变;100 混合素材全可计数;照片零 ffprobe/音频任务;重导幂等;`duration_ticks=0` 全前端无 NaN |
| PH-02 缩略图与预览 | `core/photo_decode.rs`(objc2-image-io):cover 512 + preview 2048,方向烘进像素,P3/HDR 转 SDR sRGB,透明 PNG 保留;坏图不拖垮队列;4 线程 | M | 100 张 HEIC 冷启动出全部 cover ≤ 4 s;方向 1–8 金样像素比对全对;两张 48 MP 切换内存不爆 |
| PH-03 池/带/监视器 | 媒体池卡片角标「照片」、镜头带固定宽段(hold 3 s)、监视器 `<img>` 静态检视(不经 mpv);「导入即有地图」对照片同样 ≤ 3 s | M | 选中照片监视器 ≤ 100 ms 出图;混排截图基线 +2;旧视频路径截图 diff 0 |
| PH-04 伴随文件 | 迁移 0051 `clip_companions`(RAW+JPG、`.xmp`、Live Photo `.mov`):同目录 + stem 匹配(兼容 `IMG.CR3.xmp`),一组一张卡可展开;不同目录同名不配 | S | `.ARW+.JPG+.xmp` → 1 clip + 2 companion;歧义组留给用户确认 |
| PH-08a 出得去(最小) | 剪映素材包与整包交付按顺序复制照片(HEIC 默认转 JPG,方向已烘进像素;伴随文件一起);「导出视频文件」遇照片明确阻止并引导素材包 | S | 5 视频 + 5 照片:`顺序.txt` 10 行、`01_章节/` 10 文件、HEIC 已成 .jpg;原件哈希一致 |

### Wave 2「挑得快」(→ 0.11.1)

| # | 项 | 做法 | 难度 | 判据 |
|---|---|---|---|---|
| PH-05 **A/B 擂台**(共用) | 迁移 0052 `duel_sessions`/`duel_verdicts`;组内 ← / → 两两淘汰,winner → `is_primary` + `select` 段(照片 in=out=0 + hold);整组 ⌘Z;视频段同样进擂台(相似组 / 同机位);单播放器,照片静态检视;结果面板「还有 N 条相似的没选」直接进擂台;AX `region "擂台"` | L | 7 张一组 6 次按键出 winner;⌘Z 后 verdict.undone=1 且 is_primary 回滚;3 条视频段同样工作;重启后 winner/slot 不变 |
| PH-06 相似分组 | 三层:硬规则连拍(≤1.2 s / 文件号差 ≤3)→ `image_hasher` dHash 汉明 ≤18 → 现有 CLIP 余弦(无模型时前两层也可用);30 min 硬切;落现有 `similar_groups`,池里折叠成一叠 | M | 30 张夹具(10 组 ×3):≥9 组正确、0 组跨事件误并;无 CLIP ≥8 组;1 万张取消 ≤1 s |
| PH-07 废片预筛 | 照片走 `clip_analysis` 曝光/模糊(复用 `analysis.rs`),池里「疑似废片」chip,默认只降序不隐藏、不删 | S | 5 糊 + 5 欠曝 + 10 好:召回 ≥8/10、误杀 ≤1/10;夜景不判欠曝 |
| PH-09 结果面板/一句话挑片含照片 | 每相似组取 primary,reason「同组 N 张最清晰」;「挑 20 张照片」→ 恰好 20、每组 ≤1;hold 计入预算 | M | 面板每行 reason 非空;预算核算含照片 |
| R20-1/2/4 | 视频线的可修理由、换一段撤销、P2 三条并入本 Wave | S | 见 §2 |

### Wave 3「RAW 与可靠归档」(→ 0.11.2)

| # | 项 | 做法 | 难度 | 判据 |
|---|---|---|---|---|
| PH-10 RAW | 白名单:ARW(A7R III)+ DNG(iPhone ProRAW / Leica Q / GR III);无伴随 JPG 时取内嵌 JPEG 预览(kamadak-exif 定位);预览过小提示 | L | 每机型 ≥5 样张:有 JPG/无 JPG/无预览三类各有结果 |
| PH-11 归档日志与 copy 撤销 | 迁移 0053 `archive_ops`:计划/认领/复制(staging + flush + 全哈希)/发布(排他创建、无覆盖)/撤销(只撤本次创建且未改的文件)/重启对账;**只 copy** | L | 注入空间满/断盘/EXDEV/目标冲突/每阶段崩溃:原件全部可定位且哈希一致;重复恢复不覆盖不误删 |
| R20-3 画质三指标 | 见 §2 | M | — |

## 4. 团队与施工方式

| 车道 | 写 | 验 | 文件域 |
|---|---|---|---|
| photo-core(PH-01/02/04) | Codex | Claude Sonnet | `import.rs`、新 `photo_probe.rs`/`photo_decode.rs`/`companions.rs`、`migrations.rs`(追加)、`Cargo.toml`(objc2-image-io、image_hasher) |
| photo-ui(PH-03) | Codex | Claude Sonnet | `MediaPool*`、`BandSegment*`(照片分支)、`Monitor*`(静态检视分支,不动 mpv 调用)、`photo-r21.css` |
| photo-deliver(PH-08a) | Codex | Claude Sonnet | `deliver.rs`/`jianying.rs` 照片分支、`deliver/*` |
| video-fix(V-FIX) | Claude Opus(已在跑) | 同车道 | `deliver.rs` 关键帧/复制路径、`player/` 以外的调用参数 |
| video-polish(R20-1/2/4/5) | Codex | Claude Sonnet | `smart_select*.rs`、`clip_brief.rs`、`results/*`、`StatusStrip`、deps |
| duel(PH-05,W2) | Codex(Opus 起草接口) | Claude Opus | 新 `duel.rs`、`src/workspace/duel/*`、迁移 0052 |
| group(PH-06/07/09,W2) | Codex | Claude Sonnet | `similar.rs`、`analysis.rs` 照片分支、`smart_select.rs` 照片分支 |
| 接线人 | Claude Opus(主会话派) | — | 合并、fast-gates、preview 基线、真机验收、发版 |

每条 Codex 任务书含:预检(worktree/分支/树干净)、文件域、先红后绿的测试清单、禁止事项(不 fetch/commit、不碰业主目录、不动 `player/mod.rs`);Codex 改完由验证 agent 提交并写 lane 报告。

## 5. 明确不做

人脸/闭眼/身份聚类、审美模型、远程 AI 上传;完整 RAW 显影/降噪/镜头校正;水印;写回 XMP/IPTC 评级;move 原片(除非业主改原则);照片进剪映草稿(只素材包);Live Photo 自动绑定;双 mpv 并行播放;照片动画成片;Windows;借片刻任何代码/图标/模板/权重。

## 6. 验收(每 Wave 真机)

W1:导入 100 张 iPhone HEIC + 20 张相机 JPG(含 RAW 伴随)→ 池里 ≤3 s 出占位卡、≤4 s 全部缩略;方向全对;选中照片监视器即出;混排 5+5 导出素材包结构正确;旧视频路径 preview-diff 0 差异;fast-gates 全绿;first-five 基线不退。
W2:30 张连拍夹具擂台 6 次按键出 winner、⌘Z 回滚;「挑 20 张照片」恰好 20;废片召回/误杀达标;视频段擂台同样工作。
W3:RAW 三类样张;归档注入五种故障全部可对账。

## 7. 需业主拍板

| # | 问题 | 建议 |
|---|---|---|
| Q-1 | 照片主来源 | **已拍板(09-19)**:iPhone 16 / 17 Pro Max(HEIC、ProRAW DNG)、Sony A7R III(ARW)、Leica Q(DNG)、理光 GR III(DNG)。W1 验收样本 = iPhone HEIC + 相机 JPG;W3 RAW 白名单 = **ARW + DNG** 两种容器(四台机各 ≥5 样张),内嵌 JPEG 预览都有 |
| Q-2 | 照片默认展示 3 s、计入自动挑选预算 | 是 |
| Q-3 | A/B 擂台跨媒体(照片 vs 视频段)默认能否互相淘汰 | 默认同类比较,跨媒体可比但允许双保留 |
| Q-4 | RAW+JPG 一张卡(可展开)还是两张 | 一张卡 |
| Q-5 | HEIC 进素材包默认转 JPG;HDR 转 SDR sRGB;透明 PNG 保留 | 是 |
| Q-6 | 「导出视频文件」遇照片:阻止并引导素材包(本轮不做静帧成片) | 是 |
| Q-7 | 只 copy 不 move(维持原片只读) | 是 |
| Q-8 | R20-3 画质三指标先标定后开权重(本轮只进真值) | 是 |
| Q-9 | 施工用 Codex gpt-6-astra 写、Claude 验;每 Wave 发一版 | 是 |
