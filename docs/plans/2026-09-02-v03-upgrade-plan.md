# v0.2 → v0.3 升级计划(草案 v1,2026-09-02)

> 定位:**房车长期旅行 vlog 故事线工作台**。v0.2 完成了"素材可信进出"(导入→理解→筛选→交付),v0.3 要完成"故事可信生产"(以集为单位的叙事循环)+ UI 质变。
> 测试基线:docs/qa/2026-09-02-v02-test-summary.md(五版修复账+真机覆盖面)。

## 一、房车 vlog 视角功能审计(Claude 独立轮)

| # | 规格承诺 | 后端 | UI 暴露 | 房车工作流价值 | 缺口等级 |
|---|---|---|---|---|---|
| 1 | 跨集记忆/Used Shot Memory(附录D.8) | channel_memory 全量(novelty/routine visual) | 经 storyboard 徽章间接可见;**无集边界动作** | 周更创作者的核心循环 | 🔴 最大 |
| 2 | Episode/Chapter/Beat 三级(附录C) | narrative 有 Chapter/Beat | **无 Episode 管理**(项目=单库单集) | "收本集→开下集"必需 | 🔴 |
| 3 | 数字人五模式 A-E(附录D.5) | dh_guard/间距警告/槽位建议 | 仅被动警告,无"本集 DH 计划"视图 | DH 节奏是频道风格核心 | 🟠 |
| 4 | Routine 降级(附录C/D.9) | routine_suggestion 全量 | 徽章+逐条建议;**无批量接受** | 房车素材 60% 是 routine | 🟠 |
| 5 | 在途旅程叙事(附录C 分类) | 时间阶段/GPS 信号在库 | 无"路线"视图(两目的地卡之间的路) | 房车片核心是移动感 | 🟠 |
| 6 | 交付重复预警 | channel_memory 可查 | 交付包无"本集跨集重复清单" | 防"观众看腻" | 🟡 |
| 7 | 播放器时间码 | ✅ 已修(mpv wakeup 不触发→50ms 轮询) | ✅ | 剪辑硬伤 | ✅ 已闭 |

## 二、双方审计合并结论(Claude 独立轮 × Codex 头脑风暴)

两轮独立审计在不知情下共同命中三点:**Episode 缺失是 #1**、**Routine 判断不可纠正**、**跨集记忆不可见**。Codex 额外贡献两个关键盲点:
- **可编辑 Narrative Revision**:AI 编排会决定交付顺序,但剪辑人几乎不能改——建议版/确认版分离+撤销,是"AI 副导演"成立的前提。
- **真实素材 L3 Canary 应提前**:在扩功能前用一集真实房车素材跑通一次 L3 全链(schema/分章/Routine/预算账本),S 号工作量,防止在虚假地基上盖楼。
完整对照:docs/plans/2026-09-02-codex-v03-brainstorm.md(Codex 全文,含 11 项优先级表与三个 UI 方向)。

## 三、v0.3 范围定案(最小闭环 + UI 质变)

**最小闭环五件套**(Codex 顺位 1-5,采纳):
1. **P6-G1 Episode Spine(L)**:频道/Episode/素材归属;新建-命名-绑定导入-封存只读;旧数据落默认 Episode。这是一切跨集能力的主键地基。
2. **P6-G2 可编辑 Narrative Revision(L)**:AI 生成"建议版",人可改章节标题/类型、拖 Beat、跨章移动、撤销;交付只读"确认版"。
3. **P6-G3 Channel Memory Lens(M)**:筛片主战场直接显示"EP 已用/近四集重复/上次功能/Novelty",一键"本集避免重复"筛选。
4. **P6-G4 Routine Review & Override(M)**:改 routine kind/非 Routine/本集 treatment;批量接受降级;全部可撤销。
5. **P6-G5 真实一集 L3 Canary(S,业主参与)**:真实素材+真实额度跑一次 L3 叙事链,全程留证,失败可回退。

**UI 质变双刀**(Codex 方向 A+B 为主骨,吸收 Claude 命令面板/令牌统一):
- **P6-U1 Episode 中心壳(L)**:营销式大标题壳→50-56px 文稿 toolbar(集名/阶段 segmented/全局搜索/Inspector 开关);左侧改可收起 Episode Sidebar(集列表+进度);设置退出主流程第 04 步。
- **P6-U2 可调工作区(M)**:Browser-Canvas-Inspector 面板可显隐/拖宽,胶片墙密度可调,故事板三栏改按任务切换;跨页保持选择连续性;150ms 克制动效+控件 token 拉齐。

**后半段/可裁**(不挤前五项):DH Planner+历史栏(M)、Destination Evidence Workspace(L)、Journey Scene Editor(L)、Coverage→Action Loop(M)、交付 Episode Gate(M)。

## 四、实施步骤(四周节奏,含验收门禁)

| 周 | 内容 | 出口门禁 |
|---|---|---|
| W1 | G1 Episode Spine(迁移+事务+集列表)→ G5 Canary 准备(业主选一集真实素材) | 迁移 grep 全序核验;两集滚动 E2E 绿;快照回滚演练 |
| W2 | G2 Narrative Revision(revision/override 模型)+ G4 Routine Override | 建议版/确认版分离回归;撤销链测试;vitest 组件测试 |
| W3 | G3 Memory Lens + U1 Episode 中心壳 | dev 实拍逐控件轮;Stack 交互回归(v0.2.4 教训) |
| W4 | U2 可调工作区 + G5 真实 Canary(业主在场)+ 硬门 Benchmark 回归 + 手工级全测 | 18/18 全绿;打包版(非 dev)逐控件截图轮;v0.3.0 DMG |

工程纪律(v0.2 血泪固化):
- 六门全绿才合并;merge 单发验 HEAD;迁移数组必 grep 全序;styles.css 改动验花括号平衡。
- **打包版才是验收现场**:v0.2 的七个 P0 全部只在打包版发生(PATH/库分家/哨兵/死锁/白屏),dev 绿≠可发。
- Codex 派工纯写不跑测试;25 分钟心跳盯进度;幽灵判活=产出文件 mtime。
- 每个 UI 改动 dev 实拍图存 docs/qa/;AI 判断类功能一律"建议→人工动作→可撤销"三段式。

## 五、风险控制

| 风险 | 概率 | 缓解 |
|---|---|---|
| Episode 迁移破坏现有单集数据 | 中 | 迁移前自动快照;旧数据整体落"EP00 默认集"只增不删;回滚演练进 W1 门禁 |
| channel_memory 记忆污染(误计 used) | 中 | 只在「封存本集」动作入账;账本可查可撤;预览永不落账 |
| Narrative Revision 与 D2 story_order 语义冲突 | 高 | Codex 明确警告:不能复用 story_order 冒充编辑;W2 先冻结数据模型再动手 |
| UI 壳重构回归(筛片刚修过 Stack) | 高 | 组件级小步提交;Stack 交互回归测试已加;每步实拍对照 |
| L3 Canary 消耗真实额度 | 确定 | 预算账本熔断已有;单集单跑;业主在场确认 |
| 四周范围蔓延 | 中 | 后半段五项全部可裁;W2 末范围审查;最小闭环五件套不可裁 |
| 播放器 50ms 轮询 CPU | 低 | dev 实测无感;打包版异常则退 100ms |
