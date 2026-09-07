# 1. 房车 Vlog 视角的功能缺口审计

> 审计口径：以当前源码行为为准，规格与任务卡只用于建立承诺清单。本次是只读源码与文档审计，没有启动应用、调用真实 L3 额度或重跑测试。`docs/qa/2026-09-02-v02-test-summary.md` 明确记录 v0.2.4 真机覆盖了 D2 章节、Routine 徽章和 L3 关闭降级，但“L3 真机实调”仍留给业主；因此下文把“源码已接通”与“真机已证明”分开。任务描述所称全链路真机可用，和这份现有 QA 记录在 L3 叙事链上存在冲突，按证据记为“源码实现、真机证据不足”。

## 1.1 🔥 最痛缺口 #1：没有 Episode / 项目生命周期，“每周一集”尚无产品容器

**规格承诺：** 产品定位是多集频道运营，Episode → Chapter → Beat 应成为每周生产的基本边界；`channel.db` 跨项目保存 Used Shot、Routine 和数字人记忆，而每集素材、选择与叙事应有独立归属。

**后端状态：** `channel.db` 的确独立于 `project.db`，也有 `used_shots`、`routine_events`、`dh_appearances` 三张表；但桌面应用启动时固定打开 `TripCutStudio/default/project.db`，没有项目/集 CRUD。叙事持久化先 `DELETE FROM episodes` 再写一集，实际是“单库单当前 Episode”。交付时的 `episode_id` 还是由最终导出路径哈希生成，不是用户可见、可复用的频道集标识。

**UI 暴露状态：** `AppShell` 只有导入、筛片、交付、设置四个路由；没有“新建一集、切换集、封存集、复制上集结构、查看频道历史”。用户看不到 `channel.db` 属于哪个频道，也无法给 EP01/EP02 绑定标题和发布日期。

**实际价值：** 当前底座可以在同一个固定库连续累计导出记忆，但不能安全地表达“这一批素材属于哪一集”。旧素材只要仍保持收藏/精选，就会继续进入 `load_prompt_clips` 和交付查询；对每周出片而言，第一步就缺少可控边界。这是 v0.3 的承重项，不能只做一个 Episode 下拉框而不先补数据归属。

**支撑证据：** `src-tauri/src/lib.rs:903-919, 930-935`；`src-tauri/src/core/narrative.rs:466-476`；`src-tauri/src/core/deliver.rs:891-916`；`src/App.tsx:11-25, 114-180`；`docs/tasks/P3-D3-narrative-v2.md:13-14`。

## 1.2 🔥 最痛缺口 #2：Narrative v2 会决定交付顺序，却基本不能由剪辑人改

**规格承诺：** Episode / Chapter / Beat 是“编导系统”而非静态报告；自动建议必须可撤销，剪辑人应能移动 Beat、跨章调整、改 Chapter 类型/标题、升级或降级事件，并决定粗剪顺序。

**后端状态：** `narrative.rs` 已实现严格 JSON 校验、完整覆盖当前精选、章节/Beat/降级/槽位落库；`deliver::selected_clips` 在 L3 开启且叙事有效时按 `narrative_chapter.order`、`narrative_beat.order` 交付。可是已注册的叙事命令只有“排队重新编排、编辑地点卡、切换地点卡核实态”；`set_story_order`、`rename_chapter`、`merge_chapters` 操作的是旧 D2 `story_order/chapters`，不是 `narrative_chapters/narrative_beats`。

**UI 暴露状态：** Narrative 模式展示 Chapter、Beat、得分、依据、槽位和“重新编排”，但 `NarrativeBeatCard` 没有拖拽、移动、移出、改 role 或锁定控件，Chapter 标题也不再是输入框。D2 模式具备的排序、改名、合并、撤销控件在 Narrative 分支消失。

**实际价值：** 这让模型从“建议者”变成了粗剪顺序的事实写入者。剪辑人发现“到达应放在路上前”“早餐应保留为本集冲突”时，只能消耗额度重跑，并接受整套新结果；这与本产品“自动只做可撤销建议”的护城河直接冲突。

**支撑证据：** `src-tauri/src/core/narrative.rs:334-461, 466-560`；`src-tauri/src/core/deliver.rs:919-1015`；`src-tauri/src/lib.rs:598-689, 1183-1231`；`src/Storyboard.tsx:766-823, 829-845`。

## 1.3 Episode / Chapter / Beat 生成链：源码已接通，真实素材可用性仍未被现有 QA 证明

**规格承诺：** 时间断档、日期、GPS、八维时段和转写话题只生成边界信号；L3 围绕目的地、主题和关键事件生成十类 Chapter、Beat、降级清单和解释，L3 关闭时安全回退 D2。

**后端状态：** `prompt_input` 汇总候选边界、八维、转写、Shot Stack 与长期记忆；`narration_prompt` 明确禁止机械分章，输出经 `deny_unknown_fields`、枚举、完整且不重复覆盖等校验后事务落库。精选变化时 `load_overview` 比较当前引用与旧 Beat，失配即让叙事失效，避免旧结果覆盖新选择。

**UI 暴露状态：** 故事板可触发“重新编排”，先检查 L3 开关与预算，再披露发送字段并确认；任务轮询完成后切换到 Episode / Chapter / Beat，失败时保留 D2/上一版结果。Chapter 分类、逐章/逐 Beat 分数与“为什么这么分”均可见。

**实际价值：** 从源码看，这不是空数据结构，而是一条完整的建议生成链；但当前 v0.2.4 QA 只证明了 D2、Routine 徽章与 L3 关闭降级，未证明一次真实 L3 叙事输出在旅行素材上能通过 schema、合理分章并进入交付。因此 v0.3 应先补小规模“真实一集叙事实调”验收，而不是把源码绿当作创作质量绿。

**支撑证据：** `src-tauri/src/core/narrative.rs:229-331, 334-461, 619-670`；`src-tauri/src/core/llm.rs:275-289, 697-710, 757-762`；`src/Storyboard.tsx:477-493, 654-680, 851-884`；`docs/qa/2026-09-02-v02-test-summary.md:12-20, 28-31`。

## 1.4 🔥 最痛缺口 #3：跨集记忆已参与 Best Take 排序，却在筛片主战场几乎不可见

**规格承诺：** Used Shot Memory 应告诉剪辑人某镜头在哪几集、以什么功能、是否 Hero 被使用；重复视觉模式在近四集达到阈值后降为 Routine Visual，新地点/异常天气恢复 Novelty，且推荐理由必须可解释。

**后端状态：** 成功生成稳定交付包后，系统把实际成功片段写入 `channel.db`；`clip_annotation` 返回已用集角标、重复次数、Routine Visual、Novelty 与 Narrative 调整。`shot_stack::list` 会直接把 -0.20 / +0.10 写进 Narrative 轴并重算 Best Take，总分确实受长期记忆影响。

**UI 暴露状态：** 故事板 `StoryItemCard` 会显示“EP0x 已用”、Routine Visual 与 Novelty 徽章；但筛片胶片墙和展开的 Stack 成员没有读取 `member.long_term_memory` 来展示这些信息。右侧 Best Take 只显示调整后的分数，来源与说明藏在轴行的 `title` 悬停文本中，重复次数和上次使用语境均没有一眼可见的解释。

**实际价值：** 对房车周更而言，是否又用了同一种 Drone Follow、营地早餐、驾驶 POV，必须在“选或不选”的瞬间可见；等到故事板才提示太晚。当前能力能悄悄改善排序，却不能帮助创作者建立信任或主动打破频道视觉重复。

**支撑证据：** `src-tauri/src/core/deliver.rs:570-752, 891-916`；`src-tauri/src/core/channel_memory.rs:328-397`；`src-tauri/src/core/shot_stack.rs:295-419, 422-485`；`src/SelectPage.tsx:582-688, 849-879`；`src/Storyboard.tsx:241-259`。

## 1.5 Routine Stack 识别与降级建议：可见，但出现得晚

**规格承诺：** 起床、咖啡、收营、驾驶、接水接电、做饭等重复房车行为，首次可完整解释，重复默认约 2 秒 Montage/Transition，发生故障、异常天气或情绪变化时升级 Main Story Event；全部只是建议，不强制。

**后端状态：** 内置 15 类词表，结合转写/标签、人物状态、主体、时间阶段和功能识别 Routine；情绪、故障和异常天气关键词触发 `story_event`。历史 occurrence 来自 `channel.db`，建议以 `explained/montage/story_event` 三态返回并注入 L3 prompt 和 Beat 注释。

**UI 暴露状态：** D2 故事卡和 Narrative Beat 显示三态徽章与原因；Narrative 中 Routine 被折叠成建议组，模型判定的 Montage 另有折叠组。胶片墙筛片阶段没有 Routine 筛选、分组或徽章。

**实际价值：** 它能在故事复核阶段提醒“又是一次早餐/接水”，并保留异常升级，是已经能产生价值的底座；但周更剪辑通常先在胶片墙压缩大量 routine，提示延后会造成重复浏览和无效收藏。

**支撑证据：** `src-tauri/src/core/channel_memory.rs:577-743`；`src-tauri/src/core/narrative.rs:275-330, 1086-1113`；`src/Storyboard.tsx:311-329, 766-819`。

## 1.6 🔥 最痛缺口 #4：Routine 判断不可纠正，也不能一键落实为剪辑动作

**规格承诺：** Routine 降级应是可撤销建议；人工选择要反哺后续推荐。剪辑人应能确认/纠正行为类型、改 treatment，并把“约 2 秒 Montage”转成明确片段或槽位。

**后端状态：** `routine_events` 会在成功导出时按自动识别写入；代码没有 routine 标注、treatment override、忽略误判或用户确认的写接口。变化检测主要依赖有限关键词，且 `record_successful_export` 会把自动建议持久化成频道历史。

**UI 暴露状态：** Routine 只有徽章与说明；没有“不是 Routine”“本集保留完整”“升级主事件”“采用 2 秒 Montage”按钮，也不能编辑 `routine_kind`。Narrative Beat 本身又不可编辑，所以用户无法在故事板里纠正错误降级。

**实际价值：** “水管冻结”与“普通接水”、“暴雪驾驶”与“例行驾驶”正是房车故事价值的分水岭。不可纠正会让跨集记忆把一次误判固化为以后各集的降权依据；不可一键落实则让“建议”停留在标签层，没有节省剪辑时间。

**支撑证据：** `src-tauri/src/core/channel_memory.rs:40-50, 499-575, 672-743`；`src/api.ts:770-807`；`src-tauri/src/lib.rs:1183-1231`；`src/Storyboard.tsx:311-329, 766-819`。

## 1.7 Scene Cluster：有 signal scene，不是规格中的“理解地点故事角色”

**规格承诺：** Scene 应综合 GPS、时间、视觉语义、ASR、地标和环境变化，理解地点在故事中的角色；例如 150km Icefields Parkway 是一个 Journey Scene，Lookout 是 Sub-scene/Beat，而不是按 2km 机械切分。

**后端状态：** D2 `chapterize` 仍以 45 分钟或 2km 为切分条件。Shot Stack 重建时按 `candidate.chapter_id` 分组，每个 D2 chapter 生成一个 `kind='signal'` 的 scene，再用主体/功能/景别/运动分 Stack；Narrative 只把这些信号交给 L3 组织 Chapter，没有持久化可编辑的 Journey Scene/Sub-scene 图。

**UI 暴露状态：** Scene 名称仅在胶片墙展开 Stack 后显示；用户不能合并两个 signal scene 为一条 Journey、拆出 Lookout Beat，或查看地图/时间/转写为何被聚在一起。Narrative 模式展示的是 Chapter 与 Beat，不是独立 Scene 层。

**实际价值：** 当前 Scene 足够支持局部 Stack 去重，但对长距离公路叙事仍可能把一次旅程切碎；剪辑人无法在“场景层”一次修正后让 Stack、故事板和 Coverage 共同受益。

**支撑证据：** `src-tauri/src/core/story.rs:12-13, 315-335`；`src-tauri/src/core/shot_stack.rs:177-223, 785-830`；`src/SelectPage.tsx:616-628`；`src-tauri/src/core/narrative.rs:874-930`。

## 1.8 Story Slot / Coverage 缺口：能诊断，不能驱动补救工作流

**规格承诺：** 故事板应显示叙事槽位流，让编辑者看到“缺哪部分”；Destination Coverage 的缺口要转成可执行补救，如从现有素材找 Detail/Human/Experience，或建议 Map/Graphic/DH。

**后端状态：** Narrative schema 固定九类 story slot 和十三项 Destination Coverage；校验要求已覆盖项有证据、缺失项有建议，结构完整性较强。

**UI 暴露状态：** Chapter 中用 chips 展示已有/缺失 slot；地点卡的折叠区只列未覆盖项和建议。没有点击缺口后自动搜索候选、把素材拖入对应 slot、创建 DH/MAP 占位、将建议标记为已处理的状态机。

**实际价值：** 现状像一份制作诊断报告，能告诉创作者“缺 Detail”，却不能把下一步工作集中到缺口上。对每周出片，真正省时的是“点缺口 → 看候选 → 填槽/确认无法补”，而不是多一组红色标签。

**支撑证据：** `src-tauri/src/core/narrative.rs:29-55, 990-1022`；`src/Storyboard.tsx:796-819, 420-430`。

## 1.9 数字人五模式与节奏守卫：规划可见，历史与人工控制缺失

**规格承诺：** A–E 五模式只做规划不生成；强真实事件必须 Reality First；跨集记录最近出现、连续时长、累计、机位、背景、风格和讲解类型，避免 DH ↔ B-roll 机械循环。

**后端状态：** 模型输出被限制为 A–E，`unexpected` Chapter 如带 DH 只能用 E；系统计算相邻 DH 间实拍槽数量和本集估算时长，成功导出后把 mode、估算 duration、合成 style、Chapter title 作为 topic 写入 `dh_appearances`。`dh_guard` 也会返回最近 12 次历史 appearance。

**UI 暴露状态：** Chapter 的“为什么这么分”里显示 mode 与 reason，只有产生警告时才显示本集时长/间隔警示。`historical_appearances` 虽已进入前端类型，却没有任何组件渲染；用户也不能改 mode、planned slots、实际时长、机位、背景或风格。

**实际价值：** 它能阻止最明显的连续 DH 和超时规划，但跨集记忆目前是“模型可读、剪辑人不可读”。由于 duration/style 是推算值而非剪映成片反馈，系统无法真正知道数字人最终用了多久、长什么样，长期节奏控制仍偏虚。

**支撑证据：** `src-tauri/src/core/narrative.rs:375-387, 630-667`；`src-tauri/src/core/channel_memory.rs:411-495, 745-789`；`src/api.ts:441-453`；`src/Storyboard.tsx:785-795, 868-879`。

## 1.10 🔥 最痛缺口 #5：Destination Card 可编辑可导出，但“核实”只是整卡布尔值

**规格承诺：** 地点卡结合 GPS、画面识别、现场口播和可验证外部资料，形成地点背景、特点、为什么值得来、个人体验、相关 B-roll；外部资料必须有来源与待核实态，Coverage 还要指出素材是否足够讲清楚地点。

**后端状态：** 当前输入只有原始坐标 fallback，`local_reverse_geocode` 明确为 `null`；没有地标识别或外部检索。LLM 生成的 `sources` 是“输入或模型自述依据”，默认 `verified=0`。地点卡文本可更新，更新会重置待核实；交付时未核实卡只写占位，已核实卡才写完整内容与 13 项 Coverage，安全边界是成立的。

**UI 暴露状态：** `DestinationCardEditor` 可改五个文本字段并一键切换整卡“已核实”；Coverage 只展示缺失项，不展示已覆盖项的素材证据；sources 只读，不能添加 URL/书名/现场说明牌照片、逐条判定可信度或标记“此字段已核实”。用户可以在没有任何来源证据的情况下把整卡标为已核实。

**实际价值：** 地点卡已经能作为剪映交付附件，但还不能成为可信的旅行内容研究台。对国家公园、历史建筑、道路规则这类内容，整卡布尔核实会把“我确认过个人体验”误扩展成“地理历史都确认过”，既增加事实风险，也让每周核实工作无法分工和续做。

**支撑证据：** `src-tauri/src/core/narrative.rs:746-825, 979-987, 703-742`；`src-tauri/src/core/llm.rs:697-710`；`src/Storyboard.tsx:333-439`；`src-tauri/src/core/deliver.rs:2226-2286`。

## 最痛 5 项的因果顺序

1. **Episode 容器缺失**：没有周更边界，后续所有“跨集”能力都缺稳定主键与用户心智。
2. **Narrative 不可编辑**：模型结果直接决定交付，却不能做最基本的编导修正。
3. **记忆在筛片阶段不可见**：已经影响排序，用户却无法在决策点理解和控制。
4. **Routine 不可纠正/落实**：误判可进入长期记忆，建议又不能转成节省时间的动作。
5. **地点卡核实粒度过粗**：已有交付价值，但事实依据与逐字段责任链没有闭环。

# 2. v0.3 候选项优先级

工作量口径：**S** = 单层或单组件、无迁移；**M** = 前后端跨层且需要状态/回归；**L** = 新领域模型或迁移、多个页面与端到端验收。排序按房车创作者“建本集 → 导入 → 筛片 → 编故事 → 补缺口 → 交付 → 让下一集变聪明”的一周流程，而不是按现有模块归属。

| 顺位 | v0.3 候选项 | 周更工作流中的可验收结果 | 工作量 | 依赖关系 |
|---:|---|---|:---:|---|
| 1 | **Episode Spine：频道 / Episode / 素材归属** | 新建 EP、命名/日期/状态、把一次导入绑定本集、切换/封存后只看本集；旧集只读可查 | L | 先冻结 `channel_id/episode_id/project_id` 语义；迁移当前固定 `project.db`；为旧数据提供默认 Episode |
| 2 | **可编辑 Narrative Revision** | AI 编排生成“建议版”；用户可改 Chapter 标题/类型、拖动 Beat、跨章移动、改 montage/transition、撤销；交付读取“已确认版” | L | 依赖 1 的 Episode 主键；新增 revision/override 模型，不能复用 D2 `story_order` 冒充 Narrative 编辑 |
| 3 | **筛片阶段的 Channel Memory Lens** | 胶片卡/Stack/Inspector 直接显示 EP 已用、近四集重复次数、上次功能、Routine/Novelty 与分数改变量；可一键筛“本集避免重复” | M | 依赖 1；可复用现有 `ShotStackMember.long_term_memory`，先不改评分算法 |
| 4 | **Routine Review & Override** | 在胶片墙或 Inspector 改 routine kind / 非 Routine / 本集 treatment；“采用 Montage”生成可撤销的 2 秒候选段或 Story slot | M | 依赖 2 的 override/撤销机制；需决定用户纠正写 project 还是 channel，导出成功后再沉淀频道事实 |
| 5 | **真实一集 Narrative Canary** | 用一集真实房车素材跑一次 L3：schema 成功、分章目测、Routine 升降级、交付顺序、预算账本全部有证据；失败可回退 | S | 可与 1/2 设计并行，但应在扩功能前完成；依赖可用 provider 与业主授权额度 |
| 6 | **Destination Evidence Workspace** | 本地粗粒度地名、来源条目增删、逐字段“待核实/已核实/不采用”、来源链接或说明牌素材引用；整卡状态由字段聚合 | L | 依赖 1/2；先定义离线 reverse-geocode 数据源与来源对象 schema；联网增强可后置 |
| 7 | **Coverage → Action Loop** | 点击缺口即可用八维/搜索找候选并填入 slot；无素材时创建 MAP/Graphic/DH 占位；每项有“已处理/放弃及原因” | M | 依赖 2 和 6；复用 `searchClips`、八维与 story slots |
| 8 | **DH Planner + 历史栏** | 可编辑 A–E、槽位、预计/实际时长、机位/背景/风格；可见近几集历史与重复警告，导出后记录确认值 | M | 依赖 1/2；扩 `dh_appearances` 前先定义“规划值”和“实际值”分离 |
| 9 | **Journey Scene Editor** | 合并信号场景为长途 Journey、拆 Sub-scene/Beat，并让 Stack、Narrative 输入与 Coverage 同步更新 | L | 依赖 1；复用 D2 boundary signals，但需要独立 Scene 实体，不能继续让 `chapter_id == scene` |
| 10 | **交付前 Episode Gate** | 一屏确认 Beat 顺序、未核实地点字段、未处理 Coverage、DH 警告和本次将写入频道记忆的镜头；确认后再导出 | M | 依赖 2、6、8；复用现有稳定包/草稿出口，不改媒体切片核心 |
| 11 | **紧凑可调工作区骨架** | 侧栏/Inspector 可显隐和拖拽宽度，胶片墙密度可调，故事板候选/地点卡按任务切换而非永久挤三栏 | M | 可在 1 的导航改造中搭骨架；具体信息模块依赖 2/3/6 |

建议的 v0.3 最小闭环不是“把表里前五项都做一半”，而是：**1 Episode Spine + 2 Narrative 可编辑最小集 + 3 Memory Lens + 4 Routine Override + 5 一次真实 Canary**。它首次让“每周一集”从数据边界、人工控制、跨集反馈到真实验证形成闭环；Destination 与 DH 深化可作为同版本后半段，但不能挤掉前四项。

# 3. UI 质变方向

设计参照只取工作区原则，不照搬皮肤：Final Cut Pro 把 browser、viewer、timeline、sidebar、inspector 做成可显隐/可调尺寸的任务布局（[Apple 官方工作区说明](https://support.apple.com/en-ca/guide/final-cut-pro/ver2a27194eb/mac)）；macOS HIG 建议在空间紧张时收起 sidebar，并把常用、与当前内容相关的动作放在紧凑 toolbar（[Sidebar](https://developer.apple.com/cn/design/human-interface-guidelines/sidebars)、[Toolbar](https://developer.apple.com/cn/design/human-interface-guidelines/toolbars)）；Resolve 的 Edit 工作区同样围绕 Media Pool / Viewer / Inspector 的可切换面板组织（[DaVinci Resolve 20 Editors Guide](https://documents.blackmagicdesign.com/UserManuals/DaVinci-Resolve-20-Editors-Guide.pdf)）。Things/Craft/Arc 值得借的是“安静的层级、渐进披露、状态连续性”，不是大圆角和装饰动画。

## 方向 A：从“四张落地页”变成 Episode 中心的 macOS 文稿窗口

**质变点：** 当前 `AppShell` 固定 260px 侧栏、42px 顶部内边距和大号营销式 H1；每次进入筛片都先消费大量空间解释“留下真正值得看的”。专业工具应让“当前是哪一集、现在在哪个阶段、下一关键动作是什么”成为一级信息，页面口号退到首次空态。

**页面级改法：**

- `App.tsx / AppShell`：把大 `workspace-header` 改成 50–56px 统一 titlebar/toolbar。前缘是侧栏显隐＋`频道 / EP12 · Icefields Parkway` 文稿菜单；中间是导入/筛片/故事/交付四段 segmented control；后缘是全局搜索、任务中心、Inspector 开关和当前阶段主动作。保留米色/深色 token，不做仿系统透明材质的重特效。
- 左侧从固定流程导航改为可收起的 **Episode Sidebar**：顶部“本周 / 草稿 / 已交付”，中段 Episode 列表及进度环，底部才是设置。展开宽度约 210–240px，收起为 52–60px 图标栏；窗口窄时自动收起，而不是像现在隐藏右 Inspector 但仍保留大外壳。
- `ImportPage`：顶部先显示“导入到 EP12”，来源选择与只读/磁盘风险保持在同一 toolbar；扫描进度压成可展开的后台任务条，完成后主视图直接进入“本集素材”而非停在全库表格。
- `DeliverPage`：标题区变成 Episode Gate（顺序、未核实地点、Coverage、DH、预计时长）；主按钮固定在 toolbar 后缘。交付完成后展示“本集已封存 / 已写入频道记忆 X 条”，而不是只显示文件处理状态。
- `SettingsPage`：继续使用独立分类侧栏，但不占主流程第 04 步；它是应用设置，不是每集必须经过的生产阶段。

**信息层级与视觉密度：** 一级只保留 Episode、阶段、主动作；二级是素材/Beat/缺口计数；技术路径、L1/L3、LOCAL SQLITE 等移入状态详情或帮助。这样既更像现代 macOS 文稿应用的“一个窗口处理一个对象”，也让房车频道运营天然有“本周这一集”的心智锚点。

## 方向 B：建立可调的 Browser — Canvas — Inspector 专业工作区

**质变点：** 当前筛片是 `中心 + 230px Inspector`，故事板则固定成 `主序列 + 候选 + 地点卡` 三栏；在常见窗口宽度下，后者会同时挤压三种高信息密度任务。专业剪辑工具的优势不是“永远三栏”，而是同一素材对象在不同任务布局中保持选择状态，面板可显隐、可调宽度、可保存工作区。

**页面级改法：**

- `SelectPage`：恢复真正的 Collection/Smart Bin 左栏（日期、设备、Scene、Routine、已用集、Coverage 缺口），默认 190–220px、可收起；中间 Browser 支持“大缩略图 / 紧凑胶片 / 列表”三档密度；右 Inspector 从 230px 提升为可拖拽 300–420px，并支持 `⌘4` 显隐。当前六轴、八维、精选段和 L3 描述不再挤在一条窄竖栏里，而是用 Inspector tabs：编辑 / 分析 / 频道记忆。
- `FilmCard` 与 `shot-stack-member-strip`：缩略图上只留时间、评级、Stack 数、最多一个风险标；EP 已用、Routine、Novelty 进入卡片底部一行可扫描 chips。展开 Stack 改为在当前网格行内推开一条横向 audition strip，保持后续卡片位置稳定；右 Inspector 同步显示所选候选的 Best Take 差异，而不是依赖 hover title。
- `StoryboardView`：默认只保留宽主 Canvas。Chapter 纵向为章节，Beat 横向形成可拖拽槽位流；候选区改成底部可拉高 drawer，地点卡/DH/Coverage 共用右 Inspector tabs。用户处理地点事实时打开地点卡，排 Beat 时把整宽还给故事，不再长期支付三栏空间税。
- `PlayerOverlay`：从全屏“进入/退出”升级为 Browser 与 Canvas 共用 Viewer，可在上半区/浮动窗口/沉浸态三种布局切换；选中 FilmCard、Beat 或 Coverage 候选时保持同一播放位置和入出点。
- 工作区预设：至少提供“筛片”“编故事”“核实地点”三档；保存 divider 宽度与面板显隐。视觉上继续用直角、细边框和低饱和 accent，质感来自空间控制与稳定对齐，不靠卡片阴影堆层级。

**空间布局与密度收益：** 4K/大屏可同时看 Browser、Viewer、Inspector；MacBook 宽度下自动隐藏低优先级面板但不丢能力。高频筛片可走紧凑模式，地点核实可给文本足够宽度，故事编排则获得近似时间线的横向空间。

## 方向 C：把“AI 报告”改成可操作、可撤销、可比较的编导状态

**质变点：** 当前 UI 已有大量解释字段，但多为 badge、`details` 和长状态文案；Narrative 完成后直接替换视图，地点卡整卡核实，Routine 只有标签。真正的质变是让每条 AI 判断都呈现为“建议 → 人工动作 → 已确认结果”，并用克制动效维持对象连续性。

**页面级改法：**

- `NarrativeBeatCard`：加入固定拖拽柄、role segmented control（Beat/Montage/Transition）、“移到…”和锁定；选中后 Inspector 展示模型依据、长期记忆调整和人工 override。Chapter header 可直接改标题/kind、升主章、合并/拆分；顶部显示“AI 建议版 / 人工已确认版”，交付只读后者。
- `routine-group`：每条建议提供“接受 2s Montage”“保留完整”“升级事件”“不是 Routine”。接受后在卡片内展开生成的 select range，可播放复核并撤销；频道学习只在成功交付后记录确认结果。
- `DestinationCardEditor`：不再堆五个 textarea。右 Inspector 顶部是地点名与总状态，主体用四个字段 section；每字段旁有来源 chips 与“已核实”。下方 13 项 Coverage 用 3 列矩阵（已覆盖 / 缺口 / 已处理），点一项把 Browser 切到对应八维候选；只有所有必需事实字段完成时整卡才变绿。
- 数字人：在 Chapter slot flow 中用独立紫/蓝语义色的 DH placeholder，展开后选 A–E、预计时长、背景/机位/风格；旁边以小型 sparkline/条带展示近几集 DH 频率，而不是只在超阈值时突然给红警告。
- `storyboard-status` 与 L3 任务：排队时保持旧版本可操作，在 toolbar 中显示阶段进度；新结果回来先给“变更预览”（新增/移动/降级多少 Beat），用户接受后用 160–220ms 的位置过渡更新。Stack 展开、Inspector 显隐、Beat 移动只做几何连续动画；成功提示短暂出现，错误与待核实保持持久。继续遵守现有 `prefers-reduced-motion`，不使用循环装饰动画。
- 全局 Command Palette（`⌘K`）：搜索素材、跳 Episode、执行“标 Routine / 升事件 / 打开地点卡 / 交付前检查”。把当前横向滚动的筛选条和整排快捷键提示降为可搜索命令与上下文提示，减少工具栏拥堵。

**动效与信任收益：** 动效只解释“同一个镜头从候选进入 Beat、从 AI 建议变成人工确认、从缺口变为已处理”，不做无意义漂浮。每次状态变化都有撤销与来源，用户会感到系统在协助编导，而不是生成一份不可改的漂亮报告。