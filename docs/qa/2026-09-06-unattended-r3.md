# 无人值守 R3 目标平台 + Pocket 4 专项 — 2026-09-06

## 1. 目标与工作项
计划 `docs/superpowers/plans/2026-09-06-r3-platform-pocket4.md`。目标：新建集时选目标平台与横竖画布并贯穿到交付；Pocket 4 素材的 D-Log/HDR 显示、多声道分轨、显示 LUT、可读取的曝光参数进入技术检查与交付说明。工作项（全部合入 main）：
- Task 1 迁移 0031 平台预设数据层与命令
- Task 2 新建集向导与交付对话框的平台选择（前端）
- Task 3 交付层读平台预设（导出说明/尺寸/字幕按平台）
- Task 4 迁移 0032 多声道与拍摄参数入库
- Task 5 播放器显示 LUT 与音轨/静音命令
- Task 6 转录选轨与音轨映射进交付
- Task 7 技术检查面板（色彩/横竖/多声道/拍摄参数/显示 LUT）
迁移号：**0031**（平台预设）、**0032**（音轨/LUT/元数据）。

## 2. 快照
起始 main `5c05a06` → 结束 `2176e5d`（R3 代码任务 1–7 全部合入并推送）。
主要合并提交：`432f07e`(platform 0031) `9772244`(platform-ui) `cd8a39d`(audio 0032) `cdb44cb`(deliver-platform) `c67cb19`(player-lut) `1b1760e`(techcheck) `2d93b71`(修复 ClipListItem 字段回归) `2176e5d`(transcribe-track)。

## 3. 门禁记录
合并门禁：每次合并后 `node scripts/qa/fast-gates.mjs` 以 gate.json.status 判定，全部 PASS；收尾链（DMG/审计/preflight/冒烟/崩溃对比）结果由接线人在本轮收尾时追加于此。

## 4. FINDINGS
- F-R3-1 mpv 的 `aid` 是 1 基而 `clip_audio_tracks.stream_index`（DB/api.ts 域）是 0 基，`apply_stored_display_prefs` 把存储值直接当 `aid` 传入，导致选第一条音轨时 `aid=0` 非法 → 转换收拢到单一函数 `mpv_calls_for`（`aid = stream_index + 1`，负值报错而非静默发垃圾值）→ 修复 `f970fc5`（合并入 `c67cb19`）→ 审查判定 Critical，先红后绿。
- F-R3-2 技术检查面板「探测音轨」按钮在已有音轨时也常驻显示，且探测成功后旧错误提示不清除 → 修复 `7f7ae6e`（按钮只在无音轨的空态显示；加载成功清除旧 error）→ 审查发现空态门控问题，改前测试断言按钮存在与否，先红后绿。
- F-R3-3 交付层新增 4 个参数的 `start_export`，v4 导出任务载荷缺 `platform_info` 字段时反序列化行为未测 → 补测试并按需修复默认值路径 `1dbc0cd`（证明缺字段时仍反序列化为默认平台）→ 测试先行补齐，验证通过。
- F-R3-4 `attach_audio_tracks` 注释写"按本次交付素材过滤"，实现却是不带 WHERE 的全表 `SELECT * FROM clip_audio_tracks`，注释与实现不符 → 修复 `2558409`（查询按本次交付的素材 id 过滤 + 新增反例测试断言未选中素材的音轨不泄露）→ 审查发现。

## 5. 被 revert 或冻结的项
无。`narrative.rs` 兜底逻辑等 R3 未触及项保持原状；R3 Task 4 的迁移号 gap（0031 由并发车道占用，0032 先落地）按设计允许，未回滚。

## 6. 下一轮入口
R4 联系表 PDF + 故事模板（已并行推进并合入，见 R4 报告）。
Backlog（登记 R6）：旧素材未按新探测重新探测音轨（`clip_audio_tracks` backfill 谓词未覆盖历史 clip）；ISO 前缀值（如 `ISO800`）未剥离前缀，解析为 `None`；新建/重命名后的集默认平台 `general`/画布 `both`，无 UI 提示直到用户手动改。

## 3. 收尾链结果（2026-09-06T21:44:32Z, main 27b45a2）

完整打包/审计/预检/冒烟/崩溃恢复链结果见 `docs/qa/2026-09-06-unattended-r4.md` §3（同一次收尾跑通，涵盖 R2/R3/R4 全部功能）。与本轮（R3）直接相关的 smoke-gui.mjs 断言：

| 断言 | 对应 R3 任务 | 结果 |
|---|---|---|
| select.techcheck.content（技术检查面板） | Task 7 | PASS |
| episode.renamePlatform.field（重命名对话框「目标平台」下拉，WARN-only 按设计） | Task 1/2（平台预设） | WARN：`抽屉点中=false 重命名按钮可见=false 目标平台=false`（AX 路径本身标为不可靠，不阻塞冒烟，如实记录） |

链路中曾出现一次编译期 `rustfft` 找不到与一次 settings 页级联崩溃，均判定为并发会话共享构建目录导致的环境污染、非代码回归，详见 R4 报告 §3 的完整记录。
