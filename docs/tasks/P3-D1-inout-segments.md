# 任务卡 P3-D1:入出点打点与片段级精选(帧精确交付升级)

状态:排队(P2 收口后派发)。实施:Codex。主审:Claude。

## 目标
规格 §7/§8:沉浸态里 I/O 打入出点,精选可以是「素材的一段」;交付包按入出点帧精确裁切(重编码+首尾 PTS 回读验证,规格 §8 帧精确协议)。

## 范围
- 数据:segments 表已有;新 kind='select'(用户打点产生,in/out ticks 源 time_base);一条 clip 可多个 select 段;ratings 已是 segment 级(T5 的 whole 兜底继续兼容)
- 播放器沉浸态:I 设入点/O 设出点(当前帧),底栏显示入出点时码与时长;S 保存为精选段(写 segment+binary=1 评级);已有精选段在进度条上画标记;IME 防护
- 筛片页:有 select 段的素材卡显示「N 段精选」;信息面板列出各段(时码+时长),可删除段(软删:段上 tombstone 字段,migration 0009)
- 交付(deliver):精选清单=select 段(无段的收藏素材仍整条);段导出用重编码帧精确(h264_videotoolbox,`-ss` 输入侧+精确;导出后 ffprobe 首尾 PTS 与期望比对,超 1 帧记 CSV 备注并标黄);粗剪按段拼接
- 镜头表 CSV 增列:入点/出点/段时长
## 验收
cargo ≥8(段 CRUD/ticks 换算/PTS 回读验证逻辑(mock ffprobe 输出)/整条与段混排导出/软删不出现在交付);五门全绿;真机:打点→导出→ffprobe 验证实际首帧。
## 纪律
纯写不碰 git 不跑构建;迁移只加 0009;禁碰 sidecar/search/motion/similar。
