# 任务卡 P1-T2:导入管线(引用式导入+哈希+元数据+断点续作)

状态:草拟(待 T1 验收后派发)。实施:Codex。主审/验收:Claude。

## 1. ID/阶段/依赖与前置结论
P1-T2。依赖 P1-T1 合入 main(schema v1、jobs 队列、axum 骨架)。前置结论:规格 §4(引用式导入为默认;快速指纹=头 4MB+尾 4MB+size;完整 BLAKE3 异步);S4 报告(若已合入)提供 ffprobe 元数据字段参考。

## 2. 用户可观察目标
在导入页选择一个文件夹(原生对话框),应用扫描其中视频文件并入库:列表实时增长,每条显示文件名/时长/分辨率/编码/拍摄时间/VFR 角标;中途退出应用重开后,导入从断点继续而不重扫已完成项;同一文件再次导入被去重(提示已存在)。

## 3. 范围与非目标
**做**:
- Tauri command:`pick_import_folder()`(原生对话框)、`start_import(path)`、`get_import_progress()`、`list_clips()`
- 扫描:递归找视频扩展(mp4/mov/m4v/mts/avi/mkv/insv 等,大小写不敏感;隐藏文件与包内容跳过),Kyno Drilldown 式拍平
- 每文件一个 `import_probe` job(走 T1 队列):a) 快速指纹(头4MB+尾4MB+size 的 BLAKE3)→去重(quick_hash 命中且 size 相同=疑似重复,标记不重插);b) ffprobe(JSON 输出)提元数据:容器/编码/宽高/时长/fps(r_frame_rate 与 avg_frame_rate 分数原样入库为 tb/fps 分数)/VFR 判定(两 rate 不等或 codec_time_base 异常)/创建时间(容器 tag 优先,退 mtime)/GPS(有则取);c) 入库 clips + volumes(diskutil info 取卷 UUID,失败则 uuid='local')
- 完整 BLAKE3 全量哈希:独立低优先级 job 类型,后台慢慢补 full_hash,不阻塞任何 UI
- 断点续作:扫描清单本身落 jobs(payload=文件路径),重启后按 T1 恢复语义续跑;done 的不重跑(payload_hash 命中直接跳过)
- 损坏/不可读文件:job failed 并记录原因(ffprobe 退出码/stderr 摘要),UI 列表以「不可读」角标显示,不崩管线
- 前端导入页:文件夹选择、进度条(总数/完成/失败)、素材列表(虚拟滚动,>1000 行不卡)
**不做**:复制模式与 MHL 清单(P3);缩略图/代理/波形(T3);EXIF 镜头参数深挖;外置盘重关联 UI(P3);任何分析。

## 4. 承重假设与杀停条件
- 假设 ffprobe 可用:通过 `ffprobe` PATH 或 `FFPROBE_PATH` 环境变量寻址,均无 → 启动导入时报清晰错误(不静默)。本卡不负责打包 ffmpeg 二进制(P5),README 写明 `brew install ffmpeg` 为开发前置。
- 若卷 UUID 获取在某文件系统上不可行,按 'local' 落库并记录,不杀停。

## 5. 接口与数据契约
- `start_import` 幂等:同一文件夹重复调用不产生重复 jobs(以 payload_hash 判)。
- 进度:`get_import_progress() -> { total, done, failed, running }`,前端轮询(1s)即可,本卡不做事件推送。
- ffprobe 调用:`ffprobe -v error -print_format json -show_format -show_streams <file>`,超时 30s(超时=failed)。

## 6. 数据不变量与迁移
不改 schema(v1 已含所需列)。不变量:clips.quick_hash 非空;fps/tb 为分数整数对;is_vfr∈{0,1};同 (volume_uuid, rel_path) 唯一(冲突=更新 missing_since=NULL 而非重插);ratings/segments 本卡不写。

## 7. 状态机
沿用 T1 jobs 状态机;新增 job 种类 `import_probe`、`full_hash`,注册进 runner。

## 8. 测试夹具
用 ffmpeg 现场生成小样本(testsrc2 3-5 秒):h264 mp4、hevc mov、一条 VFR(setpts 抖动)、一条 dd 截断损坏文件、一个同内容改名副本(测去重)。夹具生成脚本入 `src-tauri/tests/fixtures.rs`(或 build 脚本),不提交二进制视频。

## 9. 量化验收标准
- `cargo test` 新增 ≥10 测试:扫描过滤规则、快速指纹稳定性、去重、VFR 判定(两 rate 不等样本)、损坏文件 failed 且不崩、断点续作(中途关库重开续跑)、full_hash 补全、幂等 start_import。
- 100 个小样本文件夹导入(测试内生成)全流程 < 60s(M5,本地盘)。
- typecheck/lint/vitest 绿(前端进度页有 1 个组件测试)。

## 10. 验证责任与命令
Codex:`cargo test`、`cargo clippy --all-targets -- -D warnings`、`npm run typecheck`、`npx vitest run`,贴真退出码。主审:真实文件夹(S4 夹具库)手工导入验收 + 全量门禁。

## 11. 失败注入与恢复验收
测试:导入 50 文件中途 drop 库连接重开→不重复、不遗漏;ffprobe 超时路径(用 sleep 假 ffprobe 注入 FFPROBE_PATH)→failed 且 blocked_summary 可读。

## 12. 依赖与分发约束
新增依赖仅限:blake3、walkdir、serde_json(已有)、tauri-plugin-dialog(或 rfd)。禁 ORM、禁 Python。

## 13. 回滚与清理
feature 分支;dev 项目库可整删重建。

## 14. 交付证据
分支 `p1/t2-import` push;7位SHA、快检退出码、新增测试清单、留白/风险。

## 15. 禁改清单
`docs/**`、`spikes/**`;T1 已合入代码只许扩展点内修改(新增 job 种类注册、路由新页),不许重构 T1 结构(发现 T1 缺陷→写进报告,主审裁决)。禁 `git add -A`。

## 16. 变更记录
- 2026-08-31 v1 草拟。
