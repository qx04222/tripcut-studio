# 无人值守 R2 缺口补齐 — 2026-09-06

## 1. 目标与工作项
计划 `docs/superpowers/plans/2026-09-06-r2-gaps.md`。目标：把审计里"后端有、前端没接"和"用户会直接撞上"的缺口补齐。工作项（全部合入 main，多车道 worktree 并行）：
- Task 1 外置盘/素材缺失重连 UI（relink）
- Task 2 相似镜头对比接前端
- Task 3 旁白稿进交付包
- Task 4 隐私与诊断独立设置分区 + 帮助主题
- Task 5 三个 a11y 小项：搜索结果 listbox 语义、评级计数按当前集、三模态焦点约束
- Task 6 list_clips 增量修订号（未变化的轮询不再全量拉取）
- Task 7 导入页拖放
- Task 8 崩溃恢复回归脚本 + 只读探测不迁移
- Task 9 精选段删除撤销
- Task 10 Vite 分包 + 大 chunk 警告进严格模式
迁移号：**0030**（`segments.deleted_at`，Task 9 占用；R3 起功能包顺延为 0031–0035）。

## 2. 快照
起始 main `3f6be59` → 各车道并行开发，最终合并 `e788501`（R2 code items 1–10 全部合入）→ 集成测试假红修复 `546a9a6`（本轮实际收尾 HEAD）。
主要合并提交：`3d10d23`(privacy) `c70a618`(chunks) `87b62a4`(narration) `3b78608`(similar) `cd3ef3e`(relink) `da888f3`(crash) `348936f`(dragdrop) `7b2f65b`(undo, 迁移 0030) `ae02da2`(a11y) `e788501`(listrev)。

## 3. 门禁记录
合并门禁：每次合并后 `node scripts/qa/fast-gates.mjs` 以 gate.json.status 判定，全部 PASS；收尾链（DMG/审计/preflight/冒烟/崩溃对比）结果由接线人在本轮收尾时追加于此。

## 4. FINDINGS
- F-R2-1 relink 只清 `missing_since`，不重写 `volume_uuid`/`rel_path` → 换盘后素材下一次访问路径仍指向旧卷、立即再次失败 → 修复 `1aad600`（按新卷身份写回 uuid 与实际相对路径；无法识别新卷时保留旧 uuid 或整体拒绝并保持行不变）→ 审查员发现，未先红（首次实现即被判需修）。
- F-R2-2 SimilarGroupsPanel 无样式、切换主镜头无并发刷新守卫（快速点击可能显示过期状态）→ 修复 `39b0595`（补样式；测试断言主镜头切换后刷新生效）→ 审查发现。
- F-R2-3 旁白稿只覆盖部分素材 beat，空理由（rationale）未处理 → `d11b878` 补齐整条素材 beat 覆盖 + 空理由分支测试；同时记录地点卡（destination cards）信任已建议修订、而旁白稿要求已确认修订，两处信任门槛不一致，登记 R6 → 测试先红。
- F-R2-4 隐私分区文案指错分区（复制自其它 section 的说明未改指向）→ 修复 `60ed5e0`（文案改指本分区；顺带去掉未使用的 `SETTINGS_SECTION_IDS`）→ 审查发现。
- F-R2-5 拖放导入对空路径列表也会触发导入调用，只读窗口下出现无意义的拒绝提示 → 修复 `b442f2a`（空路径的拖放不触发导入）→ 审查发现。
- F-R2-INT-1 R2 五个车道合并后，两处 `SelectPage` 测试的 api 桩缺 `listSimilarGroups`/`setSimilarPrimary`，集成后 vitest 红 → 先按"检查 wrapper 退出码"误判绿并推送、随后发现应看 `gate.json.status` → 修复 `546a9a6` 补齐测试桩 → 集成红过一次（pushed red once），是本轮唯一先红后绿的门禁级发现。

## 5. 被 revert 或冻结的项
无。R2 Task 9 提到的"部分唯一索引"假设（`segments_live_select_idx` 实为非唯一索引）未按原计划实现撤销冲突检测，相关 UNIQUE 错误映射代码保留但目前不可触发，未删除、未回滚，如实记录为死代码。

## 6. 下一轮入口
R3 平台预设 + Pocket 4 专项（已并行推进并合入，见 R3 报告）。
Backlog：destination-card 与旁白稿信任门槛不一致（F-R2-3 衍生，R6）；`segments_live_select_idx` 非唯一导致撤销冲突检测代码死代码化，待业主确认是否需要真实唯一约束；R1 遗留的 cover/strip 拆分与 16 GB 真机验收仍未处理。

## 3. 收尾链结果（2026-09-06T21:44:32Z, main 27b45a2）

完整打包/审计/预检/冒烟/崩溃恢复链结果见 `docs/qa/2026-09-06-unattended-r4.md` §3（同一次收尾跑通，涵盖 R2/R3/R4 全部功能）。与本轮（R2）直接相关的 smoke-gui.mjs 断言：

| 断言 | 对应 R2 任务 | 结果 |
|---|---|---|
| select.similar.content（相似镜头对比） | Task 2 | PASS |
| settings.privacy.content（隐私与诊断分区） | Task 4 | PASS |
| import.dropOverlay.hidden（导入页拖放遮罩） | Task 7 | PASS |

链路中曾出现一次编译期 `rustfft` 找不到与一次 settings 页级联崩溃，均判定为并发会话共享构建目录导致的环境污染、非代码回归，详见 R4 报告 §3 的完整记录。
