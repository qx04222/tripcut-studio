# 故事缺口检测 + MiniMax 云端补镜 + 生成物回流 — 设计规格（2026-09-10）

业主批准于 2026-09-10。本文是 R7 轮的唯一依据；执行计划见 `docs/superpowers/plans/2026-09-06-r7-story-gap-minimax.md`。

## 0. 起点与目标

- 起点：`main` 已完成 R0–R6，SQLite schema 40，六门禁绿。故事板已有 `narrative_revisions`（suggested/confirmed）、章节 `story_slots_json`/`missing_slots_json`、`shot_stacks`/`shot_stack_members`（相似镜头容器 = Take 机制）、`jobs` 协调器（Decode/HeavyModel/Light 三资源类 + 内存压力暂停）、`llm_ledger`（月度调用预算熔断）。
- 目标：**每条 Vlog 少几次手动操作**。做且只做三件事：(1) 自动指出这一集哪些章节缺哪种镜头；(2) 让业主一键把缺口发去 MiniMax 云端生成；(3) 生成回来的片子作为**普通素材**入库，进相似镜头容器当备选 Take。
- 明确不做：不做本地 H3、不接 ComfyUI、不做任何模型分发、不做分享/授权/水印/合规流程（自用软件）、不改交付与剪映导出（生成片是普通 clip，`deliver.rs`/`jianying.rs` 零改动）。
- 只停下等业主的三件事：**注册 MiniMax 平台账号、拿 API Key、充值**；真机真接口 e2e 需要余额，列为业主门控任务，不阻塞前七个任务。

## 1. 架构

```
narrative(active revision) ──┐
COVERAGE_ITEMS/STORY_SLOTS ──┼─→ story_gap::detect()  ── 写 story_gaps(open)
shot_stacks + clips ─────────┘        │（纯 Rust,无 LLM,幂等,按 (chapter,slot) 去重）
                                      ↓ 业主在故事板点「生成候选」
                       generation::build_request()  ── 提示词 + 参考帧(JPEG) + 成本预估
                                      ↓ 业主确认「提交」(预算未耗尽)
                       minimax::submit()  POST /v2/video_generation → task_id
                                      ↓ 入队 job kind=generation_poll (Light)
                       minimax::query()   GET  /v2/query/video_generation/{id}
                                      ↓ succeeded + content.url
                       download → <project>/generated/<episode_id>/xxx.mp4
                                      ↓ import::start_import_files()
                       普通 clip(chapter_id=缺口章节, generated_source='minimax')
                                      ↓ 分析流水线照常跑 → shot_stack::rebuild()
                       进对应 Stack 当**备选**(排序永远排在真实素材之后)
                                      ↓ story_gaps.status = filled
```

三条不可越界的线：
1. **生成物只进 `<project>/generated/`**，绝不写进任何原始素材目录、监听目录或外置盘；原片只读纪律不变。
2. **永不自动提交**。检测到缺口只是显示卡片；提交是业主的显式点击，且先看到预估费用。
3. **生成片永不当主选**。Stack 里排序永远在真实素材之后，除非业主手动 `hero`/`locked`。

## 2. 技术栈

- HTTP：`reqwest`（`Cargo.lock` 里已有 0.13.4，是 `tauri-plugin-updater` 的传递依赖）提为直接依赖并锁 `=0.13.4`，`default-features = false` + `json`/`rustls-tls`/`stream`（流式下载结果 mp4，不整包进内存）。tokio 运行时已在。
- 密钥：**不引入 keyring crate**。沿用 R6 更新签名口令的既有模式——`security` 子进程读钥匙串：`security find-generic-password -a tripcut -s tripcut-minimax -w`，写入由设置页调 `security add-generic-password -U`。Key 永不入库、永不进日志、永不写进报告与任何 payload。
- 抽帧：复用 `artifacts.rs` 的 ffmpeg 调用与 `hardware_decode_prefix()` 硬解回退模式，新增 `frame_at_tick_args()`（精确到 tick 取单帧 JPEG，非 `thumbnail=90` 代表帧）。
- 无新前端依赖；对话框沿用 `useFocusTrap`。
- 假服务器：`scripts/qa/minimax-mock.mjs`（Node 内置 `http`，零依赖），Rust 集成测试与 e2e 脚本共用。

### 2.1 MiniMax 接口事实（2026-09-10 核于 platform.minimax.io）

| 项 | 值 |
|---|---|
| base | `https://api.minimax.io`（可由 `TRIPCUT_MINIMAX_BASE_URL` 覆盖，指向 mock） |
| 创建 | `POST /v2/video_generation` → `{task_id}` |
| 轮询 | `GET /v2/query/video_generation/{task_id}` → `status`, `content.url`, `error` |
| 鉴权 | `Authorization: Bearer {api_key}` |
| 模型 | `MiniMax-H3`（T2V/I2V/首尾帧/参考图，768P·2K）、`MiniMax-H3-Max`（仅 T2V/I2V，480P·768P，便宜） |
| 请求 | `model`, `content[]`（`type: text\|image_url\|video_url\|audio_url`，`role: first_frame\|last_frame\|reference_image\|reference_video\|base_video`）, `duration` 4–15 整数秒, `resolution`, `ratio`（T2V 必填，I2V 自适应） |
| 状态 | `queued` / `succeeded` / `failed` / `cancelled` |
| 下载 URL | 假定 **24 小时**过期——拿到即下，不缓存 URL 当资产 |
| 限额 | 图 ≤30 MB、边长 256–5760、比例 2:5–5:2；≤9 参考图、≤3 视频、≤3 音频、合计 ≤12；请求体 ≤64 MB；提示词 ≤7000 字符 |
| 计价 | H3 768P $0.08/s、2K $0.13/s；H3-Max 480P $0.05/s、768P $0.08/s；前 5 张输入图免费，之后 $0.04/张。无免费额度 |

**未核实项**：小图能否以 base64 data URI 直接放进 `image_url`（文档只说"大资产建议用 URL"）。客户端设计成**先试 data URI，被拒则报错并把结论写进 e2e 报告**；本机没有可给云端访问的公网 URL，若 data URI 被拒，补镜退化为纯 T2V（这一分支必须在代码里存在且可测）。

## 3. 数据模型（迁移 0041，schema → 41）

```sql
CREATE TABLE story_gaps (
    id INTEGER PRIMARY KEY,
    episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    revision_id INTEGER NOT NULL REFERENCES narrative_revisions(id) ON DELETE CASCADE,
    chapter_id  INTEGER NOT NULL REFERENCES narrative_chapters(id) ON DELETE CASCADE,
    beat_id     INTEGER REFERENCES narrative_beats(id) ON DELETE SET NULL,
    slot        TEXT NOT NULL,            -- STORY_SLOTS 之一,且必在可生成白名单里
    reason      TEXT NOT NULL,            -- 中文一句话:为什么判定为缺口
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK(status IN ('open','requested','filled','dismissed')),
    detected_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX story_gaps_unique_idx ON story_gaps(chapter_id, slot);

CREATE TABLE generation_requests (
    id INTEGER PRIMARY KEY,
    gap_id   INTEGER NOT NULL REFERENCES story_gaps(id) ON DELETE CASCADE,
    retry_of INTEGER REFERENCES generation_requests(id),   -- 重新生成 = 新行指向旧行
    provider TEXT NOT NULL DEFAULT 'minimax' CHECK(provider IN ('minimax')),
    model    TEXT NOT NULL,
    mode     TEXT NOT NULL CHECK(mode IN ('t2v','i2v','fl2v','r2v')),
    prompt   TEXT NOT NULL,
    refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(refs_json)),  -- [{path, role}]
    duration_s INTEGER NOT NULL CHECK(duration_s BETWEEN 4 AND 15),
    resolution TEXT NOT NULL CHECK(resolution IN ('480P','768P','2K')),
    ratio TEXT,
    estimated_cost_usd REAL NOT NULL CHECK(estimated_cost_usd >= 0),
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
           CHECK(status IN ('draft','submitted','queued','succeeded','failed','cancelled','imported')),
    error TEXT,
    result_url TEXT,
    result_clip_id INTEGER REFERENCES clips(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX generation_requests_gap_idx ON generation_requests(gap_id, id);
CREATE UNIQUE INDEX generation_requests_task_idx ON generation_requests(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE generation_ledger (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES generation_requests(id) ON DELETE CASCADE,
    cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
    seconds  INTEGER NOT NULL,
    images   INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
);
CREATE INDEX generation_ledger_month_idx ON generation_ledger(at);

ALTER TABLE clips ADD COLUMN generated_source TEXT;   -- NULL=真实素材, 'minimax'=云端生成

CREATE UNIQUE INDEX jobs_active_generation_poll_payload_unique_idx
ON jobs(kind, payload_hash)
WHERE kind = 'generation_poll' AND status IN ('pending','running');
```

设置键（`settings.rs`）：`minimax_enabled`（默认 `false`）、`minimax_model`（默认 `MiniMax-H3-Max`）、`minimax_resolution`（默认 `768P`）、`minimax_monthly_budget_usd`（默认 `10`，上限 `500`）。**API Key 不进 settings 表**，只在钥匙串 `service=tripcut-minimax, account=tripcut`。

### 3.1 为什么加 `clips.generated_source` 而不是打 tag

核过 `tags` 表是 **segment 级**（`tags.segment_id`），而导入路径并不为每条 clip 建整片 segment（`llm.rs`/`shot_stack.rs` 里写 tag 的路径都依赖已有 segment）。Select 页徽章、Stack 排序、CSV 来源列都需要 **clip 级**布尔量，故以 `clips.generated_source` 为权威来源；若该 clip 恰好已有整片 select segment，则**额外**补一条 `tags(label='generated:minimax', source='generation')` 供搜索命中，缺 segment 时不报错、不阻塞。

## 4. 缺口检测（纯 Rust，无 LLM）

- 触发：`narrative_revisions` 变化（新建 suggested / 首次编辑生成 confirmed / override 应用与撤销）之后、以及 `shot_stack::rebuild()` 之后，调 `story_gap::detect(connection)`；也提供命令供故事板手动「重新检测」。**永不自动提交生成请求。**
- 输入：活跃修订（confirmed 优先，否则 suggested）的章节与 beats 的 `story_slots_json`、章节 `missing_slots_json`、`COVERAGE_ITEMS` 覆盖表，以及该章节下 `shot_stack_members` 里 `generated_source IS NULL` 的真实素材所占的 slot。
- 判定：章节计划到的 slot，若没有任何真实素材覆盖 → 缺口。
- **可生成白名单**：`REAL/ESTABLISHING`、`ATMOSPHERE`、`TRANSITION`、`REAL/DETAIL`。`DH INTRO`、`DH OVERLAY`、`MAP`、`REAL/HUMAN`、`REAL/EXPERIENCE` **不生成**——数字人与地图由既有管线负责，人物/体验镜头生成出来是假的旅行记录，直接排除在检测结果之外（不是"生成但不推荐"，是根本不产生缺口行）。
- 幂等：`UNIQUE(chapter_id, slot)`；重跑用 `INSERT ... ON CONFLICT DO UPDATE` 只刷新 `reason`/`updated_at`；已 `requested`/`filled`/`dismissed` 的行**不回退**为 `open`；缺口不再成立（真实素材补上了）时置 `dismissed` 并记 `reason`。
- 输出可解释：`reason` 形如「第 3 章《黑石峡谷》计划了建立镜头，但本章 7 条素材里没有一条被判为 Establishing」。

## 5. 请求构造

- **提示词**（中文，≤7000 字符，模板在 `generation.rs` 里作常量，四种 slot 各一套）：章节标题 + 目的地卡（地名/地貌/时段）+ 该章 transcript 关键词（复用既有关键词抽取，截断 240 字符）+ slot 专用句式。例：建立镜头 →「航拍缓推：{地点}，{时段}，{地貌关键词}，自然光，写实纪录片质感，无人物，无文字，无字幕」。所有模板末尾统一追加负向约束「不要出现人脸、不要文字水印」。
- **参考帧与 mode 选择**（按优先级）：
  1. 前一 beat 主选片的**末帧** + 后一 beat 主选片的**首帧** 都能抽到 → `fl2v`（`first_frame` + `last_frame`）。
  2. 只有一侧 → `i2v`（最近的封面或该侧帧作 `first_frame`）。
  3. 都没有 → `t2v`，此时 `ratio` 必填（取该集 `canvas_orientation` 推出的 16:9 / 9:16）。
  4. 另附该章封面里 ≤3 张作 `reference_image`（合计参考图 ≤9、≤12 项，代码里硬校验）。
- **抽帧**：`artifacts::frame_at_tick_args()`，ticks + tb 时基（不用秒做主时基），输出 JPEG 到 `<cache>/genrefs/<request_id>/`，长边缩到 ≤1920（远低于 30 MB 与 5760 上限），失败即降级到上一优先级而不是报错。
- **默认参数**：`MiniMax-H3-Max` / `768P` / `6` 秒；可在对话框里改为 `MiniMax-H3` + `2K`；`duration` 限 4–15。
- **成本预估**：`estimate_cost_usd(model, resolution, seconds, images)` = 单价×秒数 + `max(0, images-5)×0.04`。提交前必须在对话框里显示，并显示"本月已用 / 预算"。
- **预算熔断**（镜像 `llm.rs::reserve_call` 的原子模式）：在 `IMMEDIATE` 事务里读 `minimax_monthly_budget_usd` 与本月 `generation_ledger` 求和，`已用 + 本次预估 > 预算` → 直接返回中文错误「本月云端补镜预算已用尽（$x/$y），已熔断且未发出请求」，**不发 HTTP**。`minimax_enabled=false` 同样在发请求前拦截。

## 6. 云端调用、轮询与回流

- `minimax.rs` 客户端：`submit(request) -> task_id`、`query(task_id) -> TaskState`。所有网络出口集中在这一个模块，base URL 可被 `TRIPCUT_MINIMAX_BASE_URL` 覆盖以指向 mock；请求体构造与响应解析是**纯函数**，可脱网单测。
- 提交成功即写 `generation_ledger`（按预估计价——平台不回单次实际扣费；账本自述是"预估"，设置页文案写明"以平台账单为准"），`generation_requests.status='submitted'`，并 `jobs::enqueue_idempotent('generation_poll', {"request_id":N})`。
- **job kind `generation_poll`**：`ResourceClass::Light`；**不受内存压力暂停影响**（它不解码、不占显存，等云端结果时被暂停只会白等）；指数退避 10s → 20s → 40s …上限 5 分钟；总时长上限 **2 小时**，超时置 `failed` 并写中文 `error`；`queued` 视为未完成，重新入队；`failed`/`cancelled` 终态不重试（重试由业主点「重新生成」产生新行）。
- **回流**（`succeeded` 后，一次事务外的顺序动作，每步失败都留下可读 `error`）：
  1. 流式下载 `content.url` → `<project>/generated/<episode_id>/<request_id>-<task_id>.mp4`（目录不存在则建；**绝不写进原始素材目录或监听目录**）。
  2. `import::start_import_files(&[path])` 入库，走完全套普通导入与分析流水线。
  3. `UPDATE clips SET generated_source='minimax', chapter_id=<缺口章节> WHERE id=?`；有整片 segment 时补 `generated:minimax` tag。
  4. `generation_requests.status='imported'`、`result_clip_id`；`story_gaps.status='filled'`。
  5. 触发 `shot_stack::rebuild()`，生成片按普通素材进对应 Stack。
- **"永远是备选，不是主选"如何做到**：核过 `shot_stack::rebuild()` 会 `DELETE FROM scenes` 后由分析维度**整体重建**成员，任何手工插入的成员行都会被抹掉——所以不能靠"插一行成员"。做法是在 Stack 成员排序里加一条确定性规则：`ORDER BY (generated_source IS NOT NULL) ASC, user_state, best_take_score DESC`，即生成片一律排在全部真实素材之后；只有业主手动 `hero`/`locked` 才能把它提到前面（`user_state` 是 rebuild 幸存量）。这条规则同时作用于 `shot_stack::list()` 与选片默认取用逻辑。

## 7. 界面

- **故事板**：章节已有 `missing_slots` 渲染点，在其旁按缺口行渲染卡片「缺口：建立镜头」+ `reason` + 两个按钮「生成候选」「忽略」。已有请求时卡片内联显示状态（草稿 / 已提交 / 排队中 / 生成中 / 失败：原因 / 已入库 → 缩略图），失败与已入库都提供「重新生成」（新建 `retry_of` 行，预填上次提示词）。
- **「生成候选」对话框**：提示词多行可编辑（显示字符数 / 7000）、参考帧缩略图与角色标签（首帧/末帧/参考图）、模型与分辨率下拉、时长 4–15 滑杆、**预估费用 + 本月已用/预算**、主按钮「提交（约 $0.30）」。未启用或预算耗尽时主按钮禁用并给出中文原因。
- **设置页新分区「云端补镜（MiniMax）」**（`settingsSections.ts` 加 `generation`）：启用开关、API Key 输入（保存写钥匙串，页面只显示"已配置 / 未配置"，**永不回显 key**）、默认模型/分辨率、月度预算（USD）、本月用量与账本表（时间 / 章节·slot / 模型 / 秒 / 预估费用 / 状态）、一句话说明"费用以 MiniMax 平台账单为准"。
- **筛片页**：`generated_source` 非空的 clip 显示徽章「AI 生成」。
- **联系表 / 剪辑清单 CSV**：加「来源」列，值为「AI 生成」或空——仅当改动是一列字段的加法时做，否则记入下一轮。

## 8. 验证装置

- `scripts/qa/minimax-mock.mjs`：实现两个端点，`--outcome succeeded|failed|slow`（slow = N 次 `queued` 后再成功）、`--fixture <mp4>`；断言 `Authorization: Bearer` 存在且非空；把收到的请求体落到 `--record` 指定的 JSON 供断言。Rust 集成测试用 `TRIPCUT_MINIMAX_BASE_URL` 指向它。
- `scripts/qa/generation-e2e.mjs`：脱网全链路——检测缺口 → 构造请求 → 提交到 mock → 轮询 → 下载 tiny mp4 → 导入 → 断言 clip `generated_source='minimax'`、`story_gaps.status='filled'`、Stack 里它排在真实素材之后、`generated/` 目录之外无新文件。
- **业主门控真机 e2e**：需要 key 与余额，跑一条 4 秒 480P `MiniMax-H3-Max`（约 $0.20），断言真实回流成功、账本记一笔、并**记录 data URI 是否被接受**这一未核实项的答案。

## 9. 局限

- data URI 是否可用未核实；若被拒，本机无公网 URL，补镜实际退化为纯 T2V（首尾帧引导失效），画面连贯性会明显变差——这是本轮最大的功能风险。
- 账本是**预估**成本，不是平台实际扣费；对账靠业主看平台账单。
- 生成片的分析维度（运镜、构图、曝光）由既有流水线打分，未针对生成内容校准，Best Take 分数只作参考。
- 24 小时下载链接过期属假设，未实测；因此设计为拿到即下、不持久化 URL 当资产。
- 只支持单集活跃场景；封存集里的缺口不检测。
