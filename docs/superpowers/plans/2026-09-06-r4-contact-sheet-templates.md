# R4 联系表 PDF + 故事模板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付包多一份可打印的联系表 PDF（缩略图网格 + 文件名 + 入出点 + 章节，CJK 正确嵌入）；故事板可选四种故事模板（电影感 / 快节奏 / 安静氛围 / 旅行日记），有 LLM 时作 prompt 预设，无 LLM 时有确定性兜底且四模板产出不同。

**Architecture:** 联系表是纯导出物：新模块 `core/contact_sheet.rs` 用 printpdf 手工排版，从现有 `ExportClip` 派生数据，接入 `deliver.rs` 写 `05_镜头表/联系表.pdf`；字体随包（思源黑体 OFL 子集）。故事模板：`narrative.rs::STORY_TEMPLATES` 枚举 + prompt 前缀 + 数值参数 + 兜底排序；`narrative_revisions.template` 列（迁移 0033）；命令 `list_story_templates`、`enqueue_narrative(template)`；故事板顶部模板卡片。

**Tech Stack:** printpdf（MIT，锁精确版本）、Source Han Sans SC OTF（OFL-1.1，pyftsubset 或 fonttools 子集化，仅保留常用汉字 + 拉丁 + 标点 + 数字，约 1–2 MB）、rusqlite、React。

## Global Constraints

- 规格 §4 联系表/故事模板；总计划 Global Constraints。迁移号 **0033**（数组连续追加，LATEST 33）。
- 许可证：printpdf MIT；字体 OFL-1.1，登记进 `docs/THIRD_PARTY_NOTICES.txt` 与 `scripts/generate-license-manifest.mjs`（若清单由脚本生成）；打包脚本 `package-dmg.sh` 的许可证 1:1 覆盖自检必须仍 PASS（新增资源文件要映射）。
- 时间只用 tick + `tb_num/tb_den`，时码用 `deliver.rs` 已有的 `format_clock`。
- 无 LLM 时不得引入第二套数据结构：兜底直接产出现有 `NarrativeDraft`/`chapters`/`beats`。
- 车道 worktree + 共用 `CARGO_TARGET_DIR`；接线人合并；门禁看 `gate.json.status`；提交带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

### Task 1: 字体资源与许可证登记

**Files:** `src-tauri/assets/fonts/SourceHanSansSC-Regular.subset.otf`（新）、`src-tauri/assets/fonts/LICENSE-SourceHanSans.txt`、`docs/THIRD_PARTY_NOTICES.txt`、`scripts/package-dmg.sh`（若有资源清单）、`src-tauri/tauri.conf.json`（`bundle.resources` 若需要）
- [x] 下载 Source Han Sans SC Regular（Adobe GitHub release，OFL）；用 `pyftsubset`（`pip install fonttools`，仅构建机）按 `--unicodes` 保留：U+0020-007E、U+3000-303F、U+4E00-9FFF、U+FF00-FFEF、U+2013-2026；记录原始 sha256 与子集化命令到 `assets/fonts/README.md`。
- [x] 验证：`cargo build` 后 `include_bytes!` 能读到；打包脚本许可证自检 PASS（跑 `TRIPCUT_PACKAGE_MODE=qa ./scripts/package-dmg.sh` 或其自检子步骤）。
- [x] Commit：`chore(assets): 随包思源黑体 SC 子集(OFL-1.1)——联系表 PDF 的 CJK 嵌入字体`

### Task 2: printpdf 联系表渲染

**Files:** `src-tauri/Cargo.toml`（`printpdf = "=0.7.x"`）、`src-tauri/src/core/contact_sheet.rs`（新）、`core/mod.rs`
**Interfaces:**
```rust
pub struct ContactSheetItem { pub order: usize, pub file_name: String, pub in_clock: String, pub out_clock: String, pub chapter_title: Option<String>, pub cover_jpeg: Option<Vec<u8>> }
pub struct ContactSheetOptions { pub title: String, pub portrait: bool, pub columns: usize /* 横 4 竖 3 */ }
pub fn render_contact_sheet(items: &[ContactSheetItem], options: &ContactSheetOptions, out: &Path) -> Result<ContactSheetStats /* pages, glyph_fallbacks */>;
/// 字体覆盖检查:返回文本中子集字体不含的字符;调用方把它们替换为「□」并计数,不静默。
pub fn missing_glyphs(text: &str) -> Vec<char>;
```
- [x] 失败测试：3 条项目（含中文文件名、emoji、章节标题）→ PDF 存在、`%PDF-` 头、`pages == 1`；30 条 → `pages == 3`（4 列 × 3 行/页 = 12/页）；空列表 → Err「没有精选片段」；`missing_glyphs("旅拍🎬")` 含 `🎬`；用 `pdftotext`（若 `which pdftotext`）或 `lopdf` 解析断言文本流含「第 1 章」与文件名子串——`lopdf` 已是 printpdf 依赖，用它读内容流比外部工具稳。
- [x] 实现：A4 页，页眉标题 + 页码；网格卡片：JPEG 封面（`printpdf::Image` 从 JPEG 解码，无封面画灰框）、下方三行文字（序号+文件名、`[in–out]`、章节）。字体 `include_bytes!` 一次注册。
- [x] Commit：`feat(contact-sheet): printpdf 联系表渲染——A4 网格、CJK 子集字体、缺字显式替换`

### Task 3: 接入交付流程

**Files:** `src-tauri/src/core/deliver.rs`（在写 CSV 后调用；封面 JPEG 从 `cache_artifacts` kind='cover' 读；`ContactSheetOptions.portrait` 取平台方向；写 `05_镜头表/联系表.pdf`；交付说明 05 句子加「与联系表 PDF」；`ExportStatus`/manifest 记页数）、`src/DeliverPage.tsx`（交付包内容预览列表加「联系表.pdf」勾选，默认开）、`src/api.ts`
- [x] 失败测试：交付 fixture → `05_镜头表/联系表.pdf` 存在且文本流含中文文件名；关闭勾选 → 不生成且说明不提。
- [x] Commit：`feat(deliver): 交付包写入联系表 PDF——按平台方向选横竖网格`

### Task 4: 0033 故事模板数据层 + prompt 预设 + 兜底

**Files:** `migrations.rs`（`ALTER TABLE narrative_revisions ADD COLUMN template TEXT CHECK(template IN ('cinematic','fastcut','ambient','diary') OR template IS NULL)`）、`src-tauri/src/core/narrative.rs`（`pub enum StoryTemplate { Cinematic, Fastcut, Ambient, Diary }`，`STORY_TEMPLATES: &[StoryTemplateInfo { id, name_zh, blurb_zh }]`，`fn prompt_prefix(t) -> &str`，`fn template_params(t) -> TemplateParams { beat_min_s, beat_max_s, montage_density, narration_density }`，`pub fn enqueue_with_template(connection, template: Option<StoryTemplate>)`，`pub fn build_fallback_draft(connection, template) -> Result<NarrativeDraft>`）、`src-tauri/src/core/llm.rs`（`narration_prompt(input)` 前拼 `prompt_prefix`；契约字符串不变）、`src-tauri/src/lib.rs`（`list_story_templates`、`enqueue_narrative` 加 `template: Option<String>`）、`src/api.ts`
- [x] 失败测试：四个 `prompt_prefix` 非空且互不相同，拼接后的 prompt 仍含契约 JSON 原文；`LLM_ENABLED=false` 时 `build_fallback_draft` 对同一 fixture（≥8 条素材、含 GPS/时间边界）四模板产出的 `story_slots` 顺序两两不同（`cinematic` 首槽为最高分建立镜头、`fastcut` 首槽为最短高能 beat、`ambient` 首槽为无人物空镜、`diary` 按时间顺序）；`enqueue_with_template` 把模板写进新建 revision 行；无 LLM 时 `enqueue` 直接落地兜底草稿为 `suggested` revision（不再返回「LLM 未启用」错误——注意现有 `narrative.rs:235` 的早退逻辑要改成走兜底，保留原错误给 `template=None` 且设置关闭的旧行为？——决定：一律走兜底，界面文案改为「未启用 AI，按模板规则生成」）。
- [x] Commit：`feat(narrative): 迁移 0033 故事模板——四种 prompt 预设与无 LLM 确定性兜底`

### Task 5: 故事板模板卡片（前端）

**Files:** `src/Storyboard.tsx`（顶部四选一卡片 + 「不使用模板」；选择后调用 `enqueueNarrative(template)` 并显示进度）、`src/Storyboard.test.tsx`
- [x] 测试：渲染四张卡片；点击「电影感」→ `enqueueNarrative("cinematic")`；历史集只读禁用。
- [x] Commit：`feat(storyboard): 故事模板卡片——一键按模板重新生成叙事`

### Task 6: 收尾
- [x] 合并顺序 1 → 2 → 3 → 4 → 5；门禁 gate.json；smoke 加断言：故事板 AX 含「电影感」；交付页含「联系表」。
- [x] 文档同步（联系表、故事模板）；`docs/qa/2026-09-06-unattended-r4.md`。
