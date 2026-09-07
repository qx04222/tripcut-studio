# 任务卡 P1-T3:缩略图/代理/波形管线

状态:派发(2026-08-31)。实施:Codex。主审/验收:Claude。

## 1. ID/阶段/依赖与前置结论
P1-T3。依赖 T1(jobs 队列/axum/缓存约定)与 T2(clips 入库)均已合入 main。前置结论:S2——ffmpeg `-hwaccel videotoolbox` 可用;规格 §12——**audiowaveform 是 GPL,禁用**,波形改为 ffmpeg 解 PCM + Rust 侧算峰值。

## 2. 用户可观察目标
导入素材后,导入页列表几秒内出现每条素材的封面缩略图;点选一条可见其胶片条(横向多帧缩略图)与音频波形条;全部由本地缓存服务(axum)提供,拔掉网络也一样工作。

## 3. 范围与非目标
**做**:
- 新 job 种类(走 T1 队列,按导入完成自动入队):
  - `thumbnail`:每 clip 生成 1 张封面(取 25% 处,宽 480px JPEG)+ 胶片条 N 帧(N=min(12, ceil(时长秒/5)),宽 160px 每帧,拼成一张横向长图或独立文件,实现自选并写明)
  - `proxy`:生成 540p H.264 预览代理(`-hwaccel videotoolbox -c:v h264_videotoolbox`,音频 aac 96k;源低于 540p 则跳过并标记 direct);**本卡先不接播放器,只落文件**
  - `waveform`:ffmpeg 解 16bit PCM(单声道 8kHz 足够)→ Rust 计算峰值对(每像素窗口 min/max,固定 2000 桶/整条)→ 存 JSON 到缓存(schema: {version:1, bins:2000, peaks:[[min,max],...] 归一化 -1..1})
- 缓存落盘:`<缓存根>/<clip_id>/{cover.jpg,strip.jpg,proxy.mp4,waveform.json}`,每文件带 T1 的原子写协议;cache 记录表落库(新 migration 0002:`cache_artifacts(id, clip_id, kind, rel_path, source_hash, bytes, created_at)`,source_hash=clip.quick_hash,源变即失效)
- axum:确保上述文件可经 `/cache/{clip_id}/{file}` 带 token 访问(T1 已有静态服务,补目录约定与测试)
- 前端:导入列表行内显示封面(懒加载,进入视口才请求);选中行下方显示胶片条+波形(canvas 画 peaks JSON);未生成时显示占位骨架
- 失败语义:单条 ffmpeg 失败=该 artifact failed(带 stderr 摘要),不影响其他 artifact;损坏素材三件套全 failed 但列表仍显示元数据
**不做**:播放器/JKL(独立卡);缩略图悬停 skimming 交互(T5);缓存 LRU 治理(P2);多分辨率波形缩放级。

## 4. 承重假设与杀停条件
- 假设 h264_videotoolbox 编码器可用;不可用时降级 libx264 preset veryfast 并记录。
- ffmpeg 寻址沿用 T2(PATH/FFPROBE_PATH 同族,新增 FFMPEG_PATH)。
- 若 videotoolbox 路径在测试机不可用导致集成测试无法跑,测试按 T2 模式 skip 并写明。

## 5. 接口与数据契约
- Tauri commands:`get_clip_artifacts(clip_id) -> { cover?, strip?, proxy?, waveform?, statuses }`(URL 用 axum 地址拼好返回);列表接口扩展封面 URL 字段。
- waveform JSON schema 如 §3,版本字段必带。

## 6. 数据不变量与迁移
migration 0002 只新增 `cache_artifacts` 表;不改既有表。artifact 与文件一一对应,库里有记录而文件缺失=视为需重建(读取时校验)。

## 7. 状态机
沿用 jobs;三种 artifact 各自独立 job,thumbnail 优先级>waveform>proxy(封面最先出,呼应"分钟级可开始筛")。

## 8. 测试夹具
沿用 T2 的 ffmpeg 现场生成夹具(含无音轨样本→waveform 应产出静音峰值而非失败;含损坏样本)。

## 9. 量化验收标准
- cargo 新增 ≥8 测试:三种 artifact 生成与落库、无音轨、损坏源失败语义、source_hash 失效重建判定、axum 取件、原子写、优先级顺序。
- 10 条 30s 1080p 样本:封面全部产出 < 15s(M5);波形 JSON 每条 < 2s。
- 前端:封面懒加载组件测试 1 个;typecheck/lint/vitest 绿。

## 10. 验证责任与命令
Codex:不跑构建/测试(纯写模式),自查代码与卡条款对应。主审:cargo test/clippy/tsc/eslint/vitest + tauri dev 真机看图(本卡必做 GUI 验收,连同 T2 留白的导入页走查一起)。

## 11. 失败注入与恢复验收
测试:proxy 生成中途 kill(模拟:假 ffmpeg 写一半退出非零)→ 无半成品落正式路径,重跑成功。

## 12. 依赖与分发约束
优先直接 `Command` 调 ffmpeg(与 T2 一致);如需 crate 仅允许 ffmpeg-sidecar。**禁 audiowaveform(GPL)**。禁新增其他重依赖。

## 13. 回滚与清理
分支;缓存目录整删可重建(验收时实际删一次验证)。

## 14. 交付证据
文件清单、条款对应、需校准点(纯写模式,同 T1/T2)。

## 15. 禁改清单
`docs/**`、`spikes/**`、`README.md`(如需补开发说明,写进报告由主审加)。不重构 T1/T2 结构。禁 `git add`(不碰 git)。

## 16. 变更记录
- 2026-08-31 v1 派发。
