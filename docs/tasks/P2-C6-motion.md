# 任务卡 P2-C6:运镜与抖动分类(自研块匹配,不引 OpenCV)

状态:派发(worktree <local-worktree>)。实施:Codex。主审:Claude。

## 目标与依据
规格 §5-L1 遗留项。S4 实证 Farneback 光流是成本大头(47%)且 Python 栈重;**主审拍板:不引 OpenCV,自研轻量块匹配全局运动估计**——旅行素材只需要 pan/tilt/zoom/handheld/static 五分类+抖动分,不需要稠密光流。

## 算法(卡内定死,实现照做)
- 采样:每秒 2 帧对(ffmpeg 抽 160px 宽灰度 raw 帧,沿用 T4 的帧提取手法)
- 全局运动:把前帧划 8x8=64 个 16px 块,每块在后帧 ±8px 范围 SAD 搜索最优位移 → 64 个运动向量
- 鲁棒估计:向量中位数=全局平移 (dx,dy);对每块再算「去平移残差」;缩放判定:块位移与块中心到画面中心向量的径向投影相关性(>0.6 判 zoom in/out)
- 分类(整条聚合):|全局位移|均值 <0.5px → static;径向相关 → zoom;dx 主导且同号占比>70% → pan;dy 主导 → tilt;残差高频方差大且方向不一致 → handheld;抖动分=帧间全局位移的高频能量(相邻差分 RMS)
- 全部原始数值落库(migration 0007:`clip_motion(clip_id PK, class TEXT, pan_ratio, tilt_ratio, zoom_corr, shake_score, sample_pairs, tool_version)`),可解释硬约束同 T4
- 新 job `analyze_motion`(优先级 28,analyze_l1 之后);筛片页角标加「手持抖动」(shake_score 超阈值,常量待校准),信息面板显示运镜分类+数值
## 非目标
逐镜头(segment 级)运镜(P3);转场识别;稳定性评分 UI 滑杆。

## 验收
cargo ≥7 测试:合成运动夹具(ffmpeg 用 crop 平移窗口模拟 pan、scale 序列模拟 zoom、随机 crop 抖动模拟 handheld、静止 testsrc)各命中对应分类;数值范围;幂等。性能:30s 1080p 单条 < 5s(纯 Rust,块匹配 64 块×60 帧对是小算量)。五门全绿。

## 纪律
纯写不碰 git 不跑构建;禁改 docs/spikes/README、player、deliver、sidecar、C4 将建的 similar 文件;迁移只加 0007。
