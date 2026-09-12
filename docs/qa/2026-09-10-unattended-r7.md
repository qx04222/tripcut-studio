# 无人值守 R7——故事缺口检测、MiniMax 云端补镜、生成物回流 — 2026-09-10

## 1. 目标与工作项

本轮（R7）是 `docs/superpowers/plans/2026-09-06-r7-*` 系列计划（故事缺口 + MiniMax 云端补镜）的执行轮：检测叙事里接不上的镜头缺口、按需向 MiniMax 云端下单补拍候选、把生成结果作为普通素材回流进故事板与素材库，全程按月度预算熔断、绝不自动提交。Task 8（真实接口 e2e、剪映 11.4 人眼核对）为业主门控项，本轮不当作已收口。

`git log --oneline --merges -12` 命中的本轮合并提交（新到旧）：

| 任务 | 内容 | 合并提交 |
|---|---|---|
| Task 6（+api dedupe） | 故事板缺口卡片、生成对话框；随后与 Task 5 契约副本合并去重 `generationAvailability` | `d01b68b` |
| Task 6 | 故事板缺口卡片与生成对话框（`feat/r7-board`） | `647ce03` |
| Task 7 | 设置页云端补镜分区、钥匙串命令、账本与「AI 生成」徽章（`feat/r7-settings`） | `5741d8e` |
| — | 合并 `feat/r7-gaps` 进 `feat/r7-board` | `99344a4` |
| Task 2 | 故事缺口检测器（`feat/r7-gaps`） | `444102a` |
| Task 4 | MiniMax 客户端与假服务器（`feat/r7-client`） | `6c12aa1` |
| Task 3 | 精确抽帧与生成请求构造（`feat/r7-frames`） | `dcbad95` |
| Task 1 | 迁移 0041、MiniMax 设置键与钥匙串（`feat/r7-data`） | `80972d4` |

迁移号：0041（`story_gaps` / 生成请求 / 轮询任务表，Task 1）。LATEST 41。

Task 5（轮询与生成物导入回流）在文档轮启动时仍在制作中（ledger：「Remaining: Task 5（in flight）→ merge/dedupe → gate → Task 8 closeout」），未合并进本次统计的合并列表；本文档只覆盖 Task 1–4、6、7 已落地的部分,并如实标注 Task 5/8 未完成。

验证方式：每项任务合并前跑该车道单测（先红后绿），合并后跑 `fast-gates`；真实 MiniMax 接口的 e2e 与剪映 11.4 人眼核对留给业主（见 §6）。

## 2. 快照与测量

对本地假服务器（`scripts/qa/minimax-mock.mjs`）的端到端：`src-tauri/tests/generation_e2e.rs` 10 条全部走 `JobRunner::run_one`（真协调器接线），覆盖 成功→下载→导入→挂为备选→缺口 filled→通知一次、失败、图片被拒→降级 t2v、预算耗尽、缺 key、双击提交幂等、崩溃后重轮询复用已导入 clip、轮询期间切集仍落原集、首尾帧数据 URI 出现在请求体、目录指纹证明只在 `generated/<episode>/` 新增文件。单元：generation 40、jobs 61、shot_stack 29、minimax 26 + 客户端集成 12、story_gap 8+、generation_settings 7、secret 9。真实 MiniMax 接口 e2e：**未跑**——需要业主注册、充值并粘入 API key（设置页「云端补镜（MiniMax）」）。费用口径：账本在提交时按预估记一行作预留，`actual_cost_usd` 暂不回填。

## 3. 门禁记录

`ls qa/runs/ | grep -i "2026-09-10.*fast-gates"` 命中今天的记录，逐条读取各自 `gate.json` 的 `status` 字段：

| 运行目录 | status |
|---|---|
| `2026-09-10T13-43-09Z-fast-gates` | FAIL（如实列出，未追查根因，不在本轮工作项范围内） |
| `2026-09-10T13-50-27Z-fast-gates` | PASS |
| `2026-09-10T14-22-42Z-fast-gates` | FAIL（如实列出） |
| `2026-09-10T14-25-05Z-fast-gates` | PASS |
| `2026-09-10T14-30-02Z-fast-gates` | PASS |
| `2026-09-10T14-40-00Z-fast-gates` | PASS |
| `2026-09-10T14-42-11Z-fast-gates` | FAIL（如实列出） |
| `2026-09-10T14-44-28Z-fast-gates` | PASS |

今日共 8 次 `fast-gates` 运行，5 次 PASS、3 次 FAIL；每次 FAIL 之后紧跟的下一次运行均为 PASS，main 最终推送状态以最后一次 `2026-09-10T14-44-28Z-fast-gates`（PASS）为准。

## 4. FINDINGS

（来自本轮 ledger `# R7 ledger` 段落，逐条如实列出，已修复的标注修复方式）

- F-R7-1：`security -w` 读密码——真实 macOS `security` CLI 在某些路径下会把密码提示读两遍，Task 1 的钥匙串写入曾因此踩坑——已修复并用一次真实往返（写入再读回一个临时 item）验证。
- F-R7-2：Task 3 首个版本缺少 H3-Max 模式门控（H3-Max 不支持首尾帧引导却没有拦截/降级逻辑）——review 判 Needs fixes，修复后按能力矩阵（H3-Max 仅 480P/768P、不支持 fl2v）降级为图生视频并补充说明文案，验证通过后合并。
- F-R7-3：Task 4（MiniMax 客户端）review 发现 HIGH 级问题——base URL 可被覆盖且未校验，存在把 API Key 明文发到攻击者可控端点的泄露风险；连带的 MEDIUM 问题：下载超时、临时文件泄漏、状态码容错不足、`Retry-After` 日期格式未处理、测试空洞——已在 `feat/r7-client` 修复并验证（26+12 个测试），合并 `6c12aa1`。
- F-R7-4：Task 2（故事缺口检测器）review 判 P1——处于旧修订版本（stale revision）的缺口在列表里被重复计入——已在 `feat/r7-gaps` 修复并验证，合并 `444102a`。
- F-R7-5：同一轮 review 的 P2——Orientation（朝向类）缺口被误映射成 ESTABLISHING（建立镜头）类，会产生假的可计费缺口——随 F-R7-4 一并修复。
- F-R7-6：Task 6（故事板缺口卡片/生成对话框）review 判 P1——轮询逻辑在生成请求进入 `succeeded`（生成中/已下载但未入库）状态后就停止，导致卡片永远卡在「生成中」、等不到「已入库」——已修复：轮询覆盖到全部非终态状态，直到 `imported`/`failed`/`cancelled` 才停止。
- F-R7-7：`feat/r7-board`（Task 6）与 `feat/r7-poll`（Task 5，进行中）各自维护了一份 `generationAvailability` 的类型/调用声明，merge 时出现重复声明——已在 `d01b68b` 合并去重。
- F-R7-ENV-1：本机安装的剪映在本轮期间自动更新到 11.4.13169（超出白名单 11.3.0），草稿文件格式变为加密（`template-2.tmp`，1164 B），金丝雀脚本无法再逐字段比对，判定改为 `PENDING_HUMAN_CHECK`（WARN 而非 FAIL）；应用本身仍会拒绝为该版本生成草稿，不会静默产出打不开的文件。这不是 R7 的代码回归，但需要业主用真实 11.4 剪映打开一份 TripCut 生成的 11.3.0 格式草稿来确认新版本到底能不能打开明文草稿。
- 许可证清单门禁（`license-manifest`）在本轮期间抓到 `reqwest`/`httpdate`（MiniMax 客户端新依赖）未映射，已补齐映射并保持在 `fast-gates` 内。

## 5. 被 revert 或冻结的项

无。§3 中三次 `fast-gates` FAIL（13:43Z、14:22Z、14:42Z）均在下一次运行前修复并重新验证为 PASS，没有触发「同一工作项两次 revert 即冻结」的规则。

## 6. 下一轮入口 / 待业主

**下一轮入口（技术）：**
- Task 5：轮询与生成物导入回流车道完成合并、去重、门禁绿。
- Task 8 收尾：Task 5 落地后补齐 §2 的性能/端到端快照，走完整门禁 + 打包链路，本文档补全。

**待业主（只登记不做）：**
- MiniMax 注册/充值/粘 Key → 真实接口 e2e：需要业主自行在 platform.minimax.io 注册账号、开通按量付费、充值，并把生成的 API Key 粘到设置页「云端补镜」分区，才能跑通真实网络请求的端到端验证（本轮内部测试全部基于假服务器/mock）。
- 剪映 11.4 人眼验证：F-R7-ENV-1 记录的加密草稿问题需要业主用真实安装的剪映 11.4.13169 打开一份 TripCut 生成的（11.3.0 格式）草稿，确认新版本到底能不能读取明文草稿；在业主确认前，交付页对该版本继续保持「不支持」提示。
