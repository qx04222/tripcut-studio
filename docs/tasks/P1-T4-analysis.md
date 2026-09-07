# 任务卡 P1-T4:L1 质量分析角标(P1 范围:ffmpeg 信号 + Rust,不含运镜分类)

状态:派发(2026-08-31,车道2/worktree)。实施:Codex。主审/验收:Claude。

## 1. ID/阶段/依赖与前置结论
P1-T4。基于 main(T1+T2 已合入;T3 在并行车道,**不得依赖也不得触碰 T3 将新增的文件**)。前置结论:规格 §5-L1;S4 原型(spikes/s4-stage1-bench/scripts/stage1_pipeline.py,只作参考阈值来源,不引 Python);**运镜/光流分类明确延到 P2**(校准成本 3-5x),本卡只做 ffmpeg 可得的确定性信号。

## 2. 用户可观察目标
导入素材分析完成后,列表每条素材出现质量角标:「过暗/过曝」「疑似失焦」「音频削波」「无音轨」;并且每条素材被切成场景片段(segments 表落库,列表可见片段数)。点开信息面板能看到每个分数的原始数值(可解释性:数值即证据)。

## 3. 范围与非目标
**做**:
- 新 job 种类 `analyze_l1`(每 clip 一个,导入探测完成后自动入队,优先级低于 thumbnail 高于 full_hash):单次 ffmpeg 流水尽量合并提取:
  - 场景切分:`select='gt(scene,T)'` + showinfo(T 默认 0.35,配置常量),切点写 segments(kind='scene',in/out ticks 用源 time_base);无切点→整条一个 segment
  - 曝光:`signalstats` 的 YAVG/YMIN/YMAX 按秒采样→整条聚合(过暗:平均 YAVG<40/255;过曝:高光溢出帧占比>15%,阈值配置常量并写注释"待 S4 校准")
  - 音频:`astats` 全局(Peak level≥-0.1dBFS 且 clip 计数>0 → 削波;无音轨→标记)
  - 失焦:对 3 个采样帧(10%/50%/90%)解 RGB→Rust 灰度+3x3 Laplacian 卷积算方差(纯 Rust,image crate 或手写),分数落库;阈值仅作"疑似"角标(<60 疑似失焦,常量待校准)
- 落库:migration 0003:`clip_analysis(clip_id PK, exposure_yavg REAL, overexposed_ratio REAL, audio_peak_db REAL, audio_clipped INTEGER, has_audio INTEGER, focus_scores TEXT/*json 3值*/, scene_count INTEGER, analyzed_at TEXT, tool_versions TEXT)`——原始数值全存(可解释性硬约束),角标由前端按阈值渲染,**排序/筛选只允许吃这些结构化数值**
- 前端:列表行角标(小徽章,用主题 token 色;中文文案:过暗/过曝/削波/静音/疑似失焦)+信息面板数值区(中文标签+原始值)
- 损坏素材:analyze_l1 failed 不崩,角标显示「无法分析」
**不做**:运镜/抖动分类(P2);PySceneDetect/TransNetV2/Python;NIMA;缩略图(T3 车道);任何自动隐藏或过滤(角标只展示不决策)。

## 4. 承重假设与杀停条件
ffmpeg 滤镜输出解析(showinfo/signalstats/astats 走 stderr/metadata 行文本)按当前 ffmpeg 7/8 格式;解析失败按 failed 处理不猜。若 select+showinfo 方案对长文件性能不可接受(>2x 实时),记录并降采样(fps=4 预过滤)再测,仍不行则报告卡点。

## 5. 接口与数据契约
`list_clips` 扩展分析字段;`get_clip_analysis(clip_id)` 返回全部原始数值。角标枚举:dark/overexposed/clipped/silent/soft_focus/unanalyzed。

## 6. 数据不变量与迁移
migration 0003 如上,只增表;segments 只插 kind='scene' 行,in/out ticks 单调且不重叠。

## 7. 状态机
沿用 jobs;优先级 thumbnail(40)>analyze_l1(30)>waveform/proxy>full_hash(与 T3 车道的数值若冲突,主审合并时统一)。

## 8. 测试夹具
ffmpeg 现场生成:纯黑样本(过暗)、白场样本(过曝)、正弦 0dB 满幅(削波)、无音轨、两段拼接强切换(场景≥2)、高斯模糊样本 vs 清晰 testsrc(失焦分可分离)。缺 ffmpeg 则 skip。

## 9. 量化验收标准
cargo 新增 ≥10 测试:六类夹具各命中对应角标、场景切点 ticks 正确、损坏 failed、无切点整条 segment、Laplacian 分数模糊<清晰。30s 1080p 单条 analyze_l1 < 10s(M5)。前端角标组件测试 1 个;五门全绿。

## 10-16(同 T3 模式)
纯写文件不碰 git 不跑构建;主审跑五门+真机;失败注入:ffmpeg 中途退出无半成品;依赖仅允许 image(或手写卷积);禁改 docs/spikes/README 与 T3 车道文件;worktree 路径 <local-worktree>。变更记录:2026-08-31 v1。
