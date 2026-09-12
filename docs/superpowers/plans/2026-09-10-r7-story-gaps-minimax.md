# R7 故事缺口检测 + MiniMax 云端补镜 + 生成物回流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 每个任务先写会红的测试，再写实现。

**Goal:** 故事板自己指出这一集缺哪种镜头；业主一键把缺口发去 MiniMax 云端生成；生成回来的片子作为普通素材入库并进相似镜头容器当备选 Take。少几次手动操作，不多做一件事。

**Architecture:** 检测（纯 Rust，无 LLM）→ 请求构造（提示词 + 首尾帧 JPEG + 成本预估）→ `minimax.rs` 单一网络出口 → `generation_poll` 任务轮询与下载 → `start_import_files` 回流 → `shot_stack::rebuild()` 归位。详见 `docs/superpowers/specs/2026-09-10-story-gap-generation-design.md`。

**Tech Stack:** `reqwest =0.13.4`（已在 Cargo.lock，updater 的传递依赖，本轮提为直接依赖，`default-features=false` + `json`/`rustls-tls`/`stream`）；API Key 走 `security` 子进程读写钥匙串（`service=tripcut-minimax`, `account=tripcut`），**不引入 keyring crate**；抽帧复用 `artifacts.rs` 的 ffmpeg + `hardware_decode_prefix()`；mock 服务器用 Node 内置 `http`，零新增 npm 依赖。

## Global Constraints

- 规格 §3/§6/§9；总计划 Global Constraints 全部继续生效。
- **迁移号 0041**（唯一一个，本轮不再申领；`LATEST_SCHEMA_VERSION` → 41，连续不跳号）。
- 时间一律 ticks + tb；原片只读；**生成物只允许写进 `<project>/generated/<episode_id>/`**，任何写进原始素材目录、监听目录、外置盘的代码都是缺陷。
- **API Key 永不入库、永不进日志、永不进任何 payload、永不回显、永不写进报告或提交信息。**
- **永不自动提交**生成请求；提交前必须显示预估费用；预算耗尽必须在发 HTTP 之前熔断。
- 所有代码必须能在**完全脱网**下用 `scripts/qa/minimax-mock.mjs` 跑通；真接口只在 Task 8 出现且需业主提供 key 与余额。
- 提交带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`；合并前 `node scripts/qa/fast-gates.mjs` 看 `gate.json.status` 必须 PASS；每条车道一个 `git worktree`，共用 `CARGO_TARGET_DIR`。
- 车道并行度：Task 1 先行且独占；随后 2/3/4 可并行；5 依赖 1+4；6 依赖 1+2+3；7 依赖 1；8 收口。

---

### Task 1: 数据层（迁移 0041 + 设置键 + 钥匙串）
**Files:** `src-tauri/src/core/migrations.rs`（`MIGRATION_0041`、注册、`LATEST_SCHEMA_VERSION = 41`）、`src-tauri/src/core/settings.rs`（`MINIMAX_ENABLED_KEY`/`MINIMAX_MODEL_KEY`/`MINIMAX_RESOLUTION_KEY`/`MINIMAX_MONTHLY_BUDGET_KEY` + 默认值常量）、新建 `src-tauri/src/core/secret.rs`（`read_minimax_key()` / `store_minimax_key(&str)` / `has_minimax_key()`，`security` 子进程，key 只走 stdin/stdout 不进 argv）、`src-tauri/src/core/mod.rs`
- [ ] 先红：`migration_0041_creates_gap_and_generation_tables`（断言三张表列名集合、`story_gaps(chapter_id, slot)` 唯一索引存在、`clips.generated_source` 列存在、`generation_poll` 部分唯一索引存在）；`schema_version_is_41`；`migrations_are_contiguous`（已有，加 41 后仍绿）。
- [ ] 先红：`store_and_read_roundtrip_never_puts_key_in_argv`（用可注入的命令记录器断言 key 不出现在任何 argv 元素里，镜像 `llm.rs` 的 `sensitive prompt should only use stdin` 那条测试）。
- [ ] 先红：`minimax_defaults`（enabled=false、model=`MiniMax-H3-Max`、resolution=`768P`、budget=10，budget 上限 500 被夹住）。
- [ ] **接口冻结**（其余车道按此写死）：表结构与列名见规格 §3；设置键字符串 `minimax_enabled` / `minimax_model` / `minimax_resolution` / `minimax_monthly_budget_usd`。
- [ ] Commit：`feat(db): 0041 故事缺口、生成请求与生成账本表;MiniMax 设置键与钥匙串读写`

### Task 2: 缺口检测器
**Files:** 新建 `src-tauri/src/core/story_gap.rs`、`src-tauri/src/core/mod.rs`、`src-tauri/src/core/narrative_revision.rs`（修订变更后调 `detect`）、`src-tauri/src/core/shot_stack.rs`（`rebuild` 末尾调 `detect`）、`src-tauri/src/lib.rs`（命令 `list_story_gaps` / `detect_story_gaps` / `dismiss_story_gap`）
- [ ] **接口冻结**：`pub fn detect(connection: &mut Connection) -> Result<usize>`；`pub fn list(connection: &Connection) -> Result<Vec<StoryGap>>`（`StoryGap { id, chapter_id, chapter_title, beat_id, slot, slot_label_zh, reason, status, latest_request: Option<GenerationRequestSummary> }`）；`pub const GENERATABLE_SLOTS: [&str; 4] = ["REAL/ESTABLISHING", "REAL/DETAIL", "ATMOSPHERE", "TRANSITION"]`。
- [ ] 先红：`dh_map_and_human_slots_never_produce_gaps`（造一个所有 slot 都缺的章节，断言只出 4 行且不含 `DH INTRO`/`DH OVERLAY`/`MAP`/`REAL/HUMAN`/`REAL/EXPERIENCE`）。
- [ ] 先红：`detect_is_idempotent_and_does_not_reopen_requested_gaps`（跑两次行数不变；把一行置 `requested` 后再跑仍是 `requested`）。
- [ ] 先红：`gap_closes_when_a_real_clip_covers_the_slot`（补一条真实素材 → `dismissed`）；`generated_clip_alone_does_not_close_a_gap_by_itself`（只有 `generated_source` 非空的素材时，缺口靠回流流程置 `filled`，不靠检测器）。
- [ ] 先红：`reason_names_the_chapter_and_the_slot`（断言 `reason` 含章节标题与 slot 中文名）。
- [ ] `detect` 绝不写 `generation_requests`（测试断言该表为空）。
- [ ] Commit：`feat(story-gap): 按章节计划槽位与真实素材对比检出可生成缺口,幂等且不自动提交`

### Task 3: 请求构造 + 精确抽帧
**Files:** `src-tauri/src/core/artifacts.rs`（`pub fn frame_at_tick_args(...)` + `pub fn extract_frame_at_tick(...)`，硬解 + 软解回退）、新建 `src-tauri/src/core/generation.rs`（构造与计价部分）、`src-tauri/src/lib.rs`（命令 `build_generation_request`）
- [ ] **接口冻结**：`pub fn build_request(connection, gap_id, overrides: RequestOverrides) -> Result<GenerationDraft>`；`GenerationDraft { gap_id, mode, prompt, refs: Vec<RefImage{path, role}>, duration_s, model, resolution, ratio, estimated_cost_usd, budget_used_usd, budget_limit_usd }`；`pub fn estimate_cost_usd(model: &str, resolution: &str, seconds: u32, images: u32) -> f64`。
- [ ] 先红：`estimate_cost_matches_published_pricing`（H3 768P 6s = 0.48；H3 2K 10s = 1.30；H3-Max 480P 4s = 0.20；7 张图 = +0.08；前 5 张免费）。
- [ ] 先红：`mode_is_fl2v_when_both_neighbour_frames_exist`、`falls_back_to_i2v_with_only_one_neighbour`、`falls_back_to_t2v_and_requires_ratio`。
- [ ] 先红：`prompt_contains_chapter_title_destination_and_slot_template` 与 `prompt_is_capped_at_7000_chars`；`reference_images_capped_at_three_and_total_items_at_twelve`。
- [ ] 先红：`frame_at_tick_args_seeks_by_ticks_not_by_thumbnail_filter`（断言 `-ss` 由 ticks/tb 换算、`-frames:v 1`、无 `thumbnail=`、有硬解前缀且软解版没有）。
- [ ] 抽帧失败必须降级（fl2v → i2v → t2v），测试覆盖降级路径不 panic、不报错。
- [ ] Commit 分两次：`feat(artifacts): 按 tick 精确抽单帧 JPEG,硬解带软解回退` / `feat(generation): 缺口→提示词与首尾帧参考的请求构造与成本预估`

### Task 4: MiniMax 客户端 + 假服务器
**Files:** 新建 `src-tauri/src/core/minimax.rs`、`src-tauri/Cargo.toml`（`reqwest =0.13.4`）、新建 `scripts/qa/minimax-mock.mjs`、新建 `src-tauri/tests/minimax_client.rs`
- [ ] **接口冻结**：`pub fn submit(draft: &GenerationDraft, api_key: &str) -> Result<String>`（返回 `task_id`）；`pub fn query(task_id: &str, api_key: &str) -> Result<TaskState>`（`TaskState { status: TaskStatus, url: Option<String>, error: Option<String> }`，`TaskStatus` = Queued/Succeeded/Failed/Cancelled）；base URL 由 `TRIPCUT_MINIMAX_BASE_URL` 覆盖，默认 `https://api.minimax.io`。
- [ ] 先红（纯函数，脱网）：`request_body_shape_matches_v2_contract`（`model`/`content[]` 的 `type`+`role`/`duration`/`resolution`/`ratio` 齐全，T2V 必带 `ratio`）；`duration_outside_4_to_15_is_rejected_before_any_http`；`body_stays_under_64mb_and_images_under_30mb`。
- [ ] 先红：`data_uri_rejection_is_a_typed_error_not_a_panic`——**先试 data URI，被拒时返回可识别错误**，调用方据此降级为 T2V；此分支必须有测试（真接口答案在 Task 8 记录）。
- [ ] `minimax-mock.mjs`：两个端点，`--outcome succeeded|failed|slow`、`--fixture <mp4>`、`--record <json>`；断言收到非空 `Authorization: Bearer`，缺失返回 401。
- [ ] 先红：集成测试对 mock 跑 submit→query 三种结局；`api_key_never_appears_in_error_messages_or_logs`。
- [ ] Commit 分两次：`test(qa): MiniMax 假服务器——两端点可配置成功/失败/慢速` / `feat(minimax): v2 视频生成客户端,请求体校验与鉴权,base URL 可覆盖`

### Task 5: generation_poll 任务与回流
**Files:** `src-tauri/src/core/jobs.rs`（`resource_class` 加 `generation_poll` → Light，确认它**不在** `DECODE_KINDS_SQL`/`HEAVY_KINDS_SQL` 因而不受内存压力暂停）、`src-tauri/src/core/generation.rs`（`submit_request` / `run_poll_job` / `import_result`）、`src-tauri/src/core/shot_stack.rs`（成员排序加"生成片永远排在真实素材之后"）、`src-tauri/src/lib.rs`（命令 `submit_generation_request` / `retry_generation_request` / `list_generation_requests`）
- [ ] **接口冻结**：`pub fn submit_request(connection, draft) -> Result<i64>`（预算熔断 → 写账本 → 发请求 → 入队）；`pub fn run_poll_job(connection, job, project_root) -> Result<()>`；`pub fn generated_root_for_db(db_path: &Path) -> PathBuf`（= `db_path.parent()/generated`）。
- [ ] 先红：`budget_exhausted_refuses_before_any_http`（把 mock 指到一个会 panic 的地址，断言错误是中文预算文案且 mock 未收到请求）；`disabled_provider_refuses_before_any_http`。
- [ ] 先红：`poll_backs_off_exponentially_and_gives_up_after_two_hours`（注入时钟，断言 `next_attempt_at` 递增且封顶 5 分钟、超 2h 置 `failed` 带中文原因）。
- [ ] 先红：`generation_poll_is_light_and_not_paused_by_memory_pressure`（内存压力暂停开启时仍可被认领）。
- [ ] 先红：`result_lands_only_under_generated_dir`（回流后遍历原始素材目录与监听目录，断言零新增文件）。
- [ ] 先红：`imported_clip_is_marked_generated_and_gap_is_filled`（`clips.generated_source='minimax'`、`chapter_id` = 缺口章节、`generation_requests.status='imported'`、`story_gaps.status='filled'`）。
- [ ] 先红：`generated_clip_ranks_after_every_real_clip_in_its_stack`，以及 `rebuild_does_not_lose_that_ordering`（跑一次 `rebuild()` 后仍成立）；`manual_hero_can_still_promote_it`。
- [ ] 先红：`retry_creates_a_new_row_referencing_the_old_one`（`retry_of` 非空，旧行状态不变）。
- [ ] Commit 分两次：`feat(jobs): generation_poll 轻量任务——指数退避、2 小时上限、不受内存压力暂停` / `feat(generation): 结果下载入 generated/ 并经普通导入回流,生成片恒为备选 Take`

### Task 6: 故事板缺口卡片与生成对话框
**Files:** `src/api.ts`（`listStoryGaps` / `detectStoryGaps` / `dismissStoryGap` / `buildGenerationRequest` / `submitGenerationRequest` / `retryGenerationRequest` + 类型）、`src/Storyboard.tsx`（章节 `missing_slots` 渲染处旁挂缺口卡片与内联状态）、新建 `src/GenerationDialog.tsx`、`src/Storyboard.test.tsx`、新建 `src/GenerationDialog.test.tsx`
- [ ] 先红：`缺口卡片显示「缺口：建立镜头」与原因`；`未启用或预算耗尽时提交按钮禁用并给出中文原因`；`对话框显示预估费用与本月已用/预算`；`提示词超 7000 字符时禁止提交`；`失败状态显示原因并提供「重新生成」`；`已入库显示缩略图且不再提供「生成候选」`。
- [ ] 对话框用 `useFocusTrap`，Esc 关闭，主按钮文案「提交（约 $0.30）」。
- [ ] Commit：`feat(storyboard): 缺口卡片与「生成候选」对话框——提示词可编、参考帧预览、费用先见`

### Task 7: 设置页分区、账本与「AI 生成」徽章
**Files:** `src/settingsSections.ts`（加 `generation`）、`src/SettingsPage.tsx`、`src/helpContent.ts`、`src/SelectPage.tsx`（徽章）、`src/api.ts`（`getGenerationStatus` / `listGenerationLedger` / `setMinimaxApiKey`）、`src-tauri/src/lib.rs`（对应命令）、`src/SettingsPage.test.tsx`、`src/SelectPage.test.tsx`
- [ ] 先红：`API Key 保存后只显示「已配置」且输入框不回显`；`月度预算与本月用量渲染`；`账本表列齐（时间/章节·slot/模型/秒/预估费用/状态）`；`说明文案写明「费用以 MiniMax 平台账单为准」`。
- [ ] 先红：`generated_source 非空的素材显示「AI 生成」徽章`，真实素材不显示。
- [ ] 顺带（仅当是纯加一列）：剪辑清单 CSV 与联系表 PDF 加「来源」列，值「AI 生成」；否则本条整体挪到下一轮并在报告里写明。
- [ ] Commit 分两次：`feat(settings): 「云端补镜（MiniMax）」分区——钥匙串写入、预算与预估账本` / `feat(select): AI 生成素材徽章`

### Task 8: 收尾（含业主门控真接口 e2e）
**Files:** 新建 `scripts/qa/generation-e2e.mjs`、`scripts/qa/fast-gates.mjs`、`scripts/qa/smoke-gui.mjs`、`docs/用户手册.md`、`docs/USER_GUIDE.md`、新建 `docs/qa/2026-09-10-unattended-r7.md`
- [ ] `generation-e2e.mjs`（脱网，进门禁）：mock 起服务 → 检测缺口 → 构造 → 提交 → 轮询 → 下载 tiny mp4 fixture → 导入 → 断言 `generated_source`、`story_gaps.status='filled'`、Stack 排序、`generated/` 之外零新增文件；再跑 `--outcome failed` 与 `--outcome slow` 两条负例。
- [ ] `smoke-gui.mjs` 加断言：设置页「云端补镜（MiniMax）」分区标题存在（常驻渲染，同「隐私与诊断」那条的稳定路径）；故事板缺口卡片依赖不稳定的「故事板」标签 AX 路径，降级为 WARN-only。
- [ ] 门禁：`fast-gates.mjs` 加 `generation-e2e.mjs`（脱网、mock、无 key 也能跑）。
- [ ] 手册：「故事板」章节加「缺口与云端补镜」，「设置」章节加新分区说明，写明**要钱、要自己注册充值、费用以平台账单为准、生成片默认只作备选**。
- [ ] **业主门控**（需要业主提供 key 与余额，约 $0.20）：真接口跑一条 4 秒 480P `MiniMax-H3-Max`，断言真实回流成功、账本记一笔；**并在报告里写下 data URI 是否被平台接受**这一未核实项的答案；若被拒，记录补镜退化为纯 T2V 的实际影响。
- [ ] `docs/qa/2026-09-10-unattended-r7.md` 六节（目标与工作项 / 快照 / 门禁记录 / FINDINGS / 被 revert 或冻结项 / 下一轮入口）；总计划勾选；待业主清单更新。
- [ ] Commit：`docs(r7): 缺口补镜手册与 QA 报告;e2e 进门禁`
