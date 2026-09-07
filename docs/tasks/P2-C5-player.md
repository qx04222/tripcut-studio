# 任务卡 P2-C5:libmpv 播放器正式集成(JKL/入出点地基)

状态:派发(2026-08-31,worktree <local-worktree>)。实施:Codex。主审:Claude。

## 目标与依据
S2b spike 已实机定案方案A:`spikes/s2b-tauri-embed/`(NSOpenGLView 子视图 + mpv render API + 专用渲染线程)——**先完整读它的源码与 REPORT.md,把可用部分照搬**。把该验证代码产品化进主应用:筛片页选中素材按空格进入「沉浸态」浮层,libmpv 播放原片,JKL/方向键/空格控制;Esc 退出。

## 范围
- `src-tauri/src/player/` 新模块:封装 S2b 的 mpv render 上下文为可复用组件(创建/加载文件/play-pause/frame-step/seek/销毁;线程与 GPU 上下文生命周期照 S2b);播放器视图挂接到 Tauri 主窗口指定区域(前端告知矩形,resize 跟随沿用 autoresizing)
- **S2b 留下的 seek 延迟疑点必须处理**:改轮询为 `mpv_render_context_set_update_callback` 驱动渲染;复测 seek p50/p95(exact seek),数据写进交付报告
- Tauri commands:`player_open(clip_id)`(经原片绝对路径)、`player_close`、`player_command(cmd)`(play/pause/step_fwd/step_back/seek_abs)、`player_status()`(pos/duration/paused/frame)
- 前端沉浸态:全窗口浮层,底部薄控制条(时间码/键位提示,token 化配色);键盘 J/K/L/←→(逐帧)/空格/Esc;IME 防护沿用 T5
- 崩溃隔离:mpv 层 panic/错误不拖垮主进程,浮层显示「播放器异常,已退出沉浸态」
- Cargo 依赖:libmpv2(与 S2b 同版本);构建脚本处理 /opt/homebrew 链接(照抄 S2b build.rs);**README 禁改**,开发前置(brew install mpv)写进交付报告由主审补
## 非目标
入出点 I/O 打点(P3,等 segment 级评级);代理切换;波形联动;字幕。

## 验收
cargo 测试:player 模块状态机单测(不含 GPU 的逻辑部分)≥4;五门全绿(clippy 对 unsafe 块允许精确 allow 并注释理由)。真机(主审):4K HEVC 沉浸态流畅、JKL/逐帧/seek 可用、Esc 干净退出、连开关 10 次无泄漏崩溃、seek p95 数据回报。

## 纪律
纯写文件不碰 git 不跑构建;禁改 docs/spikes/README 与 deliver/import 模块;jobs.rs 若需注册什么与 C1 车道冲突——本卡不该碰 jobs,发现需要即停下报告。
